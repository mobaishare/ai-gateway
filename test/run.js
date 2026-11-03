'use strict';

/**
 * 端到端测试：验证平台的配额规则
 *
 * 用独立的临时数据目录 + 独立端口启动一个实例，跑完自动清理，
 * 不会污染 data/db.json 里的演示数据。
 *
 * 运行：node test/run.js
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? '\n      → ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function req(p, { method = 'GET', token, body, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, headers: res.headers, text: await res.text() };
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { status: res.status, data };
}

async function waitReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error('服务启动超时');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 假上游：模拟一个 OpenAI 兼容服务，用来验证真实转发链路
 * （流式透传、usage 透传、故障切换都靠它来测）
 */
function startFakeUpstream(port, opts = {}) {
  const http = require('http');
  const { alwaysFail = false, tag = 'A' } = opts;

  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    }

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (alwaysFail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `upstream ${tag} intentionally broken` } }));
      }

      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      server.lastBody = body;   // 供用例断言网关到底往上游发了什么

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const id = 'chatcmpl-fake-' + tag;
        const chunks = ['来自', tag, '渠道', '的', '流式', '响应'];
        let i = 0;
        const tick = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(tick);
            // 故意把嵌套的 prompt_tokens_details 放在最前：
            // 老的 `"usage":{([^}]*)}` 正则会在这里截断，把后面的 prompt/completion 全丢掉
            res.write(`data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: {
                prompt_tokens_details: { cached_tokens: 3 },
                prompt_tokens: 11, completion_tokens: 22, total_tokens: 33,
              },
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(`data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', model: body.model,
            choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
          })}\n\n`);
          i++;
        }, 8);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fake-' + tag,
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: `来自 ${tag} 渠道的真实响应` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333, prompt_cache_hit_tokens: 5, prompt_tokens_details: { cached_tokens: 5 }, cache_creation_input_tokens: 6 },
      }));
    });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/** 假告警机器人：收集平台推过来的文本，用来验证「部门/个人独立告警」 */
function startWebhook(port) {
  const http = require('http');
  const messages = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let text = raw;
      try {
        const j = JSON.parse(raw);
        text = (j.content && j.content.text) || (j.text && j.text.content) || raw;
      } catch { /* 非 JSON */ }
      messages.push(text);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, messages })));
}

/** 反复调用直到被拦截，返回拦截信息 */
async function callUntilBlocked(key, maxCalls = 60) {
  for (let i = 0; i < maxCalls; i++) {
    const r = await req('/v1/chat/completions', {
      method: 'POST',
      token: key,
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '测试额度消耗' }] },
    });
    if (r.status === 429) return r.data.error;
    if (r.status !== 200) return { unexpected: r.status, body: r.data };
  }
  return null;
}

// ---------------------------------------------------------------- 主流程

(async function main() {
  console.log('\x1b[1m\nAI API 分流平台 · 端到端测试\x1b[0m');
  console.log(`数据目录：${DATA_DIR}\n端口：${PORT}\n`);

  const proc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), GW_DATA_DIR: DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverErr = '';
  proc.stderr.on('data', (d) => { serverErr += d.toString(); });

  // 两个假上游：一个正常，一个永远 500（用来验证故障切换）
  const upstreamOK = await startFakeUpstream(8798, { tag: 'OK' });
  const upstreamBad = await startFakeUpstream(8797, { alwaysFail: true, tag: 'BAD' });
  const hookGlobal = await startWebhook(8796);
  const hookDept = await startWebhook(8795);
  const hookEmp = await startWebhook(8794);

  try {
    await waitReady();

    // 登录
    const login = await req('/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin123' },
    });
    const T = login.data.token;
    if (!T) throw new Error('登录失败：' + JSON.stringify(login.data));

    // /healthz 上报版本与启动时间：前端据此判断服务端是否还在跑旧代码（改了没重启）
    const hz = await req('/healthz');
    const pkgVersion = require(path.join(__dirname, '..', 'package.json')).version;
    check('/healthz 上报版本与启动时间（前端据此识别旧进程）',
      hz.data.version === pkgVersion && !!hz.data.startedAt && typeof hz.data.uptime === 'number',
      JSON.stringify(hz.data));

    // 用一个极小的额度基准，方便快速触发拦截
    const BIG = 50_000_000;

    const mkDept = async (name, quota) => {
      const r = await req('/api/departments', {
        method: 'POST', token: T,
        body: { name, quota, providerIds: [], status: 'active' },
      });
      if (!r.data.id) throw new Error('建部门失败：' + JSON.stringify(r.data));
      return r.data;
    };

    const mkEmp = async (name, deptId, override) => {
      const r = await req('/api/employees', {
        method: 'POST', token: T,
        body: { name, deptId, status: 'active', override },
      });
      if (!r.data.id) throw new Error('建员工失败：' + JSON.stringify(r.data));
      return r.data;
    };

    const getEmp = async (id) => {
      const r = await req('/api/employees', { token: T });
      return r.data.items.find((e) => e.id === id);
    };
    const getDept = async (id) => {
      const r = await req('/api/departments', { token: T });
      return r.data.items.find((d) => d.id === id);
    };

    // ============================================================
    section('⓪ 新装默认：分时交给模型自己的时段表');
    const pr0 = await req('/api/pricing', { token: T });
    check('新装默认不启用全局高峰时段', pr0.data.peak?.enabled === false, JSON.stringify(pr0.data.peak));
    const dsPreset = pr0.data.items['deepseek-flash'];
    check('内置参考价自带 DeepSeek 峰谷时段表',
      Array.isArray(dsPreset?.periods) && dsPreset.periods.length === 3
      && dsPreset.periods[0].name === '高峰·工作日' && dsPreset.periods[2].days.join(',') === '0,6',
      JSON.stringify(dsPreset?.periods));

    const t0 = async (at) => (await req('/api/pricing/test', {
      method: 'POST', token: T,
      body: { model: 'deepseek-flash', prompt: 1000, completion: 500, at },
    })).data.detail;
    const t0Peak = await t0('2026-11-03T10:30:00+08:00');
    check('DeepSeek 周二 10:30 命中工作日高峰（入 2 / 出 8）',
      t0Peak.period?.name === '高峰·工作日' && Math.abs(t0Peak.total - 0.006) < 1e-9,
      JSON.stringify({ period: t0Peak.period, total: t0Peak.total }));
    const t0Lunch = await t0('2026-11-03T13:00:00+08:00');
    check('DeepSeek 工作日午休命中空闲价（入 1 / 出 4）',
      t0Lunch.period?.name === '空闲·工作日' && Math.abs(t0Lunch.total - 0.003) < 1e-9,
      JSON.stringify({ period: t0Lunch.period, total: t0Lunch.total }));
    const t0Weekend = await t0('2026-11-07T12:00:00+08:00');
    check('DeepSeek 周六命中周末空闲价（入 1 / 出 4）',
      t0Weekend.period?.name === '空闲·周末' && Math.abs(t0Weekend.total - 0.003) < 1e-9,
      JSON.stringify({ period: t0Weekend.period, total: t0Weekend.total }));

    // ============================================================
    section('① 员工特例优先于部门');
    // 部门额度很大，员工特例很小 —— 应该按员工特例拦截，而不是部门
    const d1 = await mkDept('测试部-特例优先', { dailyTokens: BIG, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    const e1 = await mkEmp('测试员-小额度', d1.id, {
      enabled: true, dailyTokens: 900, monthlyTokens: null, rpm: null, concurrency: null,
      countAgainstDept: true, note: '测试',
    });

    const err1 = await callUntilBlocked(e1.key);
    check('小额度员工被拦截', !!err1 && err1.type === 'quota_exceeded', JSON.stringify(err1));
    check('拦截维度是 dailyTokens', err1?.dimension === 'dailyTokens', err1?.dimension);
    check('拦截来源是 employee（员工特例生效）', err1?.scope === 'employee', err1?.scope);

    // 同一部门下的另一个员工没有特例，应该继续能用（说明拦截的是个人而非部门）
    const e1b = await mkEmp('测试员-无特例', d1.id, null);
    const r1b = await req('/v1/chat/completions', {
      method: 'POST', token: e1b.key,
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '我还能用吗' }] },
    });
    check('同部门无特例员工不受影响', r1b.status === 200, `HTTP ${r1b.status}`);

    // ============================================================
    section('② 特例额度可以比部门更宽松（覆盖为更大的值）');
    const d2 = await mkDept('测试部-宽松', { dailyTokens: 600, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    const e2 = await mkEmp('测试员-大额度', d2.id, {
      enabled: true, dailyTokens: 5_000_000, monthlyTokens: null, rpm: null, concurrency: null,
      countAgainstDept: true, note: '测试',
    });
    const r2 = await req('/v1/chat/completions', {
      method: 'POST', token: e2.key,
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '额度够用吗' }] },
    });
    check('员工特例放宽后可以正常调用', r2.status === 200, `HTTP ${r2.status} ${JSON.stringify(r2.data)}`);

    const snap2 = await req(`/api/employees/${e2.id}/quota`, { token: T });
    check('生效日额度取自员工特例',
      snap2.data.fields.dailyTokens.limit === 5_000_000 &&
      snap2.data.fields.dailyTokens.source === 'employee',
      JSON.stringify(snap2.data.fields.dailyTokens));

    // ============================================================
    section('③ 独立额度：不占用部门池');
    const d3 = await mkDept('测试部-独立额度', { dailyTokens: 400, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    const e3 = await mkEmp('测试员-独立', d3.id, {
      enabled: true, dailyTokens: 10_000_000, monthlyTokens: null, rpm: null, concurrency: null,
      countAgainstDept: false, note: '独立核算',
    });

    const before3 = (await getDept(d3.id)).usage.dayTokens;
    for (let i = 0; i < 8; i++) {
      await req('/v1/chat/completions', {
        method: 'POST', token: e3.key,
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '独立额度测试' + i }] },
      });
    }
    const after3Dept = (await getDept(d3.id)).usage.dayTokens;
    const after3Emp = (await getEmp(e3.id)).quotaSnapshot.usage.dayTokens;

    check('员工个人用量已产生', after3Emp > 0, String(after3Emp));
    check('部门池用量保持为 0（未占用）', after3Dept === before3, `部门 ${before3} → ${after3Dept}`);
    check('员工用量已超过部门额度 400 仍能用', after3Emp > 400, String(after3Emp));

    // ============================================================
    section('④ 占用部门池时，部门额度是第二道约束');
    const d4 = await mkDept('测试部-双重约束', { dailyTokens: 500, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    const e4 = await mkEmp('测试员-占池', d4.id, {
      enabled: true, dailyTokens: 10_000_000, monthlyTokens: null, rpm: null, concurrency: null,
      countAgainstDept: true, note: '个人额度大，但占部门池',
    });
    const err4 = await callUntilBlocked(e4.key);
    check('个人额度充足时被部门池拦截', !!err4 && err4.type === 'quota_exceeded', JSON.stringify(err4));
    check('拦截维度是 deptDailyTokens', err4?.dimension === 'deptDailyTokens', err4?.dimension);
    check('拦截来源是 department', err4?.scope === 'department', err4?.scope);

    // ============================================================
    section('⑤ 特例过期后自动回落到部门额度');
    const d5 = await mkDept('测试部-过期', { dailyTokens: BIG, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const e5 = await mkEmp('测试员-过期特例', d5.id, {
      enabled: true, dailyTokens: 1, monthlyTokens: null, rpm: null, concurrency: null,
      countAgainstDept: true, expiresAt: yesterday, note: '已过期',
    });
    const snap5 = await req(`/api/employees/${e5.id}/quota`, { token: T });
    check('过期特例被标记', snap5.data.overrideExpired === true, String(snap5.data.overrideExpired));
    check('过期后日额度回落到部门值',
      snap5.data.fields.dailyTokens.limit === BIG &&
      snap5.data.fields.dailyTokens.source === 'department',
      JSON.stringify(snap5.data.fields.dailyTokens));

    const r5 = await req('/v1/chat/completions', {
      method: 'POST', token: e5.key,
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '过期后还能用吗' }] },
    });
    check('过期特例不再拦截请求', r5.status === 200, `HTTP ${r5.status}`);

    // ============================================================
    section('⑥ 逐字段继承：只覆盖一个维度，其余继承部门');
    const d6 = await mkDept('测试部-逐字段', { dailyTokens: 12345, monthlyTokens: 67890, rpm: 77, concurrency: 9 });
    const e6 = await mkEmp('测试员-只改RPM', d6.id, {
      enabled: true, dailyTokens: null, monthlyTokens: null, rpm: 5, concurrency: null,
      countAgainstDept: true, note: '只覆盖 RPM',
    });
    const snap6 = (await req(`/api/employees/${e6.id}/quota`, { token: T })).data.fields;
    check('RPM 用员工特例', snap6.rpm.limit === 5 && snap6.rpm.source === 'employee', JSON.stringify(snap6.rpm));
    check('日额度继承部门', snap6.dailyTokens.limit === 12345 && snap6.dailyTokens.source === 'department', JSON.stringify(snap6.dailyTokens));
    check('月额度继承部门', snap6.monthlyTokens.limit === 67890 && snap6.monthlyTokens.source === 'department', JSON.stringify(snap6.monthlyTokens));
    check('并发继承部门', snap6.concurrency.limit === 9 && snap6.concurrency.source === 'department', JSON.stringify(snap6.concurrency));

    // ============================================================
    section('⑦ RPM 限流');
    const d7 = await mkDept('测试部-RPM', { dailyTokens: BIG, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    const e7 = await mkEmp('测试员-RPM', d7.id, {
      enabled: true, dailyTokens: 50_000_000, monthlyTokens: null, rpm: 3, concurrency: null,
      countAgainstDept: true, note: 'RPM 3',
    });
    let blockedRpm = null;
    for (let i = 0; i < 8; i++) {
      const r = await req('/v1/chat/completions', {
        method: 'POST', token: e7.key,
        body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: '快速请求' + i }] },
      });
      if (r.status === 429) { blockedRpm = r.data.error; break; }
    }
    check('超过 RPM 后被拦截', !!blockedRpm, JSON.stringify(blockedRpm));
    check('拦截维度是 rpm', blockedRpm?.dimension === 'rpm', blockedRpm?.dimension);

    // ============================================================
    section('⑧ 虚拟密钥与账号状态');
    const bad = await req('/v1/chat/completions', {
      method: 'POST', token: 'sk-ai-not-a-real-key',
      body: { model: 'gpt-4o-mini', messages: [] },
    });
    check('无效密钥返回 401', bad.status === 401, `HTTP ${bad.status}`);

    const noKey = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [] }),
    });
    check('缺少密钥返回 401', noKey.status === 401, `HTTP ${noKey.status}`);

    await req(`/api/employees/${e1b.id}`, { method: 'PUT', token: T, body: { status: 'disabled' } });
    const disabled = await req('/v1/chat/completions', {
      method: 'POST', token: e1b.key,
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
    check('停用员工返回 403', disabled.status === 403, `HTTP ${disabled.status}`);

    // ============================================================
    section('⑨ 拦截请求会写入审计日志');
    const logs = await req('/api/logs?status=rejected&limit=50', { token: T });
    check('存在 rejected 状态的日志', logs.data.items.length > 0, `共 ${logs.data.items?.length} 条`);
    const sample = logs.data.items?.[0];
    check('日志带拦截原因', !!(sample && sample.error), sample?.error);
    check('日志记录了对应员工', !!(sample && sample.employeeName && sample.employeeName !== '（已删除）'), sample?.employeeName);

    // ============================================================
    section('⑩ 用量确实记账');
    const ov = await req('/api/overview', { token: T });
    check('概览能读到今日用量', ov.data.today.tokens > 0, String(ov.data.today.tokens));
    check('概览能读到请求数', ov.data.today.reqs > 0, String(ov.data.today.reqs));
    check('趋势数据有 7 天', ov.data.trend.length === 7, String(ov.data.trend.length));

    // ============================================================
    section('⑪ 真实上游转发（非流式）');
    const mkProvider = async (name, baseUrl, weight, models) => {
      const r = await req('/api/providers', {
        method: 'POST', token: T,
        body: { name, baseUrl, apiKey: 'sk-fake-upstream-key', models, weight, timeoutMs: 8000, status: 'active' },
      });
      if (!r.data.id) throw new Error('建渠道失败：' + JSON.stringify(r.data));
      return r.data;
    };

    const pOK = await mkProvider('假上游-正常', 'http://127.0.0.1:8798', 1, ['fake-model']);
    const d11 = await mkDept('测试部-转发', { dailyTokens: BIG, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    const e11 = await mkEmp('测试员-转发', d11.id, null);

    const r11 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '转发测试' }] },
    });
    check('请求被转发到真实上游', r11.status === 200 && r11.data.choices?.[0]?.message?.content?.includes('OK 渠道'),
      JSON.stringify(r11.data).slice(0, 200));
    check('上游返回的 usage 被透传', r11.data.usage?.total_tokens === 333, JSON.stringify(r11.data.usage));

    const log11 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    check('日志记录了真实 token 数（333）', log11.data.items[0]?.totalTokens === 333, String(log11.data.items[0]?.totalTokens));
    check('日志记录了渠道 id', log11.data.items[0]?.providerId === pOK.id, String(log11.data.items[0]?.providerId));

    // ============================================================
    section('⑫ 真实上游转发（流式）');
    const streamRes = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + e11.key },
      body: JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: '流式' }] }),
    });
    const streamText = await streamRes.text();
    check('流式响应状态 200', streamRes.status === 200, String(streamRes.status));
    check('流式内容被逐块透传', streamText.includes('来自') && streamText.includes('[DONE]'), streamText.slice(0, 200));
    check('流式结束时带 usage', streamText.includes('"total_tokens":33'), streamText.slice(-200));

    // ============================================================
    section('⑬ 渠道故障自动切换');
    // 坏渠道权重更高，大概率被先选中，必须能自动落到好渠道
    await mkProvider('假上游-故障', 'http://127.0.0.1:8797', 9, ['fake-model']);

    let okCount = 0;
    for (let i = 0; i < 9; i++) {
      const r = await req('/v1/chat/completions', {
        method: 'POST', token: e11.key,
        body: { model: 'fake-model', messages: [{ role: 'user', content: '切换测试' + i }] },
      });
      if (r.status === 200) okCount++;
    }
    check('故障渠道存在时请求仍全部成功（自动切换）', okCount === 9, `${okCount}/9 成功`);

    // 把正常渠道停用，只剩坏渠道 → 应该明确报错而不是静默成功
    await req(`/api/providers/${pOK.id}`, { method: 'PUT', token: T, body: { status: 'disabled' } });
    const r13 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '全都坏了' }] },
    });
    check('所有渠道都失败时返回 502', r13.status === 502, `HTTP ${r13.status} ${JSON.stringify(r13.data).slice(0, 160)}`);

    // ================= 模型权限控制 =================
    const d14 = await mkDept('测试部-模型白名单', { dailyTokens: BIG, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    // 部门策略：只允许 gpt-4o* 和 deepseek-chat
    const put14 = await req(`/api/departments/${d14.id}`, {
      method: 'PUT', token: T,
      body: { allowedModels: ['gpt-4o*', 'deepseek-chat'] },
    });
    check('部门模型白名单可保存', Array.isArray(put14.data.allowedModels) && put14.data.allowedModels.length === 2, JSON.stringify(put14.data.allowedModels));

    const e14 = await mkEmp('测试员-模型继承', d14.id, null);
    const r14a = await req('/v1/chat/completions', {
      method: 'POST', token: e14.key,
      body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] },
    });
    check('白名单内（通配 gpt-4o*）可调用', r14a.status === 200, `HTTP ${r14a.status}`);

    const r14b = await req('/v1/chat/completions', {
      method: 'POST', token: e14.key,
      body: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] },
    });
    check('白名单外模型返回 403', r14b.status === 403, `HTTP ${r14b.status}`);
    check('错误码是 model_not_allowed', r14b.data.error?.code === 'model_not_allowed', r14b.data.error?.code);

    // 员工特例覆盖部门策略
    const e14b = await mkEmp('测试员-模型特例', d14.id, { enabled: true, allowedModels: ['claude-3-5-sonnet'] });
    const r14c = await req('/v1/chat/completions', {
      method: 'POST', token: e14b.key,
      body: { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] },
    });
    check('员工特例覆盖部门白名单后可调用', r14c.status === 200, `HTTP ${r14c.status} ${JSON.stringify(r14c.data).slice(0, 120)}`);
    const snap14 = await req(`/api/employees/${e14b.id}/quota`, { token: T });
    check('详情展示模型策略来源为员工', snap14.data.models?.source === 'employee', JSON.stringify(snap14.data.models));

    // ================= 成本核算 =================
    // 上一个用例把正常渠道停用了，先恢复
    await req(`/api/providers/${pOK.id}`, { method: 'PUT', token: T, body: { status: 'active' } });
    const pricingPut = await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'fake-model': { in: 10, out: 40 } } },
    });
    check('模型单价可保存', pricingPut.status === 200, JSON.stringify(pricingPut.data));

    // 走真实假上游：333 tokens（111 入 + 222 出）→ (111*10 + 222*40)/1e6 = 0.00999
    const r15 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '成本核算' }] },
    });
    check('定价模型可正常调用', r15.status === 200, `HTTP ${r15.status}`);
    const log15 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const cost15 = log15.data.items[0]?.cost;
    check('日志记录了成本', Math.abs(cost15 - 0.00999) < 1e-9, String(cost15));

    const ov15 = await req('/api/overview', { token: T });
    check('概览带今日成本字段', typeof ov15.data.today?.cost === 'number', String(ov15.data.today?.cost));
    check('概览今日成本大于 0', ov15.data.today.cost > 0, String(ov15.data.today.cost));
    check('模型成本排行包含 fake-model', (ov15.data.modelRank || []).some((m) => m.model === 'fake-model'), JSON.stringify((ov15.data.modelRank || []).map((m) => m.model)));
    check('趋势数据带成本', typeof ov15.data.trend?.[6]?.cost === 'number', JSON.stringify(ov15.data.trend?.[6]));

    // ================= 用量告警（无 webhook 时安全降级） =================
    const testHook = await req('/api/settings/test-webhook', {
      method: 'POST', token: T,
      body: { webhookUrl: '' },
    });
    check('未配置 webhook 时测试返回 400', testHook.status === 400, `HTTP ${testHook.status}`);
    const badHook = await req('/api/settings/test-webhook', {
      method: 'POST', token: T,
      body: { webhookUrl: 'http://127.0.0.1:1/hook' },
    });
    check('不可达 webhook 返回 ok:false', badHook.status === 200 && badHook.data.ok === false, JSON.stringify(badHook.data));

    // ================= 分时定价（高峰/空闲）与缓存命中计价 =================
    // 假上游 usage 固定：prompt 111（缓存命中 5 + 缓存写入 6）/ completion 222
    const bj = new Date(Date.now() + 8 * 3600 * 1000);
    const bjMinNow = bj.getUTCHours() * 60 + bj.getUTCMinutes();
    const bjDate = bj.toISOString().slice(0, 10);
    const bjDow = bj.getUTCDay();
    const hm = (min) => {
      const t = ((min % 1440) + 1440) % 1440;
      return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    };
    const PEAK_PRICING = { in: 10, out: 40, cacheIn: 2, cacheWrite: 4, idle: { in: 5, out: 20, cacheIn: 1 } };
    await req('/api/pricing', { method: 'PUT', token: T, body: { pricing: { 'fake-model': PEAK_PRICING } } });
    // 高峰窗口覆盖当前时刻，且今天在高峰日内
    const peakWin = { enabled: true, days: [bjDow], windows: [[hm(bjMinNow - 15), hm(bjMinNow + 15)]], holidays: [] };
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: peakWin } });

    // 1) 高峰时段 → 按输入/输出价 + 缓存命中/写入价核算
    const r16 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '高峰核算' }] },
    });
    check('高峰时段内可正常调用', r16.status === 200, `HTTP ${r16.status}`);
    const log16 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const item16 = log16.data.items[0] || {};
    const exp16 = ((111 - 5 - 6) * 10 + 5 * 2 + 6 * 4 + 222 * 40) / 1e6; // 100*10 + 5*2 + 6*4 + 222*40
    check('高峰时段按高峰单价 + 缓存命中/写入价核算', Math.abs(item16.cost - exp16) < 1e-9, `cost=${item16.cost} 期望=${exp16}`);
    check('日志记录了缓存命中 tokens（5）', item16.cacheTokens === 5, String(item16.cacheTokens));
    check('日志记录了缓存写入 tokens（6）', item16.cacheWriteTokens === 6, String(item16.cacheWriteTokens));

    // 2) 今天标记为法定节假日 → 全天按空闲时段价（DeepSeek 官方规则）
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: { ...peakWin, holidays: [bjDate] } } });
    const r17 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '节假日核算' }] },
    });
    check('节假日全天可正常调用', r17.status === 200, `HTTP ${r17.status}`);
    const log17 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const item17 = log17.data.items[0] || {};
    const exp17 = ((111 - 5 - 6) * 5 + 5 * 1 + 6 * 4 + 222 * 20) / 1e6; // 空闲价；cacheWrite 未在 idle 配置，沿用顶层 4
    check('节假日全天按空闲时段单价核算', Math.abs(item17.cost - exp17) < 1e-9, `cost=${item17.cost} 期望=${exp17}`);

    // 3) 高峰日移除今天 → 同样回到空闲价（周末/非高峰日规则）
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: { ...peakWin, holidays: [], days: [(bjDow + 1) % 7] } } });
    const log18 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    check('非高峰日按空闲时段单价核算', log18.data.items[0]?.cost === item17.cost, `cost=${log18.data.items[0]?.cost}`);

    // 4) 分档计价优先于分时（Qwen 阶梯 / Gemini 长上下文）
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: peakWin } }); // 恢复高峰窗口
    await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'fake-model': { ...PEAK_PRICING, tiers: [{ upTo: 1000, in: 5, out: 20, cacheIn: 1, cacheWrite: 0 }] } } },
    });
    const r19 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '分档核算' }] },
    });
    check('分档模型可正常调用', r19.status === 200, `HTTP ${r19.status}`);
    const log19 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const item19 = log19.data.items[0] || {};
    const exp19 = ((111 - 5 - 6) * 5 + 5 * 1 + 6 * 0 + 222 * 20) / 1e6; // 输入 111 落入 upTo:1000 档
    check('输入长度落档时按档内单价核算（优先于分时）', Math.abs(item19.cost - exp19) < 1e-9, `cost=${item19.cost} 期望=${exp19}`);

    // 5) 超出最后一档回落基础价
    await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'fake-model': { ...PEAK_PRICING, tiers: [{ upTo: 100, in: 5, out: 20 }] } } },
    });
    const r20 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '超档核算' }] },
    });
    check('超档模型可正常调用', r20.status === 200, `HTTP ${r20.status}`);
    const log20 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    check('输入超出所有档时回落基础单价', Math.abs(log20.data.items[0]?.cost - exp16) < 1e-9, `cost=${log20.data.items[0]?.cost} 期望=${exp16}`);

    // 6) 设置持久化与单价接口回显
    const st20 = await req('/api/settings', { token: T });
    check('高峰时段规则可保存', st20.data.peak && st20.data.peak.enabled === true && Array.isArray(st20.data.peak.windows) && st20.data.peak.windows.length === 1, JSON.stringify(st20.data.peak));
    const prGet = await req('/api/pricing', { token: T });
    check('单价接口返回实时时段状态与空闲/分档配置', typeof prGet.data.nowPeak === 'boolean' && typeof prGet.data.nowIdle === 'boolean' && prGet.data.hasIdlePricing === true, JSON.stringify({ nowPeak: prGet.data.nowPeak, nowIdle: prGet.data.nowIdle, hasIdlePricing: prGet.data.hasIdlePricing }));
    check('单价接口带出缓存与分档字段', prGet.data.items['fake-model']?.cacheWrite === 4 && Array.isArray(prGet.data.items['fake-model']?.tiers) && prGet.data.items['fake-model']?.tiers?.[0]?.upTo === 100, JSON.stringify(prGet.data.items['fake-model']));

    // 7) 空闲时段单独配置缓存命中/写入价（DeepSeek 空闲缓存价远低于峰时价）
    const IDLE_CACHE_PRICING = { in: 2, out: 8, cacheIn: 0.04, cacheWrite: 0.1, idle: { in: 1, out: 4, cacheIn: 0.02, cacheWrite: 0.05 } };
    await req('/api/pricing', { method: 'PUT', token: T, body: { pricing: { 'fake-model': IDLE_CACHE_PRICING } } });
    const prIdle = await req('/api/pricing', { token: T });
    const eIdle = prIdle.data.items['fake-model'] || {};
    check('空闲时段的缓存命中/写入价可保存并回显',
      eIdle.idle?.cacheIn === 0.02 && eIdle.idle?.cacheWrite === 0.05 && eIdle.idle?.in === 1 && eIdle.idle?.out === 4,
      JSON.stringify(eIdle.idle));
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: { ...peakWin, holidays: [bjDate] } } });
    const r21 = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '空闲缓存价核算' }] },
    });
    check('空闲时段请求可正常调用', r21.status === 200, `HTTP ${r21.status}`);
    const log21 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const exp21 = ((111 - 5 - 6) * 1 + 5 * 0.02 + 6 * 0.05 + 222 * 4) / 1e6; // 100*空闲输入 + 5*空闲缓存命中 + 6*空闲缓存写入 + 222*空闲输出
    check('空闲时段按空闲缓存命中/写入价核算', Math.abs(log21.data.items[0]?.cost - exp21) < 1e-9,
      `cost=${log21.data.items[0]?.cost} 期望=${exp21}`);

    // 收尾：关闭分时，避免影响其他用例
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: { ...peakWin, enabled: false } } });

    // ================= 内置官方参考价 =================
    const prPreset = await req('/api/pricing', { token: T });
    check('单价接口带出官方参考价摘要', prPreset.data.presets?.total >= 25 && Array.isArray(prPreset.data.presets.providers) && prPreset.data.presets.providers.length >= 7,
      JSON.stringify({ total: prPreset.data.presets?.total, providers: prPreset.data.presets?.providers?.length }));

    // 清空单价后载入 → 全部按参考价补齐
    await req('/api/pricing', { method: 'PUT', token: T, body: { pricing: { 'fake-model': { in: 10, out: 40 } } } });
    const loadPresets = await req('/api/pricing/presets', { method: 'POST', token: T, body: { overwrite: true } });
    check('载入官方参考价成功', loadPresets.status === 200 && loadPresets.data.added >= 25, JSON.stringify(loadPresets.data));

    const prAfter = await req('/api/pricing', { token: T });
    const items = prAfter.data.items || {};
    check('DeepSeek 参考价含空闲时段价', items['deepseek-flash']?.in === 2 && items['deepseek-flash']?.idle?.in === 1, JSON.stringify(items['deepseek-flash']));
    check('Claude 参考价含缓存写入价', (items['claude-sonnet-5-5']?.cacheWrite || 0) > 0, JSON.stringify(items['claude-sonnet-5-5']));
    check('Qwen 参考价含输入长度分档', Array.isArray(items['qwen3.7-plus']?.tiers) && items['qwen3.7-plus'].tiers.length === 2, JSON.stringify(items['qwen3.7-plus']));
    check('自定义模型未被参考价影响', items['fake-model']?.in === 10, JSON.stringify(items['fake-model']));

    // 不覆盖模式：自定义价保持不变
    await req('/api/pricing', { method: 'PUT', token: T, body: { pricing: { 'gpt-5-mini': { in: 999, out: 999 } } } });
    const noOverwrite = await req('/api/pricing/presets', { method: 'POST', token: T, body: { overwrite: false } });
    const prKeep = await req('/api/pricing', { token: T });
    check('overwrite=false 时保留自定义单价', noOverwrite.data.updated === 0 && prKeep.data.items['gpt-5-mini']?.in === 999, JSON.stringify({ res: noOverwrite.data, price: prKeep.data.items['gpt-5-mini'] }));

    // 按厂商选择性载入
    await req('/api/pricing', { method: 'PUT', token: T, body: { pricing: {} } });
    const onlyKimi = await req('/api/pricing/presets', { method: 'POST', token: T, body: { providers: ['kimi'], overwrite: true } });
    const prKimi = await req('/api/pricing', { token: T });
    check('可按厂商选择性载入参考价', onlyKimi.data.added === 3 && prKimi.data.items['kimi-k3.1-pro']?.in === 13 && !prKimi.data.items['gpt-5'], JSON.stringify(onlyKimi.data));

    // ============================================================
    section('⑭ 调用日志留存输入输出与其它上下文');
    await req('/api/settings', { method: 'PUT', token: T, body: { logContent: 'summary', logContentMax: 2000 } });
    const rLog = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: {
        model: 'fake-model', temperature: 0.3, max_tokens: 256,
        messages: [
          { role: 'system', content: '你是测试助手' },
          { role: 'user', content: '请把这句话润色一下，顺便 sk-ai-abcdefghijklmnop 不要泄漏' },
        ],
      },
    });
    check('日志内容用例的请求成功', rLog.status === 200, `HTTP ${rLog.status}`);

    const list1 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const l1 = list1.data.items[0] || {};
    check('日志列表带「有内容」标记', l1.hasContent === true, JSON.stringify({ hasContent: l1.hasContent }));
    check('日志列表带提问摘要', String(l1.preview || '').includes('润色'), l1.preview);

    const detail1 = await req('/api/logs/' + l1.id, { token: T });
    check('详情返回输入消息（2 条）', detail1.data.log?.request?.messages?.length === 2, JSON.stringify(detail1.data.log?.request?.messages));
    check('详情返回输出内容', String(detail1.data.log?.response?.content || '').includes('真实响应'), detail1.data.log?.response?.content);
    check('详情记录请求参数', detail1.data.log?.request?.params?.temperature === 0.3, JSON.stringify(detail1.data.log?.request?.params));
    check('详情记录渠道尝试', Array.isArray(detail1.data.attempts) && detail1.data.attempts.length >= 1, JSON.stringify(detail1.data.attempts));
    const rawDetail = JSON.stringify(detail1.data);
    check('内容里的虚拟密钥被打码', rawDetail.includes('sk-ai***') && !rawDetail.includes('sk-ai-abcdefghijklmnop'));

    await req('/api/settings', { method: 'PUT', token: T, body: { logContent: 'off' } });
    await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '关闭留存后的请求' }] },
    });
    const list2 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    check('关闭内容留存后只记用量', list2.data.items[0]?.hasContent === false, JSON.stringify({ hasContent: list2.data.items[0]?.hasContent }));
    await req('/api/settings', { method: 'PUT', token: T, body: { logContent: 'summary' } });

    // 模拟响应（没有任何渠道支持该模型）也必须把输出正文写进日志，
    // 否则「渠道全停用」的演示环境下点详情只能看到输入。
    const rMock = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'mock-only-model', messages: [{ role: 'user', content: '模拟响应也要留正文' }] },
    });
    check('无渠道支持时走内置模拟', rMock.status === 200 && !!rMock.data.choices?.[0]?.message?.content,
      JSON.stringify(rMock.data).slice(0, 120));
    const listMock = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const detailMock = await req('/api/logs/' + (listMock.data.items[0] || {}).id, { token: T });
    check('模拟响应也记录输出正文', (detailMock.data.log?.response?.content || '').length > 0,
      JSON.stringify(detailMock.data.log?.response || {}).slice(0, 120));
    check('模拟响应也记录渠道尝试（providerId=mock）',
      (detailMock.data.log?.attempts || [])[0]?.providerId === 'mock',
      JSON.stringify(detailMock.data.log?.attempts));

    // ============================================================
    section('⑮ 模型单价按模型 DIY（按次 / 倍率 / 公式 / 试算）');
    const calcBase = await req('/api/pricing/test', {
      method: 'POST', token: T,
      body: { model: 'calc-model', pricing: { in: 10, out: 40 }, prompt: 1000, completion: 500 },
    });
    check('试算基础费用正确（(1000×10+500×40)/1e6=0.03）', Math.abs(calcBase.data.detail.total - 0.03) < 1e-9, String(calcBase.data.detail.total));

    const calcDiy = await req('/api/pricing/test', {
      method: 'POST', token: T,
      body: {
        model: 'calc-model',
        pricing: { in: 10, out: 40, formula: 'base * 2 + 0.001', perCall: 0.002, multiplier: 2 },
        prompt: 1000, completion: 500,
      },
    });
    // (0.03×2 + 0.001 + 0.002) × 2 = 0.126
    check('公式 + 按次 + 倍率组合计算正确', Math.abs(calcDiy.data.detail.total - 0.126) < 1e-9,
      JSON.stringify({ total: calcDiy.data.detail.total, formula: calcDiy.data.detail.formula }));

    const badFormula = await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'calc-model': { in: 1, out: 1, formula: 'base ** 2' } } },
    });
    check('公式语法错误保存时被拒绝', badFormula.status === 400, `HTTP ${badFormula.status} ${JSON.stringify(badFormula.data)}`);

    const badMult = await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'calc-model': { in: 1, out: 1, multiplier: -1 } } },
    });
    check('负倍率保存时被拒绝', badMult.status === 400, `HTTP ${badMult.status}`);

    await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'fake-model': { in: 10, out: 40, formula: 'base * 2', perCall: 0.01, note: 'DIY 计费用例' } } },
    });
    const rDiy = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: 'DIY 计费' }] },
    });
    check('DIY 定价模型可正常调用', rDiy.status === 200, `HTTP ${rDiy.status}`);
    const logDiy = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const expDiy = ((111 * 10 + 222 * 40) / 1e6) * 2 + 0.01; // base 0.00999 → ×2 + 0.01
    check('按自定义公式与按次费用记账', Math.abs(logDiy.data.items[0]?.cost - expDiy) < 1e-9,
      `cost=${logDiy.data.items[0]?.cost} 期望=${expDiy}`);
    check('日志带成本拆解（公式与按次）', logDiy.data.items[0]?.costDetail?.formula != null && logDiy.data.items[0]?.costDetail?.perCall === 0.01,
      JSON.stringify(logDiy.data.items[0]?.costDetail));

    // ============================================================
    section('⑯ 部门 / 个人独立告警');
    await req('/api/settings', {
      method: 'PUT', token: T,
      body: {
        webhookUrl: 'http://127.0.0.1:8796/hook',
        alertsEnabled: true,
        alertThresholds: [80, 100],
        alertDimensions: ['dailyTokens'],
      },
    });

    const dAlert = await mkDept('测试部-独立告警', { dailyTokens: 500, monthlyTokens: 0, rpm: 0, concurrency: 0 });
    await req(`/api/departments/${dAlert.id}`, {
      method: 'PUT', token: T,
      body: { alert: { enabled: true, webhookUrl: 'http://127.0.0.1:8795/hook', thresholds: [1], dimensions: ['dailyTokens'] } },
    });
    const eAlert = await mkEmp('告警员-小额度', dAlert.id, {
      enabled: true, dailyTokens: 300, monthlyTokens: null, rpm: null, concurrency: null,
      countAgainstDept: true, note: '独立告警用例',
    });
    const putAlert = await req(`/api/employees/${eAlert.id}`, {
      method: 'PUT', token: T,
      body: { alert: { enabled: true, webhookUrl: 'http://127.0.0.1:8794/hook', thresholds: [1], dimensions: ['dailyTokens'] } },
    });
    check('员工告警配置可保存', putAlert.data.alert?.enabled === true && putAlert.data.alert?.thresholds?.[0] === 1,
      JSON.stringify(putAlert.data.alert));

    const rAlert = await req('/v1/chat/completions', {
      method: 'POST', token: eAlert.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '触发个人与部门告警' }] },
    });
    check('告警用例请求成功', rAlert.status === 200, `HTTP ${rAlert.status} ${JSON.stringify(rAlert.data).slice(0, 160)}`);
    await sleep(500);

    check('个人告警发到员工自己的群', hookEmp.messages.some((m) => m.includes('个人额度预警') && m.includes('告警员-小额度') && m.includes('员工专属通道')),
      JSON.stringify(hookEmp.messages));
    check('部门池告警发到部门自己的群', hookDept.messages.some((m) => m.includes('部门池预警') && m.includes('测试部-独立告警') && m.includes('部门通道')),
      JSON.stringify(hookDept.messages));
    check('全局机器人没有被误发', hookGlobal.messages.length === 0, JSON.stringify(hookGlobal.messages));

    const empCount = hookEmp.messages.length;
    const deptCount = hookDept.messages.length;
    const eAlert2 = await mkEmp('告警员-继承通道', dAlert.id, null);
    await req('/v1/chat/completions', {
      method: 'POST', token: eAlert2.key,
      body: { model: 'fake-model', messages: [{ role: 'user', content: '继承部门通道' }] },
    });
    await sleep(500);
    check('同一对象同一阈值不重复推送', hookEmp.messages.length === empCount, `员工通道 ${empCount} → ${hookEmp.messages.length}`);
    check('未单独配置的员工回落到部门通道', hookDept.messages.length > deptCount && hookDept.messages.some((m) => m.includes('告警员-继承通道')),
      `部门通道 ${deptCount} → ${hookDept.messages.length}`);

    const tAlert = await req(`/api/employees/${eAlert.id}/test-alert`, { method: 'POST', token: T, body: {} });
    check('员工告警通道可单独测试', tAlert.status === 200 && tAlert.data.ok === true, JSON.stringify(tAlert.data));
    const tDeptAlert = await req(`/api/departments/${dAlert.id}/test-alert`, { method: 'POST', token: T, body: {} });
    check('部门告警通道可单独测试', tDeptAlert.status === 200 && tDeptAlert.data.ok === true, JSON.stringify(tDeptAlert.data));

    const alertLog = await req('/api/alerts?limit=20', { token: T });
    check('告警发送记录可查询', Array.isArray(alertLog.data.items) && alertLog.data.items.length >= 3, JSON.stringify({ total: alertLog.data.total }));
    check('告警记录标明通道来源', alertLog.data.items.some((x) => x.channel === 'employee') && alertLog.data.items.some((x) => x.channel === 'department'),
      JSON.stringify(alertLog.data.items.map((x) => x.channel)));
    check('系统设置里的全局测试消息也入「最近告警」',
      alertLog.data.items.some((x) => x.target === 'global' && x.channel === 'global' && x.test === true),
      JSON.stringify(alertLog.data.items.filter((x) => x.channel === 'global').map((x) => x.target)));

    // 收尾：关掉告警，避免影响后续（当前没有后续用例，但保持环境干净）
    await req('/api/settings', { method: 'PUT', token: T, body: { webhookUrl: '', alertsEnabled: false } });

    // ============================================================
    section('⑰ 单价按模型自定义时段（时间规则与价格都由模型自己定）');
    const periodPricing = {
      in: 10, out: 40,
      idle: { in: 1, out: 1 }, // 故意同时配 idle，用来验证 periods 会覆盖它
      periods: [
        { name: '高峰', days: '1-5', windows: '09:00-12:00, 14:00-18:00', in: 20, out: 80 },
        { name: '夜间', windows: '00:00-07:00', in: 1, out: 4 },
        { name: '大促日', dates: ['2026-11-11'], in: 5, out: 10 },
      ],
    };
    const putPeriod = await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'period-model': periodPricing, 'fake-model': { in: 10, out: 40 } } },
    });
    check('自定义时段可保存', putPeriod.status === 200, `HTTP ${putPeriod.status} ${JSON.stringify(putPeriod.data)}`);

    const priceList = await req('/api/pricing', { token: T });
    const savedPeriods = priceList.data.items['period-model']?.periods;
    check('时段被归一化保存（星期 / 时间窗 / 日期）',
      Array.isArray(savedPeriods) && savedPeriods.length === 3
      && savedPeriods[0].days.join(',') === '1,2,3,4,5'
      && savedPeriods[0].windows[1].join('-') === '14:00-18:00'
      && savedPeriods[1].days.length === 7
      && savedPeriods[2].dates[0] === '2026-11-11',
      JSON.stringify(savedPeriods));

    const tp = async (at) => (await req('/api/pricing/test', {
      method: 'POST', token: T,
      body: { model: 'period-model', prompt: 1000, completion: 500, at },
    })).data.detail;

    const dPeak = await tp('2026-11-03T10:30:00+08:00');
    check('高峰时段按该段价计（周二 10:30）', dPeak.period?.name === '高峰' && Math.abs(dPeak.total - 0.06) < 1e-9,
      JSON.stringify({ period: dPeak.period, total: dPeak.total }));

    const dNight = await tp('2026-11-03T02:00:00+08:00');
    check('夜间时段按该段价计（周二 02:00）', dNight.period?.name === '夜间' && Math.abs(dNight.total - 0.003) < 1e-9,
      JSON.stringify({ period: dNight.period, total: dNight.total }));

    const dGap = await tp('2026-11-03T13:00:00+08:00');
    check('不在任何时段内回落基础价（12:00-14:00 空档）', dGap.period == null && Math.abs(dGap.total - 0.03) < 1e-9,
      JSON.stringify({ period: dGap.period, total: dGap.total }));

    const dWeekend = await tp('2026-11-07T10:30:00+08:00');
    check('星期不匹配时不套用该段（周六 10:30）', dWeekend.period == null && Math.abs(dWeekend.total - 0.03) < 1e-9,
      JSON.stringify({ period: dWeekend.period, total: dWeekend.total }));

    const dDate = await tp('2026-11-11T15:00:00+08:00');
    check('指定日期优先于按星期的段（11-11 15:00 命中「大促日」而非「高峰」）',
      dDate.period?.name === '大促日' && Math.abs(dDate.total - 0.01) < 1e-9,
      JSON.stringify({ period: dDate.period, total: dDate.total }));

    const dIdle = await tp('2026-11-03T20:00:00+08:00');
    check('配了自定义时段后不再套用 idle / 全局峰谷', dIdle.idle === false && Math.abs(dIdle.total - 0.03) < 1e-9,
      JSON.stringify({ idle: dIdle.idle, total: dIdle.total }));

    const cross = await req('/api/pricing/test', {
      method: 'POST', token: T,
      body: {
        model: 'cross-model',
        pricing: { in: 10, out: 10, periods: [{ name: '跨夜', windows: [['22:00', '06:00']], in: 5, out: 5 }] },
        prompt: 1000, completion: 500, at: '2026-11-03T02:00:00+08:00',
      },
    });
    check('跨零点时间窗可命中（22:00-06:00 的 02:00）', cross.data.detail.period?.name === '跨夜'
      && Math.abs(cross.data.detail.total - 0.0075) < 1e-9, JSON.stringify(cross.data.detail));

    const badWin = await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'bad-period': { in: 1, out: 1, periods: [{ name: '错', windows: '9-12' }] } } },
    });
    check('时段时间窗非法时保存被拒绝', badWin.status === 400, `HTTP ${badWin.status} ${JSON.stringify(badWin.data)}`);

    const noWin = await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'bad-period': { in: 1, out: 1, periods: [{ name: '空段' }] } } },
    });
    check('时段既无时间窗也无日期时保存被拒绝', noWin.status === 400, `HTTP ${noWin.status}`);

    await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { 'period-model': { in: 10, out: 40, periods: [{ name: '全天', windows: '00:00-24:00', in: 5, out: 5 }] } } },
    });
    const rPeriod = await req('/v1/chat/completions', {
      method: 'POST', token: e11.key,
      body: { model: 'period-model', messages: [{ role: 'user', content: '自定义时段记账' }] },
    });
    check('自定义时段模型可正常调用', rPeriod.status === 200, `HTTP ${rPeriod.status}`);
    const logPeriod = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const lp = logPeriod.data.items[0] || {};
    const expPeriod = ((lp.promptTokens || 0) * 5 + (lp.completionTokens || 0) * 5) / 1e6;
    check('记账按自定义时段价（00:00-24:00）', expPeriod > 0 && Math.abs(lp.cost - expPeriod) < 1e-9,
      `cost=${lp.cost} 期望=${expPeriod} tokens=${lp.promptTokens}/${lp.completionTokens}`);
    check('日志成本拆解带命中时段名', logPeriod.data.items[0]?.costDetail?.period?.name === '全天',
      JSON.stringify(logPeriod.data.items[0]?.costDetail));

    // ============================================================
    section('⑱ 全局高峰规则关闭时，旧写法 idle 不参与计价');
    const curPricing = (await req('/api/pricing', { token: T })).data.items || {};
    await req('/api/pricing', {
      method: 'PUT', token: T,
      body: { pricing: { ...curPricing, 'idle-only': { in: 10, out: 40, idle: { in: 5, out: 20 } } } },
    });
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: { ...peakWin, enabled: false } } });
    const pr18 = await req('/api/pricing', { token: T });
    check('关掉后接口返回 enabled=false', pr18.data.peak?.enabled === false, JSON.stringify(pr18.data.peak));

    const t18 = await req('/api/pricing/test', {
      method: 'POST', token: T,
      body: { model: 'idle-only', prompt: 1000, completion: 500, at: new Date().toISOString() },
    });
    check('全局规则关闭 → 只填 idle 的模型按基础价（不分时）',
      t18.data.detail.idle === false && Math.abs(t18.data.detail.total - 0.03) < 1e-9,
      JSON.stringify({ idle: t18.data.detail.idle, total: t18.data.detail.total }));

    // 打开全局规则，并把「高峰日」挪到明天 —— 此刻即为空闲时段，idle 价才生效
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: { ...peakWin, enabled: true, days: [(bjDow + 1) % 7] } } });
    const t18b = await req('/api/pricing/test', {
      method: 'POST', token: T,
      body: { model: 'idle-only', prompt: 1000, completion: 500, at: new Date().toISOString() },
    });
    check('手动打开全局规则 → 旧写法 idle 才生效',
      t18b.data.detail.idle === true && Math.abs(t18b.data.detail.total - 0.015) < 1e-9,
      JSON.stringify({ idle: t18b.data.detail.idle, total: t18b.data.detail.total }));

    // ============================================================
    section('⑲ 流式用量：自动向上游索取真实 usage');
    const streamOnce = async (extra = {}) => {
      const r = await fetch(BASE + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + e11.key },
        body: JSON.stringify({ model: 'fake-model', stream: true, messages: [{ role: 'user', content: '流式用量' }], ...extra }),
      });
      return r.text();
    };

    await streamOnce();
    check('流式请求自动补 stream_options.include_usage',
      upstreamOK.lastBody?.stream_options?.include_usage === true,
      JSON.stringify(upstreamOK.lastBody?.stream_options));

    const lg19 = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    const it19 = lg19.data.items[0] || {};
    check('流式记账用上游真实 token（11/22/33）',
      it19.promptTokens === 11 && it19.completionTokens === 22 && it19.totalTokens === 33,
      JSON.stringify({ p: it19.promptTokens, c: it19.completionTokens, t: it19.totalTokens }));
    check('日志标记 usageSource=上游（不再是估算值）', it19.usageSource === 'upstream', it19.usageSource);
    check('嵌套的 prompt_tokens_details.cached_tokens 能解析',
      it19.cacheTokens === 3, String(it19.cacheTokens));

    await streamOnce({ stream_options: { include_usage: false } });
    check('客户端自己设了 stream_options 就不覆盖',
      upstreamOK.lastBody?.stream_options?.include_usage === false,
      JSON.stringify(upstreamOK.lastBody?.stream_options));

    await req('/api/settings', { method: 'PUT', token: T, body: { streamUsage: false } });
    await streamOnce();
    check('关掉开关后不再注入 stream_options',
      upstreamOK.lastBody?.stream_options === undefined,
      JSON.stringify(upstreamOK.lastBody?.stream_options));
    const lg19b = await req('/api/logs?employeeId=' + e11.id + '&limit=1', { token: T });
    check('关掉开关后依然能兜底记账（totalTokens > 0）',
      lg19b.data.items[0]?.totalTokens > 0, String(lg19b.data.items[0]?.totalTokens));
    await req('/api/settings', { method: 'PUT', token: T, body: { streamUsage: true } });

    // 收尾：恢复默认（全局规则关闭），避免影响后续
    await req('/api/settings', { method: 'PUT', token: T, body: { peak: { ...peakWin, enabled: false } } });

  } catch (e) {
    fail++;
    failures.push('测试执行异常：' + e.message);
    console.error('\n\x1b[31m测试异常：\x1b[0m', e.message);
    if (serverErr) console.error('服务端错误输出：\n' + serverErr.slice(0, 2000));
  } finally {
    proc.kill('SIGKILL');
    upstreamOK.close();
    upstreamBad.close();
    hookGlobal.server.close();
    hookDept.server.close();
    hookEmp.server.close();
    await sleep(200);
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n' + '─'.repeat(52));
  if (fail === 0) {
    console.log(`\x1b[32m全部通过：${pass} 项检查\x1b[0m`);
  } else {
    console.log(`\x1b[31m${fail} 项失败\x1b[0m / 通过 ${pass} 项`);
    failures.forEach((f) => console.log('  · ' + f));
  }
  console.log('─'.repeat(52) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();

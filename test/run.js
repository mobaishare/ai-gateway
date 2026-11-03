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

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const id = 'chatcmpl-fake-' + tag;
        const chunks = ['来自', tag, '渠道', '的', '流式', '响应'];
        let i = 0;
        const tick = setInterval(() => {
          if (i >= chunks.length) {
            clearInterval(tick);
            res.write(`data: ${JSON.stringify({
              id, object: 'chat.completion.chunk', model: body.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33, prompt_cache_hit_tokens: 2 },
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

  try {
    await waitReady();

    // 登录
    const login = await req('/api/login', {
      method: 'POST',
      body: { username: 'admin', password: 'admin123' },
    });
    const T = login.data.token;
    if (!T) throw new Error('登录失败：' + JSON.stringify(login.data));

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

  } catch (e) {
    fail++;
    failures.push('测试执行异常：' + e.message);
    console.error('\n\x1b[31m测试异常：\x1b[0m', e.message);
    if (serverErr) console.error('服务端错误输出：\n' + serverErr.slice(0, 2000));
  } finally {
    proc.kill('SIGKILL');
    upstreamOK.close();
    upstreamBad.close();
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

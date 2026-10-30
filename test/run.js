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
              usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
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
        usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
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

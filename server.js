'use strict';

/**
 * AI API 分流平台 —— 服务入口
 *
 * 三条主线：
 *   1. 管理端 API  /api/*      （需要管理员令牌）
 *   2. 网关接口    /v1/*       （需要员工虚拟 key，OpenAI 兼容）
 *   3. 静态管理台  /           （public/ 下的单页应用）
 *
 * 零外部依赖，node server.js 直接启动。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/store');
const quota = require('./lib/quota');
const proxy = require('./lib/proxy');
const plugins = require('./lib/plugins');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------- 启动准备

const db = store.load();

// 首次启动补一个签名密钥，用于签发管理员令牌
if (!db.settings.secret) {
  db.settings.secret = crypto.randomBytes(32).toString('hex');
}

// 空库时灌一份演示数据，方便一打开就能看到界面效果。
// settings.seeded 用来防止「清空业务数据」后重启又把演示数据灌回来。
if (!db.settings.seeded && db.departments.length === 0 && db.employees.length === 0) {
  require('./lib/seed').seed(db);
  db.settings.seeded = true;
  store.saveNow();
  console.log('[init] 已生成演示数据');
}

// 计数器依赖聚合表，必须放在 seed 之后重建
store.rebuildCounters();

// ---------------------------------------------------------------- 工具函数

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, message, extra = {}) {
  json(res, status, { error: { message, ...extra } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' })); }
    });
    req.on('error', reject);
  });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// ---------------------------------------------------------------- 管理员令牌

function signToken(user) {
  const exp = Date.now() + 12 * 3600 * 1000;
  const payload = `${user}|${exp}`;
  const sig = crypto.createHmac('sha256', db.settings.secret).update(payload).digest('hex').slice(0, 32);
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [b64, sig] = token.split('.');
  let payload;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expect = crypto.createHmac('sha256', db.settings.secret).update(payload).digest('hex').slice(0, 32);
  // 定长比较，避免时序侧信道
  const a = Buffer.from(sig || '');
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [user, exp] = payload.split('|');
  if (Number(exp) < Date.now()) return null;
  return { user };
}

function requireAdmin(req, res) {
  const info = verifyToken(bearer(req));
  if (!info) {
    fail(res, 401, '未登录或登录已过期');
    return null;
  }
  return info;
}

// ---------------------------------------------------------------- 业务辅助

function deptWithStats(dept) {
  const emps = db.employees.filter((e) => e.deptId === dept.id);
  const u = store.getDeptUsage(dept.id);
  const daily = quota.num(dept.quota?.dailyTokens) || 0;
  const monthly = quota.num(dept.quota?.monthlyTokens) || 0;
  return {
    ...dept,
    employeeCount: emps.length,
    activeEmployeeCount: emps.filter((e) => e.status === 'active').length,
    usage: u,
    percentDaily: daily > 0 ? Math.min(100, Math.round((u.dayTokens / daily) * 1000) / 10) : 0,
    percentMonthly: monthly > 0 ? Math.min(100, Math.round((u.monthTokens / monthly) * 1000) / 10) : 0,
  };
}

function empWithQuota(emp) {
  const dept = emp.deptId ? store.findDept(emp.deptId) : null;
  const snap = quota.snapshot(emp, dept);
  return {
    ...emp,
    deptName: dept ? dept.name : '—',
    quotaSnapshot: snap,
  };
}

function sanitizeDept(input, existing) {
  const q = input.quota || {};
  const pick = (f) => (quota.num(q[f]) === null ? 0 : quota.num(q[f]));
  return {
    id: existing?.id || store.uid(),
    name: String(input.name || '').trim(),
    remark: String(input.remark || '').trim(),
    quota: {
      dailyTokens: pick('dailyTokens'),
      monthlyTokens: pick('monthlyTokens'),
      rpm: pick('rpm'),
      concurrency: pick('concurrency'),
    },
    providerIds: Array.isArray(input.providerIds) ? input.providerIds.filter(Boolean) : [],
    status: input.status === 'disabled' ? 'disabled' : 'active',
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeEmployee(input, existing) {
  const ov = input.override || {};
  const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : quota.num(v));
  const override = {
    enabled: !!ov.enabled,
    dailyTokens: numOrNull(ov.dailyTokens),
    monthlyTokens: numOrNull(ov.monthlyTokens),
    rpm: numOrNull(ov.rpm),
    concurrency: numOrNull(ov.concurrency),
    // 默认 true：个人上限之外仍然占用部门池
    countAgainstDept: ov.countAgainstDept !== false,
    expiresAt: ov.expiresAt ? String(ov.expiresAt) : '',
    note: String(ov.note || '').trim(),
  };
  return {
    id: existing?.id || store.uid(),
    name: String(input.name || '').trim(),
    email: String(input.email || '').trim(),
    deptId: String(input.deptId || ''),
    key: existing?.key || store.genKey(),
    status: input.status === 'disabled' ? 'disabled' : 'active',
    override,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function sanitizeProvider(input, existing) {
  return {
    id: existing?.id || store.uid(),
    name: String(input.name || '').trim(),
    baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(input.apiKey || '').trim(),
    models: Array.isArray(input.models)
      ? input.models.map((m) => String(m).trim()).filter(Boolean)
      : String(input.models || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
    weight: Math.max(1, Number(input.weight) || 1),
    timeoutMs: Math.max(1000, Number(input.timeoutMs) || 120000),
    status: input.status === 'disabled' ? 'disabled' : 'active',
    remark: String(input.remark || '').trim(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 概览统计

function overview() {
  const today = store.dayKey();
  const bucket = db.stats.daily[today] || { emp: {}, dept: {} };

  let todayTokens = 0, todayReqs = 0;
  for (const v of Object.values(bucket.emp || {})) { todayTokens += v.t || 0; todayReqs += v.r || 0; }

  let monthTokens = 0, monthReqs = 0;
  for (const [dk, b] of Object.entries(db.stats.daily || {})) {
    if (!dk.startsWith(store.monthKey())) continue;
    for (const v of Object.values(b.emp || {})) { monthTokens += v.t || 0; monthReqs += v.r || 0; }
  }

  const deptRank = db.departments.map((d) => {
    const u = store.getDeptUsage(d.id);
    return {
      id: d.id, name: d.name, dayTokens: u.dayTokens, monthTokens: u.monthTokens,
      dailyLimit: quota.num(d.quota?.dailyTokens) || 0,
      monthlyLimit: quota.num(d.quota?.monthlyTokens) || 0,
      percentDaily: quota.num(d.quota?.dailyTokens) ? Math.min(100, Math.round((u.dayTokens / quota.num(d.quota.dailyTokens)) * 1000) / 10) : 0,
      employeeCount: db.employees.filter((e) => e.deptId === d.id).length,
    };
  }).sort((a, b) => b.dayTokens - a.dayTokens);

  const empRank = db.employees.map((e) => {
    const u = store.getEmpUsage(e.id);
    const dept = e.deptId ? store.findDept(e.deptId) : null;
    const snap = quota.snapshot(e, dept);
    const daily = snap.fields.dailyTokens;
    return {
      id: e.id, name: e.name, deptName: dept ? dept.name : '—',
      dayTokens: u.dayTokens, monthTokens: u.monthTokens,
      percent: daily.percent, limitText: daily.limitText,
      hasOverride: snap.hasOverride && snap.overrideActive,
      countAgainstDept: snap.countAgainstDept,
    };
  }).sort((a, b) => b.dayTokens - a.dayTokens);

  // 预警：员工用量 > 80%；部门用量 > 80%
  const warnings = [];
  for (const e of empRank) {
    if (e.percent >= 80) warnings.push({ type: 'employee', level: e.percent >= 100 ? 'danger' : 'warn', name: e.name, deptName: e.deptName, percent: e.percent });
  }
  for (const d of deptRank) {
    if (d.percentDaily >= 80) warnings.push({ type: 'department', level: d.percentDaily >= 100 ? 'danger' : 'warn', name: d.name, percent: d.percentDaily });
  }

  return {
    today: { tokens: todayTokens, reqs: todayReqs, date: today },
    month: { tokens: monthTokens, reqs: monthReqs, month: store.monthKey() },
    counts: {
      departments: db.departments.length,
      employees: db.employees.length,
      activeEmployees: db.employees.filter((e) => e.status === 'active').length,
      providers: db.providers.length,
      activeProviders: db.providers.filter((p) => p.status === 'active').length,
      overrides: db.employees.filter((e) => e.override && e.override.enabled).length,
    },
    deptRank,
    empRank: empRank.slice(0, 10),
    trend: store.trend7(),
    warnings: warnings.slice(0, 8),
    recent: db.usage.slice(-12).reverse(),
  };
}

// ---------------------------------------------------------------- 路由：管理端

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // —— 登录（无需令牌）
  if (p === '/api/login' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const passHash = store.sha256(body.password || '');
    if (String(body.username || '') !== db.settings.adminUser || passHash !== db.settings.adminPassHash) {
      return fail(res, 401, '用户名或密码错误');
    }
    return json(res, 200, { token: signToken(db.settings.adminUser), user: db.settings.adminUser });
  }

  // —— 以下均需登录
  const admin = requireAdmin(req, res);
  if (!admin) return;

  if (p === '/api/me' && method === 'GET') return json(res, 200, { user: admin.user });

  if (p === '/api/overview' && method === 'GET') {
    return json(res, 200, { ...overview(), settings: { platformName: db.settings.platformName, onExceed: db.settings.onExceed } });
  }

  // ---------------- 部门
  if (p === '/api/departments' && method === 'GET') {
    return json(res, 200, { items: db.departments.map(deptWithStats) });
  }
  if (p === '/api/departments' && method === 'POST') {
    const body = await readBody(req, 256 * 1024);
    if (!String(body.name || '').trim()) return fail(res, 400, '部门名称不能为空');
    if (db.departments.some((d) => d.name === String(body.name).trim())) return fail(res, 400, '部门名称已存在');
    const dept = sanitizeDept(body);
    db.departments.push(dept);
    store.save();
    return json(res, 200, deptWithStats(dept));
  }

  const deptMatch = p.match(/^\/api\/departments\/([^/]+)$/);
  if (deptMatch) {
    const dept = store.findDept(deptMatch[1]);
    if (!dept) return fail(res, 404, '部门不存在');
    if (method === 'PUT') {
      const body = await readBody(req, 256 * 1024);
      Object.assign(dept, sanitizeDept({ ...dept, ...body }, dept));
      store.save();
      return json(res, 200, deptWithStats(dept));
    }
    if (method === 'DELETE') {
      const count = db.employees.filter((e) => e.deptId === dept.id).length;
      if (count > 0) return fail(res, 400, `该部门下还有 ${count} 名员工，请先转移或删除`);
      db.departments = db.departments.filter((d) => d.id !== dept.id);
      store.save();
      return json(res, 200, { ok: true });
    }
  }

  // ---------------- 员工
  if (p === '/api/employees' && method === 'GET') {
    const items = db.employees.map(empWithQuota);
    return json(res, 200, { items });
  }
  if (p === '/api/employees' && method === 'POST') {
    const body = await readBody(req, 256 * 1024);
    if (!String(body.name || '').trim()) return fail(res, 400, '员工姓名不能为空');
    if (body.deptId && !store.findDept(body.deptId)) return fail(res, 400, '所选部门不存在');
    const emp = sanitizeEmployee(body);
    db.employees.push(emp);
    store.save();
    return json(res, 200, empWithQuota(emp));
  }

  const empAction = p.match(/^\/api\/employees\/([^/]+)\/(quota|rotate|reset-usage)$/);
  if (empAction) {
    const emp = store.findEmployee(empAction[1]);
    if (!emp) return fail(res, 404, '员工不存在');
    const action = empAction[2];
    if (action === 'quota' && method === 'GET') {
      const dept = emp.deptId ? store.findDept(emp.deptId) : null;
      return json(res, 200, quota.snapshot(emp, dept));
    }
    if (action === 'rotate' && method === 'POST') {
      emp.key = store.genKey();
      emp.updatedAt = new Date().toISOString();
      store.save();
      return json(res, 200, { key: emp.key });
    }
    if (action === 'reset-usage' && method === 'POST') {
      // 只清这个员工自己的计数。
      // 部门池的聚合值是"多人累加"的结果，无法精确回退某一个人的贡献，
      // 所以这里刻意不动部门数据，避免把同事的用量一起抹掉。
      for (const dk of Object.keys(db.stats.daily)) {
        const b = db.stats.daily[dk];
        if (b.emp) delete b.emp[emp.id];
      }
      store.rebuildCounters();
      store.save();
      return json(res, 200, { ok: true, note: '仅清空该员工用量，部门池统计保持不变' });
    }
  }

  const empMatch = p.match(/^\/api\/employees\/([^/]+)$/);
  if (empMatch) {
    const emp = store.findEmployee(empMatch[1]);
    if (!emp) return fail(res, 404, '员工不存在');
    if (method === 'PUT') {
      const body = await readBody(req, 256 * 1024);
      const merged = sanitizeEmployee({ ...emp, ...body }, emp);
      if (merged.deptId && !store.findDept(merged.deptId)) return fail(res, 400, '所选部门不存在');
      Object.assign(emp, merged, { key: emp.key }); // key 只能通过重置接口变更
      store.save();
      return json(res, 200, empWithQuota(emp));
    }
    if (method === 'DELETE') {
      db.employees = db.employees.filter((e) => e.id !== emp.id);
      store.save();
      return json(res, 200, { ok: true });
    }
  }

  // ---------------- 渠道
  if (p === '/api/providers' && method === 'GET') {
    // 返回时对密钥打码，避免前端/浏览器里出现真实 key
    const items = db.providers.map((x) => ({
      ...x,
      apiKey: x.apiKey ? x.apiKey.slice(0, 6) + '••••••' + x.apiKey.slice(-4) : '',
      hasKey: !!x.apiKey,
    }));
    return json(res, 200, { items });
  }
  if (p === '/api/providers' && method === 'POST') {
    const body = await readBody(req, 256 * 1024);
    if (!String(body.name || '').trim()) return fail(res, 400, '渠道名称不能为空');
    if (!String(body.baseUrl || '').trim()) return fail(res, 400, 'Base URL 不能为空');
    const prov = sanitizeProvider(body);
    db.providers.push(prov);
    store.save();
    return json(res, 200, { ...prov, apiKey: prov.apiKey.slice(0, 6) + '••••••' + prov.apiKey.slice(-4) });
  }

  const provProbe = p.match(/^\/api\/providers\/([^/]+)\/probe$/);
  if (provProbe && method === 'POST') {
    const prov = db.providers.find((x) => x.id === provProbe[1]);
    if (!prov) return fail(res, 404, '渠道不存在');
    const r = await proxy.probe(prov);
    return json(res, 200, r);
  }

  const provMatch = p.match(/^\/api\/providers\/([^/]+)$/);
  if (provMatch) {
    const idx = db.providers.findIndex((x) => x.id === provMatch[1]);
    if (idx < 0) return fail(res, 404, '渠道不存在');
    const prov = db.providers[idx];
    if (method === 'PUT') {
      const body = await readBody(req, 256 * 1024);
      // 前端提交打码值时不覆盖原密钥
      const incomingKey = String(body.apiKey || '');
      const keepKey = !incomingKey || incomingKey.includes('••••');
      const merged = sanitizeProvider({ ...prov, ...body }, prov);
      if (keepKey) merged.apiKey = prov.apiKey;
      db.providers[idx] = merged;
      store.save();
      return json(res, 200, { ...merged, apiKey: merged.apiKey.slice(0, 6) + '••••••' + merged.apiKey.slice(-4) });
    }
    if (method === 'DELETE') {
      db.providers.splice(idx, 1);
      store.save();
      return json(res, 200, { ok: true });
    }
  }

  // ---------------- 日志
  if (p === '/api/logs' && method === 'GET') {
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const empId = url.searchParams.get('employeeId') || '';
    const deptId = url.searchParams.get('deptId') || '';
    const status = url.searchParams.get('status') || '';
    let list = db.usage.slice().reverse();
    if (empId) list = list.filter((x) => x.employeeId === empId);
    if (deptId) list = list.filter((x) => x.deptId === deptId);
    if (status) list = list.filter((x) => x.status === status);
    const empMap = new Map(db.employees.map((e) => [e.id, e.name]));
    const deptMap = new Map(db.departments.map((d) => [d.id, d.name]));
    const provMap = new Map(db.providers.map((x) => [x.id, x.name]));
    return json(res, 200, {
      items: list.slice(0, limit).map((x) => ({
        ...x,
        employeeName: empMap.get(x.employeeId) || '（已删除）',
        deptName: deptMap.get(x.deptId) || '—',
        providerName: x.providerId === 'mock' ? '内置模拟' : (provMap.get(x.providerId) || '—'),
      })),
      total: list.length,
    });
  }

  // ---------------- 设置
  if (p === '/api/settings' && method === 'GET') {
    const { adminPassHash, secret, ...safe } = db.settings;
    void adminPassHash; void secret;
    return json(res, 200, safe);
  }
  if (p === '/api/settings' && method === 'PUT') {
    const body = await readBody(req, 64 * 1024);
    if (body.platformName) db.settings.platformName = String(body.platformName).trim();
    if (body.onExceed === 'block' || body.onExceed === 'downgrade') db.settings.onExceed = body.onExceed;
    if (body.downgradeModel) db.settings.downgradeModel = String(body.downgradeModel).trim();
    if (typeof body.mockWhenNoProvider === 'boolean') db.settings.mockWhenNoProvider = body.mockWhenNoProvider;
    store.save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/settings/password' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    if (store.sha256(body.oldPassword || '') !== db.settings.adminPassHash) return fail(res, 400, '原密码不正确');
    const np = String(body.newPassword || '');
    if (np.length < 6) return fail(res, 400, '新密码至少 6 位');
    db.settings.adminPassHash = store.sha256(np);
    store.saveNow();
    return json(res, 200, { ok: true });
  }

  // ---------------- 扩展插件（飞书 / 企业微信 / CSV 导入）
  if (p === '/api/plugins' && method === 'GET') {
    return json(res, 200, { items: plugins.list(db) });
  }

  const plugMatch = p.match(/^\/api\/plugins\/([^/]+)\/(config|test|sync)$/);
  if (plugMatch) {
    const pid = plugMatch[1];
    if (!plugins.list(db).some((x) => x.id === pid)) return fail(res, 404, '插件不存在');
    if (plugMatch[2] === 'config' && method === 'PUT') {
      const body = await readBody(req, 256 * 1024);
      plugins.saveConfig(db, pid, body.config || {});
      store.save();
      return json(res, 200, { ok: true });
    }
    if (plugMatch[2] === 'test' && method === 'POST') {
      try {
        const body = await readBody(req, 256 * 1024);
        const r = await plugins.test(db, pid, body?.config);
        return json(res, 200, r);
      } catch (e) {
        return json(res, 200, { ok: false, message: e.message });
      }
    }
    if (plugMatch[2] === 'sync' && method === 'POST') {
      const body = await readBody(req, 1024 * 1024);
      try {
        const r = await plugins.sync(db, pid, body || {});
        store.save();
        return json(res, 200, r);
      } catch (e) {
        return fail(res, 400, e.message);
      }
    }
  }

  // ---------------- 清空业务数据（保留上游渠道与设置）
  if (p === '/api/reset-data' && method === 'POST') {
    store.saveNow();
    let backup = '';
    try {
      const bak = path.join(store.DATA_DIR, `db-backup-${Date.now()}.json`);
      fs.copyFileSync(store.DB_FILE, bak);
      backup = path.relative(path.join(__dirname), bak);
    } catch { /* 备份失败不阻塞清空 */ }
    db.departments = [];
    db.employees = [];
    db.usage = [];
    db.stats = { daily: {} };
    // 插件配置保留（省得重填 App Secret），但清掉同步记录，避免显示「已同步 N 人」与实际不符
    for (const key of Object.keys(db.plugins || {})) {
      db.plugins[key].lastSyncAt = '';
      db.plugins[key].lastResult = '';
    }
    // 清空之后不允许重启再灌演示数据
    db.settings.seeded = true;
    store.rebuildCounters();
    store.saveNow();
    return json(res, 200, { ok: true, backup });
  }

  // ---------------- 导出（备份用）
  if (p === '/api/export' && method === 'GET') {
    const out = JSON.parse(JSON.stringify(db));
    out.settings = { ...out.settings };
    delete out.settings.secret;
    delete out.settings.adminPassHash;
    // 上游真实密钥和员工虚拟密钥都属于敏感信息，导出时一并抹掉
    out.providers = out.providers.map((x) => ({ ...x, apiKey: '' }));
    out.employees = out.employees.map((x) => ({ ...x, key: '' }));
    return json(res, 200, out);
  }

  return fail(res, 404, '接口不存在');
}

// ---------------------------------------------------------------- 路由：网关

async function handleGateway(req, res, url) {
  const p = url.pathname;

  if (p === '/v1/models' && req.method === 'GET') {
    const models = new Set();
    for (const prov of db.providers) {
      if (prov.status !== 'active') continue;
      for (const m of prov.models || []) if (m !== '*') models.add(m);
    }
    if (!models.size) ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'deepseek-chat'].forEach((m) => models.add(m));
    return json(res, 200, {
      object: 'list',
      data: [...models].map((id) => ({ id, object: 'model', created: 0, owned_by: 'gateway' })),
    });
  }

  if (p !== '/v1/chat/completions') {
    return fail(res, 404, '接口不存在，本平台仅提供 /v1/chat/completions 与 /v1/models');
  }
  if (req.method !== 'POST') return fail(res, 405, '请使用 POST');

  // —— 1. 虚拟 key 鉴权
  const key = bearer(req);
  if (!key) {
    return fail(res, 401, '缺少 API Key，请在 Authorization 头中携带 Bearer <你的虚拟Key>', { code: 'missing_key' });
  }
  const emp = store.findEmployeeByKey(key);
  if (!emp) {
    return fail(res, 401, 'API Key 无效，请联系管理员在平台中确认', { code: 'invalid_key' });
  }
  if (emp.status !== 'active') {
    return fail(res, 403, '该账号已被停用，请联系管理员', { code: 'account_disabled' });
  }
  const dept = emp.deptId ? store.findDept(emp.deptId) : null;
  if (dept && dept.status !== 'active') {
    return fail(res, 403, '所属部门已被停用，请联系管理员', { code: 'dept_disabled' });
  }

  // —— 2. 解析请求体
  let body;
  try {
    body = await readBody(req, db.settings.maxBodyBytes || 4 * 1024 * 1024);
  } catch (e) {
    return fail(res, e.code === 'TOO_LARGE' ? 413 : 400, e.message);
  }
  if (!body.model) return fail(res, 400, '缺少参数 model');

  // —— 3. 配额校验（成本按 prompt 预估，避免剩余额度不足时仍放行）
  const estCost = proxy.estimatePrompt(body.messages);
  const check = quota.checkQuota({ employee: emp, dept, cost: estCost });

  if (!check.allowed) {
    store.recordUsage({
      employeeId: emp.id, deptId: dept ? dept.id : '', model: body.model,
      totalTokens: 0, status: 'rejected', source: 'api', countDept: check.effective.countAgainstDept,
      error: check.reason,
    });
    const headers = { 'Retry-After': '60' };
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers,
      'X-RateLimit-Scope': check.scope || '',
      'X-RateLimit-Dimension': check.dimension || '',
    });
    return res.end(JSON.stringify({
      error: {
        message: check.reason,
        type: 'quota_exceeded',
        code: 'quota_exceeded',
        dimension: check.dimension,
        scope: check.scope,
        detail: check.violations,
      },
    }));
  }

  // —— 4. 放行，占位并转发
  quota.acquire(emp);
  const startedAt = Date.now();
  let result;
  try {
    const candidates = proxy.pickProviders({ model: body.model, dept, employee: emp });
    if (candidates.length) {
      result = await proxy.forward({
        res, body, candidates,
        timeoutMs: db.settings.requestTimeoutMs || 120000,
      });
    } else if (db.settings.mockWhenNoProvider) {
      const m = await proxy.mockReply({ res, body });
      result = { ok: true, status: 200, usage: m.usage, providerId: 'mock', latencyMs: Date.now() - startedAt };
    } else {
      result = { ok: false, status: 503, usage: {}, error: '没有可用渠道支持该模型，且未开启模拟响应' };
    }
  } catch (e) {
    result = { ok: false, status: 500, usage: {}, error: e.message };
    if (!res.headersSent) fail(res, 500, '网关内部错误：' + e.message);
  } finally {
    quota.release(emp);
  }

  // —— 5. 记账
  const u = result.usage || {};
  store.recordUsage({
    employeeId: emp.id,
    deptId: dept ? dept.id : '',
    providerId: result.providerId || '',
    model: body.model,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    totalTokens: u.totalTokens,
    latencyMs: Date.now() - startedAt,
    status: result.ok ? 'ok' : 'error',
    source: 'api',
    countDept: check.effective.countAgainstDept,
    error: result.error || '',
  });

  if (!result.ok && !res.headersSent) {
    fail(res, result.status || 502, result.error || '上游调用失败', { code: 'upstream_error' });
  } else if (!res.writableEnded) {
    try { res.end(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 静态文件

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return fail(res, 403, '禁止访问');
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA 兜底
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      const buf = fs.readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
      return res.end(buf);
    }
    return fail(res, 404, '页面不存在');
  }
  const ext = path.extname(filePath).toLowerCase();
  const buf = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-cache',
  });
  res.end(buf);
}

// ---------------------------------------------------------------- 服务主体

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 内网工具，放开跨域方便员工从浏览器/本地脚本调试
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (url.pathname === '/healthz') {
      return json(res, 200, { ok: true, uptime: Math.round(process.uptime()), ts: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/v1/')) return await handleGateway(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('[server] 未捕获异常:', e);
    if (!res.headersSent) return fail(res, 500, '服务器内部错误：' + e.message);
    try { res.end(); } catch { /* ignore */ }
  }
});

server.listen(PORT, HOST, () => {
  const line = '─'.repeat(56);
  console.log(`\n${line}`);
  console.log(`  ${db.settings.platformName}`);
  console.log(`  管理台   http://localhost:${PORT}/`);
  console.log(`  网关地址 http://localhost:${PORT}/v1`);
  console.log(`  默认账号 admin / admin123  （请登录后立即修改）`);
  console.log(`${line}\n`);
});

// 退出前把内存数据刷盘
function shutdown(sig) {
  console.log(`\n[server] 收到 ${sig}，正在保存数据...`);
  store.saveNow();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

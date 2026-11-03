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
const alerts = require('./lib/alerts');
const { PRESETS, presetSummary } = require('./lib/preset-prices');
const { compile } = require('./lib/formula');

const pkg = require('./package.json');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOOT_AT = new Date().toISOString();

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

/** 解析模型列表输入：逗号/换行/空格分隔，支持通配 */
function parseModelList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[,，\s]+/);
  return [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))];
}

/** 告警配置清洗：部门/员工共用同一套结构 */
function sanitizeAlert(input, existing) {
  const a = input || existing || {};
  return {
    enabled: !!a.enabled,
    webhookUrl: String(a.webhookUrl || '').trim(),
    // 空数组 = 继承上级（部门级继承全局，员工级继承部门）
    thresholds: alerts.normThresholds(a.thresholds),
    dimensions: alerts.normDimensions(a.dimensions),
  };
}

/** 日志列表只回传摘要，正文放在详情接口里，避免列表接口撑爆 */
function logBrief(x, empMap, deptMap, provMap) {
  const log = x.log || null;
  const msgs = log && log.request && Array.isArray(log.request.messages) ? log.request.messages : [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user') || msgs[msgs.length - 1];
  return {
    id: x.id,
    ts: x.ts,
    employeeId: x.employeeId,
    deptId: x.deptId,
    providerId: x.providerId,
    model: x.model,
    promptTokens: x.promptTokens,
    completionTokens: x.completionTokens,
    cacheTokens: x.cacheTokens,
    cacheWriteTokens: x.cacheWriteTokens,
    totalTokens: x.totalTokens,
    cost: x.cost,
    costDetail: x.costDetail || null,
    latencyMs: x.latencyMs,
    status: x.status,
    source: x.source,
    countDept: x.countDept,
    error: x.error,
    usageSource: x.usageSource || '',
    upstreamModel: x.upstreamModel || '',
    hasContent: !!log,
    contentChars: log ? ((log.request && log.request.chars) || 0) + ((log.response && log.response.chars) || 0) : 0,
    preview: lastUser ? String(lastUser.content || '').replace(/\s+/g, ' ').slice(0, 80) : (x.error || ''),
    employeeName: empMap.get(x.employeeId) || '（已删除）',
    deptName: deptMap.get(x.deptId) || '—',
    providerName: x.providerId === 'mock' ? '内置模拟' : (provMap.get(x.providerId) || '—'),
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
    // 允许的模型：空数组 = 不限制；支持通配（gpt-4o*）
    allowedModels: parseModelList(input.allowedModels),
    alert: sanitizeAlert(input.alert, existing && existing.alert),
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
    // 允许的模型特例：null = 继承部门；数组 = 覆盖部门（特例生效时）
    allowedModels: Array.isArray(ov.allowedModels) ? parseModelList(ov.allowedModels) : null,
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
    alert: sanitizeAlert(input.alert, existing && existing.alert),
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

  let todayTokens = 0, todayReqs = 0, todayCost = 0;
  for (const v of Object.values(bucket.emp || {})) {
    todayTokens += v.t || 0; todayReqs += v.r || 0; todayCost += v.c || 0;
  }
  todayCost = Math.round(todayCost * 1e4) / 1e4;

  let monthTokens = 0, monthReqs = 0, monthCost = 0;
  for (const [dk, b] of Object.entries(db.stats.daily || {})) {
    if (!dk.startsWith(store.monthKey())) continue;
    for (const v of Object.values(b.emp || {})) {
      monthTokens += v.t || 0; monthReqs += v.r || 0; monthCost += v.c || 0;
    }
  }
  monthCost = Math.round(monthCost * 1e4) / 1e4;

  // 今日模型成本排行：哪个模型最烧钱一目了然
  const modelRank = Object.entries(bucket.models || {})
    .map(([model, v]) => ({ model, tokens: v.t || 0, reqs: v.r || 0, cost: Math.round((v.c || 0) * 1e4) / 1e4 }))
    .sort((a, b) => b.cost - a.cost);

  const deptRank = db.departments.map((d) => {
    const u = store.getDeptUsage(d.id);
    return {
      id: d.id, name: d.name, dayTokens: u.dayTokens, monthTokens: u.monthTokens,
      dayCost: u.dayCost, monthCost: u.monthCost,
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
      dayTokens: u.dayTokens, monthTokens: u.monthTokens, dayCost: u.dayCost,
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
    today: { tokens: todayTokens, reqs: todayReqs, cost: todayCost, date: today },
    month: { tokens: monthTokens, reqs: monthReqs, cost: monthCost, month: store.monthKey() },
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
    modelRank: modelRank.slice(0, 8),
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
    return json(res, 200, {
      ...overview(),
      nowIdle: store.isIdleNow(),
      hasIdlePricing: Object.values(db.pricing).some((x) => x.idle && typeof x.idle === 'object'),
      settings: { platformName: db.settings.platformName, onExceed: db.settings.onExceed },
    });
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

  const deptAlertTest = p.match(/^\/api\/departments\/([^/]+)\/test-alert$/);
  if (deptAlertTest && method === 'POST') {
    const dept = store.findDept(deptAlertTest[1]);
    if (!dept) return fail(res, 404, '部门不存在');
    const body = await readBody(req, 64 * 1024).catch(() => ({}));
    const r = await alerts.testTarget({ dept, overrideUrl: body && body.webhookUrl });
    return json(res, 200, r);
  }

  const empAlertTest = p.match(/^\/api\/employees\/([^/]+)\/test-alert$/);
  if (empAlertTest && method === 'POST') {
    const emp = store.findEmployee(empAlertTest[1]);
    if (!emp) return fail(res, 404, '员工不存在');
    const dept = emp.deptId ? store.findDept(emp.deptId) : null;
    const body = await readBody(req, 64 * 1024).catch(() => ({}));
    const r = await alerts.testTarget({ employee: emp, dept, overrideUrl: body && body.webhookUrl });
    return json(res, 200, r);
  }

  // ---------------- 告警记录
  if (p === '/api/alerts' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || 50;
    const items = alerts.recent(limit);
    const okCount = items.filter((x) => x.ok).length;
    return json(res, 200, {
      items,
      total: items.length,
      okCount,
      failCount: items.length - okCount,
      routes: (() => {
        // 让设置页能显示「哪些对象有自己的通道」，不暴露 webhook 全文
        const mask = (u) => (u ? String(u).replace(/^(https?:\/\/[^/]+).*$/, '$1/…') : '');
        return {
          departments: db.departments.filter((d) => d.alert && d.alert.enabled).map((d) => ({ id: d.id, name: d.name, url: mask(d.alert.webhookUrl) })),
          employees: db.employees.filter((e) => e.alert && e.alert.enabled).map((e) => ({ id: e.id, name: e.name, url: mask(e.alert.webhookUrl) })),
        };
      })(),
    });
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
  const nameMaps = () => ({
    empMap: new Map(db.employees.map((e) => [e.id, e.name])),
    deptMap: new Map(db.departments.map((d) => [d.id, d.name])),
    provMap: new Map(db.providers.map((x) => [x.id, x.name])),
  });

  if (p === '/api/logs' && method === 'GET') {
    const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
    const empId = url.searchParams.get('employeeId') || '';
    const deptId = url.searchParams.get('deptId') || '';
    const status = url.searchParams.get('status') || '';
    const model = url.searchParams.get('model') || '';
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    let list = db.usage.slice().reverse();
    if (empId) list = list.filter((x) => x.employeeId === empId);
    if (deptId) list = list.filter((x) => x.deptId === deptId);
    if (status) list = list.filter((x) => x.status === status);
    if (model) list = list.filter((x) => x.model === model);
    if (q) {
      // 关键词只搜「员工名 / 模型 / 错误 / 最后一条提问」，不扫全文，避免大库变慢
      const emps = new Map(db.employees.map((e) => [e.id, e.name.toLowerCase()]));
      list = list.filter((x) => {
        const msgs = x.log && x.log.request ? x.log.request.messages || [] : [];
        const last = [...msgs].reverse().find((m) => m.role === 'user');
        return String(x.model).toLowerCase().includes(q)
          || String(x.error || '').toLowerCase().includes(q)
          || (emps.get(x.employeeId) || '').includes(q)
          || (last && String(last.content || '').toLowerCase().includes(q));
      });
    }
    const { empMap, deptMap, provMap } = nameMaps();
    return json(res, 200, {
      items: list.slice(0, limit).map((x) => logBrief(x, empMap, deptMap, provMap)),
      total: list.length,
      logContent: db.settings.logContent || 'summary',
    });
  }

  const logMatch = p.match(/^\/api\/logs\/([^/]+)$/);
  if (logMatch && method === 'GET') {
    const item = db.usage.find((x) => x.id === logMatch[1]);
    if (!item) return fail(res, 404, '日志不存在或已被裁剪（明细只保留最近 5000 条）');
    const { empMap, deptMap, provMap } = nameMaps();
    return json(res, 200, {
      ...logBrief(item, empMap, deptMap, provMap),
      log: item.log || null,
      attempts: (item.log && item.log.attempts) || [],
    });
  }

  // ---------------- 模型单价（成本核算，支持高峰/空闲分时与缓存命中单价）
  if (p === '/api/pricing' && method === 'GET') {
    return json(res, 200, {
      items: db.pricing,
      peak: db.settings.peak || {},
      nowPeak: store.isPeakNow(),
      nowIdle: store.isIdleNow(),
      hasIdlePricing: Object.values(db.pricing).some((x) => x.idle && typeof x.idle === 'object'),
      presets: presetSummary(),
    });
  }
  // 一键载入内置官方参考价（默认覆盖同名模型，不影响自定义模型）
  if (p === '/api/pricing/presets' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const ids = Array.isArray(body.providers) && body.providers.length ? body.providers.map(String) : null;
    const overwrite = body.overwrite !== false;
    let added = 0;
    let updated = 0;
    for (const prov of PRESETS.providers) {
      if (ids && !ids.includes(prov.id)) continue;
      for (const [model, price] of Object.entries(prov.models)) {
        const exists = !!db.pricing[model];
        if (exists && !overwrite) continue;
        db.pricing[model] = JSON.parse(JSON.stringify(price));
        if (exists) updated++; else added++;
      }
    }
    db.settings.presetsVersion = PRESETS.updatedAt;
    store.save();
    return json(res, 200, { ok: true, added, updated, total: added + updated, updatedAt: PRESETS.updatedAt });
  }
  if (p === '/api/pricing' && method === 'PUT') {
    const body = await readBody(req, 256 * 1024);
    const out = {};
    for (const [model, v] of Object.entries(body.pricing || {})) {
      const name = String(model || '').trim();
      if (!name) continue;
      const entry = {
        in: Math.max(0, Number(v.in) || 0),
        out: Math.max(0, Number(v.out) || 0),
      };
      // 缓存命中/缓存写入输入单价（可选，留空则按输入价计）
      if (v.cacheIn !== undefined && v.cacheIn !== null && v.cacheIn !== '') {
        entry.cacheIn = Math.max(0, Number(v.cacheIn) || 0);
      }
      if (v.cacheWrite !== undefined && v.cacheWrite !== null && v.cacheWrite !== '') {
        entry.cacheWrite = Math.max(0, Number(v.cacheWrite) || 0);
      }
      // 空闲时段单价（可选，任一字段填写即视为该模型启用分时计价）
      if (v.idle && typeof v.idle === 'object') {
        const idle = {};
        for (const k of ['in', 'out', 'cacheIn', 'cacheWrite']) {
          if (v.idle[k] !== undefined && v.idle[k] !== null && v.idle[k] !== '') {
            idle[k] = Math.max(0, Number(v.idle[k]) || 0);
          }
        }
        if (Object.keys(idle).length) entry.idle = idle;
      }
      // 按输入长度分档（可选，配置后优先于分时；Qwen 阶梯价 / Gemini 长上下文加价）
      if (Array.isArray(v.tiers)) {
        const tiers = v.tiers
          .map((t) => {
            if (!t || typeof t !== 'object') return null;
            const tt = {};
            const upTo = Math.round(Number(t.upTo) || 0);
            if (upTo <= 0) return null;
            tt.upTo = upTo;
            for (const k of ['in', 'out', 'cacheIn', 'cacheWrite']) {
              if (t[k] !== undefined && t[k] !== null && t[k] !== '') {
                tt[k] = Math.max(0, Number(t[k]) || 0);
              }
            }
            return tt;
          })
          .filter(Boolean)
          .sort((a, b) => a.upTo - b.upTo);
        if (tiers.length) entry.tiers = tiers;
      }
      // 模型自定义时段价（可选）：每段自带时间规则与单价，优先于「idle + 全局峰谷规则」
      if (Array.isArray(v.periods)) {
        const list = [];
        for (let i = 0; i < v.periods.length; i++) {
          const raw = v.periods[i];
          if (!raw || typeof raw !== 'object') continue;
          const label = String(raw.name || '').trim().slice(0, 20) || `时段 ${i + 1}`;
          let days = null;
          if (raw.days !== undefined && raw.days !== null && raw.days !== '') {
            days = store.parseDaySpec(raw.days);
            if (!days) return fail(res, 400, `模型「${name}」第 ${i + 1} 个时段「${label}」的生效星期无法识别（用 1-5 或 0,6，0=周日）`);
          }
          const dates = Array.isArray(raw.dates)
            ? [...new Set(raw.dates.map((x) => String(x || '').trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort()
            : [];
          let windows = [];
          const wsrc = raw.windows;
          if (typeof wsrc === 'string') {
            const parsed = store.parseWindowSpec(wsrc);
            if (!parsed) return fail(res, 400, `模型「${name}」第 ${i + 1} 个时段「${label}」的时间窗无法识别（形如 09:00-12:00, 14:00-18:00）`);
            windows = parsed;
          } else if (Array.isArray(wsrc)) {
            for (const w of wsrc) {
              if (typeof w === 'string') {
                const parsed = store.parseWindowSpec(w);
                if (!parsed) return fail(res, 400, `模型「${name}」第 ${i + 1} 个时段「${label}」的时间窗无法识别（形如 09:00-12:00）`);
                windows.push(...parsed);
              } else if (Array.isArray(w) && w.length === 2) {
                const a = store.parseHM(w[0]);
                const b = store.parseHM(w[1]);
                if (a == null || b == null || a === b) return fail(res, 400, `模型「${name}」第 ${i + 1} 个时段「${label}」的时间窗无法识别（形如 09:00-12:00）`);
                windows.push([store.normHM(w[0]), store.normHM(w[1])]);
              }
            }
          }
          if (!windows.length && !dates.length) {
            return fail(res, 400, `模型「${name}」第 ${i + 1} 个时段「${label}」既没填时间窗也没填指定日期`);
          }
          const item = { name: label };
          if (dates.length) item.dates = dates;
          if (windows.length) {
            item.windows = windows;
            item.days = days || [0, 1, 2, 3, 4, 5, 6];
          }
          for (const k of ['in', 'out', 'cacheIn', 'cacheWrite']) {
            if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') {
              item[k] = Math.max(0, Number(raw[k]) || 0);
            }
          }
          list.push(item);
        }
        if (list.length) entry.periods = list;
      }
      // 每次调用固定费用（元）
      if (v.perCall !== undefined && v.perCall !== null && v.perCall !== '') {
        entry.perCall = Math.max(0, Number(v.perCall) || 0);
      }
      // 成本倍率（0 表示免费，1 或不填表示原价）
      if (v.multiplier !== undefined && v.multiplier !== null && v.multiplier !== '') {
        const m = Number(v.multiplier);
        if (!Number.isFinite(m) || m < 0) return fail(res, 400, `模型「${name}」的倍率必须是不小于 0 的数字`);
        entry.multiplier = m;
      }
      // 自定义公式：保存前先编译，语法错误直接 400，避免上线后算不出成本
      if (v.formula !== undefined && v.formula !== null && String(v.formula).trim()) {
        const c = compile(v.formula);
        if (!c.ok) return fail(res, 400, `模型「${name}」的公式有误：${c.error}`);
        entry.formula = String(v.formula).trim();
      }
      if (v.note !== undefined && v.note !== null) entry.note = String(v.note).trim().slice(0, 200);
      out[name] = entry;
    }
    db.pricing = out;
    store.save();
    return json(res, 200, { ok: true, count: Object.keys(out).length });
  }

  // 单模型试算：body.pricing 传未保存的配置也能算，方便编辑弹窗里即时预览
  if (p === '/api/pricing/test' && method === 'POST') {
    const body = await readBody(req, 128 * 1024);
    const model = String(body.model || '').trim();
    const entry = body.pricing && typeof body.pricing === 'object' ? body.pricing : db.pricing[model];
    if (!entry) return fail(res, 400, '该模型还没有定价，请先填写输入/输出单价');
    if (body.pricing && entry.formula) {
      const c = compile(entry.formula);
      if (!c.ok) return fail(res, 400, `公式有误：${c.error}`);
    }
    const at = body.at ? Date.parse(body.at) : Date.now();
    const detail = store.modelCostDetail(
      model,
      Number(body.prompt) || 0,
      Number(body.completion) || 0,
      Number(body.cacheHit) || 0,
      Number(body.cacheWrite) || 0,
      Number.isFinite(at) ? at : Date.now(),
      entry,
    );
    return json(res, 200, {
      ok: true,
      model,
      detail,
      nowPeak: store.isPeakNow(),
      nowIdle: store.isIdleNow(),
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
    if (typeof body.webhookUrl === 'string') db.settings.webhookUrl = body.webhookUrl.trim();
    if (typeof body.alertsEnabled === 'boolean') db.settings.alertsEnabled = body.alertsEnabled;
    // 告警全局默认（部门/员工没单独配置时用它）
    if (Array.isArray(body.alertThresholds)) {
      const list = alerts.normThresholds(body.alertThresholds);
      if (list.length) db.settings.alertThresholds = list;
    }
    if (Array.isArray(body.alertDimensions)) {
      const list = alerts.normDimensions(body.alertDimensions);
      db.settings.alertDimensions = list.length ? list : db.settings.alertDimensions;
    }
    // 调用日志内容留存策略
    if (['off', 'summary', 'full'].includes(body.logContent)) db.settings.logContent = body.logContent;
    if (body.logContentMax !== undefined && body.logContentMax !== null && body.logContentMax !== '') {
      db.settings.logContentMax = Math.min(20000, Math.max(200, Math.round(Number(body.logContentMax) || 2000)));
    }
    // 流式是否自动补 include_usage（关掉后流式请求只能按文本估算 token）
    if (typeof body.streamUsage === 'boolean') db.settings.streamUsage = body.streamUsage;
    // 上游繁忙/限流自动重试
    if (body.retry && typeof body.retry === 'object') {
      const r = db.settings.retry || (db.settings.retry = {});
      if (typeof body.retry.enabled === 'boolean') r.enabled = body.retry.enabled;
      if (body.retry.times !== undefined && body.retry.times !== null && body.retry.times !== '') {
        r.times = Math.min(5, Math.max(0, Math.round(Number(body.retry.times) || 0)));
      }
      if (body.retry.baseMs !== undefined && body.retry.baseMs !== null && body.retry.baseMs !== '') {
        r.baseMs = Math.min(5000, Math.max(100, Math.round(Number(body.retry.baseMs) || 800)));
      }
    }
    // 高峰时段规则（北京时间）：工作日 + 多时间窗 + 法定节假日排除
    if (body.peak && typeof body.peak === 'object') {
      const w = db.settings.peak || (db.settings.peak = {});
      if (typeof body.peak.enabled === 'boolean') w.enabled = body.peak.enabled;
      if (Array.isArray(body.peak.days)) {
        w.days = [...new Set(body.peak.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
      }
      if (Array.isArray(body.peak.windows)) {
        w.windows = body.peak.windows
          .filter((x) => Array.isArray(x) && x.length === 2)
          .map(([s, e]) => [String(s).trim(), String(e).trim()])
          .filter(([s, e]) => /^\d{1,2}:\d{2}$/.test(s) && /^\d{1,2}:\d{2}$/.test(e));
      }
      if (Array.isArray(body.peak.holidays)) {
        w.holidays = [...new Set(body.peak.holidays.map((x) => String(x).trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort();
      }
    }
    store.save();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/settings/test-webhook' && method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    const url = String(body.webhookUrl || db.settings.webhookUrl || '').trim();
    if (!/^https?:\/\//.test(url)) return fail(res, 400, '请先填写机器人 Webhook 地址');
    const r = await alerts.testWebhook(url);
    return json(res, 200, r);
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

  // 日志内容摘要（是否落盘、截断多少由 settings.logContent / logContentMax 决定）
  const reqSummary = proxy.summarizeRequest(body);

  // —— 3. 模型权限校验（部门默认 → 员工特例覆盖，与额度同一套继承规则）
  const modelPolicy = quota.resolveModels(emp, dept);
  if (modelPolicy && !quota.modelAllowed(modelPolicy.list, body.model)) {
    const reason = `没有权限使用模型「${body.model}」（${modelPolicy.source === 'employee' ? '个人' : '部门'}策略限制，允许：${modelPolicy.list.join('、')}）`;
    store.recordUsage({
      employeeId: emp.id, deptId: dept ? dept.id : '', model: body.model,
      totalTokens: 0, status: 'rejected', source: 'api', countDept: true,
      error: reason, request: reqSummary,
    });
    return fail(res, 403, reason, { code: 'model_not_allowed', type: 'model_not_allowed' });
  }

  // —— 4. 配额校验（成本按 prompt 预估，避免剩余额度不足时仍放行）
  const estCost = proxy.estimatePrompt(body.messages);
  const check = quota.checkQuota({ employee: emp, dept, cost: estCost });

  if (!check.allowed) {
    store.recordUsage({
      employeeId: emp.id, deptId: dept ? dept.id : '', model: body.model,
      totalTokens: 0, status: 'rejected', source: 'api', countDept: check.effective.countAgainstDept,
      error: check.reason, request: reqSummary,
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
        // 流式默认补 include_usage，拿到上游真实 usage；管理员可在设置里关掉
        forceStreamUsage: db.settings.streamUsage !== false,
        // 上游 5xx / 429 / 连接抖动时退避重试
        retry: db.settings.retry,
      });
    } else if (db.settings.mockWhenNoProvider) {
      const m = await proxy.mockReply({ res, body });
      // 模拟响应也要把输出正文、finish_reason、渠道尝试带进日志，
      // 否则「没有启用渠道」时点详情只有输入、看不到输出。
      result = {
        ok: true,
        status: 200,
        usage: m.usage,
        providerId: 'mock',
        completionText: m.completionText || '',
        finishReason: m.finishReason || 'stop',
        usageSource: m.usageSource || 'upstream',
        attempts: [{ providerId: 'mock', ok: true, status: 200, latencyMs: Date.now() - startedAt }],
        latencyMs: Date.now() - startedAt,
      };
    } else {
      result = { ok: false, status: 503, usage: {}, error: '没有可用渠道支持该模型，且未开启模拟响应' };
    }
  } catch (e) {
    result = { ok: false, status: 500, usage: {}, error: e.message };
    if (!res.headersSent) fail(res, 500, '网关内部错误：' + e.message);
  } finally {
    quota.release(emp);
  }

  // —— 5. 记账 + 告警检查
  const u = result.usage || {};
  const rec = store.recordUsage({
    employeeId: emp.id,
    deptId: dept ? dept.id : '',
    providerId: result.providerId || '',
    model: body.model,
    promptTokens: u.promptTokens,
    completionTokens: u.completionTokens,
    cacheTokens: u.cacheTokens,
    cacheWriteTokens: u.cacheWriteTokens,
    totalTokens: u.totalTokens,
    latencyMs: Date.now() - startedAt,
    status: result.ok ? 'ok' : 'error',
    source: 'api',
    countDept: check.effective.countAgainstDept,
    error: result.error || '',
    request: reqSummary,
    response: result.completionText || '',
    finishReason: result.finishReason || '',
    usageSource: result.usageSource || '',
    upstreamModel: result.upstreamModel || '',
    attempts: result.attempts || [],
  });
  if (rec.status === 'ok') {
    alerts.check({ employee: emp, dept, effective: check.effective, platformName: db.settings.platformName });
  }

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
      return json(res, 200, {
        ok: true,
        version: pkg.version,
        startedAt: BOOT_AT,
        uptime: Math.round(process.uptime()),
        ts: new Date().toISOString(),
      });
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

'use strict';

/**
 * 数据层：JSON 文件持久化 + 内存用量计数器
 *
 * 设计取舍：
 * 1. 零外部依赖，db.json 单文件落盘，方便内网部署和备份、直接拷走。
 * 2. 用量明细（usage）只保留最近 N 条用于排障；长期统计走 stats.daily 聚合表，
 *    这样即使明细被裁剪，月报/日报数据也不会丢。
 * 3. 写盘做防抖，避免每个请求都触发一次 IO。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 数据目录可用环境变量覆盖，测试时指向临时目录即可做到完全隔离
const DATA_DIR = process.env.GW_DATA_DIR
  ? path.resolve(process.env.GW_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const USAGE_DETAIL_LIMIT = 5000;   // 明细保留条数
const STATS_KEEP_DAYS = 120;       // 聚合表保留天数

// ---------------------------------------------------------------- 时间工具

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/** 本地时区的 YYYY-MM-DD */
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本地时区的 YYYY-MM */
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** 最近 n 天的日期键，从旧到新 */
function lastDays(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

const uid = () => crypto.randomBytes(8).toString('hex');

// ---------------------------------------------------------------- 默认数据

function defaultDb() {
  return {
    version: 1,
    settings: {
      platformName: 'AI API 分流平台',
      // 管理员口令（sha256）。首次启动写入默认 admin / admin123
      adminUser: 'admin',
      adminPassHash: sha256('admin123'),
      // 未配置任何上游渠道时，走内置模拟响应，方便先跑通流程
      mockWhenNoProvider: true,
      // 额度用尽时的策略：block=直接 429；downgrade=降级到备用模型
      onExceed: 'block',
      downgradeModel: 'gpt-4o-mini',
      // 请求体最大字节数
      maxBodyBytes: 4 * 1024 * 1024,
      createdAt: new Date().toISOString(),
    },
    departments: [],
    employees: [],
    providers: [],
    plugins: {},       // 扩展插件的配置与同步状态（飞书/企业微信/CSV…）
    usage: [],
    stats: { daily: {} },
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// ---------------------------------------------------------------- 存储实例

let db = null;
let saveTimer = null;

function load() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      // 文件损坏时留个备份再重建，避免直接丢掉历史数据
      const bak = DB_FILE + '.broken-' + Date.now();
      fs.copyFileSync(DB_FILE, bak);
      console.error(`[store] db.json 解析失败，已备份到 ${bak}，将重建默认数据`);
      db = defaultDb();
    }
  } else {
    db = defaultDb();
  }
  // 兜底补字段，兼容旧版本文件
  const base = defaultDb();
  db.settings = Object.assign({}, base.settings, db.settings || {});
  db.stats = db.stats && db.stats.daily ? db.stats : { daily: {} };
  for (const k of ['departments', 'employees', 'providers', 'usage']) {
    if (!Array.isArray(db[k])) db[k] = [];
  }
  if (!db.plugins || typeof db.plugins !== 'object' || Array.isArray(db.plugins)) db.plugins = {};
  return db;
}

function saveNow() {
  if (!db) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);   // 原子替换，防止写一半断电导致文件损坏
  } catch (e) {
    console.error('[store] 写盘失败:', e.message);
  }
}

function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 400);
  if (saveTimer.unref) saveTimer.unref();
}

function getDb() {
  if (!db) load();
  return db;
}

// ---------------------------------------------------------------- 内存计数器

/**
 * 计数器结构（按员工 / 部门分开维护）：
 *   { dd: '2026-10-30', dTokens, dReqs, mm: '2026-10', mTokens, mReqs }
 * 跨天/跨月时自动归零，不需要定时任务。
 */
const counters = {
  emp: new Map(),
  dept: new Map(),
  rpm: new Map(),       // scopeKey -> [timestamp, ...]
  inflight: new Map(),  // scopeKey -> number
};

function blankCounter() {
  return {
    dd: dayKey(), dTokens: 0, dReqs: 0,
    mm: monthKey(), mTokens: 0, mReqs: 0,
  };
}

function touchCounter(map, key) {
  let c = map.get(key);
  const today = dayKey();
  const month = monthKey();
  if (!c) {
    c = blankCounter();
    map.set(key, c);
  }
  if (c.dd !== today) { c.dd = today; c.dTokens = 0; c.dReqs = 0; }
  if (c.mm !== month) { c.mm = month; c.mTokens = 0; c.mReqs = 0; }
  return c;
}

/** 从聚合表重建今日/本月计数器（进程重启后调用） */
function rebuildCounters() {
  counters.emp.clear();
  counters.dept.clear();
  counters.rpm.clear();

  const daily = getDb().stats.daily || {};
  const today = dayKey();
  const thisMonth = monthKey();

  for (const [dk, bucket] of Object.entries(daily)) {
    const isToday = dk === today;
    const isThisMonth = dk.startsWith(thisMonth);
    if (!isToday && !isThisMonth) continue;

    for (const [id, v] of Object.entries(bucket.emp || {})) {
      const c = touchCounter(counters.emp, id);
      if (isToday) { c.dTokens += v.t || 0; c.dReqs += v.r || 0; }
      if (isThisMonth) { c.mTokens += v.t || 0; c.mReqs += v.r || 0; }
    }
    for (const [id, v] of Object.entries(bucket.dept || {})) {
      const c = touchCounter(counters.dept, id);
      if (isToday) { c.dTokens += v.t || 0; c.dReqs += v.r || 0; }
      if (isThisMonth) { c.mTokens += v.t || 0; c.mReqs += v.r || 0; }
    }
  }
}

function getEmpUsage(empId) {
  const c = counters.emp.get(empId) || blankCounter();
  // 确保返回的是"当前"日/月的值（跨天后旧数据不返回）
  const today = dayKey();
  const month = monthKey();
  return {
    dayTokens: c.dd === today ? c.dTokens : 0,
    dayReqs: c.dd === today ? c.dReqs : 0,
    monthTokens: c.mm === month ? c.mTokens : 0,
    monthReqs: c.mm === month ? c.mReqs : 0,
  };
}

function getDeptUsage(deptId) {
  const c = counters.dept.get(deptId) || blankCounter();
  const today = dayKey();
  const month = monthKey();
  return {
    dayTokens: c.dd === today ? c.dTokens : 0,
    dayReqs: c.dd === today ? c.dReqs : 0,
    monthTokens: c.mm === month ? c.mTokens : 0,
    monthReqs: c.mm === month ? c.mReqs : 0,
  };
}

/** RPM 滑动窗口：记录一次请求并返回窗口内请求数 */
function hitRpm(scopeKey, windowMs = 60000) {
  const now = Date.now();
  let arr = counters.rpm.get(scopeKey) || [];
  arr = arr.filter((t) => now - t < windowMs);
  arr.push(now);
  counters.rpm.set(scopeKey, arr);
  return arr.length;
}

function peekRpm(scopeKey, windowMs = 60000) {
  const now = Date.now();
  const arr = (counters.rpm.get(scopeKey) || []).filter((t) => now - t < windowMs);
  return arr.length;
}

function enterInflight(scopeKey) {
  const n = (counters.inflight.get(scopeKey) || 0) + 1;
  counters.inflight.set(scopeKey, n);
  return n;
}

function leaveInflight(scopeKey) {
  const n = Math.max(0, (counters.inflight.get(scopeKey) || 1) - 1);
  counters.inflight.set(scopeKey, n);
  return n;
}

function getInflight(scopeKey) {
  return counters.inflight.get(scopeKey) || 0;
}

// ---------------------------------------------------------------- 用量记账

/**
 * 记一笔用量。明细 + 聚合表 + 内存计数器三处同步更新。
 * @param {object} rec { employeeId, deptId, providerId, model, promptTokens,
 *                       completionTokens, totalTokens, latencyMs, status,
 *                       countDept, source, ip, error }
 */
function recordUsage(rec) {
  const d = getDb();
  const tokens = Math.max(0, Math.round(rec.totalTokens || 0));
  const today = dayKey();

  // 1) 明细
  const entry = {
    id: uid(),
    ts: new Date().toISOString(),
    employeeId: rec.employeeId || '',
    deptId: rec.deptId || '',
    providerId: rec.providerId || '',
    model: rec.model || '',
    promptTokens: Math.round(rec.promptTokens || 0),
    completionTokens: Math.round(rec.completionTokens || 0),
    totalTokens: tokens,
    latencyMs: Math.round(rec.latencyMs || 0),
    status: rec.status || 'ok',
    source: rec.source || 'api',
    countDept: rec.countDept !== false,
    error: rec.error || '',
  };
  d.usage.push(entry);
  if (d.usage.length > USAGE_DETAIL_LIMIT) {
    d.usage.splice(0, d.usage.length - USAGE_DETAIL_LIMIT);
  }

  // 2) 聚合表（只统计成功/计费的请求，用于额度）
  if (entry.status === 'ok' && tokens > 0) {
    const bucket = d.stats.daily[today] || (d.stats.daily[today] = { emp: {}, dept: {} });
    if (entry.employeeId) {
      const e = bucket.emp[entry.employeeId] || (bucket.emp[entry.employeeId] = { t: 0, r: 0 });
      e.t += tokens;
      e.r += 1;
    }
    if (entry.deptId && entry.countDept) {
      const p = bucket.dept[entry.deptId] || (bucket.dept[entry.deptId] = { t: 0, r: 0 });
      p.t += tokens;
      p.r += 1;
    }

    // 3) 内存计数器
    if (entry.employeeId) {
      const c = touchCounter(counters.emp, entry.employeeId);
      c.dTokens += tokens; c.dReqs += 1; c.mTokens += tokens; c.mReqs += 1;
    }
    if (entry.deptId && entry.countDept) {
      const c = touchCounter(counters.dept, entry.deptId);
      c.dTokens += tokens; c.dReqs += 1; c.mTokens += tokens; c.mReqs += 1;
    }
  }

  pruneStats();
  save();
  return entry;
}

/** 清理过期聚合数据 */
let lastPruneDay = '';
function pruneStats() {
  const today = dayKey();
  if (lastPruneDay === today) return;
  lastPruneDay = today;
  const keep = new Set(lastDays(STATS_KEEP_DAYS));
  for (const k of Object.keys(getDb().stats.daily)) {
    if (!keep.has(k)) delete getDb().stats.daily[k];
  }
}

// ---------------------------------------------------------------- 查询辅助

function findEmployeeByKey(plainKey) {
  if (!plainKey) return null;
  return getDb().employees.find((e) => e.key === plainKey) || null;
}

function findDept(id) {
  return getDb().departments.find((d) => d.id === id) || null;
}

function findEmployee(id) {
  return getDb().employees.find((e) => e.id === id) || null;
}

function genKey() {
  // sk-ai-<40位十六进制>，前缀方便识别是内部平台的虚拟密钥
  return 'sk-ai-' + crypto.randomBytes(20).toString('hex');
}

/** 7 日趋势（用于概览页图表） */
function trend7() {
  const daily = getDb().stats.daily || {};
  return lastDays(7).map((dk) => {
    const b = daily[dk] || { emp: {}, dept: {} };
    let tokens = 0, reqs = 0;
    for (const v of Object.values(b.emp || {})) { tokens += v.t || 0; reqs += v.r || 0; }
    return { date: dk, tokens, reqs };
  });
}

module.exports = {
  DATA_DIR, DB_FILE,
  load, save, saveNow, getDb,
  sha256, uid,
  dayKey, monthKey, lastDays,
  rebuildCounters, getEmpUsage, getDeptUsage,
  hitRpm, peekRpm, enterInflight, leaveInflight, getInflight,
  recordUsage, findEmployeeByKey, findDept, findEmployee, genKey, trend7,
};

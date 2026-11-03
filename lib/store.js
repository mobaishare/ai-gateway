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
      // 用量告警：额度跨过阈值时推送到飞书/企业微信机器人
      webhookUrl: '',
      alertsEnabled: true,
      // 高峰时段规则（北京时间 UTC+8），贴合 DeepSeek 官方计价：
      // 周一至周五（不含法定节假日）9:00-12:00、14:00-18:00 为高峰，其余（含周末、节假日全天）为空闲
      peak: {
        enabled: true,
        days: [1, 2, 3, 4, 5],                              // 周几为高峰候选（0=周日）
        windows: [['09:00', '12:00'], ['14:00', '18:00']],  // 高峰时间窗
        holidays: [],                                       // 法定节假日（YYYY-MM-DD），全天按空闲时段计价
      },
      createdAt: new Date().toISOString(),
    },
    // 模型单价表（元 / 百万 tokens）：
    // { "deepseek-flash": { in: 2, out: 8, cacheIn: 0.04, idle: { in: 1, out: 4, cacheIn: 0.02 } } }
    // - in/out/cacheIn：高峰时段（默认）单价；cacheIn 是缓存命中输入的可选单价，未配置时按 in 计
    // - idle：空闲时段单价（可选），时段由 settings.peak 决定；不配置 idle 的模型不分时
    // 渠道转发本身与单价无关，成本核算只在记账时按请求发生时刻查这张表
    pricing: {},
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

/** 解析 "HH:MM" 为当天分钟数，非法返回 null */
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 某时刻是否处于高峰时段（按北京时间 UTC+8 判断，与服务器本地时区无关）。
 * 规则贴合 DeepSeek 官方：settings.peak = { enabled, days: [1-5], windows: [['09:00','12:00'],...], holidays: ['YYYY-MM-DD',...] }
 * - days 命中星期 且 时间落在任一 windows 内 → 高峰
 * - holidays（法定节假日，北京时间日期）当天全天视为空闲
 * - 未开启或规则不完整时恒为非高峰（全按默认价计）
 * @param {number} at 毫秒时间戳，默认当前时间
 */
function isPeakNow(at = Date.now()) {
  const w = getDb().settings.peak || {};
  if (!w.enabled) return false;
  const d = new Date(at + 8 * 3600 * 1000);
  // 偏移 8 小时后用 UTC 分量即为北京时间
  const dateStr = d.toISOString().slice(0, 10);
  if (Array.isArray(w.holidays) && w.holidays.includes(dateStr)) return false;
  const dow = d.getUTCDay();
  if (!Array.isArray(w.days) || !w.days.map(Number).includes(dow)) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  const windows = Array.isArray(w.windows) ? w.windows : [];
  return windows.some(([s, e]) => {
    const a = parseHM(s);
    const b = parseHM(e);
    if (a == null || b == null) return false;
    return a < b ? mins >= a && mins < b : mins >= a || mins < b;
  });
}

/** 当前是否处于空闲时段（peak 规则开启且此刻不在高峰内） */
function isIdleNow(at = Date.now()) {
  const w = getDb().settings.peak || {};
  return !!w.enabled && !isPeakNow(at);
}

/** 按输入长度挑选分档（tiers 已按 upTo 升序；无匹配档时返回 null 回落基础价） */
function pickTier(tiers, promptTokens) {
  const list = tiers
    .filter((t) => t && Number(t.upTo) > 0)
    .sort((a, b) => Number(a.upTo) - Number(b.upTo));
  for (const t of list) {
    if ((promptTokens || 0) <= Number(t.upTo)) return t;
  }
  return null;
}

/**
 * 按单价表计算一次调用的成本（元）。覆盖国内外主流计费模式：
 * pricing: {
 *   in, out,                    // 高峰/默认：输入、输出单价
 *   cacheIn?,                   // 缓存命中输入价（OpenAI cached_tokens、DeepSeek/Kimi 缓存命中）
 *   cacheWrite?,                // 缓存写入价（Anthropic cache_creation，官方为输入价 1.25 倍需自行填）
 *   idle?: { in, out, cacheIn?, cacheWrite? },              // 空闲时段价（DeepSeek 谷时），时段由 settings.peak 决定
 *   tiers?: [{ upTo, in, out, cacheIn?, cacheWrite? }],     // 按输入长度分档（Qwen 阶梯价、Gemini 长上下文加价）；配置后优先于分时
 * }
 * @param {string} model 模型名
 * @param {number} promptTokens 输入 tokens（含缓存命中/写入部分）
 * @param {number} completionTokens 输出 tokens
 * @param {number} cacheTokens 缓存命中输入 tokens，按 cacheIn 计（未配置按当前时段输入价计）
 * @param {number} cacheWriteTokens 缓存写入 tokens，按 cacheWrite 计（未配置按当前时段输入价计）
 * @param {number} at 请求发生时刻（毫秒），记账时传明细时间戳，保证按当时所处时段计价
 * 未配置单价的模型成本记 0（前端会显示"未定价"）。
 */
function modelCost(model, promptTokens, completionTokens, cacheTokens = 0, cacheWriteTokens = 0, at = Date.now()) {
  const p = getDb().pricing[model];
  if (!p) return 0;
  let inNow = Math.max(0, Number(p.in) || 0);
  let outNow = Math.max(0, Number(p.out) || 0);
  let cachePrice = p.cacheIn != null ? Math.max(0, Number(p.cacheIn) || 0) : null;
  let writePrice = p.cacheWrite != null ? Math.max(0, Number(p.cacheWrite) || 0) : null;
  // 空闲时段价：模型配置了 idle 且当前（或传入时刻）处于空闲时段才生效
  const idle = p.idle && typeof p.idle === 'object' ? p.idle : null;
  if (idle && isIdleNow(at)) {
    if (idle.in != null) inNow = Math.max(0, Number(idle.in) || 0);
    if (idle.out != null) outNow = Math.max(0, Number(idle.out) || 0);
    if (idle.cacheIn != null) cachePrice = Math.max(0, Number(idle.cacheIn) || 0);
    if (idle.cacheWrite != null) writePrice = Math.max(0, Number(idle.cacheWrite) || 0);
  }
  // 分档计价优先于分时：按本次输入长度选档（现实中同一模型不会既分时又分档）
  if (Array.isArray(p.tiers) && p.tiers.length) {
    const tier = pickTier(p.tiers, promptTokens);
    if (tier) {
      if (tier.in != null) inNow = Math.max(0, Number(tier.in) || 0);
      if (tier.out != null) outNow = Math.max(0, Number(tier.out) || 0);
      if (tier.cacheIn != null) cachePrice = Math.max(0, Number(tier.cacheIn) || 0);
      if (tier.cacheWrite != null) writePrice = Math.max(0, Number(tier.cacheWrite) || 0);
    }
  }
  if (cachePrice == null) cachePrice = inNow;
  if (writePrice == null) writePrice = inNow;
  const hit = Math.min(Math.max(0, cacheTokens || 0), Math.max(0, promptTokens || 0));
  const write = Math.min(Math.max(0, cacheWriteTokens || 0), Math.max(0, (promptTokens || 0) - hit));
  const miss = Math.max(0, (promptTokens || 0) - hit - write);
  const cost = (miss * inNow + hit * cachePrice + write * writePrice + (completionTokens || 0) * outNow) / 1e6;
  // 保留 8 位小数，避免浮点累加误差越滚越大
  return Math.round(cost * 1e8) / 1e8;
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
  delete db.settings.offPeak; // v1.3.0 曾短暂使用单一闲时窗口，已升级为 peak 规则，清理旧字段
  db.stats = db.stats && db.stats.daily ? db.stats : { daily: {} };
  if (!db.pricing || typeof db.pricing !== 'object' || Array.isArray(db.pricing)) db.pricing = {};
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
    dd: dayKey(), dTokens: 0, dReqs: 0, dCost: 0,
    mm: monthKey(), mTokens: 0, mReqs: 0, mCost: 0,
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
  if (c.dd !== today) { c.dd = today; c.dTokens = 0; c.dReqs = 0; c.dCost = 0; }
  if (c.mm !== month) { c.mm = month; c.mTokens = 0; c.mReqs = 0; c.mCost = 0; }
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
      if (isToday) { c.dTokens += v.t || 0; c.dReqs += v.r || 0; c.dCost += v.c || 0; }
      if (isThisMonth) { c.mTokens += v.t || 0; c.mReqs += v.r || 0; c.mCost += v.c || 0; }
    }
    for (const [id, v] of Object.entries(bucket.dept || {})) {
      const c = touchCounter(counters.dept, id);
      if (isToday) { c.dTokens += v.t || 0; c.dReqs += v.r || 0; c.dCost += v.c || 0; }
      if (isThisMonth) { c.mTokens += v.t || 0; c.mReqs += v.r || 0; c.mCost += v.c || 0; }
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
    dayCost: c.dd === today ? Math.round((c.dCost || 0) * 1e6) / 1e6 : 0,
    monthTokens: c.mm === month ? c.mTokens : 0,
    monthReqs: c.mm === month ? c.mReqs : 0,
    monthCost: c.mm === month ? Math.round((c.mCost || 0) * 1e6) / 1e6 : 0,
  };
}

function getDeptUsage(deptId) {
  const c = counters.dept.get(deptId) || blankCounter();
  const today = dayKey();
  const month = monthKey();
  return {
    dayTokens: c.dd === today ? c.dTokens : 0,
    dayReqs: c.dd === today ? c.dReqs : 0,
    dayCost: c.dd === today ? Math.round((c.dCost || 0) * 1e6) / 1e6 : 0,
    monthTokens: c.mm === month ? c.mTokens : 0,
    monthReqs: c.mm === month ? c.mReqs : 0,
    monthCost: c.mm === month ? Math.round((c.mCost || 0) * 1e6) / 1e6 : 0,
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

  // 1) 明细（成本在聚合时按单价表统一计算）
  const entry = {
    id: uid(),
    ts: new Date().toISOString(),
    employeeId: rec.employeeId || '',
    deptId: rec.deptId || '',
    providerId: rec.providerId || '',
    model: rec.model || '',
    promptTokens: Math.round(rec.promptTokens || 0),
    completionTokens: Math.round(rec.completionTokens || 0),
    cacheTokens: Math.round(rec.cacheTokens || 0),
    cacheWriteTokens: Math.round(rec.cacheWriteTokens || 0),
    totalTokens: tokens,
    cost: 0,
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
    // 按请求发生时刻所处时段计价（高峰/空闲），而不是按聚合计算时刻
    entry.cost = modelCost(entry.model, entry.promptTokens, entry.completionTokens, entry.cacheTokens, entry.cacheWriteTokens, new Date(entry.ts).getTime());
    const bucket = d.stats.daily[today] || (d.stats.daily[today] = { emp: {}, dept: {}, models: {} });
    if (entry.employeeId) {
      const e = bucket.emp[entry.employeeId] || (bucket.emp[entry.employeeId] = { t: 0, r: 0, c: 0 });
      e.t += tokens; e.r += 1; e.c = Math.round(((e.c || 0) + entry.cost) * 1e8) / 1e8;
    }
    if (entry.deptId && entry.countDept) {
      const p = bucket.dept[entry.deptId] || (bucket.dept[entry.deptId] = { t: 0, r: 0, c: 0 });
      p.t += tokens; p.r += 1; p.c = Math.round(((p.c || 0) + entry.cost) * 1e8) / 1e8;
    }
    // 模型维度：成本核算与「哪个模型最烧钱」
    if (entry.model) {
      const m = bucket.models[entry.model] || (bucket.models[entry.model] = { t: 0, r: 0, c: 0 });
      m.t += tokens; m.r += 1; m.c = Math.round(((m.c || 0) + entry.cost) * 1e8) / 1e8;
    }
  }

  // 3) 内存计数器
  if (entry.status === 'ok' && tokens > 0) {
    if (entry.employeeId) {
      const c = touchCounter(counters.emp, entry.employeeId);
      c.dTokens += tokens; c.dReqs += 1; c.mTokens += tokens; c.mReqs += 1;
      c.dCost = (c.dCost || 0) + entry.cost; c.mCost = (c.mCost || 0) + entry.cost;
    }
    if (entry.deptId && entry.countDept) {
      const c = touchCounter(counters.dept, entry.deptId);
      c.dTokens += tokens; c.dReqs += 1; c.mTokens += tokens; c.mReqs += 1;
      c.dCost = (c.dCost || 0) + entry.cost; c.mCost = (c.mCost || 0) + entry.cost;
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

/** 7 日趋势（用于概览页图表），带成本 */
function trend7() {
  const daily = getDb().stats.daily || {};
  return lastDays(7).map((dk) => {
    const b = daily[dk] || { emp: {}, dept: {}, models: {} };
    let tokens = 0, reqs = 0, cost = 0;
    for (const v of Object.values(b.emp || {})) {
      tokens += v.t || 0; reqs += v.r || 0; cost += v.c || 0;
    }
    return { date: dk, tokens, reqs, cost: Math.round(cost * 1e4) / 1e4 };
  });
}

module.exports = {
  DATA_DIR, DB_FILE,
  load, save, saveNow, getDb,
  sha256, uid,
  dayKey, monthKey, lastDays,
  rebuildCounters, getEmpUsage, getDeptUsage,
  hitRpm, peekRpm, enterInflight, leaveInflight, getInflight,
  recordUsage, modelCost, isPeakNow, isIdleNow, findEmployeeByKey, findDept, findEmployee, genKey, trend7,
};

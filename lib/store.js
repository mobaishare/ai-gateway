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
const { PRESETS, presetPricing } = require('./preset-prices');
const { evalFormula } = require('./formula');

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
      // 全局默认告警阈值与维度（部门/员工可各自覆盖，见 department.alert / employee.alert）
      alertThresholds: [80, 100],
      alertDimensions: ['dailyTokens', 'monthlyTokens'],
      // 调用日志内容留存：off=只记用量；summary=摘要（按 logContentMax 截断）；full=尽量完整
      logContent: 'summary',
      logContentMax: 2000,
      // 流式请求自动补 stream_options.include_usage，让上游返回真实 usage。
      // 不补的话上游默认不回 usage，网关只能按文本估算，和厂商账单对不上。
      streamUsage: true,
      // 全局高峰时段规则（北京时间 UTC+8）：默认**关闭**。
      // v1.6 起分时计价交给每个模型自己的「自定义时段」（pricing[model].periods），
      // 这里只作兜底：某模型填了 idle 却没配 periods 时，才需要打开它。
      peak: {
        enabled: false,
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

/** 解析 "HH:MM" 为当天分钟数，非法返回 null（允许 24:00 表示当天结束） */
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59) return null;
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

/**
 * 解析「生效星期」写法 → 0-6 数组（0=周日）
 * 支持 "1-5"（区间，可跨周如 "5-1"）、"0,6"、"1,3,5"、"周一" 之外的中文不认；空值返回 null（= 每天）
 */
function parseDaySpec(v) {
  if (v == null || String(v).trim() === '') return null;
  if (Array.isArray(v)) {
    const list = [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort((a, b) => a - b);
    return list.length ? list : null;
  }
  const out = new Set();
  for (const part of String(v).split(/[,，\s]+/).filter(Boolean)) {
    const range = /^([0-6])\s*[-~]\s*([0-6])$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a <= b) for (let i = a; i <= b; i++) out.add(i);
      else { for (let i = a; i <= 6; i++) out.add(i); for (let i = 0; i <= b; i++) out.add(i); }
    } else if (/^[0-6]$/.test(part)) {
      out.add(Number(part));
    } else {
      return null; // 出现无法识别的片段，交给调用方报错
    }
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/** 解析时段窗口写法 "09:00-12:00, 14:00-18:00" → [['09:00','12:00'], ...]；非法返回 null */
function parseWindowSpec(v) {
  const parts = String(v || '').split(/[,，;；]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const m = /^(\d{1,2}:\d{2})\s*[-~—至]\s*(\d{1,2}:\d{2})$/.exec(p);
    if (!m) return null;
    const a = parseHM(m[1]);
    const b = parseHM(m[2]);
    if (a == null || b == null || a === b) return null;
    out.push([normHM(m[1]), normHM(m[2])]);
  }
  return out.length ? out : null;
}

/** "9:00" → "09:00"，保持存储格式统一 */
function normHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  return m ? `${String(Number(m[1])).padStart(2, '0')}:${m[2]}` : String(s || '');
}

/**
 * 按「模型自定义时段」挑选价格：数组顺序即优先级，先命中先用。
 * periods: [{ name, days?: [0-6], windows?: [['HH:MM','HH:MM']], dates?: ['YYYY-MM-DD'], in?, out?, cacheIn?, cacheWrite? }]
 * - 配了 dates（指定日期）时当天整日生效，且**优先于按星期的段**（大促/节假日特价总能盖住常规时段）
 * - days 缺省 = 每天；windows 支持跨零点（如 22:00-06:00）
 * - 都不命中返回 null（记账回落基础价）
 * 时段按北京时间 UTC+8 判断，与服务器时区无关。
 */
function pickPeriod(periods, at = Date.now()) {
  if (!Array.isArray(periods) || !periods.length) return null;
  const d = new Date(at + 8 * 3600 * 1000);
  const dateStr = d.toISOString().slice(0, 10);
  const dow = d.getUTCDay();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  // 第一轮：指定日期的段整日生效，优先于按星期的时间窗段
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    if (!p || typeof p !== 'object') continue;
    if (Array.isArray(p.dates) && p.dates.length && p.dates.includes(dateStr)) {
      return { index: i, name: String(p.name || ''), period: p };
    }
  }
  // 第二轮：按星期 + 时间窗，数组顺序即优先级
  for (let i = 0; i < periods.length; i++) {
    const p = periods[i];
    if (!p || typeof p !== 'object') continue;
    if (Array.isArray(p.dates) && p.dates.length) continue;
    const days = Array.isArray(p.days) && p.days.length ? p.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    if (!days.includes(dow)) continue;
    const windows = Array.isArray(p.windows) ? p.windows : [];
    for (const [s, e] of windows) {
      const a = parseHM(s);
      const b = parseHM(e);
      if (a == null || b == null) continue;
      const hit = a < b ? mins >= a && mins < b : mins >= a || mins < b;
      if (hit) return { index: i, name: String(p.name || ''), period: p };
    }
  }
  return null;
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
 * 按单价表计算一次调用的成本明细（元）。覆盖国内外主流计费模式：
 * pricing: {
 *   in, out,                    // 高峰/默认：输入、输出单价
 *   cacheIn?,                   // 缓存命中输入价（OpenAI cached_tokens、DeepSeek/Kimi 缓存命中）
 *   cacheWrite?,                // 缓存写入价（Anthropic cache_creation，官方为输入价 1.25 倍需自行填）
 *   idle?: { in, out, cacheIn?, cacheWrite? },              // 空闲时段价（DeepSeek 谷时），时段由 settings.peak 决定
 *   periods?: [{ name, days?, windows?, dates?, in?, out?, cacheIn?, cacheWrite? }],
 *                                                          // 模型自定义时段价：自带时间规则，优先级高于 idle 与全局 peak
 *   tiers?: [{ upTo, in, out, cacheIn?, cacheWrite? }],     // 按输入长度分档（Qwen 阶梯价、Gemini 长上下文加价）；配置后优先于分时
 *   perCall?,                   // 每次调用固定费用（元），叠加在 token 费用上
 *   multiplier?,                // 成本倍率（加价/折扣），最后相乘，默认 1
 *   formula?,                   // 自定义公式（直接算出这一步费用，元）；写错时回落到内置公式并在明细里给出错误
 *   note?,                      // 计费备注，只做展示
 * }
 * @param {string} model 模型名
 * @param {number} promptTokens 输入 tokens（含缓存命中/写入部分）
 * @param {number} completionTokens 输出 tokens
 * @param {number} cacheTokens 缓存命中输入 tokens，按 cacheIn 计（未配置按当前时段输入价计）
 * @param {number} cacheWriteTokens 缓存写入 tokens，按 cacheWrite 计（未配置按当前时段输入价计）
 * @param {number} at 请求发生时刻（毫秒），记账时传明细时间戳，保证按当时所处时段计价
 * @param {object} [entry] 可选：直接传入一份定价对象（试算未保存的配置时用）
 * 未配置单价的模型成本记 0（前端显示「未定价」）。
 */
function modelCostDetail(model, promptTokens, completionTokens, cacheTokens = 0, cacheWriteTokens = 0, at = Date.now(), entry) {
  const p = entry || getDb().pricing[model];
  const detail = {
    priced: !!p,
    base: 0,
    formula: null,       // 公式算出的金额（未配公式为 null）
    formulaError: '',
    perCall: 0,
    multiplier: 1,
    total: 0,
    idle: false,
    period: null,        // 命中的「模型自定义时段」：{ index, name }
    tierUpTo: 0,
    prices: { in: 0, out: 0, cacheIn: 0, cacheWrite: 0 },
    tokens: { prompt: 0, completion: 0, cacheHit: 0, cacheWrite: 0, miss: 0 },
  };
  if (!p) return detail;

  const prompt = Math.max(0, Number(promptTokens) || 0);
  const completion = Math.max(0, Number(completionTokens) || 0);

  let inNow = Math.max(0, Number(p.in) || 0);
  let outNow = Math.max(0, Number(p.out) || 0);
  let cachePrice = p.cacheIn != null ? Math.max(0, Number(p.cacheIn) || 0) : null;
  let writePrice = p.cacheWrite != null ? Math.max(0, Number(p.cacheWrite) || 0) : null;
  const idle = p.idle && typeof p.idle === 'object' ? p.idle : null;
  // 模型自定义时段（periods）：优先级高于「idle + 全局峰谷规则」
  // 只要模型配了 periods，就完全按它自己的时段表判价，不再参考 settings.peak
  const periods = Array.isArray(p.periods) ? p.periods.filter((x) => x && typeof x === 'object') : [];
  const hitPeriod = periods.length ? pickPeriod(periods, at) : null;
  if (hitPeriod) {
    detail.period = { index: hitPeriod.index, name: hitPeriod.name || `时段 ${hitPeriod.index + 1}` };
    const pp = hitPeriod.period;
    if (pp.in != null) inNow = Math.max(0, Number(pp.in) || 0);
    if (pp.out != null) outNow = Math.max(0, Number(pp.out) || 0);
    if (pp.cacheIn != null) cachePrice = Math.max(0, Number(pp.cacheIn) || 0);
    if (pp.cacheWrite != null) writePrice = Math.max(0, Number(pp.cacheWrite) || 0);
  } else if (idle && isIdleNow(at)) {
    // 空闲时段价：模型配置了 idle 且当前（或传入时刻）处于空闲时段才生效
    detail.idle = true;
    if (idle.in != null) inNow = Math.max(0, Number(idle.in) || 0);
    if (idle.out != null) outNow = Math.max(0, Number(idle.out) || 0);
    if (idle.cacheIn != null) cachePrice = Math.max(0, Number(idle.cacheIn) || 0);
    if (idle.cacheWrite != null) writePrice = Math.max(0, Number(idle.cacheWrite) || 0);
  }
  // 分档计价优先于分时：按本次输入长度选档（现实中同一模型不会既分时又分档）
  if (Array.isArray(p.tiers) && p.tiers.length) {
    const tier = pickTier(p.tiers, prompt);
    if (tier) {
      detail.tierUpTo = Number(tier.upTo) || 0;
      if (tier.in != null) inNow = Math.max(0, Number(tier.in) || 0);
      if (tier.out != null) outNow = Math.max(0, Number(tier.out) || 0);
      if (tier.cacheIn != null) cachePrice = Math.max(0, Number(tier.cacheIn) || 0);
      if (tier.cacheWrite != null) writePrice = Math.max(0, Number(tier.cacheWrite) || 0);
    }
  }
  if (cachePrice == null) cachePrice = inNow;
  if (writePrice == null) writePrice = inNow;

  const hit = Math.min(Math.max(0, cacheTokens || 0), prompt);
  const write = Math.min(Math.max(0, cacheWriteTokens || 0), Math.max(0, prompt - hit));
  const miss = Math.max(0, prompt - hit - write);
  const base = (miss * inNow + hit * cachePrice + write * writePrice + completion * outNow) / 1e6;

  detail.base = Math.round(base * 1e8) / 1e8;
  detail.prices = { in: inNow, out: outNow, cacheIn: cachePrice, cacheWrite: writePrice };
  detail.tokens = { prompt, completion, cacheHit: hit, cacheWrite: write, miss };

  // 自定义公式：变量见下方 vars，结果单位同为元
  let amount = base;
  if (p.formula && String(p.formula).trim()) {
    const r = evalFormula(p.formula, {
      prompt, completion,
      cacheHit: hit, cacheWrite: write, miss,
      calls: 1,
      inPrice: inNow, outPrice: outNow,
      cacheInPrice: cachePrice, cacheWritePrice: writePrice,
      base,
    });
    if (r.ok) {
      detail.formula = Math.round(r.value * 1e8) / 1e8;
      amount = r.value;
    } else {
      detail.formulaError = r.error;
    }
  }

  const perCall = Math.max(0, Number(p.perCall) || 0);
  const multRaw = p.multiplier == null ? 1 : Number(p.multiplier);
  const multiplier = Number.isFinite(multRaw) && multRaw >= 0 ? multRaw : 1;
  detail.perCall = perCall;
  detail.multiplier = multiplier;

  const total = Math.max(0, (amount + perCall) * multiplier);
  detail.total = Math.round(total * 1e8) / 1e8;
  return detail;
}

/** 只取金额的便捷封装（记账与展示都用它，保证口径一致） */
function modelCost(model, promptTokens, completionTokens, cacheTokens = 0, cacheWriteTokens = 0, at = Date.now()) {
  return modelCostDetail(model, promptTokens, completionTokens, cacheTokens, cacheWriteTokens, at).total;
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
  // 告警发送记录（最近 200 条，给「最近告警」列表用）
  if (!Array.isArray(db.stats.alertLog)) db.stats.alertLog = [];

  // 官方参考价自动补全：价目表版本变化时，把参考价写进「尚未定价」的模型
  // 已有自定义价的模型不覆盖（要覆盖可在渠道页点「载入官方参考价」）
  if (db.settings.presetsVersion !== PRESETS.updatedAt) {
    const presets = presetPricing();
    for (const [m, p] of Object.entries(presets)) {
      if (!db.pricing[m]) db.pricing[m] = p;
    }
    db.settings.presetsVersion = PRESETS.updatedAt;
  }

  // v1.6：分时计价从「全局高峰规则 + 模型 idle」改为「每个模型自带时段表」
  upgradeToModelPeriods(db);
  return db;
}

/** 分钟数 → "HH:MM" */
function mmToHM(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * 把「高峰时间窗」取补集，得到同一天内的空闲时间窗。
 * 用于把模型的 idle 价翻译成 periods 里的空闲段（支持跨零点窗口）。
 */
function complementWindows(windows) {
  const segs = [];
  for (const w of Array.isArray(windows) ? windows : []) {
    if (!Array.isArray(w) || w.length !== 2) continue;
    const a = parseHM(w[0]);
    const b = parseHM(w[1]);
    if (a == null || b == null || a === b) continue;
    if (a < b) segs.push([a, b]);
    else { segs.push([a, 1440]); if (b > 0) segs.push([0, b]); }
  }
  segs.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of segs) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  const out = [];
  let cur = 0;
  for (const [a, b] of merged) {
    if (a > cur) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (cur < 1440) out.push([cur, 1440]);
  return out.map(([a, b]) => [mmToHM(a), mmToHM(b)]);
}

/**
 * v1.6 迁移：把「全局高峰规则 + 模型 idle」翻译成每个模型自己的时段表（periods），
 * 同时把全局高峰规则默认关掉——分时怎么算、算哪个时间段，今后由每个模型自己决定。
 *
 * - 只跑一次（`settings.periodsMigrated`），之后管理员手动打开全局规则不会被再次关闭
 * - 迁移后计价结果与之前一致：高峰段沿用基础价，其余时段（含周末、法定节假日）用 idle 价
 * - 已经配过 periods 的模型完全不动
 */
function upgradeToModelPeriods(db) {
  const st = db.settings;
  if (st.periodsMigrated) return;
  st.periodsMigrated = true;

  const peak = st.peak && typeof st.peak === 'object' ? st.peak : {};
  // 1) 全局规则默认关闭
  st.peak = Object.assign({}, peak, { enabled: false });

  const days = Array.isArray(peak.days) && peak.days.length
    ? [...new Set(peak.days.map(Number).filter((d) => d >= 0 && d <= 6))]
    : [1, 2, 3, 4, 5];
  const wins = (Array.isArray(peak.windows) && peak.windows.length ? peak.windows : [['09:00', '12:00'], ['14:00', '18:00']])
    .filter((w) => Array.isArray(w) && w.length === 2 && parseHM(w[0]) != null && parseHM(w[1]) != null);
  const holidays = Array.isArray(peak.holidays)
    ? peak.holidays.map((x) => String(x || '').trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
    : [];
  const offDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => !days.includes(d));
  const idleWins = complementWindows(wins);
  // 周一至周五的常见配置用与内置参考价一致的名字，读日志/看界面时更直观
  const weekdayOnly = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));

  const priceOf = (src) => {
    const o = {};
    for (const k of ['in', 'out', 'cacheIn', 'cacheWrite']) {
      if (src && src[k] != null && src[k] !== '') o[k] = Math.max(0, Number(src[k]) || 0);
    }
    return o;
  };

  let count = 0;
  for (const p of Object.values(db.pricing || {})) {
    if (!p || typeof p !== 'object') continue;
    if (!p.idle || typeof p.idle !== 'object') continue;
    if (Array.isArray(p.periods) && p.periods.length) continue;
    if (!wins.length || !days.length) continue;

    // 高峰段不写价格 = 沿用基础价，这样管理员改基础价时高峰价自动跟随
    const list = [{
      name: weekdayOnly ? '高峰·工作日' : '高峰',
      days,
      windows: wins.map((w) => [normHM(w[0]), normHM(w[1])]),
    }];
    if (idleWins.length) {
      list.push({ name: weekdayOnly ? '空闲·工作日' : '空闲', days, windows: idleWins, ...priceOf(p.idle) });
    }
    if (offDays.length) {
      list.push({
        name: weekdayOnly ? '空闲·周末' : '空闲·非高峰日',
        days: offDays,
        windows: [['00:00', '24:00']],
        ...priceOf(p.idle),
      });
    }
    if (holidays.length) list.push({ name: '节假日', dates: holidays, ...priceOf(p.idle) });

    p.periods = list;
    count++;
  }
  if (count) {
    console.log(`[store] 已把 ${count} 个模型的空闲价转成模型自定义时段表，全局高峰规则默认关闭`);
  }
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

// ---------------------------------------------------------------- 日志内容打包

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{6,})/g;

/** 抹掉内容里可能出现的密钥，避免日志变成第二个密钥泄漏面 */
function maskSecrets(s) {
  return String(s == null ? '' : s)
    .replace(SECRET_RE, (m) => m.slice(0, 5) + '***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, '$1***');
}

function clip(s, n) {
  const str = String(s == null ? '' : s);
  if (!(n > 0)) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

/**
 * 按 settings.logContent / logContentMax 把请求与响应压成可落盘的摘要：
 *   off     —— 完全不记内容，只记用量
 *   summary —— 按 logContentMax 截断（默认 2000 字符）
 *   full    —— 尽量完整，硬上限 20000 字符
 * 超长时优先保留最近的几条消息（排障最关心最后一次提问）。
 */
function packLogContent(rec) {
  const s = getDb().settings;
  const mode = s.logContent || 'summary';
  if (mode === 'off') return null;
  const cap = Math.min(20000, Math.max(200, Number(s.logContentMax) || 2000));
  const max = mode === 'full' ? 20000 : cap;
  const out = {};

  const req = rec.request;
  if (req && Array.isArray(req.messages) && req.messages.length) {
    const msgs = req.messages
      .map((m) => ({ role: String((m && m.role) || ''), content: maskSecrets((m && m.content) || '') }))
      .filter((m) => m.role || m.content);
    const totalChars = msgs.reduce((n, m) => n + m.content.length, 0);
    let truncated = false;
    let kept = msgs;
    if (totalChars > max) {
      truncated = true;
      const keep = [];
      let budget = max;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (budget <= 0) break;
        const m = msgs[i];
        if (m.content.length <= budget) {
          keep.unshift(m);
          budget -= m.content.length;
        } else {
          keep.unshift({ role: m.role, content: clip(m.content, budget) });
          budget = 0;
        }
      }
      kept = keep;
      // system 提示词对排障很重要，被挤掉时补回一条短的
      if (msgs[0].role === 'system' && kept[0] !== msgs[0]) {
        kept.unshift({ role: 'system', content: clip(msgs[0].content, Math.min(400, max)) });
      }
    }
    out.request = { messages: kept, params: req.params || {}, truncated, chars: totalChars };
  }

  if (rec.response != null && rec.response !== '') {
    const full = maskSecrets(rec.response);
    out.response = {
      content: clip(full, max),
      truncated: full.length > max,
      chars: full.length,
      finishReason: rec.finishReason || '',
    };
  } else if (rec.finishReason) {
    out.response = { content: '', truncated: false, chars: 0, finishReason: rec.finishReason };
  }

  if (Array.isArray(rec.attempts) && rec.attempts.length) {
    out.attempts = rec.attempts.slice(0, 8);
  }
  return Object.keys(out).length ? out : null;
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
    usageSource: rec.usageSource || '',     // upstream=上游给了 usage，estimated=按文本估算
    upstreamModel: rec.upstreamModel || '', // 上游实际返回的模型名（可能被渠道改写过）
    log: packLogContent(rec),
  };
  d.usage.push(entry);
  if (d.usage.length > USAGE_DETAIL_LIMIT) {
    d.usage.splice(0, d.usage.length - USAGE_DETAIL_LIMIT);
  }

  // 2) 聚合表（只统计成功/计费的请求，用于额度）
  if (entry.status === 'ok' && tokens > 0) {
    // 按请求发生时刻所处时段计价（高峰/空闲），而不是按聚合计算时刻
    const detail = modelCostDetail(entry.model, entry.promptTokens, entry.completionTokens, entry.cacheTokens, entry.cacheWriteTokens, new Date(entry.ts).getTime());
    entry.cost = detail.total;
    // 只留展示需要的字段，别把整个明细塞进每条日志
    entry.costDetail = {
      base: detail.base,
      formula: detail.formula,
      formulaError: detail.formulaError,
      perCall: detail.perCall,
      multiplier: detail.multiplier,
      idle: detail.idle,
      period: detail.period,
      tierUpTo: detail.tierUpTo,
      prices: detail.prices,
    };
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
  sha256, uid, maskSecrets, packLogContent,
  dayKey, monthKey, lastDays,
  rebuildCounters, getEmpUsage, getDeptUsage,
  hitRpm, peekRpm, enterInflight, leaveInflight, getInflight,
  recordUsage, modelCost, modelCostDetail, isPeakNow, isIdleNow, findEmployeeByKey, findDept, findEmployee, genKey, trend7,
  parseHM, normHM, parseDaySpec, parseWindowSpec, pickPeriod,
};

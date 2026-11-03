'use strict';

/**
 * 用量告警 —— 额度跨过阈值时推送到飞书 / 企业微信机器人
 *
 * 触发点：网关记账完成后调用 check()（见 server.js 第 5 步）。
 *
 * 通道与阈值按「员工 → 部门 → 全局」逐级回退，因此可以做到：
 *   - 每个部门配自己的群（例如客服部单独一个告警群）
 *   - 每个人配自己的群或自己的阈值（例如主管只要 95% 才提醒）
 *   - 都没配时落到「系统设置」里的全局机器人，行为与旧版本一致
 *
 * 防打扰设计：
 *   1. 每个告警对象（员工 / 部门）× 每个维度（日、月 Token）× 每个阈值 ×
 *      每个统计周期只发一次；状态存在 db.stats.alerts，随统计一起落盘，
 *      重启不会重复发。
 *   2. 发送是异步 fire-and-forget，失败只打日志，绝不阻塞或影响调用请求。
 *   3. 每次发送结果写进 db.stats.alertLog（最近 200 条），供管理台「最近告警」查看。
 *
 * 机器人格式按 URL 自动识别：
 *   open.feishu.cn / *.larksuite.com → 飞书自定义机器人
 *   qyapi.weixin.qq.com              → 企业微信群机器人
 *   其他地址                          → 按飞书格式发
 */

const store = require('./store');

const DIM_LABEL = { dailyTokens: '日 Token', monthlyTokens: '月 Token' };
const DIMENSIONS = Object.keys(DIM_LABEL);
const DEFAULT_THRESHOLDS = [80, 100];
const ALERT_LOG_LIMIT = 200;

function isUrl(v) {
  return /^https?:\/\//.test(String(v || '').trim());
}

/** 阈值归一化：1–100 的整数，升序去重；空数组表示「继承上级」 */
function normThresholds(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 100).map((n) => Math.round(n)))].sort((a, b) => a - b);
}

/** 维度归一化；空数组表示「继承上级」 */
function normDimensions(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(String).filter((d) => DIMENSIONS.includes(d)))];
}

/** 某个对象自己是否配置了有效的告警（enable + 有地址或阈值） */
function ownAlert(a) {
  if (!a || !a.enabled) return null;
  return {
    webhookUrl: isUrl(a.webhookUrl) ? String(a.webhookUrl).trim() : '',
    thresholds: normThresholds(a.thresholds),
    dimensions: normDimensions(a.dimensions),
  };
}

/**
 * 解析某员工 / 部门实际使用的告警通道、阈值与维度
 * @returns {{employee: object, department: object}}
 */
function resolve(employee, dept, settings) {
  const s = settings || store.getDb().settings;
  const empA = ownAlert(employee && employee.alert);
  const deptA = ownAlert(dept && dept.alert);
  const globalUrl = isUrl(s.webhookUrl) ? String(s.webhookUrl).trim() : '';
  const globalThresholds = normThresholds(s.alertThresholds);
  const globalDims = normDimensions(s.alertDimensions);

  const empUrl = (empA && empA.webhookUrl) || (deptA && deptA.webhookUrl) || globalUrl;
  const empSource = empA && empA.webhookUrl ? 'employee' : ((deptA && deptA.webhookUrl) ? 'department' : (globalUrl ? 'global' : ''));
  const empThresholds = (empA && empA.thresholds.length ? empA.thresholds : null)
    || (deptA && deptA.thresholds.length ? deptA.thresholds : null)
    || (globalThresholds.length ? globalThresholds : DEFAULT_THRESHOLDS);
  const empDims = (empA && empA.dimensions.length ? empA.dimensions : null)
    || (deptA && deptA.dimensions.length ? deptA.dimensions : null)
    || (globalDims.length ? globalDims : DIMENSIONS);

  const deptUrl = (deptA && deptA.webhookUrl) || globalUrl;
  const deptSource = deptA && deptA.webhookUrl ? 'department' : (globalUrl ? 'global' : '');
  const deptThresholds = (deptA && deptA.thresholds.length ? deptA.thresholds : null)
    || (globalThresholds.length ? globalThresholds : DEFAULT_THRESHOLDS);
  const deptDims = (deptA && deptA.dimensions.length ? deptA.dimensions : null)
    || (globalDims.length ? globalDims : DIMENSIONS);

  return {
    employee: { url: empUrl, source: empSource, thresholds: empThresholds, dimensions: empDims },
    department: { url: deptUrl, source: deptSource, thresholds: deptThresholds, dimensions: deptDims },
  };
}

function periodOf(dim) {
  return dim.startsWith('daily') ? store.dayKey() : store.monthKey();
}

/** 去重状态：跨天时保留仍在统计周期内的键（月维度的键要留到月底） */
function stateBucket() {
  const db = store.getDb();
  const today = store.dayKey();
  const month = store.monthKey();
  if (!db.stats.alerts || db.stats.alerts.day !== today) {
    const prev = (db.stats.alerts && db.stats.alerts.sent) || {};
    const sent = {};
    for (const [k, v] of Object.entries(prev)) {
      if (k.endsWith(':' + today) || k.endsWith(':' + month)) sent[k] = v;
    }
    db.stats.alerts = { day: today, month, sent };
  }
  return db.stats.alerts;
}

/** 飞书自定义机器人 */
function feishuPayload(text) {
  return { msg_type: 'text', content: { text } };
}

/** 企业微信群机器人 */
function wecomPayload(text) {
  return { msgtype: 'text', text: { content: text } };
}

function detectType(url) {
  if (/open\.feishu\.cn|\.larksuite\.com/i.test(url)) return 'feishu';
  if (/qyapi\.weixin\.qq\.com/i.test(url)) return 'wecom';
  return 'feishu'; // 默认按飞书格式，飞书 webhook 校验较宽松
}

async function send(url, text) {
  const type = detectType(url);
  const payload = type === 'wecom' ? wecomPayload(text) : feishuPayload(text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await r.text().catch(() => '');
    if (!r.ok) return { ok: false, message: `HTTP ${r.status} ${body.slice(0, 120)}` };
    // 飞书/企微业务错误都是 HTTP 200 + code 字段
    try {
      const j = JSON.parse(body);
      if (j.code && j.code !== 0) return { ok: false, message: `code=${j.code} ${j.msg || ''}` };
      if (j.errcode && j.errcode !== 0) return { ok: false, message: `errcode=${j.errcode} ${j.errmsg || ''}` };
    } catch { /* 非 JSON 响应，HTTP 200 就算成功 */ }
    return { ok: true, message: '已发送', type };
  } catch (e) {
    return { ok: false, message: controller.signal.aborted ? '超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

function fmtPct(used, limit) {
  return limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
}

function logAlert(entry) {
  const db = store.getDb();
  if (!Array.isArray(db.stats.alertLog)) db.stats.alertLog = [];
  db.stats.alertLog.push({ id: store.uid(), ts: new Date().toISOString(), ...entry });
  if (db.stats.alertLog.length > ALERT_LOG_LIMIT) {
    db.stats.alertLog.splice(0, db.stats.alertLog.length - ALERT_LOG_LIMIT);
  }
  store.save();
}

function channelText(source) {
  return { employee: '员工专属通道', department: '部门通道', global: '全局通道', '': '未配置' }[source] || source;
}

function buildText({ platformName, target, name, deptName, dim, percent, used, limit, source }) {
  const title = target === 'employee' ? '个人额度预警' : '部门池预警';
  const who = target === 'employee' ? `${name}（${deptName || '未分配部门'}）` : `部门「${name}」`;
  const dimText = DIM_LABEL[dim] || dim;
  return `【${platformName || 'AI 网关'}】${title}\n`
    + `${who}${dimText}已达 ${percent}%：${Number(used).toLocaleString('en-US')} / ${Number(limit).toLocaleString('en-US')}\n`
    + `通道：${channelText(source)}`;
}

/**
 * 记账后检查是否需要告警
 * @param {object} p { employee, dept, effective, platformName }
 * @returns {Array} 本次新产生的告警任务（主要是给测试和排障用）
 */
function check({ employee, dept, effective, platformName }) {
  const s = store.getDb().settings;
  if (!s.alertsEnabled) return [];

  const routes = resolve(employee, dept, s);
  const bucket = stateBucket();
  const tasks = [];
  const empUsage = store.getEmpUsage(employee.id);

  // —— 员工维度：阈值/通道按「员工 → 部门 → 全局」解析
  const empRoute = routes.employee;
  if (empRoute.url) {
    for (const dim of empRoute.dimensions) {
      const field = effective && effective.fields ? effective.fields[dim] : null;
      const limit = field ? field.value : 0;
      if (!(limit > 0)) continue;                 // 0 = 不限，不告警
      const used = dim === 'dailyTokens' ? empUsage.dayTokens : empUsage.monthTokens;
      const pct = fmtPct(used, limit);
      for (const th of empRoute.thresholds) {
        if (pct < th) continue;
        const key = `emp:${employee.id}:${dim}:${th}:${periodOf(dim)}`;
        if (bucket.sent[key]) continue;
        bucket.sent[key] = true;
        tasks.push({
          url: empRoute.url,
          target: 'employee',
          targetId: employee.id,
          targetName: employee.name,
          deptName: dept ? dept.name : '',
          dim,
          threshold: th,
          percent: pct,
          used,
          limit,
          source: empRoute.source,
          text: buildText({ platformName, target: 'employee', name: employee.name, deptName: dept ? dept.name : '', dim, percent: pct, used, limit, source: empRoute.source }),
        });
      }
    }
  }

  // —— 部门维度（该员工占池时才检查，避免未占池的调用误报）
  const deptRoute = routes.department;
  if (dept && effective && effective.countAgainstDept && deptRoute.url) {
    const usage = store.getDeptUsage(dept.id);
    for (const dim of deptRoute.dimensions) {
      const limit = dim === 'dailyTokens'
        ? Number(dept.quota && dept.quota.dailyTokens) || 0
        : Number(dept.quota && dept.quota.monthlyTokens) || 0;
      if (!(limit > 0)) continue;
      const used = dim === 'dailyTokens' ? usage.dayTokens : usage.monthTokens;
      const pct = fmtPct(used, limit);
      for (const th of deptRoute.thresholds) {
        if (pct < th) continue;
        const key = `dept:${dept.id}:${dim}:${th}:${periodOf(dim)}`;
        if (bucket.sent[key]) continue;
        bucket.sent[key] = true;
        tasks.push({
          url: deptRoute.url,
          target: 'department',
          targetId: dept.id,
          targetName: dept.name,
          deptName: dept.name,
          dim,
          threshold: th,
          percent: pct,
          used,
          limit,
          source: deptRoute.source,
          text: buildText({ platformName, target: 'department', name: dept.name, dim, percent: pct, used, limit, source: deptRoute.source }),
        });
      }
    }
  }

  if (!tasks.length) return [];
  store.save(); // sent 标记落盘（防抖），先于发送，保证不重复
  for (const t of tasks) {
    send(t.url, t.text).then((r) => {
      if (!r.ok) console.error('[alerts] 告警发送失败:', r.message);
      logAlert({
        target: t.target,
        targetId: t.targetId,
        targetName: t.targetName,
        deptName: t.deptName,
        dimension: t.dim,
        threshold: t.threshold,
        percent: t.percent,
        used: t.used,
        limit: t.limit,
        channel: t.source,
        ok: r.ok,
        message: r.message,
        text: t.text,
      });
    });
  }
  return tasks;
}

/** 设置页「发送测试消息」 */
async function testWebhook(url, opts = {}) {
  const text =
    `【${store.getDb().settings.platformName || 'AI 网关'}】这是一条测试消息。\n`
    + `收到即表示用量告警通道配置成功，额度用到阈值时会推送到这里。`;
  const r = await send(url, text);
  // 测试消息同样记入「最近告警」，否则设置页只能看到部门/员工的测试，看不到全局的
  if (opts.log !== false) {
    const s = store.getDb().settings;
    logAlert({
      target: 'global',
      targetName: '全局默认',
      deptName: '',
      dimension: (Array.isArray(s.alertDimensions) && s.alertDimensions[0]) || 'dailyTokens',
      threshold: 0,
      percent: 0,
      used: 0,
      limit: 0,
      channel: 'global',
      ok: !!r.ok,
      message: r.message || '',
      text,
      test: true,
    });
  }
  return r;
}

/**
 * 部门 / 员工卡片上的「测试该对象告警」：使用解析后的真实通道与真实阈值，
 * 消息里写明当前用量，方便确认群里收到的是哪一路。
 */
async function testTarget({ employee, dept, overrideUrl }) {
  const s = store.getDb().settings;
  const routes = resolve(employee, dept, s);
  const route = employee ? routes.employee : routes.department;
  const url = isUrl(overrideUrl) ? String(overrideUrl).trim() : route.url;
  if (!url) return { ok: false, message: '该对象没有可用的告警通道，请先填写 Webhook 或在系统设置里配置全局机器人' };

  const name = employee ? employee.name : (dept ? dept.name : '');
  const dim = route.dimensions[0] || 'dailyTokens';
  const used = employee
    ? (dim === 'dailyTokens' ? store.getEmpUsage(employee.id).dayTokens : store.getEmpUsage(employee.id).monthTokens)
    : (() => {
        const u = store.getDeptUsage(dept.id);
        return dim === 'dailyTokens' ? u.dayTokens : u.monthTokens;
      })();
  const text =
    `【${s.platformName || 'AI 网关'}】告警通道测试\n`
    + `对象：${employee ? `员工「${name}」` : `部门「${name}」`}\n`
    + `实际通道：${channelText(route.source)}\n`
    + `监控维度：${route.dimensions.map((d) => DIM_LABEL[d]).join('、') || '—'}\n`
    + `触发阈值：${route.thresholds.map((t) => t + '%').join(' / ')}\n`
    + `当前用量：${used.toLocaleString('en-US')} tokens（用于验证数值能否正常渲染）`;

  const r = await send(url, text);
  logAlert({
    target: employee ? 'employee' : 'department',
    targetId: employee ? employee.id : (dept ? dept.id : ''),
    targetName: name,
    deptName: dept ? dept.name : '',
    dimension: dim,
    threshold: 0,
    percent: 0,
    used,
    limit: 0,
    channel: route.source,
    ok: r.ok,
    message: r.message,
    text,
    test: true,
  });
  return r;
}

/** 最近告警记录（新的在前） */
function recent(limit = 50) {
  const log = store.getDb().stats.alertLog || [];
  return log.slice(-Math.max(1, Math.min(200, limit))).reverse();
}

module.exports = {
  check, testWebhook, testTarget, recent, resolve, normThresholds, normDimensions,
  THRESHOLDS: DEFAULT_THRESHOLDS, DIMENSIONS, DIM_LABEL,
};

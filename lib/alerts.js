'use strict';

/**
 * 用量告警 —— 额度跨过阈值时推送到飞书 / 企业微信机器人
 *
 * 触发点：网关记账完成后调用 check()（见 server.js 第 5 步）。
 *
 * 防打扰设计：
 *   1. 每个告警对象（员工日额度 / 部门日池）× 每个阈值（80% / 100%）×
 *      每天只发一次。状态存在 db.stats.alerts，随统计一起落盘，
 *      重启不会重复发。
 *   2. 发送是异步 fire-and-forget，失败只打日志，绝不阻塞或影响调用请求。
 *   3. 跨天自动重置（状态里记了日期键）。
 *
 * 机器人格式按 URL 自动识别：
 *   open.feishu.cn / *.larksuite.com → 飞书自定义机器人
 *   qyapi.weixin.qq.com              → 企业微信群机器人
 *   其他地址                          → 按飞书格式发（企业微信也能容错的场景少，明确提示更友好）
 */

const store = require('./store');

const THRESHOLDS = [80, 100];

function stateBucket() {
  const db = store.getDb();
  const today = store.dayKey();
  if (!db.stats.alerts || db.stats.alerts.day !== today) {
    db.stats.alerts = { day: today, sent: {} };
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

/**
 * 记账后检查是否需要告警
 * @param {object} p { employee, dept, effective, platformName }
 */
function check({ employee, dept, effective, platformName }) {
  const s = store.getDb().settings;
  if (!s.alertsEnabled) return;
  const url = String(s.webhookUrl || '').trim();
  if (!/^https?:\/\//.test(url)) return;

  const bucket = stateBucket();
  const tasks = [];

  // —— 员工日额度
  const d = effective.fields.dailyTokens;
  if (d.value > 0) {
    const pct = fmtPct(d.used, d.value);
    for (const th of THRESHOLDS) {
      if (pct >= th) {
        const key = `emp:${employee.id}:${th}`;
        if (!bucket.sent[key]) {
          bucket.sent[key] = true;
          tasks.push(
            `【${platformName || 'AI 网关'}】额度预警\n` +
            `${employee.name}（${dept ? dept.name : '未分配部门'}）` +
            `今日 Token 已达 ${pct}%：${d.used.toLocaleString()} / ${d.value.toLocaleString()}`
          );
        }
      }
    }
  }

  // —— 部门日池（该员工占池时才检查，避免未占池的调用误报）
  if (dept && effective.countAgainstDept) {
    const limit = store.getDb().departments.find((x) => x.id === dept.id)?.quota?.dailyTokens || 0;
    if (limit > 0) {
      const u = store.getDeptUsage(dept.id);
      const pct = fmtPct(u.dayTokens, limit);
      for (const th of THRESHOLDS) {
        if (pct >= th) {
          const key = `dept:${dept.id}:${th}`;
          if (!bucket.sent[key]) {
            bucket.sent[key] = true;
            tasks.push(
              `【${platformName || 'AI 网关'}】部门池预警\n` +
              `部门「${dept.name}」今日 Token 已达 ${pct}%：${u.dayTokens.toLocaleString()} / ${limit.toLocaleString()}`
            );
          }
        }
      }
    }
  }

  if (!tasks.length) return;
  store.save(); // sent 标记落盘（防抖），先于发送，保证不重复
  for (const text of tasks) {
    send(url, text).then((r) => {
      if (!r.ok) console.error('[alerts] 告警发送失败:', r.message);
    });
  }
}

/** 设置页「发送测试消息」 */
async function testWebhook(url) {
  const text =
    `【${store.getDb().settings.platformName || 'AI 网关'}】这是一条测试消息。\n` +
    `收到即表示用量告警通道配置成功，额度用到 80% / 100% 时会推送到这里。`;
  return send(url, text);
}

module.exports = { check, testWebhook, THRESHOLDS };

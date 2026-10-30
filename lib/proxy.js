'use strict';

/**
 * 上游转发层
 *
 * 职责：
 *   1. 渠道分流 —— 按部门绑定的渠道池 + 模型支持 + 权重做加权随机，
 *      失败自动换下一个渠道（failover）。
 *   2. 协议转发 —— 对下游保持 OpenAI 兼容（/v1/chat/completions），
 *      支持 stream / 非 stream。
 *   3. 用量统计 —— 优先读上游返回的真实 usage；上游没给（或流式未开
 *      include_usage）时按文本长度估算，保证额度记账不会漏。
 *
 * 说明：平台自身不暴露任何真实上游密钥，员工只拿虚拟 key，真实 key
 * 只存在于本服务的内存和 db.json 里，不会出现在任何响应体中。
 */

const store = require('./store');

const DEFAULT_TIMEOUT = 120000;

// ---------------------------------------------------------------- 渠道选择

function supportsModel(provider, model) {
  const list = provider.models || [];
  if (!list.length) return true;              // 未填 = 通配
  if (list.includes('*')) return true;
  if (list.includes(model)) return true;
  // 支持通配前缀，如 "gpt-4o*"
  return list.some((m) => m.endsWith('*') && model.startsWith(m.slice(0, -1)));
}

function weightedShuffle(list) {
  // 按权重做不放回的加权抽样：权重高的排前面，同时保留随机性
  const pool = list.slice();
  const out = [];
  while (pool.length) {
    const total = pool.reduce((s, p) => s + Math.max(0.01, Number(p.weight) || 1), 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= Math.max(0.01, Number(pool[i].weight) || 1);
      if (r <= 0) { idx = i; break; }
      idx = i;
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

/**
 * 为一次请求挑选候选渠道（已按优先级排好序）
 * @param {object} p { model, dept, employee }
 */
function pickProviders({ model, dept }) {
  const db = store.getDb();
  let pool = db.providers.filter((p) => p.status === 'active');

  // 部门渠道池：部门若绑定了渠道，只在这些渠道里分流
  if (dept && Array.isArray(dept.providerIds) && dept.providerIds.length) {
    const allowed = new Set(dept.providerIds);
    const subset = pool.filter((p) => allowed.has(p.id));
    if (subset.length) pool = subset;
  }

  pool = pool.filter((p) => supportsModel(p, model || ''));
  return weightedShuffle(pool);
}

// ---------------------------------------------------------------- Token 估算

const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\uac00-\ud7af]/g;

/** 粗略估算：中日韩字符按 1 token/字，其余按 4 字符/token */
function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  const cjk = (text.match(CJK) || []).length;
  const rest = Math.max(0, text.length - cjk);
  return Math.ceil(cjk * 1.0 + rest / 4);
}

/** 从请求 messages 估算 prompt tokens */
function estimatePrompt(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (!m) continue;
    if (typeof m.content === 'string') n += estimateTokens(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string') n += estimateTokens(part.text);
      }
    }
    n += 4; // 每条消息的角色/分隔符开销
  }
  return n + 3;
}

// ---------------------------------------------------------------- 转发

function joinUrl(base, p) {
  const b = String(base || '').replace(/\/+$/, '');
  const path = p.replace(/^\/+/, '');
  // 兼容用户填 https://api.x.com 或 https://api.x.com/v1
  if (/\/v1$/.test(b) && path.startsWith('v1/')) return `${b}/${path.slice(3)}`;
  return `${b}/${path}`;
}

/**
 * 把一次上游调用转发完成（含流式）
 * @returns {Promise<{ok:boolean, status:number, usage:object, providerId:string,
 *                    error?:string, retryable?:boolean}>}
 */
async function forward({ res, body, candidates, timeoutMs }) {
  let lastErr = null;

  for (const provider of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs || timeoutMs || DEFAULT_TIMEOUT);
    const startedAt = Date.now();

    let upstream;
    try {
      upstream = await fetch(joinUrl(provider.baseUrl, 'v1/chat/completions'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
          // 透传幂等键，方便上游排障
          'X-Gateway-Channel': provider.id,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      lastErr = {
        providerId: provider.id,
        error: controller.signal.aborted ? '上游请求超时' : `连接上游失败：${e.message}`,
        retryable: true,
      };
      continue; // 换下一个渠道
    }

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      clearTimeout(timer);
      let msg = `上游返回 ${upstream.status}`;
      try {
        const j = JSON.parse(text);
        msg += '：' + (j.error?.message || j.message || text.slice(0, 200));
      } catch {
        if (text) msg += '：' + text.slice(0, 200);
      }
      lastErr = {
        providerId: provider.id,
        error: msg,
        retryable: upstream.status >= 500 || upstream.status === 429,
      };
      // 4xx 多半是参数问题，换渠道也没用
      if (!lastErr.retryable) {
        return { ok: false, status: upstream.status, usage: {}, providerId: provider.id, error: msg, retryable: false };
      }
      continue;
    }

    // —— 上游已接受，开始回传
    const isStream = !!body.stream;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    try {
      if (isStream && upstream.body) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';        // 用于解析 usage 的累积缓冲
        let completionText = '';
        const MAX_BUF = 512 * 1024;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));

          const chunk = decoder.decode(value, { stream: true });
          if (buf.length < MAX_BUF) buf += chunk;

          // 边流边收集正文，用于上游不给 usage 时兜底估算
          let m;
          const re = /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
          while ((m = re.exec(chunk)) !== null) {
            completionText += m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          }
        }
        res.end();

        // 优先取最后一个 usage 对象
        const matches = [...buf.matchAll(/"usage"\s*:\s*\{([^}]*)\}/g)];
        if (matches.length) {
          const raw = matches[matches.length - 1][1];
          const get = (k) => {
            const mm = raw.match(new RegExp(`"${k}"\\s*:\\s*(\\d+)`));
            return mm ? Number(mm[1]) : 0;
          };
          usage.promptTokens = get('prompt_tokens');
          usage.completionTokens = get('completion_tokens');
          usage.totalTokens = get('total_tokens');
        }
        if (!usage.totalTokens) {
          usage.promptTokens = estimatePrompt(body.messages);
          usage.completionTokens = estimateTokens(completionText);
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }

        clearTimeout(timer);
        return { ok: true, status: 200, usage, providerId: provider.id, latencyMs: Date.now() - startedAt };
      }

      // —— 非流式
      const text = await upstream.text();
      clearTimeout(timer);

      let json = null;
      try { json = JSON.parse(text); } catch { /* 保持原样透传 */ }

      const u = json && json.usage;
      if (u && (u.total_tokens || u.prompt_tokens || u.completion_tokens)) {
        usage.promptTokens = u.prompt_tokens || 0;
        usage.completionTokens = u.completion_tokens || 0;
        usage.totalTokens = u.total_tokens || (usage.promptTokens + usage.completionTokens);
      } else {
        usage.promptTokens = estimatePrompt(body.messages);
        const outText = json?.choices?.[0]?.message?.content || '';
        usage.completionTokens = estimateTokens(typeof outText === 'string' ? outText : JSON.stringify(outText));
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }

      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Gateway-Channel': provider.id,
        });
      }
      res.end(text);
      return { ok: true, status: 200, usage, providerId: provider.id, latencyMs: Date.now() - startedAt };
    } catch (e) {
      clearTimeout(timer);
      lastErr = { providerId: provider.id, error: `回传中断：${e.message}`, retryable: false };
      // 已经写过响应头，无法重试
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return { ok: false, status: 502, usage, providerId: provider.id, error: lastErr.error };
      }
      continue;
    }
  }

  return {
    ok: false,
    status: 502,
    usage: {},
    providerId: '',
    error: lastErr ? lastErr.error : '没有可用的上游渠道',
    retryable: false,
  };
}

// ---------------------------------------------------------------- 模拟响应

/**
 * 没有任何可用渠道时的内置模拟（也用于本地演示/联调）
 * 保证平台在没配真实 key 的情况下也能完整跑通配额流程
 */
function mockReply({ res, body }) {
  const model = body.model || 'mock-model';
  const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
  const question = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const answer =
    `【模拟响应】这是平台内置的占位模型，未配置真实上游渠道时启用。\n` +
    `收到模型「${model}」的请求，用户消息：「${question.slice(0, 120)}」。\n` +
    `配置好上游渠道后，本响应会被真实模型结果替换。`;

  const promptTokens = estimatePrompt(body.messages);
  const completionTokens = estimateTokens(answer);

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const id = 'chatcmpl-mock-' + Date.now();
    const created = Math.floor(Date.now() / 1000);
    const pieces = answer.match(/[\s\S]{1,18}/g) || [];
    let i = 0;
    // 返回 Promise：必须等最后一段写完再让调用方收尾，
    // 否则外层会提前 res.end() 把流截断。
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(timer);
          const final = {
            id, object: 'chat.completion.chunk', created, model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
          };
          res.write(`data: ${JSON.stringify(final)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          resolve({
            usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
            providerId: 'mock',
          });
          return;
        }
        const payload = {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: pieces[i] }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        i++;
      }, 25);
    });
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Gateway-Channel': 'mock' });
  res.end(JSON.stringify({
    id: 'chatcmpl-mock-' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }));
  return { usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }, providerId: 'mock' };
}

/** 探测渠道连通性（管理台"测试"按钮用） */
async function probe(provider, model) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(joinUrl(provider.baseUrl, 'v1/models'), {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      return { ok: false, status: r.status, message: `HTTP ${r.status} ${text.slice(0, 160)}`, latencyMs: Date.now() - startedAt };
    }
    let models = [];
    try {
      const j = JSON.parse(text);
      models = (j.data || []).map((m) => m.id).filter(Boolean).slice(0, 200);
    } catch { /* ignore */ }
    return { ok: true, status: r.status, message: '连通正常', latencyMs: Date.now() - startedAt, models };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, message: controller.signal.aborted ? '超时' : e.message, latencyMs: Date.now() - startedAt };
  }
}

module.exports = { pickProviders, forward, mockReply, probe, estimateTokens, estimatePrompt, supportsModel };

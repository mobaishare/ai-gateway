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

/**
 * 从请求 messages 估算 prompt tokens。
 * tools / tool_calls 必须计入：agent 场景下 20 多个函数定义就占几千到几万 token，
 * 只算 content 会严重低估（实测同一模型能差 3～5 倍）。
 */
function estimatePrompt(messages, tools) {
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
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      try { n += estimateTokens(JSON.stringify(m.tool_calls)); } catch { /* ignore */ }
    }
    n += 4; // 每条消息的角色/分隔符开销
  }
  if (Array.isArray(tools) && tools.length) {
    try { n += estimateTokens(JSON.stringify(tools)); } catch { /* ignore */ }
  }
  return n + 3;
}

/** 安全转数字：上游字段可能是 null / 字符串 / 负数 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 从 SSE 累积缓冲里取最后一个带 usage 的事件。
 * 逐行 JSON.parse 而不是正则：usage 里可能嵌套 prompt_tokens_details，
 * 用 `"usage":{([^}]*)}` 会在第一个 } 处截断，把后面的字段吃掉。
 */
function pickStreamUsage(buf) {
  let found = null;
  for (const line of String(buf || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      if (j && j.usage && typeof j.usage === 'object') found = j.usage;
    } catch { /* 半行或非 JSON 行，跳过 */ }
  }
  return found;
}

// ---------------------------------------------------------------- 请求摘要

/** 把 message.content 转成可读文本（图片/音频只留占位符，避免把 base64 写进日志） */
function messageText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      const type = part.type || '';
      if (type === 'image_url' || type === 'image') return '[图片]';
      if (type === 'input_audio' || type === 'audio') return '[音频]';
      if (type === 'file') return '[文件]';
      return type ? `[${type}]` : '';
    }).filter(Boolean).join('\n');
  }
  try { return JSON.stringify(content); } catch { return ''; }
}

/**
 * 把一次请求压成「日志用」的摘要：消息列表 + 关键参数。
 * 只做结构转换，不做截断（截断策略在 store.packLogContent，按设置变化）。
 */
function summarizeRequest(body) {
  const messages = (Array.isArray(body.messages) ? body.messages : []).map((m) => {
    let content = messageText(m && m.content);
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      try { content += (content ? '\n' : '') + '[tool_calls] ' + JSON.stringify(m.tool_calls); } catch { /* ignore */ }
    }
    if (m && m.tool_call_id) content = `[tool_call_id ${m.tool_call_id}] ${content}`;
    return { role: String((m && m.role) || ''), content };
  }).filter((m) => m.role || m.content);

  const params = {
    stream: !!body.stream,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens != null ? body.max_tokens : body.max_completion_tokens,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    response_format: body.response_format && body.response_format.type ? body.response_format.type : '',
    n: body.n || 1,
  };
  return { messages, params };
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
async function forward({ res, body, candidates, timeoutMs, forceStreamUsage = true, retry }) {
  let lastErr = null;
  const attempts = [];
  let retried = 0;

  // 上游繁忙（503）/ 限流（429）/ 连接抖动基本都是瞬时的：同一个渠道先退避重试几次，
  // 都失败再切下一个渠道。只有一个渠道时，这条路是唯一能自动恢复的手段。
  const retryOn = !(retry && retry.enabled === false);
  const maxTry = retryOn ? Math.max(1, Math.min(6, 1 + (Number(retry && retry.times) || 0))) : 1;
  const baseMs = Math.max(100, Math.min(5000, Number(retry && retry.baseMs) || 800));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 退避等待：有 Retry-After 就听上游的，否则指数退避 + 抖动，避免并发请求同时重试。
   * 上限 10 秒，防止上游给个离谱的值把请求拖死。
   */
  const backoff = async (n, upstream) => {
    let wait = Math.round(baseMs * Math.pow(2, n) * (0.8 + Math.random() * 0.4));
    const ra = upstream && upstream.headers && upstream.headers.get && upstream.headers.get('retry-after');
    if (ra) {
      const sec = Number(String(ra).trim());
      if (Number.isFinite(sec)) wait = Math.round(sec * 1000);
      else {
        const at = Date.parse(ra);
        if (Number.isFinite(at)) wait = at - Date.now();
      }
    }
    await sleep(Math.max(0, Math.min(10000, wait)));
    retried += 1;
  };

  // 流式请求主动要一份 usage：OpenAI 兼容上游默认不返回，
  // 网关就只能按文本估算，而估算值和厂商账单必然对不上。
  // 客户端自己设了 stream_options 就尊重它的选择。
  const wantUsage = forceStreamUsage && !!body.stream;
  const bodyWithUsage = wantUsage && !(body.stream_options && body.stream_options.include_usage != null)
    ? { ...body, stream_options: { ...(body.stream_options || {}), include_usage: true } }
    : body;

  for (const provider of candidates) {
   for (let attempt = 0; attempt < maxTry; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), provider.timeoutMs || timeoutMs || DEFAULT_TIMEOUT);
    const startedAt = Date.now();

    let payload = bodyWithUsage;
    const post = () => fetch(joinUrl(provider.baseUrl, 'v1/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        // 透传幂等键，方便上游排障
        'X-Gateway-Channel': provider.id,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    let upstream;
    try {
      upstream = await post();
      // 少数自建代理不认 stream_options，退回客户端原始请求再试一次，不让它变成 400
      if (!upstream.ok && upstream.status === 400 && payload !== body) {
        const peek = await upstream.clone().text().catch(() => '');
        if (/stream_options|include_usage/i.test(peek)) {
          payload = body;
          upstream = await post();
        }
      }
    } catch (e) {
      clearTimeout(timer);
      lastErr = {
        providerId: provider.id,
        error: controller.signal.aborted ? '上游请求超时' : `连接上游失败：${e.message}`,
        retryable: true,
      };
      attempts.push({ providerId: provider.id, ok: false, status: 0, attempt, error: lastErr.error, latencyMs: Date.now() - startedAt });
      if (attempt < maxTry - 1) await backoff(attempt, null);
      continue; // 还有额度就重试本渠道，否则换下一个渠道
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
      attempts.push({ providerId: provider.id, ok: false, status: upstream.status, attempt, error: msg, latencyMs: Date.now() - startedAt });
      // 4xx 多半是参数问题，重试和换渠道都没用
      if (!lastErr.retryable) {
        return { ok: false, status: upstream.status, usage: {}, providerId: provider.id, error: msg, retryable: false, attempts };
      }
      if (attempt < maxTry - 1) await backoff(attempt, upstream);
      continue;
    }

    // —— 上游已接受，开始回传
    const isStream = !!body.stream;
    const usage = { promptTokens: 0, completionTokens: 0, cacheTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };

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

        // 取最后一个带 usage 的事件（流式开启 include_usage 后，末尾会有一条 choices 为空的 usage 帧）
        const u = pickStreamUsage(buf);
        if (u) {
          usage.promptTokens = num(u.prompt_tokens);
          usage.completionTokens = num(u.completion_tokens);
          usage.totalTokens = num(u.total_tokens) || (usage.promptTokens + usage.completionTokens);
          // 缓存命中：DeepSeek 用 prompt_cache_hit_tokens，OpenAI 在 prompt_tokens_details.cached_tokens
          usage.cacheTokens = num(u.prompt_cache_hit_tokens)
            || num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
            || num(u.cached_tokens);
          // 缓存写入（Anthropic）
          usage.cacheWriteTokens = num(u.cache_creation_input_tokens);
        }
        const fromUpstream = usage.totalTokens > 0 || usage.promptTokens > 0;
        if (!fromUpstream) {
          usage.promptTokens = estimatePrompt(body.messages, body.tools);
          usage.completionTokens = estimateTokens(completionText);
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
        // 从最后一段 finish_reason 里取结束原因（stop / length / tool_calls …）
        let finishReason = '';
        for (const fm of buf.matchAll(/"finish_reason"\s*:\s*"([a-zA-Z_]+)"/g)) finishReason = fm[1];

        attempts.push({ providerId: provider.id, ok: true, status: 200, attempt, latencyMs: Date.now() - startedAt });
        clearTimeout(timer);
        return {
          ok: true, status: 200, usage, providerId: provider.id, latencyMs: Date.now() - startedAt,
          completionText, finishReason, usageSource: fromUpstream ? 'upstream' : 'estimated', attempts,
        };
      }

      // —— 非流式
      const text = await upstream.text();
      clearTimeout(timer);

      let json = null;
      try { json = JSON.parse(text); } catch { /* 保持原样透传 */ }

      const u = json && json.usage;
      const fromUpstream = !!(u && (u.total_tokens || u.prompt_tokens || u.completion_tokens));
      if (fromUpstream) {
        usage.promptTokens = num(u.prompt_tokens);
        usage.completionTokens = num(u.completion_tokens);
        usage.totalTokens = num(u.total_tokens) || (usage.promptTokens + usage.completionTokens);
        usage.cacheTokens = num(u.prompt_cache_hit_tokens)
          || num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens)
          || num(u.cached_tokens);
        // 缓存写入 tokens（Anthropic cache_creation_input_tokens）
        usage.cacheWriteTokens = num(u.cache_creation_input_tokens);
      } else {
        usage.promptTokens = estimatePrompt(body.messages, body.tools);
        const outText = json?.choices?.[0]?.message?.content || '';
        usage.completionTokens = estimateTokens(typeof outText === 'string' ? outText : JSON.stringify(outText));
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }

      const msg = json && json.choices && json.choices[0] && json.choices[0].message;
      let completionText = '';
      if (msg) {
        if (typeof msg.content === 'string') completionText = msg.content;
        else if (Array.isArray(msg.content)) completionText = messageText(msg.content);
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
          try { completionText += (completionText ? '\n' : '') + '[tool_calls] ' + JSON.stringify(msg.tool_calls); } catch { /* ignore */ }
        }
      }

      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Gateway-Channel': provider.id,
        });
      }
      res.end(text);
      attempts.push({ providerId: provider.id, ok: true, status: 200, attempt, latencyMs: Date.now() - startedAt });
      return {
        ok: true, status: 200, usage, providerId: provider.id, latencyMs: Date.now() - startedAt,
        completionText,
        finishReason: (json && json.choices && json.choices[0] && json.choices[0].finish_reason) || '',
        upstreamModel: (json && json.model) || '',
        usageSource: fromUpstream ? 'upstream' : 'estimated',
        attempts,
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = { providerId: provider.id, error: `回传中断：${e.message}`, retryable: false };
      // 已经写过响应头，无法重试
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        return { ok: false, status: 502, usage, providerId: provider.id, error: lastErr.error, attempts };
      }
      continue;
    }
   }
  }

  return {
    ok: false,
    status: 502,
    usage: {},
    providerId: '',
    error: (lastErr ? lastErr.error : '没有可用的上游渠道')
      + (retried ? `（已自动重试 ${retried} 次仍失败）` : ''),
    retryable: false,
    attempts,
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

  const promptTokens = estimatePrompt(body.messages, body.tools);
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
            completionText: answer,
            finishReason: 'stop',
            usageSource: 'upstream',
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
  return {
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    providerId: 'mock',
    completionText: answer,
    finishReason: 'stop',
    usageSource: 'upstream',
  };
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

module.exports = { pickProviders, forward, mockReply, probe, estimateTokens, estimatePrompt, supportsModel, summarizeRequest, messageText };

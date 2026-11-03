/**
 * 内置官方参考价目表
 *
 * 数据来源：各厂商官方定价页（2026-11-03 核对）。单位：元 / 百万 tokens。
 * 美元定价按 USD_CNY 汇率折算（可在币种说明中看到），仅用于内部成本核算，
 * 实际账单以各厂商账单为准；管理员可在「上游渠道 → 模型单价」中按需修改。
 *
 * 支持的计费结构（与 lib/store.js 的 modelCost 对应）：
 *   in / out          高峰（默认）输入、输出单价
 *   cacheIn           缓存命中输入价
 *   cacheWrite        缓存写入输入价（Anthropic 1.25x、Kimi 缓存写入）
 *   idle              空闲时段价（DeepSeek：工作日 9-12/14-18 点以外）
 *   tiers             按输入长度分档（Qwen 阶梯、Gemini 200K 断点、豆包输入长度阶梯）
 *   tiers[].upTo      该档输入 tokens 上限（含）；超出最后一档按基础价计
 */

const USD_CNY = 7.2;

/** 美元价 → 人民币（保留 4 位小数，避免 0.005 类价格被抹掉） */
const usd = (v) => Math.round(v * USD_CNY * 10000) / 10000;

const PRESETS = {
  updatedAt: '2026-11-03',
  usdCny: USD_CNY,
  providers: [
    {
      id: 'deepseek',
      name: 'DeepSeek 官方',
      currency: 'CNY',
      source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
      note: '官方分时计价：工作日 9:00-12:00、14:00-18:00 为高峰，其余为空闲（空闲价约为高峰一半）',
      models: {
        'deepseek-flash': { in: 2, out: 8, cacheIn: 0.04, idle: { in: 1, out: 4, cacheIn: 0.02 } },
        'deepseek-v4-pro': { in: 9, out: 27, cacheIn: 0.3, idle: { in: 4.5, out: 13.5, cacheIn: 0.15 } },
      },
    },
    {
      id: 'openai',
      name: 'OpenAI',
      currency: 'USD',
      source: 'https://platform.openai.com/docs/pricing',
      note: `美元价按 1 USD = ${USD_CNY} CNY 折算；cached input 通常为输入价 1/10`,
      models: {
        'gpt-5.5': { in: usd(5), out: usd(30), cacheIn: usd(0.5) },
        'gpt-5.4': { in: usd(2.5), out: usd(15), cacheIn: usd(0.25) },
        'gpt-5.4-mini': { in: usd(0.75), out: usd(4.5), cacheIn: usd(0.075) },
        'gpt-5': { in: usd(1.25), out: usd(10), cacheIn: usd(0.125) },
        'gpt-5-mini': { in: usd(0.25), out: usd(2), cacheIn: usd(0.025) },
        'gpt-5-nano': { in: usd(0.05), out: usd(0.4), cacheIn: usd(0.005) },
        'gpt-4.1': { in: usd(2), out: usd(8), cacheIn: usd(0.5) },
        'gpt-4.1-mini': { in: usd(0.4), out: usd(1.6), cacheIn: usd(0.1) },
        'gpt-4o': { in: usd(2.5), out: usd(10), cacheIn: usd(1.25) },
        'gpt-4o-mini': { in: usd(0.15), out: usd(0.6), cacheIn: usd(0.075) },
        o3: { in: usd(2), out: usd(8), cacheIn: usd(0.5) },
      },
    },
    {
      id: 'anthropic',
      name: 'Anthropic Claude',
      currency: 'USD',
      source: 'https://platform.claude.com/docs/en/about-claude/pricing',
      note: '缓存写按 5 分钟 TTL 的 1.25x；Haiku 5.5 超过 100K 输入翻 5 倍（已用 tiers 表达）',
      models: {
        'claude-opus-5-5': { in: usd(4), out: usd(20), cacheIn: usd(0.2), cacheWrite: usd(5) },
        'claude-sonnet-5-5': { in: usd(2), out: usd(10), cacheIn: usd(0.1), cacheWrite: usd(2.5) },
        'claude-haiku-5-5': {
          in: usd(0.1), out: usd(0.5), cacheIn: usd(0.01), cacheWrite: usd(0.125),
          tiers: [{ upTo: 100000, in: usd(0.1), out: usd(0.5), cacheIn: usd(0.01), cacheWrite: usd(0.125) },
            { upTo: 1000000, in: usd(0.5), out: usd(2.5), cacheIn: usd(0.05), cacheWrite: usd(0.625) }],
        },
        'claude-opus-4-8': { in: usd(5), out: usd(25), cacheIn: usd(0.5), cacheWrite: usd(6.25) },
        'claude-sonnet-4-6': { in: usd(3), out: usd(15), cacheIn: usd(0.3), cacheWrite: usd(3.75) },
      },
    },
    {
      id: 'google',
      name: 'Google Gemini',
      currency: 'USD',
      source: 'https://ai.google.dev/gemini-api/docs/pricing',
      note: 'Pro 系列输入超过 200K tokens 后输入/输出翻倍（用 tiers 表达）',
      models: {
        'gemini-3.1-pro': {
          in: usd(2), out: usd(12), cacheIn: usd(0.2),
          tiers: [{ upTo: 200000, in: usd(2), out: usd(12), cacheIn: usd(0.2) },
            { upTo: 2000000, in: usd(4), out: usd(18), cacheIn: usd(0.4) }],
        },
        'gemini-3.8-flash': { in: usd(1.5), out: usd(7.5), cacheIn: usd(0.15) },
        'gemini-2.5-pro': {
          in: usd(1.25), out: usd(10),
          tiers: [{ upTo: 200000, in: usd(1.25), out: usd(10) }, { upTo: 2000000, in: usd(2.5), out: usd(15) }],
        },
        'gemini-2.5-flash': { in: usd(0.3), out: usd(2.5), cacheIn: usd(0.075) },
        'gemini-2.5-flash-lite': { in: usd(0.1), out: usd(0.4), cacheIn: usd(0.025) },
      },
    },
    {
      id: 'qwen',
      name: '通义千问（阿里云百炼）',
      currency: 'CNY',
      source: 'https://help.aliyun.com/zh/model-studio/models',
      note: '按单次输入长度分档（0-256K / 256K-1M）；缓存命中价约为输入价 1/8',
      models: {
        'qwen3.8-max': { in: 12, out: 36, cacheIn: 1.5 },
        'qwen3.7-max': { in: 12, out: 36, cacheIn: 2.4 },
        'qwen3.8-flash': { in: 0.8, out: 2.7, cacheIn: 0.1 },
        'qwen3.7-plus': {
          in: 2, out: 8, cacheIn: 0.4,
          tiers: [{ upTo: 262144, in: 2, out: 8, cacheIn: 0.4 }, { upTo: 1048576, in: 6, out: 24, cacheIn: 1.2 }],
        },
        'qwen3.7-flash': {
          in: 0.2, out: 0.8, cacheIn: 0.04,
          tiers: [{ upTo: 32768, in: 0.2, out: 0.8, cacheIn: 0.04 },
            { upTo: 262144, in: 0.6, out: 2.4, cacheIn: 0.12 },
            { upTo: 1048576, in: 1.2, out: 4.8, cacheIn: 0.24 }],
        },
      },
    },
    {
      id: 'kimi',
      name: 'Kimi（月之暗面）',
      currency: 'CNY',
      source: 'https://platform.kimi.com/docs/pricing/chat',
      note: 'K3 系列缓存写入按 TTL 单独计费（5min 价），缓存命中仅按命中价收，不重复收写入',
      models: {
        'kimi-k3.1-pro': { in: 13, out: 68, cacheIn: 1.3, cacheWrite: 13 },
        'kimi-k3.1-pro-highspeed': { in: 26, out: 136, cacheIn: 1.3, cacheWrite: 26 },
        'kimi-k3': { in: 20, out: 100, cacheIn: 2, cacheWrite: 20 },
      },
    },
    {
      id: 'doubao',
      name: '豆包（火山方舟）',
      currency: 'CNY',
      source: 'https://www.volcengine.com/docs/82379/1099320',
      note: '按输入长度阶梯定价（32K / 128K / 256K 三档）',
      models: {
        'doubao-seed-2.1-pro': { in: 12, out: 60, cacheIn: 2.4 },
        'doubao-seed-2.1-turbo': { in: 6, out: 30, cacheIn: 1.2 },
        'doubao-seed-2.0-pro': {
          in: 1.6, out: 8, cacheIn: 0.64,
          tiers: [{ upTo: 32768, in: 1.6, out: 8, cacheIn: 0.64 },
            { upTo: 131072, in: 2.4, out: 12, cacheIn: 0.96 },
            { upTo: 262144, in: 4.8, out: 24, cacheIn: 1.92 }],
        },
        'doubao-seed-2.0-mini': {
          in: 0.4, out: 4, cacheIn: 0.08,
          tiers: [{ upTo: 32768, in: 0.4, out: 4, cacheIn: 0.08 },
            { upTo: 131072, in: 0.8, out: 8, cacheIn: 0.16 },
            { upTo: 262144, in: 1.6, out: 16, cacheIn: 0.32 }],
        },
      },
    },
    {
      id: 'zhipu',
      name: '智谱 GLM',
      currency: 'CNY',
      source: 'https://open.bigmodel.cn/pricing',
      note: '固定输入/输出价',
      models: {
        'glm-5.3': { in: 8, out: 28 },
        'glm-5.2': { in: 8, out: 28, cacheIn: 2 },
      },
    },
  ],
};

/** 扁平化成 { 模型名: 价格对象 }，供 seed 与「载入参考价」使用 */
function presetPricing() {
  const out = {};
  for (const p of PRESETS.providers) {
    for (const [model, price] of Object.entries(p.models)) {
      out[model] = JSON.parse(JSON.stringify(price));
    }
  }
  return out;
}

/** 供前端展示的轻量摘要（不含完整价格，避免响应过大） */
function presetSummary() {
  return {
    updatedAt: PRESETS.updatedAt,
    usdCny: PRESETS.usdCny,
    providers: PRESETS.providers.map((p) => ({
      id: p.id,
      name: p.name,
      currency: p.currency,
      source: p.source,
      note: p.note,
      models: Object.keys(p.models),
    })),
    total: Object.values(PRESETS.providers).reduce((n, p) => n + Object.keys(p.models).length, 0),
  };
}

module.exports = { PRESETS, presetPricing, presetSummary, USD_CNY };

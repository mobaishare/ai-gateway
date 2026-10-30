'use strict';

/**
 * 首次启动的演示数据
 * 目的：打开管理台就能看到完整的组织结构、配额层级和用量趋势，
 *      而不是面对一个空白页面。所有渠道默认停用，网关会走内置模拟响应。
 */

const store = require('./store');

const DEPARTMENTS = [
  {
    name: '研发部', remark: '后端 / 前端 / 算法，日常调用量最大',
    quota: { dailyTokens: 5000000, monthlyTokens: 100000000, rpm: 120, concurrency: 20 },
    providerIds: [],
  },
  {
    name: '市场部', remark: '文案生成、素材批量处理',
    quota: { dailyTokens: 2000000, monthlyTokens: 40000000, rpm: 60, concurrency: 10 },
    providerIds: [],
  },
  {
    name: '客服部', remark: '工单摘要、话术辅助，追求低延迟小模型',
    quota: { dailyTokens: 800000, monthlyTokens: 15000000, rpm: 200, concurrency: 30 },
    providerIds: [],
  },
  {
    name: '行政部', remark: '低频使用，额度从紧',
    quota: { dailyTokens: 300000, monthlyTokens: 5000000, rpm: 30, concurrency: 5 },
    providerIds: [],
  },
];

const EMPLOYEES = [
  { name: '张伟', email: 'zhangwei@example.com', dept: '研发部', override: null },
  {
    name: '李娜', email: 'lina@example.com', dept: '研发部',
    // 算法组特殊需求：额度独立于部门池，且临时提额
    override: {
      enabled: true, dailyTokens: null, monthlyTokens: null, rpm: 300, concurrency: 40,
      countAgainstDept: false, note: '算法组批量评测，额度独立核算，不占用研发部池',
      expiresAt: '',
    },
  },
  {
    name: '王强', email: 'wangqiang@example.com', dept: '研发部',
    // 新人：只给很低的日额度，避免误用
    override: {
      enabled: true, dailyTokens: 200000, monthlyTokens: null, rpm: null, concurrency: 3,
      countAgainstDept: true, note: '试用期，日额度 20 万封顶', expiresAt: '',
    },
  },
  { name: '王芳', email: 'wangfang@example.com', dept: '市场部', override: null },
  {
    name: '陈晨', email: 'chenchen@example.com', dept: '市场部',
    override: {
      enabled: true, dailyTokens: 3000000, monthlyTokens: null, rpm: null, concurrency: null,
      countAgainstDept: false, note: '双十一素材生产临时提额，独立额度', expiresAt: '',
    },
  },
  {
    name: '刘洋', email: 'liuyang@example.com', dept: '客服部',
    override: {
      enabled: true, dailyTokens: 50000, monthlyTokens: null, rpm: 20, concurrency: 2,
      countAgainstDept: true, note: '客服组唯一入口，严格控制防刷', expiresAt: '',
    },
  },
  { name: '赵敏', email: 'zhaomin@example.com', dept: '行政部', override: null },
];

const PROVIDERS = [
  {
    name: 'OpenAI 官方', baseUrl: 'https://api.openai.com',
    apiKey: '', models: ['gpt-4o', 'gpt-4o-mini'],
    weight: 3, timeoutMs: 120000, status: 'disabled', remark: '主渠道，需填入真实 Key 后启用',
  },
  {
    name: 'DeepSeek 官方', baseUrl: 'https://api.deepseek.com',
    apiKey: '', models: ['deepseek-chat', 'deepseek-reasoner'],
    weight: 2, timeoutMs: 120000, status: 'disabled', remark: '性价比渠道',
  },
  {
    name: '内网代理（示例）', baseUrl: 'http://10.0.0.10:3000',
    apiKey: '', models: ['*'],
    weight: 1, timeoutMs: 60000, status: 'disabled', remark: '公司内网统一出口，支持全部模型',
  },
];

const MODELS = ['gpt-4o-mini', 'gpt-4o', 'deepseek-chat', 'claude-3-5-sonnet'];

function rand(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function pick(arr) {
  return arr[rand(0, arr.length)];
}

/** 每个员工的日消耗量级（tokens），用来生成有区分度的曲线 */
const WEIGHT = {
  张伟: 420000, 李娜: 900000, 王强: 60000,
  王芳: 260000, 陈晨: 520000,
  刘洋: 70000, 赵敏: 18000,
};

function seed(db) {
  const now = new Date();

  // —— 部门
  const deptMap = {};
  for (const d of DEPARTMENTS) {
    const dept = {
      id: store.uid(),
      name: d.name,
      remark: d.remark,
      quota: d.quota,
      providerIds: d.providerIds,
      status: 'active',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    db.departments.push(dept);
    deptMap[d.name] = dept;
  }

  // —— 员工
  const empList = [];
  for (const e of EMPLOYEES) {
    const dept = deptMap[e.dept];
    const emp = {
      id: store.uid(),
      name: e.name,
      email: e.email,
      deptId: dept.id,
      key: store.genKey(),
      status: 'active',
      override: e.override
        ? { countAgainstDept: true, expiresAt: '', note: '', ...e.override }
        : {
            enabled: false, dailyTokens: null, monthlyTokens: null, rpm: null,
            concurrency: null, countAgainstDept: true, expiresAt: '', note: '',
          },
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    db.employees.push(emp);
    empList.push(emp);
  }

  // —— 渠道
  for (const p of PROVIDERS) {
    db.providers.push({
      id: store.uid(),
      ...p,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }

  // —— 历史用量：生成最近 7 天的趋势
  const empById = new Map(empList.map((e) => [e.name, e]));
  for (let back = 6; back >= 0; back--) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const dk = store.dayKey(day);
    const bucket = { emp: {}, dept: {} };
    const weekend = day.getDay() === 0 || day.getDay() === 6;

    for (const e of empList) {
      const base = WEIGHT[e.name] || 50000;
      // 今天只跑到上午，量少一些；周末量更少
      let factor = back === 0 ? 0.35 : (weekend ? 0.18 : 1);
      // 加一点随机波动
      factor *= 0.75 + Math.random() * 0.5;
      const tokens = Math.round(base * factor);
      if (tokens < 500) continue;

      const reqs = Math.max(1, Math.round(tokens / rand(700, 1500)));
      bucket.emp[e.id] = { t: tokens, r: reqs };

      const countDept = e.override.enabled ? e.override.countAgainstDept !== false : true;
      if (countDept) {
        const d = bucket.dept[e.deptId] || (bucket.dept[e.deptId] = { t: 0, r: 0 });
        d.t += tokens;
        d.r += reqs;
      }

      // 抽几条明细日志
      const sample = Math.min(3, reqs);
      for (let i = 0; i < sample; i++) {
        const ts = new Date(day.getTime() + rand(9, 19) * 3600 * 1000 + rand(0, 59) * 60000);
        if (back === 0 && ts > now) continue;
        const t = Math.round(tokens / sample);
        db.usage.push({
          id: store.uid(),
          ts: ts.toISOString(),
          employeeId: e.id,
          deptId: e.deptId,
          providerId: db.providers[0].id,
          model: pick(MODELS),
          promptTokens: Math.round(t * 0.4),
          completionTokens: Math.round(t * 0.6),
          totalTokens: t,
          latencyMs: rand(600, 4200),
          status: 'ok',
          source: 'seed',
          countDept,
          error: '',
        });
      }
    }
    db.stats.daily[dk] = bucket;
  }

  db.usage.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return db;
}

module.exports = { seed };

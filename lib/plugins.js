'use strict';

/**
 * 扩展插件：把外部系统的部门与员工同步进平台
 *
 * 内置三个插件：
 *   1. feishu —— 飞书开放平台「通讯录」自建应用
 *   2. wecom  —— 企业微信「通讯录同步」密钥
 *   3. csv    —— 手工粘贴文本导入（不需要任何凭证，兜底方案）
 *
 * 插件只需实现 fetchOrg(config, payload) -> { departments:[{name}],
 * employees:[{name,email,deptName}] }，其余（配置存储、同步合并）由本文件统一处理。
 * 想接入钉钉/LDAP 等，照着现有插件加一个对象即可。
 */

const store = require('./store');

// ---------------------------------------------------------------- HTTP 小工具

async function httpJson(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw new Error(`响应不是 JSON（HTTP ${r.status}）：${text.slice(0, 120)}`); }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时，请检查服务器能否访问该域名');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const trimBase = (s, fallback) => String(s || '').trim().replace(/\/+$/, '') || fallback;

// ---------------------------------------------------------------- 飞书

const feishu = {
  id: 'feishu',
  name: '飞书通讯录',
  desc: '用飞书开放平台的自建应用拉取部门与成员。需要开通「通讯录」相关权限（获取部门基础信息、获取成员基础信息）。',
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_xxxxxxxx' },
    { key: 'appSecret', label: 'App Secret', type: 'password' },
    { key: 'apiBase', label: 'API 域名', type: 'text', placeholder: 'https://open.feishu.cn', hint: '海外 Lark 填 https://open.larksuite.com' },
  ],

  async token(cfg) {
    const base = trimBase(cfg.apiBase, 'https://open.feishu.cn');
    const j = await httpJson(base + '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    });
    if (!j.tenant_access_token) throw new Error('获取 tenant_access_token 失败：' + (j.msg || '未知错误'));
    return { base, token: j.tenant_access_token };
  },

  async fetchOrg(cfg) {
    const { base, token } = await this.token(cfg);
    const headers = { Authorization: `Bearer ${token}` };

    // 1) 递归拉全部部门（从根 0 开始）
    const depts = [];
    const queue = ['0'];
    let level = 0;
    while (queue.length && level < 15) {
      const parent = queue.shift();
      level++;
      let pageToken = '';
      do {
        const url = `${base}/open-apis/contact/v3/departments/${parent}/children?department_id_type=open_department_id&user_id_type=user_id&page_size=50${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
        const j = await httpJson(url, { headers });
        if (j.code !== 0) throw new Error(`拉取部门失败 [${j.code}]：${j.msg}`);
        for (const item of j.data?.items || []) {
          depts.push({ id: item.open_department_id, name: item.name });
          queue.push(item.open_department_id);
        }
        pageToken = j.data?.page_token || '';
        if (!j.data?.has_more) pageToken = '';
      } while (pageToken);
    }
    const nameOf = new Map(depts.map((d) => [d.id, d.name]));

    // 2) 拉全部成员（含子部门）
    const employees = [];
    let userToken = '';
    do {
      const url = `${base}/open-apis/contact/v3/users?department_id=0&fetch_child=true&department_id_type=open_department_id&user_id_type=user_id&page_size=100${userToken ? `&page_token=${encodeURIComponent(userToken)}` : ''}`;
      const j = await httpJson(url, { headers });
      if (j.code !== 0) throw new Error(`拉取成员失败 [${j.code}]：${j.msg}`);
      for (const u of j.data?.items || []) {
        if (u.status?.resigned) continue; // 离职成员跳过
        const deptName = (u.department_ids || []).map((id) => nameOf.get(id)).filter(Boolean).pop() || '';
        employees.push({ name: u.name, email: u.email || '', deptName });
      }
      userToken = j.data?.page_token || '';
      if (!j.data?.has_more) userToken = '';
    } while (userToken);

    return {
      departments: depts.map((d) => ({ name: d.name })),
      employees,
    };
  },
};

// ---------------------------------------------------------------- 企业微信

const wecom = {
  id: 'wecom',
  name: '企业微信通讯录',
  desc: '用企业微信管理后台的「通讯录同步」密钥拉取部门与成员。密钥位置：管理后台 → 管理工具 → 通讯录同步。',
  fields: [
    { key: 'corpId', label: '企业 ID (corpId)', type: 'text', placeholder: 'wwxxxxxxxx' },
    { key: 'corpSecret', label: '通讯录 Secret', type: 'password' },
    { key: 'apiBase', label: 'API 域名', type: 'text', placeholder: 'https://qyapi.weixin.qq.com' },
  ],

  async token(cfg) {
    const base = trimBase(cfg.apiBase, 'https://qyapi.weixin.qq.com');
    const j = await httpJson(`${base}/cgi-bin/gettoken?corpid=${encodeURIComponent(cfg.corpId)}&corpsecret=${encodeURIComponent(cfg.corpSecret)}`);
    if (!j.access_token) throw new Error(`获取 access_token 失败 [${j.errcode}]：${j.errmsg}`);
    return { base, token: j.access_token };
  },

  async fetchOrg(cfg) {
    const { base, token } = await this.token(cfg);

    const dj = await httpJson(`${base}/cgi-bin/department/list?access_token=${token}`);
    if (dj.errcode !== 0) throw new Error(`拉取部门失败 [${dj.errcode}]：${dj.errmsg}`);
    const deptList = dj.department || [];
    const byId = new Map(deptList.map((d) => [d.id, d]));
    const depth = (id) => {
      let n = 0, cur = byId.get(id);
      while (cur && n < 20) { cur = byId.get(cur.parentid); n++; }
      return n;
    };

    const employees = [];
    for (const d of deptList) {
      const uj = await httpJson(`${base}/cgi-bin/user/list?access_token=${token}&department_id=${d.id}&fetch_child=0`);
      if (uj.errcode !== 0 && uj.errcode !== 60111) throw new Error(`拉取成员失败 [${uj.errcode}]：${uj.errmsg}`);
      for (const u of uj.userlist || []) {
        const ids = u.department || [];
        const deepest = ids.slice().sort((a, b) => depth(b) - depth(a))[0];
        employees.push({ name: u.name, email: u.email || '', deptName: byId.get(deepest)?.name || '' });
      }
    }

    return {
      departments: deptList.map((d) => ({ name: d.name })),
      employees,
    };
  },
};

// ---------------------------------------------------------------- CSV 导入

const csv = {
  id: 'csv',
  name: '文本 / CSV 导入',
  desc: '不依赖任何外部系统：把「姓名,邮箱,部门」格式的内容粘贴进来即可。适合首次初始化或从其他工具迁移。',
  fields: [
    { key: 'text', label: '导入内容', type: 'textarea', placeholder: '姓名,邮箱,部门\n张三,zhangsan@corp.com,研发部\n李四,lisi@corp.com,研发部\n王五,wangwu@corp.com,市场部', hint: '每行一条，邮箱可省略。首行若包含「姓名」会自动当作表头跳过。' },
  ],

  parse(cfg) {
    const lines = String(cfg.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('没有可导入的内容');
    let rows = lines.map((l) => l.split(/[,，\t]/).map((s) => s.trim()));
    if (rows[0][0] === '姓名' || /^name$/i.test(rows[0][0])) rows = rows.slice(1);
    const departments = [];
    const employees = [];
    for (const r of rows) {
      const [name, email = '', deptName = ''] = r;
      if (!name) continue;
      if (deptName && !departments.some((d) => d.name === deptName)) departments.push({ name: deptName });
      employees.push({ name, email, deptName });
    }
    if (!employees.length) throw new Error('没有解析到有效的员工行');
    return { departments, employees };
  },

  async fetchOrg(cfg) {
    return this.parse(cfg);
  },
};

// ---------------------------------------------------------------- 注册表与合并

const REGISTRY = [feishu, wecom, csv];

function pluginStore(db) {
  if (!db.plugins || typeof db.plugins !== 'object') db.plugins = {};
  return db.plugins;
}

/** 管理端列表：插件元信息 + 已存配置 + 上次同步结果 */
function list(db) {
  const saved = pluginStore(db);
  return REGISTRY.map((p) => ({
    id: p.id,
    name: p.name,
    desc: p.desc,
    fields: p.fields,
    configured: !!(saved[p.id] && saved[p.id].config && Object.keys(saved[p.id].config).some((k) => String(saved[p.id].config[k] || '').trim())),
    lastSyncAt: saved[p.id]?.lastSyncAt || '',
    lastResult: saved[p.id]?.lastResult || '',
    config: saved[p.id]?.config || {},
  }));
}

function getConfig(db, id) {
  const saved = pluginStore(db);
  return (saved[id] && saved[id].config) || {};
}

function saveConfig(db, id, config) {
  const saved = pluginStore(db);
  saved[id] = { ...(saved[id] || {}), config: config || {}, lastSyncAt: saved[id]?.lastSyncAt || '', lastResult: saved[id]?.lastResult || '' };
}

function markSynced(db, id, resultText) {
  const saved = pluginStore(db);
  saved[id] = { ...(saved[id] || { config: {} }), lastSyncAt: new Date().toISOString(), lastResult: resultText };
}

/** 连接测试：能拉到组织就算通过。configOverride 允许用表单里未保存的值直接测 */
async function test(db, id, configOverride) {
  const p = REGISTRY.find((x) => x.id === id);
  if (!p) throw new Error('插件不存在');
  const cfg = { ...getConfig(db, id), ...(configOverride || {}) };
  const org = await p.fetchOrg(cfg, {});
  return {
    ok: true,
    message: `连接成功：${org.departments.length} 个部门、${org.employees.length} 名员工`,
  };
}

/**
 * 同步：把插件返回的组织架构合并进平台。
 * 部门按名称去重建；员工按邮箱（其次同名）匹配，存在则更新部门/邮箱，不存在则新建。
 * 配额全部保持平台侧已有设置，同步不会覆盖任何额度。
 */
function applyOrg(db, org, sourceName) {
  const summary = {
    deptsSeen: org.departments.length,
    empsSeen: org.employees.length,
    deptsCreated: 0,
    empsCreated: 0,
    empsUpdated: 0,
  };

  const now = new Date().toISOString();
  const byName = new Map(db.departments.map((d) => [d.name, d]));
  for (const dep of org.departments) {
    if (!dep.name || byName.has(dep.name)) continue;
    const d = {
      id: store.uid(),
      name: dep.name,
      remark: `来自${sourceName}同步`,
      quota: { dailyTokens: 0, monthlyTokens: 0, rpm: 0, concurrency: 0 },
      providerIds: [],
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    db.departments.push(d);
    byName.set(d.name, d);
    summary.deptsCreated++;
  }

  const byEmail = new Map(db.employees.filter((e) => e.email).map((e) => [e.email, e]));
  const byNameE = new Map(db.employees.map((e) => [e.name, e]));
  for (const em of org.employees) {
    if (!em.name) continue;
    const dept = em.deptName ? byName.get(em.deptName) : null;
    const exist = (em.email && byEmail.get(em.email)) || byNameE.get(em.name);
    if (exist) {
      let changed = false;
      if (em.email && exist.email !== em.email) { exist.email = em.email; changed = true; }
      if (dept && exist.deptId !== dept.id) { exist.deptId = dept.id; changed = true; }
      if (changed) { exist.updatedAt = now; summary.empsUpdated++; }
    } else {
      const e = {
        id: store.uid(),
        name: em.name,
        email: em.email || '',
        deptId: dept ? dept.id : '',
        key: store.genKey(),
        status: 'active',
        override: { enabled: false, dailyTokens: null, monthlyTokens: null, rpm: null, concurrency: null, countAgainstDept: true, expiresAt: '', note: '' },
        createdAt: now,
        updatedAt: now,
      };
      db.employees.push(e);
      if (e.email) byEmail.set(e.email, e);
      byNameE.set(e.name, e);
      summary.empsCreated++;
    }
  }
  return summary;
}

async function sync(db, id, payload = {}) {
  const p = REGISTRY.find((x) => x.id === id);
  if (!p) throw new Error('插件不存在');
  const cfg = { ...getConfig(db, id), ...(payload.config || {}) };
  const org = await p.fetchOrg(cfg, payload);
  const summary = applyOrg(db, org, p.name);
  const text = `同步 ${summary.deptsSeen} 部门（新建 ${summary.deptsCreated}）/ ${summary.empsSeen} 员工（新建 ${summary.empsCreated}、更新 ${summary.empsUpdated}）`;
  markSynced(db, id, text);
  return { ...summary, message: text };
}

module.exports = { list, test, sync, saveConfig, getConfig, applyOrg };

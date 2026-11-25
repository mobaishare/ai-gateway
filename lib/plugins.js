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

// ---------------------------------------------------------------- 通用 HTTP API

/** 从多种常见响应结构里取数组：[] / {items} / {data} / {data:{items}} / {departments} 等 */
function rowsFrom(json, keys) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const key of keys) {
    const v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), json);
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** 按候选字段名取值，兼容下划线/驼峰；对象值取 .name */
function pick(row, keys) {
  if (!row || typeof row !== 'object') return '';
  for (const key of keys) {
    let v = key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), row);
    if (v && typeof v === 'object') v = v.name || v.title;
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return '';
}

const api = {
  id: 'api',
  name: 'HTTP API 同步',
  desc: '调用你自己的 HTTP 接口拉取部门与成员，用独立 API Key 鉴权。支持增量合并与全量镜像（自动移除源端已不存在的托管人员）。',
  fields: [
    { key: 'apiBase', label: 'API 根地址', type: 'text', placeholder: 'https://hr.example.com', hint: '接口完整地址 = 根地址 + 下面的路径。' },
    { key: 'deptPath', label: '部门接口路径', type: 'text', placeholder: '/api/org/departments', hint: '留空则跳过部门。支持数组或 {items:[…]} / {data:[…]} 等常见结构。' },
    { key: 'empPath', label: '员工接口路径', type: 'text', placeholder: '/api/org/employees', hint: '留空则跳过员工。字段自动识别 name / email / deptName 等常见命名。' },
    { key: 'authHeader', label: '鉴权 Header', type: 'text', placeholder: 'X-API-Key', hint: '默认 X-API-Key；填 Authorization 时自动加 Bearer 前缀。' },
    { key: 'apiKey', label: '独立 API Key', type: 'password', placeholder: '调用上述接口用的 Key' },
    {
      key: 'syncMode', label: '同步模式', type: 'select',
      options: [
        { value: 'merge', label: '增量合并（默认，只增改不删）' },
        { value: 'full', label: '全量镜像（移除源端已不存在的托管人员）' },
      ],
      hint: '全量模式只删除由本插件同步创建的数据，手工录入的人员不受影响。',
    },
  ],

  /** 全量模式开关交给通用同步流程，插件本身只负责拉数据 */
  syncOptions(cfg) {
    return { deleteMissing: String(cfg.syncMode || 'merge') === 'full' };
  },

  async fetchOrg(cfg) {
    const base = trimBase(cfg.apiBase, '');
    if (!base) throw new Error('请填写 API 根地址');
    const deptPath = String(cfg.deptPath || '').trim();
    const empPath = String(cfg.empPath || '').trim();
    if (!deptPath && !empPath) throw new Error('部门接口和员工接口至少填写一个');

    const header = String(cfg.authHeader || '').trim() || 'X-API-Key';
    const key = String(cfg.apiKey || '').trim();
    if (!key) throw new Error('请填写独立 API Key');
    const value = /^bearer\s+/i.test(key) ? key
      : (/^authorization$/i.test(header) ? `Bearer ${key}` : key);
    const headers = { Accept: 'application/json', [header]: value };

    const getJson = async (path, label) => {
      const url = /^https?:\/\//i.test(path) ? path : base + (path.startsWith('/') ? path : '/' + path);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      try {
        const r = await fetch(url, { headers, signal: ctrl.signal });
        const text = await r.text();
        if (!r.ok) throw new Error(`HTTP ${r.status}：${text.slice(0, 120)}`);
        if (!text.trim()) return [];
        try { return JSON.parse(text); }
        catch { throw new Error(`响应不是 JSON：${text.slice(0, 120)}`); }
      } catch (e) {
        if (e.name === 'AbortError') throw new Error(`${label}接口请求超时`);
        throw new Error(`${label}接口请求失败：${e.message}`);
      } finally {
        clearTimeout(timer);
      }
    };

    const departments = [];
    const employees = [];

    if (deptPath) {
      const rows = rowsFrom(await getJson(deptPath, '部门'), ['departments', 'items', 'data', 'data.items', 'data.list', 'list', 'rows', 'result']);
      for (const r of rows) {
        const name = pick(r, ['name', 'departmentName', 'deptName', 'title']);
        if (!name) continue;
        const sourceId = pick(r, ['id', 'open_department_id', 'departmentId', 'deptId']);
        departments.push({ name, ...(sourceId ? { sourceId } : {}) });
      }
    }

    if (empPath) {
      const rows = rowsFrom(await getJson(empPath, '员工'), ['employees', 'items', 'data', 'data.items', 'data.list', 'list', 'rows', 'result']);
      for (const r of rows) {
        const name = pick(r, ['name', 'employeeName', 'userName', 'username']);
        if (!name) continue;
        const sourceId = pick(r, ['id', 'userId', 'user_id', 'employeeId', 'open_id']);
        employees.push({
          name,
          email: pick(r, ['email', 'mail', 'emailAddress']),
          deptName: pick(r, ['deptName', 'dept_name', 'departmentName', 'department_name', 'department', 'dept', 'groupName']),
          ...(sourceId ? { sourceId } : {}),
        });
      }
    }

    if (!departments.length && !employees.length && deptPath && empPath) {
      throw new Error('两个接口都返回了空数据，请检查接口地址与字段格式');
    }
    return { departments, employees };
  },
};

// ---------------------------------------------------------------- 注册表与合并

const REGISTRY = [feishu, wecom, csv, api];

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
 * 部门按名称去重建；员工按邮箱（其次同名）匹配，存在则更新部门/邮箱/外部 ID，不存在则新建。
 * 配额全部保持平台侧已有设置，同步不会覆盖任何额度。
 *
 * 全量模式（opts.deleteMissing + opts.source）：只删除 source 标记等于本插件、
 * 且本次源端没有出现的部门/员工。手工录入、别的插件创建的数据一律不动，
 * 避免一次同步把平台侧手工配的额度/密钥连带抹掉。
 */
function applyOrg(db, org, sourceName, opts = {}) {
  const source = String(opts.source || '');
  const deleteMissing = !!opts.deleteMissing && !!source;
  const summary = {
    deptsSeen: org.departments.length,
    empsSeen: org.employees.length,
    deptsCreated: 0,
    empsCreated: 0,
    empsUpdated: 0,
    deptsDeleted: 0,
    empsDeleted: 0,
  };

  const now = new Date().toISOString();
  const seenDepts = new Set();
  const seenEmps = new Set();

  const byName = new Map(db.departments.map((d) => [d.name, d]));
  const bySourceId = new Map(db.departments.filter((d) => d.sourceId).map((d) => [d.sourceId, d]));
  for (const dep of org.departments) {
    if (!dep.name) continue;
    let d = (source && dep.sourceId && bySourceId.get(dep.sourceId)) || byName.get(dep.name);
    if (!d) {
      d = {
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
      summary.deptsCreated++;
    } else {
      if (d.name !== dep.name) { d.name = dep.name; d.updatedAt = now; }
    }
    if (source) { d.source = source; if (dep.sourceId) d.sourceId = dep.sourceId; }
    byName.set(d.name, d);
    if (dep.sourceId) bySourceId.set(dep.sourceId, d);
    seenDepts.add(d.id);
  }

  const byEmail = new Map(db.employees.filter((e) => e.email).map((e) => [e.email, e]));
  const byNameE = new Map(db.employees.map((e) => [e.name, e]));
  const empBySourceId = new Map(db.employees.filter((e) => e.sourceId).map((e) => [e.sourceId, e]));
  for (const em of org.employees) {
    if (!em.name) continue;
    const dept = em.deptName ? byName.get(em.deptName) : null;
    const exist = (source && em.sourceId && empBySourceId.get(em.sourceId))
      || (em.email && byEmail.get(em.email))
      || byNameE.get(em.name);
    if (exist) {
      let changed = false;
      if (exist.name !== em.name) { exist.name = em.name; changed = true; }
      if (em.email && exist.email !== em.email) { exist.email = em.email; changed = true; }
      if (dept && exist.deptId !== dept.id) { exist.deptId = dept.id; changed = true; }
      if (source && em.sourceId && exist.sourceId !== em.sourceId) { exist.sourceId = em.sourceId; changed = true; }
      if (changed) { exist.updatedAt = now; summary.empsUpdated++; }
      byNameE.set(exist.name, exist);
      if (exist.email) byEmail.set(exist.email, exist);
      seenEmps.add(exist.id);
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
      if (source) { e.source = source; if (em.sourceId) e.sourceId = em.sourceId; }
      db.employees.push(e);
      if (e.email) byEmail.set(e.email, e);
      byNameE.set(e.name, e);
      if (e.sourceId) empBySourceId.set(e.sourceId, e);
      seenEmps.add(e.id);
      summary.empsCreated++;
    }
  }

  if (deleteMissing) {
    // 只摘掉本插件托管、且源端这次没出现的记录；顺序：先员工后部门，避免留下空挂部门
    const goneEmps = db.employees.filter((e) => e.source === source && !seenEmps.has(e.id));
    if (goneEmps.length) {
      db.employees = db.employees.filter((e) => !(e.source === source && !seenEmps.has(e.id)));
      summary.empsDeleted = goneEmps.length;
      store.reindex(); // 旧 Key 立即失效，不等 save 的 400ms 防抖
    }
    // 部门删除前先看还有没有员工在用（包括手工创建、别的插件的员工）
    const usedDeptIds = new Set(db.employees.map((e) => e.deptId).filter(Boolean));
    const before = db.departments.length;
    db.departments = db.departments.filter((d) => !(d.source === source && !seenDepts.has(d.id) && !usedDeptIds.has(d.id)));
    summary.deptsDeleted = before - db.departments.length;
  }
  return summary;
}

async function sync(db, id, payload = {}) {
  const p = REGISTRY.find((x) => x.id === id);
  if (!p) throw new Error('插件不存在');
  const cfg = { ...getConfig(db, id), ...(payload.config || {}) };
  const org = await p.fetchOrg(cfg, payload);
  // 外部 ID 只在本插件托管的记录上参与匹配，防止误认别的插件/手工录入的相同 ID
  const opts = { source: 'plugin:' + id, ...(typeof p.syncOptions === 'function' ? p.syncOptions(cfg) : {}) };
  const summary = applyOrg(db, org, p.name, opts);
  const del = (summary.deptsDeleted || summary.empsDeleted)
    ? `，删除 ${summary.deptsDeleted} 部门 / ${summary.empsDeleted} 员工` : '';
  const text = `同步 ${summary.deptsSeen} 部门（新建 ${summary.deptsCreated}）/ ${summary.empsSeen} 员工（新建 ${summary.empsCreated}、更新 ${summary.empsUpdated}${del}）`;
  markSynced(db, id, text);
  return { ...summary, message: text };
}

module.exports = { list, test, sync, saveConfig, getConfig, applyOrg };

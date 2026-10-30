'use strict';

/* ============================================================
   AI API 分流平台 —— 管理台前端
   原生 JS，无框架、无 CDN 依赖（内网可直接跑）
   ============================================================ */

// ---------------------------------------------------------------- 基础工具

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  token: localStorage.getItem('gw_token') || '',
  view: 'dashboard',
  depts: [],
  emps: [],
  providers: [],
  overview: null,
  logs: [],
  settings: null,
  plugins: [],
  pluginId: '',
  filters: { empKeyword: '', empDept: '', logStatus: '' },
};

const ICON = {
  dash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  dept: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-5h6v5"/></svg>',
  user: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>',
  route: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8h5.5"/></svg>',
  log: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/></svg>',
  doc: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  gear: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.66.73.85.28.16.6.24.92.24H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  info: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></svg>',
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  plug: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7V3M15 7V3"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v4"/></svg>',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(n) {
  if (n == null || isNaN(n)) return '0';
  return Number(n).toLocaleString('en-US');
}

/** 大数字缩写：12345678 → 1234.6万 */
function shortNum(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return (v / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
  return fmt(v);
}

function timeText(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return '今天 ' + hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

function barClass(p) {
  if (p >= 100) return 'danger';
  if (p >= 80) return 'warn';
  return '';
}

/** 进度条宽度：占用率很低时也给一个最小可视宽度，避免看起来像"没有数据" */
function barWidth(percent, unlimited) {
  if (unlimited || !percent) return 0;
  return Math.max(2, Math.min(100, percent));
}

// ---------------------------------------------------------------- 请求封装

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;

  const res = await fetch(path, { ...opts, headers });
  let data = {};
  try { data = await res.json(); } catch { /* 允许空响应 */ }

  if (res.status === 401 && !path.includes('/api/login')) {
    logout();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

// ---------------------------------------------------------------- 登录

async function doLogin(e) {
  e.preventDefault();
  const btn = $('#login-btn');
  const errBox = $('#login-error');
  errBox.textContent = '';
  btn.disabled = true;
  btn.textContent = '登录中...';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-pass').value }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || '登录失败');
    state.token = data.token;
    localStorage.setItem('gw_token', data.token);
    await enterApp();
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '登 录';
  }
}

function logout() {
  state.token = '';
  localStorage.removeItem('gw_token');
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  $('#login-pass').value = '';
}

async function enterApp() {
  try {
    await refreshAll();
  } catch (e) {
    toast(e.message, 'err');
    if (!state.token) return;
  }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  buildNav();
  navigate(state.view || 'dashboard');
}

// ---------------------------------------------------------------- 数据加载

async function refreshAll() {
  const [depts, emps, providers, overview, settings] = await Promise.all([
    api('/api/departments'),
    api('/api/employees'),
    api('/api/providers'),
    api('/api/overview'),
    api('/api/settings'),
  ]);
  state.depts = depts.items;
  state.emps = emps.items;
  state.providers = providers.items;
  state.overview = overview;
  state.settings = settings;
  renderSideStat();
}

function renderSideStat() {
  const o = state.overview;
  if (!o) return;
  $('#side-stat').innerHTML =
    `今日 <b>${shortNum(o.today.tokens)}</b> tokens · <b>${fmt(o.today.reqs)}</b> 次<br>` +
    `<b>${o.counts.activeEmployees}</b>/<b>${o.counts.employees}</b> 名员工在用 · <b>${o.counts.overrides}</b> 个特例额度<br>` +
    `渠道 <b>${o.counts.activeProviders}</b>/<b>${o.counts.providers}</b> 启用`;
}

// ---------------------------------------------------------------- 导航

const ROUTES = [
  { key: 'dashboard', label: '概览', icon: 'dash', title: '概览', sub: '整体用量、部门排行与超额预警' },
  { key: 'departments', label: '部门管理', icon: 'dept', title: '部门管理', sub: '部门是额度的第一层来源，员工默认继承所属部门的配额' },
  { key: 'employees', label: '员工管理', icon: 'user', title: '员工管理', sub: '分配虚拟密钥与个人额度，员工特例优先于部门默认' },
  { key: 'providers', label: '上游渠道', icon: 'route', title: '上游渠道', sub: '真实密钥只保存在服务端，按权重分流到不同上游' },
  { key: 'logs', label: '调用日志', icon: 'log', title: '调用日志', sub: '每一次请求的模型、渠道、耗时与用量' },
  { key: 'docs', label: '接入文档', icon: 'doc', title: '接入文档', sub: '把地址和虚拟密钥发给同事，就能直接调用' },
  { key: 'plugins', label: '扩展插件', icon: 'plug', title: '扩展插件', sub: '点击插件卡片进入，从飞书、企业微信或文本同步部门与员工' },
  { key: 'settings', label: '系统设置', icon: 'gear', title: '系统设置', sub: '平台名称、超额策略与管理员密码' },
];

function buildNav() {
  $('#nav').innerHTML = ROUTES.map((r) => `
    <div class="nav-item ${r.key === state.view ? 'active' : ''}" data-nav="${r.key}">
      ${ICON[r.icon]}<span>${r.label}</span>
    </div>`).join('');
}

function navigate(key, sub) {
  if (!ROUTES.some((r) => r.key === key)) key = 'dashboard';
  state.view = key;
  // 二级视图：目前只有插件页有（#/plugins/<插件id>）
  if (sub !== undefined) state.pluginId = sub;
  else if (key !== 'plugins') state.pluginId = '';
  location.hash = '#/' + key + (key === 'plugins' && state.pluginId ? '/' + state.pluginId : '');
  const route = ROUTES.find((r) => r.key === key);
  $('#page-title').textContent = route.title;
  $('#page-sub').textContent = route.sub;
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.nav === key));
  $('#view').innerHTML = '<div class="empty">加载中…</div>';
  location.hash = '#/' + key;

  const render = {
    dashboard: renderDashboard,
    departments: renderDepartments,
    employees: renderEmployees,
    providers: renderProviders,
    logs: renderLogs,
    docs: renderDocs,
    plugins: renderPlugins,
    settings: renderSettings,
  }[key];

  Promise.resolve(render()).catch((e) => {
    $('#view').innerHTML = `<div class="card"><div class="empty"><strong>加载失败</strong>${esc(e.message)}</div></div>`;
  });
}

// ---------------------------------------------------------------- 概览页

function renderDashboard() {
  const o = state.overview;
  const maxTrend = Math.max(1, ...o.trend.map((t) => t.tokens));
  const todayKey = o.today.date;

  const kpis = `
    <div class="kpi-grid">
      <div class="kpi">
        <div class="kpi-label">今日 Token</div>
        <div class="kpi-value">${shortNum(o.today.tokens)}<small>tokens</small></div>
        <div class="kpi-foot">今日请求 ${fmt(o.today.reqs)} 次</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">本月 Token</div>
        <div class="kpi-value">${shortNum(o.month.tokens)}<small>tokens</small></div>
        <div class="kpi-foot">${o.month.month} · 共 ${fmt(o.month.reqs)} 次请求</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">员工与特例</div>
        <div class="kpi-value">${o.counts.activeEmployees}<small>/ ${o.counts.employees} 人</small></div>
        <div class="kpi-foot">其中 <b>${o.counts.overrides}</b> 人设置了特例额度</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">上游渠道</div>
        <div class="kpi-value">${o.counts.activeProviders}<small>/ ${o.counts.providers} 个</small></div>
        <div class="kpi-foot">${o.counts.activeProviders === 0 ? '全部停用，当前走内置模拟响应' : '按权重分流中'}</div>
      </div>
    </div>`;

  const trend = `
    <div class="card">
      <div class="card-head">
        <div>
          <h3>近 7 日用量趋势</h3>
          <div class="sub">全部员工的 token 消耗合计</div>
        </div>
      </div>
      <div class="card-body">
        <div class="chart">
          ${o.trend.map((t) => {
            const h = Math.max(3, Math.round((t.tokens / maxTrend) * 100));
            const isToday = t.date === todayKey;
            const d = new Date(t.date + 'T00:00:00');
            return `<div class="chart-col" title="${t.date}　${fmt(t.tokens)} tokens / ${fmt(t.reqs)} 次">
              <div class="chart-bar-wrap">
                <div class="chart-bar ${isToday ? 'today' : ''}" style="height:${h}%"></div>
              </div>
              <span class="chart-x ${isToday ? 'today' : ''}">${isToday ? '今天' : (d.getMonth() + 1) + '/' + d.getDate()}</span>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>`;

  const deptRank = `
    <div class="card">
      <div class="card-head">
        <div>
          <h3>部门用量</h3>
          <div class="sub">按今日消耗排序</div>
        </div>
      </div>
      <div class="card-body">
        ${o.deptRank.length ? o.deptRank.map((d) => `
          <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
              <span style="font-weight:550;font-size:13px">${esc(d.name)}</span>
              <span style="font-size:12px;color:var(--muted)" class="num">
                ${shortNum(d.dayTokens)} / ${d.dailyLimit ? shortNum(d.dailyLimit) : '不限'}${d.dailyLimit && d.percentDaily > 0 ? ` · ${d.percentDaily}%` : ''}
              </span>
            </div>
            <div class="bar"><i class="${barClass(d.percentDaily)}" style="width:${d.dailyLimit ? barWidth(d.percentDaily) : 0}%"></i></div>
          </div>`).join('') : '<div class="empty">还没有部门</div>'}
      </div>
    </div>`;

  const warnings = o.warnings.length ? `
    <div class="card" style="margin-bottom:16px">
      <div class="card-head">
        <div><h3>额度预警</h3><div class="sub">用量达到额度 80% 以上</div></div>
      </div>
      <div class="card-body" style="display:flex;flex-wrap:wrap;gap:9px">
        ${o.warnings.map((w) => `
          <span class="tag ${w.level === 'danger' ? 'tag-danger' : 'tag-warn'}">
            ${w.type === 'employee' ? '员工' : '部门'} · ${esc(w.name)} ${w.type === 'employee' ? '（' + esc(w.deptName) + '）' : ''} ${w.percent}%
          </span>`).join('')}
      </div>
    </div>` : '';

  const empTable = `
    <div class="card">
      <div class="card-head">
        <div><h3>员工用量 Top 10</h3><div class="sub">今日消耗排行</div></div>
        <button class="btn btn-ghost btn-sm" data-act="goto" data-key="employees">查看全部</button>
      </div>
      <div class="card-body tight table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>员工</th><th>部门</th><th>生效额度</th><th style="width:200px">今日进度</th><th>今日 Token</th><th>月度 Token</th>
          </tr></thead>
          <tbody>
            ${o.empRank.length ? o.empRank.map((e) => `
              <tr>
                <td>
                  <div class="cell-main">${esc(e.name)}</div>
                  ${e.hasOverride ? `<div class="cell-sub"><span class="tag tag-brand" style="font-size:10.5px;padding:0 6px">特例${e.countAgainstDept ? '' : '·独立'}</span></div>` : ''}
                </td>
                <td class="nowrap">${esc(e.deptName)}</td>
                <td class="nowrap num">${e.limitText}<span style="color:var(--muted);font-size:11px"> /日</span></td>
                <td>
                  <div class="bar"><i class="${barClass(e.percent)}" style="width:${barWidth(e.percent)}%"></i></div>
                  <div class="cell-sub num">${e.percent}%</div>
                </td>
                <td class="num nowrap">${fmt(e.dayTokens)}</td>
                <td class="num nowrap">${fmt(e.monthTokens)}</td>
              </tr>`).join('') : '<tr><td colspan="6" class="empty">还没有员工</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  $('#view').innerHTML = kpis + warnings +
    `<div class="grid-2">${trend}${deptRank}</div>` + empTable;
}

// ---------------------------------------------------------------- 部门页

function renderDepartments() {
  const items = state.depts;
  const rows = items.map((d) => `
    <tr>
      <td>
        <div class="cell-main">${esc(d.name)}</div>
        ${d.remark ? `<div class="cell-sub">${esc(d.remark)}</div>` : ''}
      </td>
      <td class="nowrap">
        <span class="tag tag-grey">${d.employeeCount} 人</span>
      </td>
      <td class="num nowrap">${d.quota.dailyTokens ? fmt(d.quota.dailyTokens) : '不限'}</td>
      <td class="num nowrap">${d.quota.monthlyTokens ? fmt(d.quota.monthlyTokens) : '不限'}</td>
      <td>
        <div class="bar" style="width:120px"><i class="${barClass(d.percentDaily)}" style="width:${d.quota.dailyTokens ? barWidth(d.percentDaily) : 0}%"></i></div>
        <div class="cell-sub num">${shortNum(d.usage.dayTokens)} / ${d.quota.dailyTokens ? shortNum(d.quota.dailyTokens) : '不限'}</div>
      </td>
      <td class="num nowrap">${d.quota.rpm ? d.quota.rpm + ' 次/分' : '不限'}</td>
      <td class="nowrap">
        <span class="tag ${d.status === 'active' ? 'tag-ok' : 'tag-grey'}">
          <span class="dot ${d.status === 'active' ? '' : 'off'}"></span>${d.status === 'active' ? '启用' : '停用'}
        </span>
      </td>
      <td class="nowrap">
        <button class="btn-link" data-act="edit-dept" data-id="${d.id}">编辑</button>
        <button class="btn-link danger" data-act="del-dept" data-id="${d.id}">删除</button>
      </td>
    </tr>`).join('');

  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <span class="tag tag-grey">${items.length} 个部门</span>
      </div>
      <button class="btn btn-primary btn-sm" data-act="new-dept">${ICON.plus} 新建部门</button>
    </div>
    <div class="card">
      <div class="card-body tight table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>部门</th><th>人数</th><th>日 Token 额度</th><th>月 Token 额度</th>
            <th style="width:160px">今日用量</th><th>RPM</th><th>状态</th><th style="width:110px">操作</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="empty"><strong>还没有部门</strong>先创建部门，员工才能继承额度</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 员工页

function renderEmployees() {
  const f = state.filters;
  let list = state.emps;
  if (f.empDept) list = list.filter((e) => e.deptId === f.empDept);
  if (f.empKeyword) {
    const k = f.empKeyword.toLowerCase();
    list = list.filter((e) => e.name.toLowerCase().includes(k) || (e.email || '').toLowerCase().includes(k));
  }

  const rows = list.map((e) => {
    const s = e.quotaSnapshot;
    const daily = s.fields.dailyTokens;
    const ruleTag = (s.hasOverride && s.overrideActive)
      ? `<span class="tag tag-brand">特例${s.countAgainstDept ? '' : ' · 独立额度'}</span>${s.overrideNote ? `<div class="cell-sub" title="${esc(s.overrideNote)}">${esc(s.overrideNote.slice(0, 22))}${s.overrideNote.length > 22 ? '…' : ''}</div>` : ''}`
      : (s.hasOverride && s.overrideExpired
        ? `<span class="tag tag-warn">特例已过期</span>`
        : `<span class="tag tag-grey">继承 · ${esc(s.deptName)}</span>`);

    return `
      <tr>
        <td>
          <div class="cell-main">${esc(e.name)}</div>
          ${e.email ? `<div class="cell-sub">${esc(e.email)}</div>` : ''}
        </td>
        <td class="nowrap">${esc(s.deptName)}</td>
        <td class="nowrap">
          <code class="cell-sub" style="font-family:var(--mono)" title="${esc(e.key)}">${esc(e.key.slice(0, 10))}…${esc(e.key.slice(-4))}</code>
          <button class="btn-link" data-act="copy" data-text="${esc(e.key)}">复制</button>
        </td>
        <td>${ruleTag}</td>
        <td>
          <div class="bar" style="width:130px"><i class="${barClass(daily.percent)}" style="width:${barWidth(daily.percent, daily.unlimited)}%"></i></div>
          <div class="cell-sub num">${fmt(daily.used)} / ${daily.limitText}</div>
        </td>
        <td class="num nowrap">${shortNum(s.usage.monthTokens)}</td>
        <td class="nowrap">
          <span class="tag ${e.status === 'active' ? 'tag-ok' : 'tag-grey'}">
            <span class="dot ${e.status === 'active' ? '' : 'off'}"></span>${e.status === 'active' ? '正常' : '停用'}
          </span>
        </td>
        <td class="nowrap">
          <button class="btn-link" data-act="emp-detail" data-id="${e.id}">配额详情</button>
          <button class="btn-link" data-act="edit-emp" data-id="${e.id}">编辑</button>
        </td>
      </tr>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="notice notice-info">
      ${ICON.info}
      <div><b>额度怎么算：</b>每个员工默认继承所属部门的配额；如果给他开了<b>特例</b>，特例里填了数字的维度就按特例来，留空的维度继续继承部门，填 <b>0</b> 表示该维度不限制。想让人在部门预算之外单独拿额度，把「占用部门池」关掉即可。</div>
    </div>

    <div class="toolbar">
      <div class="toolbar-left">
        <input class="input-sm" type="text" id="emp-search" placeholder="搜索姓名或邮箱" value="${esc(f.empKeyword)}" />
        <select class="input-sm" id="emp-dept-filter">
          <option value="">全部部门</option>
          ${state.depts.map((d) => `<option value="${d.id}" ${f.empDept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
        <span class="tag tag-grey">${list.length} 人</span>
      </div>
      <button class="btn btn-primary btn-sm" data-act="new-emp">${ICON.plus} 新增员工</button>
    </div>

    <div class="card">
      <div class="card-body tight table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>员工</th><th>部门</th><th>API Key</th><th>额度来源</th>
            <th style="width:170px">今日用量</th><th>本月 Token</th><th>状态</th><th style="width:130px">操作</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="8" class="empty"><strong>没有匹配的员工</strong>换个关键词，或者新增一位；也可以在「扩展插件」里从飞书 / 企业微信 / 文本批量导入</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  const search = $('#emp-search');
  if (search) {
    search.addEventListener('input', (ev) => {
      state.filters.empKeyword = ev.target.value;
      clearTimeout(search._t);
      search._t = setTimeout(() => {
        const pos = search.selectionStart;
        renderEmployees();
        const again = $('#emp-search');
        again.focus();
        again.setSelectionRange(pos, pos);
      }, 220);
    });
  }
  const deptFilter = $('#emp-dept-filter');
  if (deptFilter) {
    deptFilter.addEventListener('change', (ev) => {
      state.filters.empDept = ev.target.value;
      renderEmployees();
    });
  }
}

// ---------------------------------------------------------------- 渠道页

async function renderProviders() {
  const d = await api('/api/providers');
  state.providers = d.items;

  const cards = d.items.map((p) => `
    <div class="provider-card ${p.status === 'active' ? '' : 'disabled'}">
      <div class="provider-top">
        <div>
          <div class="provider-name">${esc(p.name)}</div>
          <div class="provider-url">${esc(p.baseUrl)}</div>
        </div>
        <span class="tag ${p.status === 'active' ? 'tag-ok' : 'tag-grey'}">
          <span class="dot ${p.status === 'active' ? '' : 'off'}"></span>${p.status === 'active' ? '启用' : '停用'}
        </span>
      </div>
      <div class="provider-meta">
        <span class="tag tag-outline">权重 ${p.weight}</span>
        <span class="tag tag-outline">${p.apiKey ? 'Key 已配置' : '未配置 Key'}</span>
        ${(p.models || []).slice(0, 4).map((m) => `<span class="tag tag-grey">${esc(m)}</span>`).join('')}
        ${(p.models || []).length > 4 ? `<span class="tag tag-grey">+${p.models.length - 4}</span>` : ''}
      </div>
      ${p.remark ? `<div class="cell-sub">${esc(p.remark)}</div>` : ''}
      <div class="provider-actions">
        <button class="btn btn-ghost btn-sm" data-act="probe-provider" data-id="${p.id}">连通测试</button>
        <button class="btn btn-ghost btn-sm" data-act="edit-provider" data-id="${p.id}">编辑</button>
        <button class="btn btn-danger-ghost btn-sm" data-act="del-provider" data-id="${p.id}">删除</button>
      </div>
    </div>`).join('');

  const activeCount = d.items.filter((p) => p.status === 'active').length;

  $('#view').innerHTML = `
    <div class="notice notice-warn">
      ${ICON.warn}
      <div><b>当前有 ${activeCount} 个渠道处于启用状态。</b>${activeCount === 0
        ? '所有渠道都停用了，网关会自动返回内置模拟响应，方便先验证配额流程；接真实模型时把渠道启用并填入 Key 即可。'
        : '员工永远不会拿到这些真实 Key，平台只把虚拟密钥发给员工，转发时在服务端替换。'}</div>
    </div>
    <div class="toolbar">
      <div class="toolbar-left"><span class="tag tag-grey">${d.items.length} 个渠道</span></div>
      <button class="btn btn-primary btn-sm" data-act="new-provider">${ICON.plus} 新增渠道</button>
    </div>
    ${d.items.length ? `<div class="provider-grid">${cards}</div>`
      : `<div class="card"><div class="empty"><strong>还没有配置上游渠道</strong>新增一个 OpenAI 兼容的渠道，填入 Base URL 和 Key 就能用了</div></div>`}`;
}

// ---------------------------------------------------------------- 日志页

async function renderLogs() {
  const q = state.filters.logStatus ? `?status=${state.filters.logStatus}` : '';
  const d = await api('/api/logs' + q);
  state.logs = d.items;

  const rows = d.items.map((x) => `
    <tr>
      <td class="nowrap" style="color:var(--muted);font-size:12px">${timeText(x.ts)}</td>
      <td>
        <div class="cell-main">${esc(x.employeeName)}</div>
        <div class="cell-sub">${esc(x.deptName)}</div>
      </td>
      <td><span class="tag tag-grey">${esc(x.model)}</span></td>
      <td class="nowrap">${esc(x.providerName)}</td>
      <td class="num nowrap">${fmt(x.totalTokens)}</td>
      <td class="num nowrap" style="color:var(--muted)">${x.latencyMs} ms</td>
      <td class="nowrap">
        <span class="tag ${x.status === 'ok' ? 'tag-ok' : (x.status === 'rejected' ? 'tag-warn' : 'tag-danger')}">
          ${x.status === 'ok' ? '成功' : (x.status === 'rejected' ? '配额拦截' : '失败')}
        </span>
        ${x.error ? `<div class="cell-sub" title="${esc(x.error)}">${esc(x.error.slice(0, 30))}${x.error.length > 30 ? '…' : ''}</div>` : ''}
      </td>
    </tr>`).join('');

  $('#view').innerHTML = `
    <div class="toolbar">
      <div class="toolbar-left">
        <select class="input-sm" id="log-status">
          <option value="">全部状态</option>
          <option value="ok" ${state.filters.logStatus === 'ok' ? 'selected' : ''}>成功</option>
          <option value="rejected" ${state.filters.logStatus === 'rejected' ? 'selected' : ''}>配额拦截</option>
          <option value="error" ${state.filters.logStatus === 'error' ? 'selected' : ''}>失败</option>
        </select>
        <span class="tag tag-grey">最近 ${d.items.length} 条</span>
      </div>
    </div>
    <div class="card">
      <div class="card-body tight table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>时间</th><th>员工</th><th>模型</th><th>渠道</th><th>Token</th><th>耗时</th><th>状态</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="empty"><strong>还没有调用记录</strong>用「接入文档」里的示例发一个请求试试</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#log-status').addEventListener('change', (e) => {
    state.filters.logStatus = e.target.value;
    renderLogs();
  });
}

// ---------------------------------------------------------------- 文档页

function renderDocs() {
  const base = location.origin;
  // 示例密钥默认取第一位员工，可在下拉框里切换，避免把 A 的密钥当成通用密钥发出去
  if (!state.docsEmpId) state.docsEmpId = state.emps[0]?.id || '';
  const emp = state.emps.find((e) => e.id === state.docsEmpId) || state.emps[0];
  const sampleKey = emp ? emp.key : 'sk-ai-请先在员工管理中创建账号';

  const empPicker = state.emps.length ? `
    <select class="input-sm" id="docs-emp">
      ${state.emps.map((e) => `<option value="${e.id}" ${emp && e.id === emp.id ? 'selected' : ''}>${esc(e.name)} · ${esc(e.quotaSnapshot?.deptName || '')}</option>`).join('')}
    </select>` : '';

  $('#view').innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-head">
          <div><h3>接入地址</h3><div class="sub">兼容 OpenAI 协议，现有 SDK 改一个 base_url 即可</div></div>
          ${empPicker}
        </div>
        <div class="card-body">
          <div class="copy-line">
            <div>
              <div class="label">Base URL</div>
              <code>${esc(base)}/v1</code>
            </div>
            <button class="btn btn-ghost btn-sm" data-act="copy" data-text="${esc(base)}/v1">复制</button>
          </div>
          <div class="copy-line">
            <div>
              <div class="label">API Key${emp ? `（${esc(emp.name)} 的专属密钥）` : ''}</div>
              <code>${esc(sampleKey)}</code>
            </div>
            <button class="btn btn-ghost btn-sm" data-act="copy" data-text="${esc(sampleKey)}">复制</button>
          </div>
          <div class="notice notice-info" style="margin:14px 0 0">
            ${ICON.info}
            <div><b>每位员工应当用自己的密钥。</b>平台签发的是虚拟 Key，不是上游服务的真实密钥；真实 Key 只存在服务端。
              员工调岗或离职时，删掉账号或重置他的密钥即可，其他人的配置完全不受影响。</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>调用限制响应</h3><div class="sub">超额时返回 429 与明确原因</div></div></div>
        <div class="card-body">
          <pre class="code"><span class="c">// HTTP 429 Too Many Requests</span>
{
  <span class="k">"error"</span>: {
    <span class="k">"type"</span>: <span class="s">"quota_exceeded"</span>,
    <span class="k">"message"</span>: <span class="s">"员工每日 Token 额度已用尽（200,000/200,000）"</span>,
    <span class="k">"dimension"</span>: <span class="s">"dailyTokens"</span>,
    <span class="k">"scope"</span>: <span class="s">"employee"</span>
  }
}</pre>
          <p class="field-hint" style="margin-top:10px"><code>scope</code> 为 <code>employee</code> 表示触发了员工特例额度，<code>department</code> 表示触发的是部门池。</p>
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><h3>代码示例</h3><div class="sub">拿到地址和 Key 后直接替换即可</div></div></div>
      <div class="card-body">
        <div class="section-label">curl</div>
        <pre class="code">curl ${esc(base)}/v1/chat/completions \\
  -H <span class="s">"Content-Type: application/json"</span> \\
  -H <span class="s">"Authorization: Bearer ${esc(sampleKey)}"</span> \\
  -d <span class="s">'{
    "model": "gpt-4o-mini",
    "messages": [{"role": "user", "content": "用一句话解释什么是向量数据库"}]
  }'</span></pre>

        <div class="section-label">Python（openai SDK）</div>
        <pre class="code"><span class="k">from</span> openai <span class="k">import</span> OpenAI

client = OpenAI(
    base_url=<span class="s">"${esc(base)}/v1"</span>,
    api_key=<span class="s">"${esc(sampleKey)}"</span>,
)

resp = client.chat.completions.create(
    model=<span class="s">"gpt-4o-mini"</span>,
    messages=[{<span class="s">"role"</span>: <span class="s">"user"</span>, <span class="s">"content"</span>: <span class="s">"你好"</span>}],
)
<span class="k">print</span>(resp.choices[0].message.content)</pre>

        <div class="section-label">Node.js</div>
        <pre class="code"><span class="k">import</span> OpenAI <span class="k">from</span> <span class="s">'openai'</span>;

<span class="k">const</span> client = <span class="k">new</span> OpenAI({
  baseURL: <span class="s">'${esc(base)}/v1'</span>,
  apiKey: <span class="s">'${esc(sampleKey)}'</span>,
});

<span class="k">const</span> stream = <span class="k">await</span> client.chat.completions.create({
  model: <span class="s">'gpt-4o-mini'</span>,
  messages: [{ role: <span class="s">'user'</span>, content: <span class="s">'你好'</span> }],
  stream: <span class="k">true</span>,
});

<span class="k">for await</span> (<span class="k">const</span> chunk <span class="k">of</span> stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || <span class="s">''</span>);
}</pre>

        <div class="section-label">Dify / Cherry Studio / 各类客户端</div>
        <p class="field-hint" style="font-size:13px;color:var(--text-2)">
          在客户端的「自定义 OpenAI 接口」里填：<br>
          API Base / Base URL：<code style="font-family:var(--mono)">${esc(base)}/v1</code><br>
          API Key：该员工在平台上对应的虚拟密钥<br>
          模型名：填上游支持的模型，或先在「上游渠道」里配置好模型列表。
        </p>
      </div>
    </div>`;

  const picker = $('#docs-emp');
  if (picker) {
    picker.addEventListener('change', (e) => {
      state.docsEmpId = e.target.value;
      renderDocs();
    });
  }
}

// ---------------------------------------------------------------- 设置页

// ---------------------------------------------------------------- 扩展插件页

const PLUGIN_EMOJI = { feishu: '🐦', wecom: '💬', csv: '📄' };

function pluginStatusTag(p) {
  return p.lastSyncAt
    ? '<span class="tag tag-ok"><span class="dot"></span>已同步</span>'
    : (p.configured
      ? '<span class="tag tag-grey">已配置</span>'
      : '<span class="tag tag-outline">未配置</span>');
}

function pluginFormFields(p) {
  return p.fields.map((f) => {
    const v = p.config[f.key] || '';
    const id = `pg-${p.id}-${f.key}`;
    if (f.type === 'textarea') {
      return `<label class="field"><span>${esc(f.label)}</span><textarea id="${id}" rows="5" placeholder="${esc(f.placeholder || '')}">${esc(v)}</textarea>${f.hint ? `<span class="field-hint">${esc(f.hint)}</span>` : ''}</label>`;
    }
    return `<label class="field"><span>${esc(f.label)}</span><input type="${f.type === 'password' ? 'password' : 'text'}" id="${id}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" />${f.hint ? `<span class="field-hint">${esc(f.hint)}</span>` : ''}</label>`;
  }).join('');
}

const PLUGIN_SYNC_RULE_HTML = `
  <div class="notice notice-info">
    ${ICON.info}
    <div><b>同步规则：</b>部门按名称合并（已存在则不动），员工按邮箱（其次同名）匹配——已有员工只更新归属部门，<b>不会改动任何已设置的额度与密钥</b>；新员工自动签发虚拟 Key。同步可反复执行，不会产生重复数据。</div>
  </div>`;

/** 一级页：插件列表（点卡片进入对应插件） */
async function renderPlugins() {
  if (state.pluginId) return renderPluginDetail(state.pluginId);

  const d = await api('/api/plugins');
  state.plugins = d.items;

  const cards = d.items.map((p) => {
    const sub = p.lastSyncAt
      ? `上次同步 ${timeText(p.lastSyncAt)}`
      : (p.configured ? '配置已保存，进入后可直接同步' : '尚未配置，点击进入填写');
    return `
      <div class="plugin-card" data-act="open-plugin" data-id="${p.id}">
        <div class="plugin-card-head">
          <span class="plugin-icon">${PLUGIN_EMOJI[p.id] || '🧩'}</span>
          <div style="flex:1;min-width:0">
            <div class="cell-main">${esc(p.name)}</div>
            <div class="cell-sub">${sub}</div>
          </div>
          ${pluginStatusTag(p)}
        </div>
        <p class="plugin-desc">${esc(p.desc)}</p>
        <div class="plugin-enter">进入插件 →</div>
      </div>`;
  }).join('');

  $('#view').innerHTML = `
    <div class="plugin-grid">${cards}</div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><h3>接入更多系统</h3><div class="sub">钉钉、LDAP、HR 系统都能接，装好后会出现在上面的列表里</div></div></div>
      <div class="card-body">
        <p class="field-hint" style="margin:0;font-size:13px">
          每个插件就是一个实现了 <code style="font-family:var(--mono)">fetchOrg(config) → { departments, employees }</code>
          的对象，注册在 <code style="font-family:var(--mono)">lib/plugins.js</code> 的 <code style="font-family:var(--mono)">REGISTRY</code> 里。
          照着飞书插件的写法加一个即可，配置表单、同步合并和这里的卡片都会自动生效。
        </p>
      </div>
    </div>`;
}

/** 二级页：某个插件的配置与同步 */
async function renderPluginDetail(id) {
  const d = await api('/api/plugins');
  state.plugins = d.items;
  const p = d.items.find((x) => x.id === id);
  if (!p) {
    state.pluginId = '';
    return renderPlugins();
  }

  const lastResult = p.lastResult
    ? `<div class="cell-sub" style="margin-top:8px">${esc(p.lastResult)}</div>`
    : '';

  $('#view').innerHTML = `
    <button class="btn-link" data-act="back-plugins" style="font-size:13px">← 返回插件列表</button>

    <div class="card" style="margin-top:12px">
      <div class="card-head">
        <div style="display:flex;align-items:center;gap:12px">
          <span class="plugin-icon">${PLUGIN_EMOJI[p.id] || '🧩'}</span>
          <div>
            <h3 style="margin:0">${esc(p.name)}</h3>
            <div class="sub">${esc(p.desc)}</div>
          </div>
        </div>
        ${pluginStatusTag(p)}
      </div>
      <div class="card-body">
        <div class="grid-2" style="align-items:start">${pluginFormFields(p)}</div>
        <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" data-act="plugin-save" data-id="${p.id}">保存配置</button>
          <button class="btn btn-ghost btn-sm" data-act="plugin-test" data-id="${p.id}">连接测试</button>
          <button class="btn btn-ghost btn-sm" data-act="plugin-sync" data-id="${p.id}">立即同步</button>
        </div>
        ${lastResult}
      </div>
    </div>

    <div style="margin-top:16px">${PLUGIN_SYNC_RULE_HTML}</div>`;
}

// ---------------------------------------------------------------- 系统设置

function renderSettings() {
  const s = state.settings;
  $('#view').innerHTML = `
    <div class="grid-2">
      <div class="card">
        <div class="card-head"><div><h3>基础设置</h3><div class="sub">影响所有员工的默认行为</div></div></div>
        <div class="card-body">
          <label class="field">
            <span>平台名称</span>
            <input type="text" id="set-name" value="${esc(s.platformName)}" />
          </label>
          <label class="field">
            <span>额度用尽时的策略</span>
            <select id="set-onExceed">
              <option value="block" ${s.onExceed === 'block' ? 'selected' : ''}>直接拒绝（返回 429）</option>
              <option value="downgrade" ${s.onExceed === 'downgrade' ? 'selected' : ''}>降级到备用模型（预留）</option>
            </select>
            <span class="field-hint">当前版本推荐「直接拒绝」，原因最明确，员工也容易理解。</span>
          </label>
          <div style="margin:16px 0 18px">
            <label class="switch">
              <input type="checkbox" id="set-mock" ${s.mockWhenNoProvider ? 'checked' : ''} />
              <span class="switch-track"></span>
              <span class="switch-label">没有可用渠道时返回内置模拟响应</span>
            </label>
          </div>
          <button class="btn btn-primary btn-sm" data-act="save-settings">保存设置</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>修改管理员密码</h3><div class="sub">默认密码请务必更换</div></div></div>
        <div class="card-body">
          <label class="field"><span>原密码</span><input type="password" id="pw-old" /></label>
          <label class="field"><span>新密码</span><input type="password" id="pw-new" placeholder="至少 6 位" /></label>
          <label class="field"><span>确认新密码</span><input type="password" id="pw-new2" /></label>
          <button class="btn btn-primary btn-sm" data-act="save-password">更新密码</button>
        </div>
      </div>
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div><h3>数据管理</h3><div class="sub">清空部门、员工、日志与统计</div></div></div>
        <div class="card-body">
          <p class="field-hint" style="margin-top:0;font-size:13px">
            清空后平台回到「零业务数据」状态，适合正式启用前抹掉演示数据。<b>上游渠道与模型配置、平台设置会完整保留</b>；
            清空前会自动在 <code style="font-family:var(--mono)">data/</code> 目录生成完整备份文件。
          </p>
          <button class="btn btn-danger-ghost btn-sm" data-act="reset-data">清空业务数据（保留上游渠道）</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><h3>数据备份</h3><div class="sub">导出配置（不含真实密钥与密码）</div></div></div>
        <div class="card-body">
          <p class="field-hint" style="margin-top:0;font-size:13px">
            所有数据保存在 <code style="font-family:var(--mono)">data/db.json</code>，直接复制该文件即可完成备份。
            下面是脱敏后的配置导出，适合排查问题或迁移结构。
          </p>
          <button class="btn btn-ghost btn-sm" data-act="export">下载脱敏配置</button>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 弹窗基础

function closeModal() {
  $('#modal-root').innerHTML = '';
}

function openModal({ title, sub, body, footer, wide }) {
  $('#modal-root').innerHTML = `
    <div class="modal-mask" data-act="mask">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <div>
            <h3>${esc(title)}</h3>
            ${sub ? `<p>${sub}</p>` : ''}
          </div>
          <button class="modal-close" data-act="close-modal">&times;</button>
        </div>
        <div class="modal-body">${body}</div>
        <div class="modal-foot">${footer}</div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 部门表单

function deptForm(dept) {
  const d = dept || { name: '', remark: '', quota: { dailyTokens: 0, monthlyTokens: 0, rpm: 0, concurrency: 0 }, providerIds: [], status: 'active' };
  const q = d.quota || {};
  const val = (v) => (v === 0 || v == null ? '' : v);

  openModal({
    title: dept ? '编辑部门' : '新建部门',
    sub: '部门的配额是员工额度的默认来源',
    body: `
      <label class="field">
        <span>部门名称 *</span>
        <input type="text" id="f-name" value="${esc(d.name)}" placeholder="例如：研发部" />
      </label>
      <label class="field">
        <span>备注</span>
        <input type="text" id="f-remark" value="${esc(d.remark || '')}" placeholder="这个部门主要用来做什么" />
      </label>

      <div class="section-label">部门配额（留空 = 不限制）</div>
      <div class="form-row">
        <label class="field">
          <span>每日 Token 上限</span>
          <input type="number" id="f-daily" value="${val(q.dailyTokens)}" placeholder="不限" min="0" />
        </label>
        <label class="field">
          <span>每月 Token 上限</span>
          <input type="number" id="f-monthly" value="${val(q.monthlyTokens)}" placeholder="不限" min="0" />
        </label>
      </div>
      <div class="form-row">
        <label class="field">
          <span>每分钟请求数（RPM）</span>
          <input type="number" id="f-rpm" value="${val(q.rpm)}" placeholder="不限" min="0" />
        </label>
        <label class="field">
          <span>并发上限</span>
          <input type="number" id="f-conc" value="${val(q.concurrency)}" placeholder="不限" min="0" />
        </label>
      </div>

      <div class="section-label">渠道绑定（可选）</div>
      <p class="field-hint" style="margin-top:0">不选则使用全部启用的渠道；选了以后该部门的流量只在选中的渠道里分流。</p>
      <div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:8px">
        ${state.providers.map((p) => `
          <label class="switch">
            <input type="checkbox" class="f-prov" value="${p.id}" ${(d.providerIds || []).includes(p.id) ? 'checked' : ''} />
            <span class="switch-track"></span>
            <span class="switch-label" style="font-weight:400;font-size:13px">${esc(p.name)}</span>
          </label>`).join('') || '<span class="field-hint">还没有上游渠道</span>'}
      </div>

      <label class="switch" style="margin-top:18px">
        <input type="checkbox" id="f-status" ${d.status !== 'disabled' ? 'checked' : ''} />
        <span class="switch-track"></span>
        <span class="switch-label">启用该部门</span>
      </label>
    `,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-dept" data-id="${d.id || ''}">保存</button>
    `,
  });
}

// ---------------------------------------------------------------- 员工表单（核心）

function empForm(emp) {
  const isNew = !emp;
  const e = emp || {
    name: '', email: '', deptId: state.depts[0]?.id || '', status: 'active',
    override: { enabled: false, dailyTokens: null, monthlyTokens: null, rpm: null, concurrency: null, countAgainstDept: true, expiresAt: '', note: '' },
  };
  const ov = e.override || {};

  const deptOptions = state.depts.map((d) =>
    `<option value="${d.id}" ${e.deptId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');

  openModal({
    title: isNew ? '新增员工' : '编辑员工',
    sub: isNew ? '保存后会自动生成一个虚拟密钥' : '修改特例额度会立即生效，无需重启',
    wide: true,
    body: `
      <div class="form-row">
        <label class="field">
          <span>姓名 *</span>
          <input type="text" id="e-name" value="${esc(e.name)}" placeholder="例如：张伟" />
        </label>
        <label class="field">
          <span>邮箱 / 工号</span>
          <input type="text" id="e-email" value="${esc(e.email || '')}" placeholder="选填，便于识别" />
        </label>
      </div>
      <div class="form-row">
        <label class="field">
          <span>所属部门 *</span>
          <select id="e-dept">${deptOptions || '<option value="">请先创建部门</option>'}</select>
        </label>
        <label class="field">
          <span>账号状态</span>
          <select id="e-status">
            <option value="active" ${e.status !== 'disabled' ? 'selected' : ''}>正常</option>
            <option value="disabled" ${e.status === 'disabled' ? 'selected' : ''}>停用（拒绝所有请求）</option>
          </select>
        </label>
      </div>

      <div class="section-label">额度规则</div>

      <div class="override-box ${ov.enabled ? '' : 'disabled'}">
        <div class="override-head">
          <div class="override-title">
            <label class="switch">
              <input type="checkbox" id="e-ov-enabled" ${ov.enabled ? 'checked' : ''} />
              <span class="switch-track"></span>
              <span class="switch-label">给这名员工设置特例额度</span>
            </label>
          </div>
        </div>

        <div id="ov-summary" class="effect-line"></div>

        <div id="ov-fields" class="${ov.enabled ? '' : 'hidden'}">
          <div class="explain" style="margin-top:0;margin-bottom:13px">
            <b>规则：</b>填写数字 = 用这个值；<b>留空</b> = 继续继承部门；填 <b>0</b> = 该维度不限制。
            特例一旦启用，填了值的维度就<b>优先于部门</b>。
          </div>
          <div class="form-row">
            <label class="field">
              <span>每日 Token 上限</span>
              <input type="number" class="ov-in" id="e-ov-daily" value="${ov.dailyTokens ?? ''}" placeholder="继承部门" min="0" />
            </label>
            <label class="field">
              <span>每月 Token 上限</span>
              <input type="number" class="ov-in" id="e-ov-monthly" value="${ov.monthlyTokens ?? ''}" placeholder="继承部门" min="0" />
            </label>
          </div>
          <div class="form-row">
            <label class="field">
              <span>每分钟请求数（RPM）</span>
              <input type="number" class="ov-in" id="e-ov-rpm" value="${ov.rpm ?? ''}" placeholder="继承部门" min="0" />
            </label>
            <label class="field">
              <span>并发上限</span>
              <input type="number" class="ov-in" id="e-ov-conc" value="${ov.concurrency ?? ''}" placeholder="继承部门" min="0" />
            </label>
          </div>

          <label class="switch" style="margin-bottom:10px">
            <input type="checkbox" id="e-ov-count" ${ov.countAgainstDept !== false ? 'checked' : ''} />
            <span class="switch-track"></span>
            <span class="switch-label">用量同时计入部门池</span>
          </label>
          <span class="field-hint" style="margin-top:-4px;margin-bottom:12px;display:block">
            关闭后，这名员工的消耗<b>不扣部门预算</b>，等于在部门之外单独给了一块额度。适合给算法组、外包团队单独核算。
          </span>

          <div class="form-row">
            <label class="field">
              <span>特例有效期（留空 = 长期有效）</span>
              <input type="date" id="e-ov-expire" value="${esc((ov.expiresAt || '').slice(0, 10))}" />
            </label>
            <label class="field">
              <span>备注</span>
              <input type="text" id="e-ov-note" value="${esc(ov.note || '')}" placeholder="为什么给他开特例" />
            </label>
          </div>
        </div>

        <div id="ov-preview"></div>
      </div>
    `,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-emp" data-id="${e.id || ''}">保存</button>
    `,
  });

  // —— 实时预览：改了任何字段都重算生效额度
  const refreshPreview = () => {
    const deptId = $('#e-dept').value;
    const dept = state.depts.find((x) => x.id === deptId);
    const enabled = $('#e-ov-enabled').checked;
    const ovNow = enabled ? {
      dailyTokens: $('#e-ov-daily').value,
      monthlyTokens: $('#e-ov-monthly').value,
      rpm: $('#e-ov-rpm').value,
      concurrency: $('#e-ov-conc').value,
      countAgainstDept: $('#e-ov-count').checked,
    } : null;

    $('#ov-fields').classList.toggle('hidden', !enabled);
    $('.override-box').classList.toggle('disabled', !enabled);

    const rows = resolvePreview(dept, ovNow);

    // 首屏就能看到的一行摘要：哪些维度用了特例，一眼可辨
    const short = { dailyTokens: '日', monthlyTokens: '月', rpm: 'RPM', concurrency: '并发' };
    const bits = rows.map((r) =>
      `${short[r.key]} <b class="${r.source === 'employee' ? 'emp' : ''}">${r.valueText}</b>`).join(' · ');
    $('#ov-summary').innerHTML = `
      <div style="font-size:12.5px;line-height:1.7">
        生效额度：${bits}
        ${enabled && ovNow && ovNow.countAgainstDept === false
          ? '<span class="tag tag-brand" style="margin-left:6px">不占部门池</span>'
          : '<span class="tag tag-grey" style="margin-left:6px">计入部门池</span>'}
      </div>`;

    $('#ov-preview').innerHTML = `
      <div class="section-label" style="margin-top:16px">当前生效额度</div>
      <table class="preview-table">
        <thead><tr><th>维度</th><th>生效值</th><th>来源</th><th>部门默认</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>${r.label}</td>
              <td class="num"><b>${r.valueText}</b></td>
              <td><span class="tag ${r.source === 'employee' ? 'tag-brand' : (r.source === 'department' ? 'tag-grey' : 'tag-outline')}" style="font-size:11px">${r.sourceText}</span></td>
              <td class="num" style="color:var(--muted)">${r.deptText}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="field-hint" style="margin-top:8px">
        ${enabled && ovNow.countAgainstDept === false
          ? '该员工的用量<b>不占用</b>部门池，部门预算只统计其余员工。'
          : '该员工的用量会计入部门池，个人额度与部门预算形成双重约束。'}
      </p>`;
  };

  $('#e-ov-enabled').addEventListener('change', refreshPreview);
  $('#e-dept').addEventListener('change', refreshPreview);
  ['#e-ov-daily', '#e-ov-monthly', '#e-ov-rpm', '#e-ov-conc', '#e-ov-count'].forEach((sel) => {
    const el = $(sel);
    if (el) el.addEventListener('input', refreshPreview);
    if (el) el.addEventListener('change', refreshPreview);
  });
  refreshPreview();

  // 没有部门时提示
  if (!state.depts.length) {
    toast('请先创建部门，员工需要归属部门才能继承额度', 'err');
  }
}

/** 前端侧复刻配额解析逻辑，用于表单实时预览 */
function resolvePreview(dept, ov) {
  const FIELDS = [
    { key: 'dailyTokens', label: '每日 Token' },
    { key: 'monthlyTokens', label: '每月 Token' },
    { key: 'rpm', label: '每分钟请求' },
    { key: 'concurrency', label: '并发数' },
  ];
  const toNum = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  const text = (v) => (v === 0 || v == null ? '不限' : fmt(v));

  return FIELDS.map((f) => {
    const deptVal = dept ? toNum(dept.quota?.[f.key]) : null;
    const ovVal = ov ? toNum(ov[f.key]) : null;
    let value, source, sourceText;
    if (ov && ovVal !== null) {
      value = ovVal; source = 'employee'; sourceText = '员工特例';
    } else if (deptVal !== null) {
      value = deptVal; source = 'department'; sourceText = '继承部门';
    } else {
      value = 0; source = 'none'; sourceText = '未限制';
    }
    return {
      key: f.key,
      label: f.label,
      valueText: text(value),
      source, sourceText,
      deptText: dept ? text(deptVal) : '—',
    };
  });
}

// ---------------------------------------------------------------- 员工详情

async function empDetail(id) {
  const snap = await api(`/api/employees/${id}/quota`);
  const emp = state.emps.find((x) => x.id === id);
  const logs = await api(`/api/logs?employeeId=${id}&limit=8`);

  const fieldRow = (k) => {
    const f = snap.fields[k];
    const cls = f.source === 'employee' ? 'tag-brand' : (f.source === 'department' ? 'tag-grey' : 'tag-outline');
    const UNIT = { dailyTokens: '/日', monthlyTokens: '/月', rpm: '次/分', concurrency: '个' };
    return `
      <tr>
        <td>${f.label}</td>
        <td class="num nowrap"><b>${f.limitText}</b>${f.unlimited ? '' : ' ' + (UNIT[k] || '')}</td>
        <td class="num">${fmt(f.used)}</td>
        <td style="width:120px">
          <div class="bar"><i class="${barClass(f.percent)}" style="width:${barWidth(f.percent, f.unlimited)}%"></i></div>
          <div class="cell-sub num">${f.unlimited ? '—' : f.percent + '%'}</div>
        </td>
        <td><span class="tag ${cls}" style="font-size:11px">${f.sourceText}</span></td>
      </tr>`;
  };

  openModal({
    title: '员工配额详情',
    wide: true,
    body: `
      <div class="detail-hd">
        <div class="avatar">${esc((emp?.name || '?').slice(0, 1))}</div>
        <div>
          <div style="font-weight:600;font-size:15px">${esc(emp?.name || '')}</div>
          <div class="cell-sub">${esc(snap.deptName)}${emp?.email ? ' · ' + esc(emp.email) : ''}</div>
        </div>
        <div style="margin-left:auto">
          ${snap.hasOverride && snap.overrideActive
            ? `<span class="tag tag-brand">特例生效中</span>`
            : (snap.overrideExpired ? `<span class="tag tag-warn">特例已过期</span>` : `<span class="tag tag-grey">继承部门</span>`)}
        </div>
      </div>

      ${snap.overrideNote ? `<div class="explain" style="margin-top:0;margin-bottom:14px"><b>备注：</b>${esc(snap.overrideNote)}</div>` : ''}

      <div class="section-label">虚拟密钥</div>
      <div class="key-box">
        <code id="key-text" data-full="${esc(emp?.key || '')}">${'•'.repeat(28)}</code>
        <button class="btn btn-ghost btn-sm" data-act="toggle-key">显示</button>
        <button class="btn btn-ghost btn-sm" data-act="copy" data-text="${esc(emp?.key || '')}">复制</button>
        <button class="btn btn-danger-ghost btn-sm" data-act="rotate-key" data-id="${id}">重置</button>
      </div>
      <p class="field-hint">重置后旧密钥立即失效，该员工需要换成新密钥。</p>

      <div class="section-label">额度使用情况</div>
      <table class="preview-table">
        <thead><tr><th>维度</th><th>额度</th><th>已用</th><th>进度</th><th>来源</th></tr></thead>
        <tbody>
          ${fieldRow('dailyTokens')}
          ${fieldRow('monthlyTokens')}
          ${fieldRow('rpm')}
          ${fieldRow('concurrency')}
        </tbody>
      </table>

      ${snap.deptPool ? `
        <div class="section-label">部门池（${esc(snap.deptPool.name)}）</div>
        <div class="explain" style="margin-top:0">
          ${snap.countAgainstDept
            ? '该员工的消耗<b>计入</b>部门池。'
            : '该员工的消耗<b>不计入</b>部门池，用的是独立额度。'}
          <br>
          部门今日：${fmt(snap.deptPool.dayUsed)} / ${snap.deptPool.dailyTokens ? fmt(snap.deptPool.dailyTokens) : '不限'}　
          本月：${fmt(snap.deptPool.monthUsed)} / ${snap.deptPool.monthlyTokens ? fmt(snap.deptPool.monthlyTokens) : '不限'}
        </div>` : ''}

      <div class="section-label">最近调用</div>
      ${logs.items.length ? `
        <table class="preview-table">
          <thead><tr><th>时间</th><th>模型</th><th>Token</th><th>状态</th></tr></thead>
          <tbody>
            ${logs.items.map((x) => `
              <tr>
                <td style="color:var(--muted)">${timeText(x.ts)}</td>
                <td>${esc(x.model)}</td>
                <td class="num">${fmt(x.totalTokens)}</td>
                <td><span class="tag ${x.status === 'ok' ? 'tag-ok' : 'tag-warn'}" style="font-size:11px">${x.status === 'ok' ? '成功' : (x.status === 'rejected' ? '拦截' : '失败')}</span></td>
              </tr>`).join('')}
          </tbody>
        </table>` : '<p class="field-hint">还没有调用记录</p>'}
    `,
    footer: `<button class="btn btn-ghost" data-act="close-modal">关闭</button>`,
  });
}

// ---------------------------------------------------------------- 渠道表单

function providerForm(p) {
  const d = p || { name: '', baseUrl: '', apiKey: '', models: [], weight: 1, timeoutMs: 120000, status: 'active', remark: '' };
  openModal({
    title: p ? '编辑渠道' : '新增上游渠道',
    sub: '需要支持 OpenAI 兼容协议的服务',
    body: `
      <label class="field">
        <span>渠道名称 *</span>
        <input type="text" id="p-name" value="${esc(d.name)}" placeholder="例如：OpenAI 官方" />
      </label>
      <label class="field">
        <span>Base URL *</span>
        <input type="text" id="p-url" value="${esc(d.baseUrl)}" placeholder="https://api.openai.com" />
        <span class="field-hint">只填到域名，平台会自动拼 /v1/chat/completions。也可以写成 https://xxx.com/v1。</span>
      </label>
      <label class="field">
        <span>真实 API Key</span>
        <input type="text" id="p-key" value="${esc(d.apiKey)}" placeholder="sk-..." />
        <span class="field-hint">只保存在服务端，不会下发给员工。编辑时留空或保持打码表示不修改。</span>
      </label>
      <label class="field">
        <span>支持的模型</span>
        <input type="text" id="p-models" value="${esc((d.models || []).join(', '))}" placeholder="gpt-4o, gpt-4o-mini（留空 = 全部）" />
        <span class="field-hint">用逗号分隔。想匹配一整类可以写前缀通配，如 gpt-4o*。</span>
      </label>
      <div class="form-row-3">
        <label class="field">
          <span>权重</span>
          <input type="number" id="p-weight" value="${d.weight}" min="1" />
        </label>
        <label class="field">
          <span>超时（毫秒）</span>
          <input type="number" id="p-timeout" value="${d.timeoutMs}" min="1000" step="1000" />
        </label>
        <label class="field">
          <span>状态</span>
          <select id="p-status">
            <option value="active" ${d.status === 'active' ? 'selected' : ''}>启用</option>
            <option value="disabled" ${d.status === 'disabled' ? 'selected' : ''}>停用</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span>备注</span>
        <input type="text" id="p-remark" value="${esc(d.remark || '')}" placeholder="用途说明" />
      </label>
    `,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-provider" data-id="${d.id || ''}">保存</button>
    `,
  });
}

// ---------------------------------------------------------------- 事件绑定

const viewEl = () => $('#view');

document.addEventListener('click', async (ev) => {
  const navEl = ev.target.closest('[data-nav]');
  if (navEl) { navigate(navEl.dataset.nav); return; }

  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;

  try {
    switch (act) {
      case 'close-modal':
        closeModal();
        break;

      case 'mask':
        if (ev.target === el) closeModal();
        break;

      case 'goto':
        navigate(el.dataset.key);
        break;

      case 'copy': {
        const text = el.dataset.text || '';
        await navigator.clipboard.writeText(text);
        toast('已复制到剪贴板', 'ok');
        break;
      }

      case 'toggle-key': {
        const code = $('#key-text');
        const full = code.dataset.full;
        if (code.textContent.includes('•')) {
          code.textContent = full;
          el.textContent = '隐藏';
        } else {
          code.textContent = '•'.repeat(28);
          el.textContent = '显示';
        }
        break;
      }

      case 'new-dept':
        deptForm(null);
        break;

      case 'edit-dept': {
        const d = state.depts.find((x) => x.id === id);
        deptForm(d);
        break;
      }

      case 'save-dept': {
        const payload = {
          name: $('#f-name').value.trim(),
          remark: $('#f-remark').value.trim(),
          quota: {
            dailyTokens: $('#f-daily').value || 0,
            monthlyTokens: $('#f-monthly').value || 0,
            rpm: $('#f-rpm').value || 0,
            concurrency: $('#f-conc').value || 0,
          },
          providerIds: $$('.f-prov').filter((c) => c.checked).map((c) => c.value),
          status: $('#f-status').checked ? 'active' : 'disabled',
        };
        if (!payload.name) { toast('请填写部门名称', 'err'); return; }
        await api(id ? `/api/departments/${id}` : '/api/departments', {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(payload),
        });
        closeModal();
        await refreshAll();
        navigate('departments');
        toast('已保存', 'ok');
        break;
      }

      case 'del-dept': {
        const d = state.depts.find((x) => x.id === id);
        if (!confirm(`确定删除部门「${d.name}」？`)) return;
        await api(`/api/departments/${id}`, { method: 'DELETE' });
        await refreshAll();
        navigate('departments');
        toast('已删除', 'ok');
        break;
      }

      case 'new-emp':
        empForm(null);
        break;

      case 'edit-emp': {
        const e = state.emps.find((x) => x.id === id);
        empForm(e);
        break;
      }

      case 'save-emp': {
        const ovEnabled = $('#e-ov-enabled')?.checked || false;
        const val = (sel) => {
          const v = $(sel)?.value;
          return v === '' || v == null ? null : Number(v);
        };
        const payload = {
          name: $('#e-name').value.trim(),
          email: $('#e-email').value.trim(),
          deptId: $('#e-dept').value,
          status: $('#e-status').value,
          override: {
            enabled: ovEnabled,
            dailyTokens: ovEnabled ? val('#e-ov-daily') : null,
            monthlyTokens: ovEnabled ? val('#e-ov-monthly') : null,
            rpm: ovEnabled ? val('#e-ov-rpm') : null,
            concurrency: ovEnabled ? val('#e-ov-conc') : null,
            countAgainstDept: ovEnabled ? $('#e-ov-count').checked : true,
            expiresAt: ovEnabled ? ($('#e-ov-expire').value || '') : '',
            note: ovEnabled ? ($('#e-ov-note').value || '') : '',
          },
        };
        if (!payload.name) { toast('请填写姓名', 'err'); return; }
        if (!payload.deptId) { toast('请选择部门', 'err'); return; }
        await api(id ? `/api/employees/${id}` : '/api/employees', {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(payload),
        });
        closeModal();
        await refreshAll();
        navigate('employees');
        toast('已保存', 'ok');
        break;
      }

      case 'emp-detail':
        await empDetail(id);
        break;

      case 'rotate-key': {
        if (!confirm('重置后旧密钥立即失效，确定继续？')) return;
        const r = await api(`/api/employees/${id}/rotate`, { method: 'POST' });
        closeModal();
        state.emps = (await api('/api/employees')).items;
        await empDetail(id);
        toast('密钥已重置：' + r.key.slice(0, 16) + '…', 'ok');
        break;
      }

      case 'new-provider':
        providerForm(null);
        break;

      case 'edit-provider': {
        const p = state.providers.find((x) => x.id === id);
        providerForm(p);
        break;
      }

      case 'save-provider': {
        const payload = {
          name: $('#p-name').value.trim(),
          baseUrl: $('#p-url').value.trim(),
          apiKey: $('#p-key').value.trim(),
          models: $('#p-models').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          weight: Number($('#p-weight').value) || 1,
          timeoutMs: Number($('#p-timeout').value) || 120000,
          status: $('#p-status').value,
          remark: $('#p-remark').value.trim(),
        };
        if (!payload.name) { toast('请填写渠道名称', 'err'); return; }
        if (!payload.baseUrl) { toast('请填写 Base URL', 'err'); return; }
        await api(id ? `/api/providers/${id}` : '/api/providers', {
          method: id ? 'PUT' : 'POST',
          body: JSON.stringify(payload),
        });
        closeModal();
        await refreshAll();
        navigate('providers');
        toast('已保存', 'ok');
        break;
      }

      case 'del-provider': {
        if (!confirm('确定删除该渠道？')) return;
        await api(`/api/providers/${id}`, { method: 'DELETE' });
        await refreshAll();
        navigate('providers');
        toast('已删除', 'ok');
        break;
      }

      case 'probe-provider': {
        el.disabled = true;
        el.textContent = '测试中…';
        try {
          const r = await api(`/api/providers/${id}/probe`, { method: 'POST' });
          toast(r.ok ? `连通正常（${r.latencyMs}ms）` : `连接失败：${r.message}`, r.ok ? 'ok' : 'err');
        } finally {
          el.disabled = false;
          el.textContent = '连通测试';
        }
        break;
      }

      case 'save-settings': {
        await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            platformName: $('#set-name').value.trim(),
            onExceed: $('#set-onExceed').value,
            mockWhenNoProvider: $('#set-mock').checked,
          }),
        });
        await refreshAll();
        toast('设置已保存', 'ok');
        break;
      }

      case 'save-password': {
        const oldPw = $('#pw-old').value;
        const pw = $('#pw-new').value;
        const pw2 = $('#pw-new2').value;
        if (pw.length < 6) { toast('新密码至少 6 位', 'err'); return; }
        if (pw !== pw2) { toast('两次输入的新密码不一致', 'err'); return; }
        await api('/api/settings/password', {
          method: 'POST',
          body: JSON.stringify({ oldPassword: oldPw, newPassword: pw }),
        });
        toast('密码已更新，请重新登录', 'ok');
        setTimeout(logout, 900);
        break;
      }

      case 'export': {
        const data = await api('/api/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ai-gateway-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('已导出', 'ok');
        break;
      }

      case 'reset-data': {
        if (!confirm('确定清空所有部门、员工、调用日志与统计数据？\n\n上游渠道与模型配置会保留，清空前会自动生成备份文件。')) return;
        if (!confirm('再次确认：此操作不可撤销（除非手工恢复备份文件），继续吗？')) return;
        const r = await api('/api/reset-data', { method: 'POST' });
        closeModal();
        await refreshAll();
        navigate(state.view);
        toast(r.backup ? `已清空，备份在 ${r.backup}` : '已清空（备份生成失败，请谨慎操作）', 'ok');
        break;
      }

      case 'open-plugin':
        navigate('plugins', id);
        break;

      case 'back-plugins':
        navigate('plugins', '');
        break;

      case 'plugin-save': {
        const pid = id;
        const p = (state.plugins || []).find((x) => x.id === pid);
        const config = {};
        for (const f of p.fields) {
          const el = $(`#pg-${pid}-${f.key}`);
          if (el) config[f.key] = el.value;
        }
        await api(`/api/plugins/${pid}/config`, { method: 'PUT', body: JSON.stringify({ config }) });
        toast('配置已保存', 'ok');
        await renderPlugins();
        break;
      }

      case 'plugin-test': {
        const pid = id;
        // 先把当前表单里的值一起带上，方便填完直接测
        const p = (state.plugins || []).find((x) => x.id === pid);
        const config = {};
        for (const f of p.fields) {
          const el = $(`#pg-${pid}-${f.key}`);
          if (el) config[f.key] = el.value;
        }
        el.disabled = true;
        el.textContent = '测试中…';
        try {
          const r = await api(`/api/plugins/${pid}/test`, { method: 'POST', body: JSON.stringify({ config }) });
          toast(r.message, r.ok ? 'ok' : 'err');
        } finally {
          el.disabled = false;
          el.textContent = '连接测试';
        }
        break;
      }

      case 'plugin-sync': {
        const pid = id;
        const p = (state.plugins || []).find((x) => x.id === pid);
        const config = {};
        for (const f of p.fields) {
          const el = $(`#pg-${pid}-${f.key}`);
          if (el) config[f.key] = el.value;
        }
        el.disabled = true;
        el.textContent = '同步中…';
        try {
          // 同步时顺手落一次配置，避免刷新页面后填的内容丢掉
          await api(`/api/plugins/${pid}/config`, { method: 'PUT', body: JSON.stringify({ config }) });
          const r = await api(`/api/plugins/${pid}/sync`, { method: 'POST', body: JSON.stringify({ config }) });
          await refreshAll();
          await renderPlugins();
          toast(r.message, 'ok');
        } finally {
          el.disabled = false;
          el.textContent = '立即同步';
        }
        break;
      }

      default:
        break;
    }
  } catch (err) {
    toast(err.message, 'err');
  }
});

// ---------------------------------------------------------------- 启动

$('#login-form').addEventListener('submit', doLogin);
$('#logout-btn').addEventListener('click', () => {
  if (confirm('确定退出登录？')) logout();
});
$('#refresh-btn').addEventListener('click', async () => {
  try {
    await refreshAll();
    navigate(state.view);
    toast('已刷新', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
});

window.addEventListener('hashchange', () => {
  const [key, sub] = location.hash.replace('#/', '').split('/');
  if (key === 'plugins' && sub) {
    if (state.view !== 'plugins' || state.pluginId !== sub) navigate('plugins', sub);
    return;
  }
  if (key && key !== state.view && ROUTES.some((r) => r.key === key)) navigate(key);
});

// 快捷键：Esc 关闭弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modal-root').innerHTML) closeModal();
});

(function boot() {
  const [initial, sub] = location.hash.replace('#/', '').split('/');
  if (ROUTES.some((r) => r.key === initial)) state.view = initial;
  if (initial === 'plugins' && sub) state.pluginId = sub;
  if (state.token) enterApp();
})();

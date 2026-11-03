'use strict';

/* ============================================================
   AI API 分流平台 —— 管理台前端
   原生 JS，无框架、无 CDN 依赖（内网可直接跑）
   ============================================================ */

// ---------------------------------------------------------------- 基础工具

// 与 package.json 的 version 保持一致（scripts/check-docs.js 会校验）
const APP_VERSION = '1.6.5';

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
  filters: { empKeyword: '', empDept: '', logStatus: '', logQ: '' },
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

/** 成本展示：¥ + 最多 4 位小数 */
function costText(c) {
  const v = Number(c) || 0;
  if (v === 0) return '¥0';
  const s = v.toFixed(Math.abs(v) < 100 ? 4 : 2).replace(/0+$/, '').replace(/\.$/, '');
  return '¥' + s;
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

/**
 * 服务端进程可能还在跑旧代码（改了文件没重启）。静态文件每次都是从磁盘读的，
 * 于是会出现「新界面 + 旧接口」：点详情提示「接口不存在」。
 * 这里对比 /healthz 上报的版本，不一致就给出明确提示，省得靠猜。
 */
async function checkServerVersion() {
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    const d = await res.json();
    if (d && d.version && 'v' + d.version === 'v' + APP_VERSION) return;
    showVersionWarn(d && d.version ? 'v' + d.version : '', (d && d.startedAt) || '');
  } catch {
    /* 健康检查不可用不影响正常使用 */
  }
}

function showVersionWarn(serverVersion, startedAt) {
  if ($('#version-warn')) return;
  const el = document.createElement('div');
  el.id = 'version-warn';
  el.className = 'version-warn';
  const when = startedAt ? ` · 启动于 ${new Date(startedAt).toLocaleString('zh-CN', { hour12: false })}` : '';
  el.innerHTML = `
    <b>服务端还在运行旧代码</b>
    <span>界面 v${APP_VERSION}${serverVersion ? ` · 服务端 ${serverVersion}` : ' · 服务端未上报版本'}${when}</span>
    <span>请重启服务后刷新页面：<code>pkill -f "node server.js" &amp;&amp; npm start</code></span>
    <button class="btn-link" id="version-warn-close">知道了</button>`;
  document.body.appendChild(el);
  $('#version-warn-close').addEventListener('click', () => el.remove());
}

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
    `渠道 <b>${o.counts.activeProviders}</b>/<b>${o.counts.providers}</b> 启用<br>` +
    `<span style="opacity:.65">前端 v${APP_VERSION}</span>`;
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
  { key: 'settings', label: '系统设置', icon: 'gear', title: '系统设置', sub: '平台名称、日志内容、告警通道与管理员密码' },
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
        <div class="kpi-foot">今日请求 ${fmt(o.today.reqs)} 次 · ${costText(o.today.cost)}${o.nowIdle && o.hasIdlePricing ? ' · 🌙 空闲时段计价中' : ''}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">本月 Token</div>
        <div class="kpi-value">${shortNum(o.month.tokens)}<small>tokens</small></div>
        <div class="kpi-foot">${o.month.month} · ${fmt(o.month.reqs)} 次 · ${costText(o.month.cost)}</div>
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
                ${shortNum(d.dayTokens)} / ${d.dailyLimit ? shortNum(d.dailyLimit) : '不限'}${d.dailyLimit && d.percentDaily > 0 ? ` · ${d.percentDaily}%` : ''}${d.dayCost ? ` · ${costText(d.dayCost)}` : ''}
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
            <th>员工</th><th>部门</th><th>生效额度</th><th style="width:200px">今日进度</th><th>今日 Token</th><th>今日成本</th><th>月度 Token</th>
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
                <td class="num nowrap">${costText(e.dayCost)}</td>
                <td class="num nowrap">${fmt(e.monthTokens)}</td>
              </tr>`).join('') : '<tr><td colspan="7" class="empty">还没有员工</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  const modelCostTable = `
    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div><h3>今日模型成本</h3><div class="sub">按模型汇总 · 单价在「上游渠道」页配置</div></div>
        <button class="btn btn-ghost btn-sm" data-act="goto" data-key="providers">配置单价</button>
      </div>
      <div class="card-body tight table-wrap">
        <table class="tbl">
          <thead><tr><th>模型</th><th>请求数</th><th>Token</th><th>成本</th><th style="width:130px">成本占比</th></tr></thead>
          <tbody>
            ${o.modelRank && o.modelRank.length ? (() => {
              const maxC = Math.max(0.0000001, ...o.modelRank.map((m) => m.cost));
              return o.modelRank.map((m) => `
              <tr>
                <td><span class="tag tag-grey">${esc(m.model)}</span></td>
                <td class="num nowrap">${fmt(m.reqs)}</td>
                <td class="num nowrap">${fmt(m.tokens)}</td>
                <td class="num nowrap"><b>${costText(m.cost)}</b></td>
                <td><div class="bar"><i style="width:${barWidth(Math.round((m.cost / maxC) * 100))}%"></i></div></td>
              </tr>`).join('');
            })() : '<tr><td colspan="5" class="empty">今天还没有成功调用</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  $('#view').innerHTML = kpis + warnings +
    `<div class="grid-2">${trend}${deptRank}</div>` + empTable + modelCostTable;
}

// ---------------------------------------------------------------- 部门页

function renderDepartments() {
  const items = state.depts;
  const rows = items.map((d) => `
    <tr>
      <td>
        <div class="cell-main">${esc(d.name)}
          ${d.alert && d.alert.enabled ? `<span class="tag tag-outline" style="font-size:10px;margin-left:4px" title="${esc(d.alert.webhookUrl || '使用全局机器人')}">独立告警</span>` : ''}
        </div>
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
    const alertTag = e.alert && e.alert.enabled
      ? `<div style="margin-top:2px"><span class="tag tag-outline" style="font-size:10px" title="${esc(e.alert.webhookUrl || '继承部门 / 全局机器人')}">独立告警</span></div>`
      : '';
    const ruleTag = ((s.hasOverride && s.overrideActive)
      ? `<span class="tag tag-brand">特例${s.countAgainstDept ? '' : ' · 独立额度'}</span>${s.overrideNote ? `<div class="cell-sub" title="${esc(s.overrideNote)}">${esc(s.overrideNote.slice(0, 22))}${s.overrideNote.length > 22 ? '…' : ''}</div>` : ''}`
      : (s.hasOverride && s.overrideExpired
        ? `<span class="tag tag-warn">特例已过期</span>`
        : `<span class="tag tag-grey">继承 · ${esc(s.deptName)}</span>`)) + alertTag;

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
  const pr = await api('/api/pricing');
  const pricing = pr.items || {};
  const presets = pr.presets || {};
  const peak = pr.peak || { enabled: false, days: [1, 2, 3, 4, 5], windows: [['09:00', '12:00'], ['14:00', '18:00']], holidays: [] };
  const periodModels = Object.entries(pricing).filter(([, v]) => Array.isArray(v && v.periods) && v.periods.length);
  state.rawPricing = pricing;

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
      : `<div class="card"><div class="empty"><strong>还没有配置上游渠道</strong>新增一个 OpenAI 兼容的渠道，填入 Base URL 和 Key 就能用了</div></div>`}

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div>
          <h3>模型单价 ${peak.enabled !== false
            ? `<span class="tag ${pr.nowPeak ? 'tag-warn' : 'tag-brand'}" style="font-size:10.5px;padding:1px 8px">${pr.nowPeak ? '当前：高峰时段' : '当前：空闲时段'}</span>`
            : `<span class="tag tag-grey" style="font-size:10.5px;padding:1px 8px">按模型时段计价${periodModels.length ? ` · ${periodModels.length} 个模型已配` : ''}</span>`}</h3>
          <div class="sub">元 / 百万 tokens · 用于成本核算，与转发无关；未定价的模型成本按 0 计${presets.updatedAt ? ` · 内置官方参考价 ${presets.updatedAt}（${presets.total} 个模型，USD 按 1:${presets.usdCny} 折算）` : ''}</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" data-act="load-presets">载入官方参考价</button>
          <button class="btn btn-primary btn-sm" data-act="save-pricing">保存单价</button>
        </div>
      </div>
      <div class="card-body tight">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:2px 0 12px;border-bottom:1px solid var(--border);margin-bottom:12px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;white-space:nowrap">
            <input type="checkbox" id="pr-peak-enabled" ${peak.enabled !== false ? 'checked' : ''} />
            启用全局高峰时段（兜底，默认关闭）
          </label>
          <span style="font-size:12.5px">高峰日</span>
          ${['日', '一', '二', '三', '四', '五', '六'].map((d, i) => `
            <label style="display:flex;align-items:center;gap:3px;font-size:12px"><input type="checkbox" class="pr-peak-day" value="${i}" ${(peak.days || [1, 2, 3, 4, 5]).includes(i) ? 'checked' : ''} />${d}</label>`).join('')}
          <span style="font-size:12.5px">高峰时段</span>
          <input type="time" id="pr-w1-start" class="input-sm" style="width:100px" value="${esc(peak.windows?.[0]?.[0] || '09:00')}" />
          <span>–</span>
          <input type="time" id="pr-w1-end" class="input-sm" style="width:100px" value="${esc(peak.windows?.[0]?.[1] || '12:00')}" />
          <input type="time" id="pr-w2-start" class="input-sm" style="width:100px" value="${esc(peak.windows?.[1]?.[0] || '14:00')}" />
          <span>–</span>
          <input type="time" id="pr-w2-end" class="input-sm" style="width:100px" value="${esc(peak.windows?.[1]?.[1] || '18:00')}" />
          <span style="font-size:12.5px">节假日</span>
          <input type="text" id="pr-holidays" class="input-sm" style="flex:1;min-width:180px" value="${esc((peak.holidays || []).join(', '))}" placeholder="法定节假日日期，逗号分隔，如 2026-10-01, 2026-10-02" />
          <div class="field-hint" style="margin:0;flex-basis:100%">
            分时计价默认<b>不启用</b>这套全局规则：请点每行「编辑 → 自定义时段价」，按模型自己配时段与价格（内置参考价里的 DeepSeek 已带「工作日高峰 / 工作日空闲 / 周末」三段）。
            这里打开后只影响「填了右侧空闲价、但没配自定义时段」的模型，配了自定义时段的模型始终以自己的时段表为准。
          </div>
        </div>
        <div class="table-wrap">
        <table class="tbl price-tbl">
          <thead>
            <tr>
              <th rowspan="2" class="th-model" style="width:130px">模型</th>
              <th colspan="4" class="th-group">基础价 / 峰时</th>
              <th colspan="4" class="th-group th-group-idle">空闲价（全局规则）</th>
              <th rowspan="2" style="width:104px">自定义</th>
            </tr>
            <tr>
              <th style="width:72px">输入</th>
              <th style="width:72px">输出</th>
              <th style="width:78px">缓存命中</th>
              <th style="width:78px">缓存写入</th>
              <th style="width:72px">输入</th>
              <th style="width:72px">输出</th>
              <th style="width:78px">缓存命中</th>
              <th style="width:78px">缓存写入</th>
            </tr>
          </thead>
          <tbody>
            ${(() => {
              const models = [...new Set([...d.items.flatMap((p) => p.models || []).filter((m) => m !== '*'), ...Object.keys(pricing)])];
              const numCell = (cls, m, val, ph, tip) => `<td><input type="number" step="0.01" min="0" class="input-sm ${cls}" data-model="${esc(m)}" value="${val ?? ''}" placeholder="${ph}" title="${tip || ph}" /></td>`;
              const badges = (p) => [
                p && p.formula ? '<span class="tag tag-brand" style="font-size:10px;padding:0 6px">公式</span>' : '',
                p && p.perCall ? '<span class="tag tag-outline" style="font-size:10px;padding:0 6px">按次</span>' : '',
                p && p.multiplier != null && Number(p.multiplier) !== 1 ? `<span class="tag tag-outline" style="font-size:10px;padding:0 6px">×${p.multiplier}</span>` : '',
                p && Array.isArray(p.periods) && p.periods.length ? `<span class="tag tag-brand" style="font-size:10px;padding:0 6px" title="自定义时段：${esc(p.periods.map((x) => x.name).join(' / '))}">时段 ${p.periods.length}</span>` : '',
              ].filter(Boolean).join(' ');
              const rows = models.map((m) => {
                const p = pricing[m] || {};
                return `
                <tr>
                  <td>
                    <span class="tag tag-grey" title="${esc(p.note || '')}">${esc(m)}</span>
                    ${p.note ? `<div class="cell-sub" title="${esc(p.note)}">${esc(p.note.slice(0, 16))}${p.note.length > 16 ? '…' : ''}</div>` : ''}
                  </td>
                  ${numCell('pr-in', m, p.in, '未定价', '基础输入价（元/百万 tokens）；配了自定义时段的模型，未命中时段时也按它计')}
                  ${numCell('pr-out', m, p.out, '未定价', '基础输出价（元/百万 tokens）')}
                  ${numCell('pr-cachein', m, p.cacheIn, '同输入', '缓存命中输入价，留空按输入价')}
                  ${numCell('pr-cachewrite', m, p.cacheWrite, '同输入', '缓存写入输入价，留空按输入价')}
                  ${numCell('pr-idlein', m, p.idle?.in, '不分时', '空闲价：只有打开全局高峰规则、且该模型没配自定义时段时才生效')}
                  ${numCell('pr-idleout', m, p.idle?.out, '不分时', '空闲价：留空沿用基础输出价')}
                  ${numCell('pr-idlecachein', m, p.idle?.cacheIn, '同闲入', '空闲价：缓存命中输入价，留空按空闲输入价')}
                  ${numCell('pr-idlecachewrite', m, p.idle?.cacheWrite, '同闲入', '空闲价：缓存写入输入价，留空按空闲输入价')}
                  <td class="nowrap">
                    <button class="btn-link" data-act="edit-pricing" data-model="${esc(m)}">编辑</button>
                    <div style="margin-top:2px;line-height:1.4">${badges(p)}</div>
                  </td>
                </tr>`;
              }).join('');
              return rows + `
                <tr class="price-new-row">
                  <td><input type="text" class="input-sm" id="pr-new-model" placeholder="新模型名" style="width:100%" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-in" placeholder="输入" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-out" placeholder="输出" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-cachein" placeholder="可选" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-cachewrite" placeholder="可选" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-idlein" placeholder="可选" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-idleout" placeholder="可选" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-idlecachein" placeholder="可选" /></td>
                  <td><input type="number" step="0.01" min="0" class="input-sm" id="pr-new-idlecachewrite" placeholder="可选" /></td>
                  <td><span class="field-hint" style="margin:0">填完点保存</span></td>
                </tr>`;
            })()}
          </tbody>
        </table>
        </div>
        <p class="field-hint" style="margin-top:10px">
          <b>分时计价默认走「每个模型自己的时段表」</b>：点某行「编辑」→「自定义时段价」，可以为这个模型单独设生效星期、时间窗（可跨零点）或指定日期，并给每一段配独立的输入/输出/缓存价。
          内置参考价里的 DeepSeek 已经预填好三段（工作日高峰 9:00–12:00、14:00–18:00；工作日其余时间；周末全天），不用再动全局规则。
          未配时段、或时刻不在任何时段内 → 按左侧「基础价」计。
        </p>
        <p class="field-hint" style="margin-top:4px">
          右侧「空闲价」是<b>旧版写法</b>：只有勾上「启用全局高峰时段」才参与计算，且优先级低于模型自定义时段；两者都没配的模型不分时。全局规则默认关闭，避免「明明给模型配了时段、却被全局规则盖住」。
          缓存命中/写入：上游 usage 里的缓存 tokens（DeepSeek <code>prompt_cache_hit_tokens</code>、OpenAI <code>cached_tokens</code>、Anthropic <code>cache_creation_input_tokens</code>）自动按对应价核算；段内没填的缓存价按该段输入价计。
        </p>
        <p class="field-hint" style="margin-top:4px">
          <b>想更自由地算钱？</b>点每行右侧「编辑」可单独为这个模型配置：分档阶梯、每次调用固定费用（如按次计费的图像模型）、成本倍率（加价/折扣）、自定义公式（如 <code>base * 1.2 + 0.001</code>），并在弹窗里直接试算。
        </p>
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div>
          <h3>高级定价（JSON）</h3>
          <div class="sub">分档计价（Qwen 阶梯价、Gemini 长上下文加价）等进阶字段在此编辑；配置了 tiers 的模型优先按输入长度分档，分时规则不再生效</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-act="save-pricing-advanced">保存高级定价</button>
      </div>
      <div class="card-body">
        <textarea id="pr-advanced" class="input-sm" style="width:100%;min-height:180px;font-family:var(--mono,monospace);font-size:12px;line-height:1.6">${esc(JSON.stringify(pricing, null, 2))}</textarea>
        <p class="field-hint" style="margin-top:8px">
          结构示例：<code>{ "qwen3.7-plus": { "in": 2, "out": 8, "cacheIn": 0.4, "tiers": [ { "upTo": 262144, "in": 2, "out": 8, "cacheIn": 0.4 }, { "upTo": 1048576, "in": 6, "out": 24, "cacheIn": 1.2 } ] } }</code>。
          upTo 为该档输入 tokens 上限（含），超过最后一档按基础价计；档内可再配 cacheIn / cacheWrite。
        </p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- 日志页

async function renderLogs() {
  const params = new URLSearchParams();
  if (state.filters.logStatus) params.set('status', state.filters.logStatus);
  if (state.filters.logQ) params.set('q', state.filters.logQ);
  const qs = params.toString();
  const d = await api('/api/logs' + (qs ? '?' + qs : ''));
  state.logs = d.items;
  state.logContentMode = d.logContent || 'summary';

  const rows = d.items.map((x) => `
    <tr>
      <td class="nowrap" style="color:var(--muted);font-size:12px">${timeText(x.ts)}</td>
      <td>
        <div class="cell-main">${esc(x.employeeName)}</div>
        <div class="cell-sub">${esc(x.deptName)}</div>
      </td>
      <td>
        <span class="tag tag-grey">${esc(x.model)}</span>
        ${x.preview ? `<div class="cell-sub log-snippet" title="${esc(x.preview)}">${esc(x.preview.slice(0, 40))}${x.preview.length > 40 ? '…' : ''}</div>` : ''}
      </td>
      <td class="nowrap">${esc(x.providerName)}</td>
      <td class="num nowrap">${fmt(x.totalTokens)}<div class="cell-sub num">${fmt(x.promptTokens)} / ${fmt(x.completionTokens)}</div></td>
      <td class="num nowrap">${x.cost ? `<b>${costText(x.cost)}</b>` : '<span style="color:var(--muted)">—</span>'}</td>
      <td class="num nowrap" style="color:var(--muted)">${x.latencyMs} ms</td>
      <td class="nowrap">
        <span class="tag ${x.status === 'ok' ? 'tag-ok' : (x.status === 'rejected' ? 'tag-warn' : 'tag-danger')}">
          ${x.status === 'ok' ? '成功' : (x.status === 'rejected' ? '配额拦截' : '失败')}
        </span>
        ${x.error ? `<div class="cell-sub" title="${esc(x.error)}">${esc(x.error.slice(0, 26))}${x.error.length > 26 ? '…' : ''}</div>` : ''}
      </td>
      <td class="nowrap"><button class="btn-link" data-act="log-detail" data-id="${x.id}">详情</button></td>
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
        <input class="input-sm" type="text" id="log-q" placeholder="搜索员工 / 模型 / 提问关键词" value="${esc(state.filters.logQ || '')}" style="width:240px" />
        <span class="tag tag-grey">最近 ${d.items.length} 条</span>
      </div>
      <div class="toolbar-right">
        <span class="field-hint" style="margin:0">
          ${state.logContentMode === 'off'
            ? '内容留存已关闭，只记录用量'
            : `内容留存：${state.logContentMode === 'full' ? '完整' : '摘要'} · 点「详情」看输入输出`}
        </span>
      </div>
    </div>
    <div class="card">
      <div class="card-body tight table-wrap">
        <table class="tbl">
          <thead><tr>
            <th>时间</th><th>员工</th><th>模型 / 请求内容</th><th>渠道</th><th>Token（入/出）</th><th>成本</th><th>耗时</th><th>状态</th><th style="width:64px">操作</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="9" class="empty"><strong>还没有调用记录</strong>用「接入文档」里的示例发一个请求试试</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;

  $('#log-status').addEventListener('change', (e) => {
    state.filters.logStatus = e.target.value;
    renderLogs();
  });
  const search = $('#log-q');
  search.addEventListener('input', (e) => {
    state.filters.logQ = e.target.value;
    clearTimeout(search._t);
    search._t = setTimeout(() => {
      const pos = search.selectionStart;
      renderLogs().then(() => {
        const again = $('#log-q');
        if (again) { again.focus(); again.setSelectionRange(pos, pos); }
      });
    }, 260);
  });
}

/** 调用详情：输入、输出、参数、成本拆解、渠道尝试链都在这里 */
async function logDetail(id) {
  let d;
  try {
    d = await api('/api/logs/' + encodeURIComponent(id));
  } catch (e) {
    // 服务端没有这个路由 = 进程还是更新前的代码（静态页是新版，接口是旧版）
    if (/接口不存在/.test(e.message)) {
      showVersionWarn('', '');
      toast('服务端缺少 GET /api/logs/:id，重启服务后即可查看详情', 'err');
      return;
    }
    toast(e.message, 'err');
    return;
  }
  const log = d.log || null;
  const req = (log && log.request) || null;
  const res = (log && log.response) || null;
  const cd = d.costDetail || null;
  const p = (req && req.params) || {};
  const attempts = (log && log.attempts) || [];
  const statusText = d.status === 'ok' ? '成功' : (d.status === 'rejected' ? '配额拦截' : '失败');
  const statusCls = d.status === 'ok' ? 'tag-ok' : (d.status === 'rejected' ? 'tag-warn' : 'tag-danger');

  const chip = (k, v) => `<span class="tag tag-outline" style="margin:0 4px 4px 0"><span style="color:var(--muted)">${esc(k)}</span> ${esc(v)}</span>`;
  const paramChips = [
    chip('stream', p.stream ? '是' : '否'),
    chip('temperature', p.temperature == null ? '—' : p.temperature),
    chip('top_p', p.top_p == null ? '—' : p.top_p),
    chip('max_tokens', p.max_tokens == null ? '—' : p.max_tokens),
    chip('tools', p.tools || 0),
    chip('response_format', p.response_format || '—'),
  ].join('');

  const msgHtml = req && req.messages && req.messages.length
    ? req.messages.map((m) => `
        <div class="log-msg">
          <div class="log-role ${esc(m.role)}">${esc(m.role || 'unknown')}</div>
          <pre class="log-body">${esc(m.content || '（空）')}</pre>
        </div>`).join('')
    : '<p class="field-hint">这条记录没有留存输入内容（可能是内容留存已关闭，或记录产生于开启之前）。</p>';

  const costRows = cd ? `
    <table class="preview-table">
      <tbody>
        <tr><td>基础 token 费用</td><td class="num">${costText(cd.base)}</td><td class="field-hint" style="margin:0">单价（元/百万）：入 ${cd.prices.in} · 出 ${cd.prices.out}</td></tr>
        ${cd.period ? `<tr><td>命中时段</td><td class="num"><b>${esc(cd.period.name)}</b></td><td class="field-hint" style="margin:0">该模型自定义时段，按此时段单价计</td></tr>` : ''}
        ${cd.formula != null ? `<tr><td>自定义公式</td><td class="num"><b>${costText(cd.formula)}</b></td><td class="field-hint" style="margin:0">公式结果替代基础费用</td></tr>` : ''}
        ${cd.formulaError ? `<tr><td>公式错误</td><td class="num" style="color:var(--danger)">回退基础价</td><td class="field-hint" style="margin:0">${esc(cd.formulaError)}</td></tr>` : ''}
        ${cd.perCall ? `<tr><td>按次费用</td><td class="num">+ ${costText(cd.perCall)}</td><td class="field-hint" style="margin:0">每次调用固定加收</td></tr>` : ''}
        ${cd.multiplier && cd.multiplier !== 1 ? `<tr><td>成本倍率</td><td class="num">× ${cd.multiplier}</td><td class="field-hint" style="margin:0">加价 / 折扣</td></tr>` : ''}
        <tr><td><b>合计</b></td><td class="num"><b>${costText(cd.total)}</b></td><td class="field-hint" style="margin:0">${cd.period ? `时段「${esc(cd.period.name)}」` : (cd.idle ? '按空闲时段价' : '按峰时/基础价')}${cd.tierUpTo ? ` · 命中 ≤${fmt(cd.tierUpTo)} 档` : ''}</td></tr>
      </tbody>
    </table>` : '<p class="field-hint">该请求没有产生成本（被拦截、失败或模型未定价）。</p>';

  openModal({
    title: '调用详情',
    sub: `${esc(d.employeeName)} · ${esc(d.model)} · ${esc(new Date(d.ts).toLocaleString('zh-CN'))}`,
    wide: true,
    body: `
      <div class="detail-hd">
        <div class="avatar">${esc((d.employeeName || '?').slice(0, 1))}</div>
        <div>
          <div style="font-weight:600;font-size:15px">${esc(d.employeeName)} <span class="tag ${statusCls}" style="margin-left:6px">${statusText}</span></div>
          <div class="cell-sub">${esc(d.deptName)} · ${esc(d.providerName)} · ${d.latencyMs} ms${d.usageSource === 'estimated' ? ' · Token 为估算值' : ''}</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div class="cell-sub">成本</div>
          <div style="font-size:20px;font-weight:600">${d.cost ? costText(d.cost) : '—'}</div>
        </div>
      </div>

      <div class="log-facts">
        <div><span>请求 ID</span><code>${esc(d.id)}</code></div>
        <div><span>模型</span><code>${esc(d.model)}${d.upstreamModel && d.upstreamModel !== d.model ? ' → ' + esc(d.upstreamModel) : ''}</code></div>
        <div><span>输入 tokens</span><b>${fmt(d.promptTokens)}</b></div>
        <div><span>输出 tokens</span><b>${fmt(d.completionTokens)}</b></div>
        <div><span>缓存命中</span><b>${fmt(d.cacheTokens)}</b></div>
        <div><span>缓存写入</span><b>${fmt(d.cacheWriteTokens)}</b></div>
        <div><span>计入部门池</span><b>${d.countDept ? '是' : '否'}</b></div>
        <div><span>来源</span><b>${esc(d.source || 'api')}</b></div>
      </div>

      ${d.error ? `<div class="notice notice-warn" style="margin:0 0 14px">${ICON.warn}<div><b>错误信息</b><br>${esc(d.error)}</div></div>` : ''}

      <div class="section-label">请求参数</div>
      <div style="margin-bottom:14px">${paramChips}</div>

      <div class="section-label">输入内容${req && req.truncated ? '（已截断）' : ''}</div>
      <div class="log-thread">${msgHtml}</div>

      <div class="section-label">输出内容${res && res.finishReason ? `（finish_reason: ${esc(res.finishReason)}）` : ''}${res && res.truncated ? ' · 已截断' : ''}</div>
      ${res && res.content
        ? `<pre class="log-body" style="max-height:320px;overflow:auto">${esc(res.content)}</pre>`
        : '<p class="field-hint">没有留存输出内容。</p>'}

      <div class="section-label">成本拆解</div>
      ${costRows}

      ${attempts.length ? `
        <div class="section-label">渠道尝试（${attempts.length} 次）</div>
        <table class="preview-table">
          <thead><tr><th>渠道</th><th>结果</th><th>状态码</th><th>耗时</th><th>错误</th></tr></thead>
          <tbody>
            ${attempts.map((a) => {
              const name = (state.providers.find((x) => x.id === a.providerId) || {}).name || a.providerId || '—';
              return `<tr>
                <td>${esc(name)}</td>
                <td><span class="tag ${a.ok ? 'tag-ok' : 'tag-danger'}" style="font-size:11px">${a.ok ? '成功' : '失败'}</span></td>
                <td class="num">${a.status || '—'}</td>
                <td class="num">${a.latencyMs || 0} ms</td>
                <td class="cell-sub">${esc(a.error || '—')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>` : ''}
    `,
    footer: `<button class="btn btn-ghost" data-act="close-modal">关闭</button>`,
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

async function renderSettings() {
  const s = state.settings;
  const dims = Array.isArray(s.alertDimensions) && s.alertDimensions.length ? s.alertDimensions : ['dailyTokens', 'monthlyTokens'];
  let alertData = { items: [], routes: { departments: [], employees: [] } };
  try { alertData = await api('/api/alerts?limit=20'); } catch { /* 记录为空时忽略 */ }

  const alertRows = (alertData.items || []).map((a) => `
    <tr>
      <td class="nowrap" style="color:var(--muted);font-size:12px">${timeText(a.ts)}</td>
      <td class="nowrap">${a.target === 'employee' ? '员工' : (a.target === 'department' ? '部门' : '全局')} · ${esc(a.targetName)}</td>
      <td class="nowrap">${a.test ? '<span class="tag tag-outline">测试</span>' : `${a.dimension === 'monthlyTokens' ? '月 Token' : '日 Token'} ≥ ${a.threshold}%`}</td>
      <td class="num nowrap">${a.percent ? a.percent + '%' : '—'}</td>
      <td class="nowrap">${a.channel === 'employee' ? '员工通道' : (a.channel === 'department' ? '部门通道' : '全局通道')}</td>
      <td class="nowrap"><span class="tag ${a.ok ? 'tag-ok' : 'tag-danger'}">${a.ok ? '已发送' : '失败'}</span>
        ${a.ok ? '' : `<div class="cell-sub" title="${esc(a.message)}">${esc(String(a.message || '').slice(0, 40))}</div>`}</td>
    </tr>`).join('');

  const ownRoutes = [
    ...(alertData.routes?.departments || []).map((x) => `部门「${esc(x.name)}」`),
    ...(alertData.routes?.employees || []).map((x) => `员工「${esc(x.name)}」`),
  ];

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
        <div class="card-head"><div><h3>调用日志内容</h3><div class="sub">记录每次请求的输入与输出，便于排障与审计</div></div></div>
        <div class="card-body">
          <label class="field">
            <span>留存策略</span>
            <select id="set-logmode">
              <option value="off" ${s.logContent === 'off' ? 'selected' : ''}>关闭 —— 只记录 token / 成本</option>
              <option value="summary" ${(!s.logContent || s.logContent === 'summary') ? 'selected' : ''}>摘要 —— 按下方长度截断（推荐）</option>
              <option value="full" ${s.logContent === 'full' ? 'selected' : ''}>完整 —— 尽量保留全文（上限 20000 字符）</option>
            </select>
            <span class="field-hint">日志正文里的 <code>sk-</code> 密钥、Bearer 值会自动打码，不会二次泄漏。</span>
          </label>
          <label class="field">
            <span>摘要最大长度（字符）</span>
            <input type="number" id="set-logmax" min="200" max="20000" value="${s.logContentMax || 2000}" />
            <span class="field-hint">超过时优先保留最近的几条消息，并标记「已截断」。明细只留最近 5000 条，按需调整。</span>
          </label>
          <div style="margin:4px 0 14px">
            <label class="switch">
              <input type="checkbox" id="set-stream-usage" ${s.streamUsage !== false ? 'checked' : ''} />
              <span class="switch-track"></span>
              <span class="switch-label">流式请求向上游索取真实用量（include_usage）</span>
            </label>
            <span class="field-hint">
              开启后网关会在流式请求里补 <code>stream_options.include_usage</code>，拿到厂商返回的真实 token 数；
              关掉则上游多半不返回用量，只能按文本估算，和厂商账单会有偏差。个别不认这个参数的代理会自动退回原始请求重试。
            </span>
          </div>
          <div style="margin:4px 0 14px">
            <label class="switch">
              <input type="checkbox" id="set-retry-on" ${(s.retry && s.retry.enabled === false) ? '' : 'checked'} />
              <span class="switch-track"></span>
              <span class="switch-label">上游繁忙 / 限流时自动重试</span>
            </label>
            <span class="field-hint">
              上游返回 503「Service is too busy」、429 限流或连接中断时，先在同一渠道退避重试几次，都失败再切下一个渠道。
              只配了一个渠道时，这是它能自动恢复的唯一手段。4xx（参数错误、鉴权失败）不重试。
            </span>
          </div>
          <div class="field-row">
            <label class="field">
              <span>重试次数（额外）</span>
              <input type="number" id="set-retry-times" min="0" max="5" value="${(s.retry && s.retry.times != null) ? s.retry.times : 2}" />
              <span class="field-hint">填 0 等于关闭。</span>
            </label>
            <label class="field">
              <span>首次退避（毫秒）</span>
              <input type="number" id="set-retry-base" min="100" max="5000" step="100" value="${(s.retry && s.retry.baseMs) || 800}" />
              <span class="field-hint">之后按 ×2 递增并加随机抖动；上游给了 <code>Retry-After</code> 就听它的（上限 10 秒）。</span>
            </label>
          </div>
          <button class="btn btn-primary btn-sm" data-act="save-settings">保存设置</button>
        </div>
      </div>
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="card">
        <div class="card-head"><div><h3>用量告警（全局默认）</h3><div class="sub">部门、员工没单独配置时用这里的通道与阈值</div></div></div>
        <div class="card-body">
          <label class="field">
            <span>机器人 Webhook 地址</span>
            <input type="text" id="set-webhook" value="${esc(s.webhookUrl || '')}" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/… 或 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…" />
            <span class="field-hint">支持飞书自定义机器人和企业微信群机器人，按地址自动识别格式。</span>
          </label>
          <div style="margin:4px 0 14px">
            <label class="switch">
              <input type="checkbox" id="set-alerts" ${s.alertsEnabled !== false ? 'checked' : ''} />
              <span class="switch-track"></span>
              <span class="switch-label">启用用量告警</span>
            </label>
          </div>
          <div class="form-row">
            <label class="field">
              <span>默认阈值（%）</span>
              <input type="text" id="set-alert-th" value="${esc((s.alertThresholds || [80, 100]).join(', '))}" placeholder="80, 100" />
            </label>
            <label class="field">
              <span>默认监控维度</span>
              <div style="display:flex;gap:14px;padding-top:6px">
                <label class="switch"><input type="checkbox" class="set-alert-dim" value="dailyTokens" ${dims.includes('dailyTokens') ? 'checked' : ''} /><span class="switch-track"></span><span class="switch-label" style="font-weight:400;font-size:13px">日 Token</span></label>
                <label class="switch"><input type="checkbox" class="set-alert-dim" value="monthlyTokens" ${dims.includes('monthlyTokens') ? 'checked' : ''} /><span class="switch-track"></span><span class="switch-label" style="font-weight:400;font-size:13px">月 Token</span></label>
              </div>
            </label>
          </div>
          <div class="notice notice-info" style="margin:6px 0 12px">
            ${ICON.info}
            <div><b>告警通道的继承顺序：</b>员工自己的 Webhook → 所属部门的 Webhook → 这里的全局机器人。阈值与维度同理。给每个部门单独建群，就能做到「谁超了只通知谁」。</div>
          </div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-primary btn-sm" data-act="save-settings">保存设置</button>
            <button class="btn btn-ghost btn-sm" data-act="test-webhook">发送测试消息</button>
          </div>
          ${ownRoutes.length ? `<p class="field-hint" style="margin-top:10px">已配置独立通道：${ownRoutes.join('、')}</p>` : ''}
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

    <div class="card" style="margin-top:16px">
      <div class="card-head">
        <div><h3>最近告警</h3><div class="sub">成功 ${alertData.okCount || 0} 条 · 失败 ${alertData.failCount || 0} 条（最多保留 200 条）</div></div>
      </div>
      <div class="card-body tight table-wrap">
        ${alertRows ? `
          <table class="tbl">
            <thead><tr><th>时间</th><th>对象</th><th>触发条件</th><th>用量</th><th>通道</th><th>结果</th></tr></thead>
            <tbody>${alertRows}</tbody>
          </table>` : '<div class="empty"><strong>还没有告警记录</strong>额度达到阈值、或点过「发送测试消息」后会出现在这里</div>'}
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

      <div class="section-label">允许的模型（可选）</div>
      <label class="field">
        <span>模型白名单</span>
        <input type="text" id="f-models" value="${esc((d.allowedModels || []).join(', '))}" placeholder="留空 = 不限制，可使用全部模型" />
        <span class="field-hint">用逗号分隔，支持通配，如 gpt-4o-mini, deepseek*。填了之后该部门只能调用列表里的模型。</span>
      </label>

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

      ${alertFields('f', d.alert, { dept: true, testId: d.id || '' })}

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
  wireAlertToggle('f');
}

// ---------------------------------------------------------------- 员工表单（核心）

function empForm(emp) {
  const isNew = !emp;
  const e = emp || {
    name: '', email: '', deptId: state.depts[0]?.id || '', status: 'active',
    override: { enabled: false, dailyTokens: null, monthlyTokens: null, rpm: null, concurrency: null, countAgainstDept: true, allowedModels: null, expiresAt: '', note: '' },
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

          <label class="field">
            <span>允许的模型（留空 = 继承部门策略）</span>
            <input type="text" class="ov-in" id="e-ov-models" value="${esc((ov.allowedModels || []).join(', '))}" placeholder="继承部门" />
            <span class="field-hint">填了就<b>整体覆盖</b>部门的模型白名单，同样支持通配（如 gpt-4o*）。部门没设且这里也没填 = 不限制。</span>
          </label>
        </div>

        <div id="ov-preview"></div>
      </div>

      ${alertFields('e', e.alert, { testId: e.id || '' })}
    `,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-emp" data-id="${e.id || ''}">保存</button>
    `,
  });
  wireAlertToggle('e');

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
      allowedModels: $('#e-ov-models').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    } : null;

    $('#ov-fields').classList.toggle('hidden', !enabled);
    $('.override-box').classList.toggle('disabled', !enabled);

    const rows = resolvePreview(dept, ovNow);

    // 首屏就能看到的一行摘要：哪些维度用了特例，一眼可辨
    const short = { dailyTokens: '日', monthlyTokens: '月', rpm: 'RPM', concurrency: '并发' };
    const bits = rows.map((r) =>
      `${short[r.key]} <b class="${r.source === 'employee' ? 'emp' : ''}">${r.valueText}</b>`).join(' · ');

    // 模型策略摘要
    let modelText;
    if (enabled && ovNow && ovNow.allowedModels.length) {
      modelText = `模型 <b class="emp">${esc(ovNow.allowedModels.join('、'))}</b>`;
    } else if (dept && (dept.allowedModels || []).length) {
      modelText = `模型 <b>${esc(dept.allowedModels.join('、'))}</b>（部门）`;
    } else {
      modelText = '模型 <b>不限</b>';
    }
    $('#ov-summary').innerHTML = `
      <div style="font-size:12.5px;line-height:1.7">
        生效额度：${bits} · ${modelText}
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
  ['#e-ov-daily', '#e-ov-monthly', '#e-ov-rpm', '#e-ov-conc', '#e-ov-count', '#e-ov-models'].forEach((sel) => {
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

      ${snap.models && snap.models.restricted ? `
        <div class="section-label">允许的模型</div>
        <div class="explain" style="margin-top:0">
          <span class="tag ${snap.models.source === 'employee' ? 'tag-brand' : 'tag-grey'}" style="margin-right:8px">${snap.models.source === 'employee' ? '个人特例' : '部门策略'}</span>
          ${snap.models.list.map((m) => `<span class="tag tag-outline" style="margin:2px 4px 2px 0">${esc(m)}</span>`).join('')}
        </div>` : ''}

      <div class="section-label">用量告警</div>
      <div class="explain" style="margin-top:0">
        ${emp && emp.alert && emp.alert.enabled
          ? `<span class="tag tag-brand" style="margin-right:8px">独立通道</span>
             ${emp.alert.webhookUrl ? '专属 Webhook 已配置' : '未填专属 Webhook，继承部门 / 全局机器人'}　
             阈值 ${emp.alert.thresholds && emp.alert.thresholds.length ? emp.alert.thresholds.map((t) => t + '%').join(' / ') : '继承'}　
             维度 ${emp.alert.dimensions && emp.alert.dimensions.length ? emp.alert.dimensions.map((d) => d === 'monthlyTokens' ? '月 Token' : '日 Token').join('、') : '继承'}`
          : '<span class="tag tag-grey" style="margin-right:8px">继承</span>使用部门或全局的告警通道与阈值'}
      </div>

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

// ---------------------------------------------------------------- 模型单价：单模型 DIY

/** 从「单模型编辑」弹窗读出定价对象（只返回填了的字段，空值一律删除） */
function pricingEntryFromForm() {
  const val = (sel) => {
    const el = $(sel);
    if (!el) return undefined;
    const v = el.value;
    return v === '' || v == null ? undefined : Math.max(0, Number(v) || 0);
  };
  const entry = { in: val('#pf-in') ?? 0, out: val('#pf-out') ?? 0 };
  const setIf = (k, v) => { if (v !== undefined) entry[k] = v; };
  setIf('cacheIn', val('#pf-cachein'));
  setIf('cacheWrite', val('#pf-cachewrite'));

  const idle = {};
  [['in', '#pf-idle-in'], ['out', '#pf-idle-out'], ['cacheIn', '#pf-idle-cachein'], ['cacheWrite', '#pf-idle-cachewrite']]
    .forEach(([k, sel]) => { const v = val(sel); if (v !== undefined) idle[k] = v; });
  if (Object.keys(idle).length) entry.idle = idle;

  const tiers = [];
  $$('.pf-tier').forEach((tr) => {
    const upTo = Number($('.pf-t-upto', tr).value) || 0;
    if (!upTo) return;
    const t = { upTo: Math.round(upTo) };
    [['in', '.pf-t-in'], ['out', '.pf-t-out'], ['cacheIn', '.pf-t-cachein'], ['cacheWrite', '.pf-t-cachewrite']]
      .forEach(([k, sel]) => {
        const raw = $(sel, tr).value;
        if (raw !== '') t[k] = Math.max(0, Number(raw) || 0);
      });
    tiers.push(t);
  });
  if (tiers.length) entry.tiers = tiers.sort((a, b) => a.upTo - b.upTo);

  // 自定义时段：没填时间窗/日期的行直接忽略（避免半填状态导致保存失败）
  const periods = [];
  $$('.pf-period').forEach((tr) => {
    const name = ($('.pf-p-name', tr).value || '').trim();
    const daysRaw = ($('.pf-p-days', tr).value || '').trim();
    const timeRaw = ($('.pf-p-win', tr).value || '').trim();
    if (!timeRaw) return;
    const p = {};
    if (name) p.name = name;
    if (/^(\d{4}-\d{2}-\d{2}\s*[,，]\s*)*\d{4}-\d{2}-\d{2}$/.test(timeRaw)) {
      p.dates = timeRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    } else {
      p.windows = timeRaw;
      if (daysRaw) p.days = daysRaw;
    }
    [['in', '.pf-p-in'], ['out', '.pf-p-out'], ['cacheIn', '.pf-p-cachein'], ['cacheWrite', '.pf-p-cachewrite']]
      .forEach(([k, sel]) => {
        const raw = $(sel, tr).value;
        if (raw !== '') p[k] = Math.max(0, Number(raw) || 0);
      });
    periods.push(p);
  });
  if (periods.length) entry.periods = periods;

  const perCall = val('#pf-percall');
  if (perCall !== undefined) entry.perCall = perCall;
  const multRaw = $('#pf-multiplier')?.value;
  if (multRaw !== '' && multRaw != null && Number(multRaw) >= 0) entry.multiplier = Number(multRaw);
  const formula = ($('#pf-formula')?.value || '').trim();
  if (formula) entry.formula = formula;
  const note = ($('#pf-note')?.value || '').trim();
  if (note) entry.note = note;
  return entry;
}

/** 把「1-5」「0,6」「1,2,3,4,5」翻成人看的星期文字，看不懂的原样保留 */
function pfDayLabel(raw) {
  const N = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const s = String(raw || '').trim();
  if (!s) return '每天';
  const nums = [];
  const others = [];
  s.split(/[,，\s]+/).filter(Boolean).forEach((tok) => {
    const m = tok.match(/^(\d)\s*-\s*(\d)$/);
    if (m && Number(m[1]) <= 6 && Number(m[2]) <= 6) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a <= b) { for (let i = a; i <= b; i++) nums.push(i); } else { others.push(`${N[a]}~${N[b]}`); }
      return;
    }
    const n = Number(tok);
    if (Number.isInteger(n) && n >= 0 && n <= 6) nums.push(n);
    else others.push(tok);
  });
  // 连续 3 天以上压成区间（周一~周五），零散的天照原样列举
  const uniq = [...new Set(nums)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < uniq.length; i++) {
    let j = i;
    while (j + 1 < uniq.length && uniq[j + 1] === uniq[j] + 1) j++;
    parts.push(j - i >= 2 ? `${N[uniq[i]]}~${N[uniq[j]]}` : uniq.slice(i, j + 1).map((d) => N[d]).join('、'));
    i = j;
  }
  return [...parts, ...others].join('、') || '每天';
}

/** 时段卡片底部的「读作」摘要：把星期、时间窗、价格继承情况讲清楚，边填边刷新 */
function pfPeriodSummary(card) {
  const box = $('.pf-p-sum', card);
  if (!box) return;
  const winRaw = ($('.pf-p-win', card)?.value || '').trim();
  const isDates = /^(\d{4}-\d{2}-\d{2}\s*[,，]\s*)*\d{4}-\d{2}-\d{2}$/.test(winRaw);
  const filled = ['.pf-p-in', '.pf-p-out', '.pf-p-cachein', '.pf-p-cachewrite']
    .filter((sel) => ($(sel, card)?.value || '').trim() !== '').length;

  let what;
  if (!winRaw) {
    what = '<span class="pf-p-warn">还没填时间窗 —— 保存时会跳过这一段</span>';
  } else if (isDates) {
    const dates = winRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    what = `指定日期 ${dates.map((d) => `<code>${esc(d)}</code>`).join(' ')} 整天生效`;
  } else {
    const wins = winRaw.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
    what = `每周 ${esc(pfDayLabel($('.pf-p-days', card)?.value))} · ${wins.map((w) => `<code>${esc(w)}</code>`).join(' ')}`;
  }
  const priceText = filled === 0
    ? '价格全部留空 → 跟随基础价'
    : `已填 ${filled} 个价格${filled < 4 ? '，其余跟随基础价' : ''}`;
  box.innerHTML = `<span class="pf-p-sum-k">读作</span>${what}<span class="pf-p-sum-sep">·</span>${priceText}`;
}

/** 时段卡片序号随增删重排 */
function pfRenumberPeriods() {
  $$('#pf-period-list .pf-period').forEach((card, i) => {
    const tag = $('.pf-p-idx', card);
    if (tag) tag.textContent = `时段 ${i + 1}`;
  });
}

/** 单模型编辑弹窗：基础 / 空闲 / 分档 / 自定义时段 / DIY（按次、倍率、公式）/ 试算 */
function pricingForm(model) {
  const base = JSON.parse(JSON.stringify((state.rawPricing || {})[model] || { in: '', out: '' }));
  const idle = base.idle || {};
  const tierRow = (t) => `
    <tr class="pf-tier">
      <td><input type="number" class="input-sm pf-t-upto" min="1" value="${t.upTo ?? ''}" placeholder="262144" /></td>
      <td><input type="number" class="input-sm pf-t-in" min="0" step="0.01" value="${t.in ?? ''}" placeholder="同基础" /></td>
      <td><input type="number" class="input-sm pf-t-out" min="0" step="0.01" value="${t.out ?? ''}" placeholder="同基础" /></td>
      <td><input type="number" class="input-sm pf-t-cachein" min="0" step="0.01" value="${t.cacheIn ?? ''}" placeholder="可选" /></td>
      <td><input type="number" class="input-sm pf-t-cachewrite" min="0" step="0.01" value="${t.cacheWrite ?? ''}" placeholder="可选" /></td>
      <td><button class="btn-link danger" data-act="pf-del-tier">删除</button></td>
    </tr>`;

  // 自定义时段：每段一张卡（原来的 8 列表格挤在 760px 里，时间窗内容看不全）
  // 时间窗列兼容两种写法——「09:00-12:00, 14:00-18:00」或指定日期「2026-11-11」
  const periodRow = (p) => {
    const isDates = Array.isArray(p.dates) && p.dates.length;
    const daysText = isDates ? '' : (Array.isArray(p.days) && p.days.length ? p.days.join(',') : '');
    const timeText = isDates ? p.dates.join(', ') : (Array.isArray(p.windows) ? p.windows.map((w) => w.join('-')).join(', ') : '');
    return `
    <div class="pf-period">
      <div class="pf-p-head">
        <span class="pf-p-idx">时段</span>
        <input type="text" class="input-sm pf-p-name" value="${esc(p.name || '')}" placeholder="时段名，例如：高峰·工作日 / 空闲·周末" />
        <button class="btn-link danger" data-act="pf-del-period">删除</button>
      </div>
      <div class="pf-p-grid">
        <label class="pf-p-field">
          <span>生效星期</span>
          <input type="text" class="input-sm pf-p-days" value="${esc(daysText)}" placeholder="1-5" ${isDates ? 'disabled title="该段按指定日期生效"' : ''} />
        </label>
        <label class="pf-p-field">
          <span>时间窗 / 指定日期</span>
          <input type="text" class="input-sm pf-p-win" value="${esc(timeText)}" placeholder="09:00-12:00, 14:00-18:00 或 2026-11-11" />
        </label>
      </div>
      <div class="pf-p-prices">
        <label class="pf-p-field"><span>输入价</span><input type="number" class="input-sm pf-p-in" min="0" step="0.01" value="${p.in ?? ''}" placeholder="同基础" /></label>
        <label class="pf-p-field"><span>输出价</span><input type="number" class="input-sm pf-p-out" min="0" step="0.01" value="${p.out ?? ''}" placeholder="同基础" /></label>
        <label class="pf-p-field"><span>缓存命中</span><input type="number" class="input-sm pf-p-cachein" min="0" step="0.01" value="${p.cacheIn ?? ''}" placeholder="同输入" /></label>
        <label class="pf-p-field"><span>缓存写入</span><input type="number" class="input-sm pf-p-cachewrite" min="0" step="0.01" value="${p.cacheWrite ?? ''}" placeholder="同输入" /></label>
      </div>
      <div class="pf-p-sum"></div>
    </div>`;
  };

  openModal({
    title: `模型单价 · ${model}`,
    sub: '单价单位：元 / 百万 tokens。这个弹窗只影响该模型，保存后写入单价表',
    wide: true,
    body: `
      <div class="section-label" style="margin-top:0">基础价（峰时 / 不分时）</div>
      <div class="form-row">
        <label class="field"><span>输入</span><input type="number" id="pf-in" min="0" step="0.01" value="${base.in ?? ''}" placeholder="必填" /></label>
        <label class="field"><span>输出</span><input type="number" id="pf-out" min="0" step="0.01" value="${base.out ?? ''}" placeholder="必填" /></label>
        <label class="field"><span>缓存命中</span><input type="number" id="pf-cachein" min="0" step="0.01" value="${base.cacheIn ?? ''}" placeholder="留空按输入价" /></label>
        <label class="field"><span>缓存写入</span><input type="number" id="pf-cachewrite" min="0" step="0.01" value="${base.cacheWrite ?? ''}" placeholder="留空按输入价" /></label>
      </div>

      <div class="section-label">空闲时段价（旧版写法，需要打开「全局高峰时段」才生效 —— 推荐用下文的「自定义时段价」）</div>
      <div class="form-row">
        <label class="field"><span>空闲 · 输入</span><input type="number" id="pf-idle-in" min="0" step="0.01" value="${idle.in ?? ''}" placeholder="不分时" /></label>
        <label class="field"><span>空闲 · 输出</span><input type="number" id="pf-idle-out" min="0" step="0.01" value="${idle.out ?? ''}" placeholder="沿用峰时" /></label>
        <label class="field"><span>空闲 · 缓存命中</span><input type="number" id="pf-idle-cachein" min="0" step="0.01" value="${idle.cacheIn ?? ''}" placeholder="按空闲输入" /></label>
        <label class="field"><span>空闲 · 缓存写入</span><input type="number" id="pf-idle-cachewrite" min="0" step="0.01" value="${idle.cacheWrite ?? ''}" placeholder="按空闲输入" /></label>
      </div>

      <div class="section-label">按输入长度分档（可选，配置后优先于分时）</div>
      <div class="table-wrap">
        <table class="tbl pf-tier-tbl">
          <thead><tr><th>输入上限 upTo</th><th>输入价</th><th>输出价</th><th>缓存命中</th><th>缓存写入</th><th style="width:64px">操作</th></tr></thead>
          <tbody id="pf-tier-body">${(base.tiers || []).map(tierRow).join('')}</tbody>
        </table>
      </div>
      <button class="btn btn-ghost btn-sm" id="pf-add-tier" style="margin-top:8px">+ 增加一档</button>
      <p class="field-hint">例如通义千问：≤262144 一档、≤1048576 一档，超出最后一档回落基础价。</p>

      <div class="section-label">自定义时段价（可选，时间规则也按模型自己配）</div>
      <div class="pf-period-list" id="pf-period-list">${(base.periods || []).map(periodRow).join('')}</div>
      <p class="field-hint" id="pf-period-empty" ${(base.periods || []).length ? 'style="display:none"' : ''}>还没有时段：点下面「+ 增加一段」，或者用内置参考价里已填好的 DeepSeek 三段做参考。</p>
      <button class="btn btn-ghost btn-sm" id="pf-add-period" style="margin-top:8px">+ 增加一段</button>
      <p class="field-hint">
        典型用法：<b>高峰</b> = 星期 <code>1-5</code> + 时间窗 <code>09:00-12:00, 14:00-18:00</code>；
        <b>夜间</b> = 星期留空 + <code>00:00-07:00</code>；<b>周末</b> = <code>0,6</code> + <code>00:00-24:00</code>。
        星期写 <code>1-5</code> / <code>0,6</code>（0=周日），留空=每天；时间窗可跨零点（<code>22:00-06:00</code>），结束写 <code>24:00</code> 表示到当天结束；
        想按具体日期整天生效（大促、节假日特价），直接在「时间窗 / 指定日期」里写 <code>2026-11-11</code>。
        每张卡片底部的「读作」会把填的内容翻译成一句人话，填错顺序能立刻看出来。
        按卡片<b>从上往下先命中先用</b>（写日期的那几段永远先判，用来盖住常规时段），都不命中用基础价。配了自定义时段后，这个模型不再看全局高峰规则与上面的空闲价。
      </p>

      <div class="section-label">自定义计费（DIY）</div>
      <div class="form-row">
        <label class="field">
          <span>每次调用固定费用（元）</span>
          <input type="number" id="pf-percall" min="0" step="0.001" value="${base.perCall ?? ''}" placeholder="0 = 不额外收费" />
          <span class="field-hint">按次计费的模型（图像、语音、检索）用它，叠加在 token 费用上。</span>
        </label>
        <label class="field">
          <span>成本倍率</span>
          <input type="number" id="pf-multiplier" min="0" step="0.01" value="${base.multiplier ?? ''}" placeholder="1 = 原价" />
          <span class="field-hint">加价或折扣：1.2 = 上浮 20%，0.8 = 八折，0 = 内部免费。</span>
        </label>
      </div>
      <label class="field">
        <span>自定义公式（元，留空 = 用上面的单价规则）</span>
        <input type="text" id="pf-formula" value="${esc(base.formula || '')}" placeholder="例如 base * 1.2 + 0.001 或 prompt * 0.000002 + completion * 0.000008" style="font-family:var(--mono)" />
        <span class="field-hint">
          可用变量：<code>prompt</code> <code>completion</code> <code>cacheHit</code> <code>cacheWrite</code> <code>miss</code>
          <code>inPrice</code> <code>outPrice</code> <code>cacheInPrice</code> <code>cacheWritePrice</code> <code>base</code> <code>calls</code>。
          只支持 + - * / 和括号；公式结果替代基础 token 费用，之后再叠加「按次」并乘以「倍率」。
        </span>
      </label>
      <label class="field">
        <span>计费备注</span>
        <input type="text" id="pf-note" value="${esc(base.note || '')}" placeholder="例如：官方 2026-11 调价；代理商加价 10%" />
      </label>

      <div class="section-label">试算</div>
      <div class="form-row">
        <label class="field"><span>输入 tokens</span><input type="number" id="pf-t-prompt" min="0" value="1000" /></label>
        <label class="field"><span>输出 tokens</span><input type="number" id="pf-t-completion" min="0" value="500" /></label>
        <label class="field"><span>缓存命中</span><input type="number" id="pf-t-cachehit" min="0" value="0" /></label>
        <label class="field"><span>缓存写入</span><input type="number" id="pf-t-cachewrite" min="0" value="0" /></label>
      </div>
      <label class="field" style="max-width:300px">
        <span>试算时刻（留空 = 现在）</span>
        <input type="datetime-local" id="pf-t-at" />
        <span class="field-hint">用来验证自定义时段 / 全局峰谷是否命中，例如填周二 10:30 看高峰价。</span>
      </label>
      <button class="btn btn-ghost btn-sm" id="pf-test">按当前表单试算（不保存）</button>
      <div id="pf-result" style="margin-top:10px"></div>
    `,
    footer: `
      <button class="btn btn-ghost" data-act="close-modal">取消</button>
      <button class="btn btn-primary" data-act="save-pricing-one" data-model="${esc(model)}">保存该模型</button>
    `,
  });

  $('#pf-add-tier').addEventListener('click', () => {
    $('#pf-tier-body').insertAdjacentHTML('beforeend', tierRow({}));
  });

  const plist = $('#pf-period-list');
  $$('.pf-period', plist).forEach(pfPeriodSummary);
  pfRenumberPeriods();
  plist.addEventListener('input', (ev) => {
    const card = ev.target.closest('.pf-period');
    if (card) pfPeriodSummary(card);
  });
  $('#pf-add-period').addEventListener('click', () => {
    plist.insertAdjacentHTML('beforeend', periodRow({}));
    const card = plist.lastElementChild;
    pfRenumberPeriods();
    pfPeriodSummary(card);
    $('#pf-period-empty')?.style.setProperty('display', 'none');
    $('.pf-p-name', card)?.focus();
  });
  $('#pf-test').addEventListener('click', () => pfTest(model));
}

/** 试算：把表单里的（可能还没保存的）配置发给后端，用真实计价引擎算一遍 */
async function pfTest(model) {
  const box = $('#pf-result');
  box.innerHTML = '<span class="field-hint">计算中…</span>';
  try {
    const entry = pricingEntryFromForm();
    const atRaw = ($('#pf-t-at')?.value || '').trim();
    const r = await api('/api/pricing/test', {
      method: 'POST',
      body: JSON.stringify({
        model,
        pricing: entry,
        prompt: Number($('#pf-t-prompt').value) || 0,
        completion: Number($('#pf-t-completion').value) || 0,
        cacheHit: Number($('#pf-t-cachehit').value) || 0,
        cacheWrite: Number($('#pf-t-cachewrite').value) || 0,
        at: atRaw ? new Date(atRaw).toISOString() : undefined,
      }),
    });
    const d = r.detail;
    const rows = [
      d.period ? ['命中自定义时段', `「${d.period.name}」`, '按这一段的时间规则与单价计'] : null,
      !d.period && entry.periods && entry.periods.length ? ['自定义时段', '未命中', '该时刻不在任何时段内，按基础价计'] : null,
      ['基础 token 费用', costText(d.base), `输入价 ${d.prices.in} / 输出价 ${d.prices.out}（元/百万）`],
      d.formula != null ? ['公式覆盖', costText(d.formula), '公式结果替代基础费用'] : null,
      d.formulaError ? ['公式错误', '回退基础价', d.formulaError] : null,
      d.perCall ? ['按次费用', '+ ' + costText(d.perCall), '每次调用固定加收'] : null,
      d.multiplier !== 1 ? ['成本倍率', '× ' + d.multiplier, ''] : null,
    ].filter(Boolean);
    box.innerHTML = `
      <table class="preview-table">
        <tbody>
          ${rows.map(([k, v, h]) => `<tr><td>${esc(k)}</td><td class="num"><b>${esc(v)}</b></td><td class="field-hint" style="margin:0">${esc(h)}</td></tr>`).join('')}
          <tr><td><b>合计</b></td><td class="num"><b>${costText(d.total)}</b></td><td class="field-hint" style="margin:0">${d.period ? `自定义时段「${esc(d.period.name)}」` : (d.idle ? '按空闲时段价' : '按峰时/基础价')}${d.tierUpTo ? ` · 命中 ≤${fmt(d.tierUpTo)} 档` : ''}</td></tr>
        </tbody>
      </table>`;
  } catch (e) {
    box.innerHTML = `<span class="field-hint" style="color:var(--danger)">${esc(e.message)}</span>`;
  }
}

// ---------------------------------------------------------------- 告警配置表单块

/** 部门 / 员工共用的告警配置块；dimensions 为空 = 继承上级 */
function alertFields(prefix, a, opts = {}) {
  const al = a || {};
  const isDept = !!opts.dept;
  const dims = Array.isArray(al.dimensions) ? al.dimensions : [];
  return `
    <div class="section-label">用量告警${isDept ? '（部门级）' : '（个人级）'}</div>
    <label class="switch">
      <input type="checkbox" id="${prefix}-alert-enabled" ${al.enabled ? 'checked' : ''} />
      <span class="switch-track"></span>
      <span class="switch-label">${isDept ? '这个部门用自己的告警通道' : '这名员工用自己的告警通道'}</span>
    </label>
    <div id="${prefix}-alert-fields" class="${al.enabled ? '' : 'hidden'}" style="margin-top:10px">
      <label class="field">
        <span>告警机器人 Webhook</span>
        <input type="text" id="${prefix}-alert-url" value="${esc(al.webhookUrl || '')}" placeholder="${isDept ? '留空 = 用系统设置里的全局机器人' : '留空 = 继承部门 / 全局机器人'}" />
        <span class="field-hint">飞书自定义机器人或企业微信群机器人。填了之后，该对象自己的额度告警只发到这个群。</span>
      </label>
      <div class="form-row">
        <label class="field">
          <span>触发阈值（%）</span>
          <input type="text" id="${prefix}-alert-th" value="${esc((al.thresholds || []).join(', '))}" placeholder="留空 = 80, 100" />
          <span class="field-hint">逗号分隔，如 50, 80, 95。同一个阈值每个统计周期只提醒一次。</span>
        </label>
        <label class="field">
          <span>监控维度</span>
          <div style="display:flex;gap:14px;padding-top:6px">
            <label class="switch"><input type="checkbox" class="${prefix}-alert-dim" value="dailyTokens" ${!dims.length || dims.includes('dailyTokens') ? 'checked' : ''} /><span class="switch-track"></span><span class="switch-label" style="font-weight:400;font-size:13px">日 Token</span></label>
            <label class="switch"><input type="checkbox" class="${prefix}-alert-dim" value="monthlyTokens" ${!dims.length || dims.includes('monthlyTokens') ? 'checked' : ''} /><span class="switch-track"></span><span class="switch-label" style="font-weight:400;font-size:13px">月 Token</span></label>
          </div>
        </label>
      </div>
      ${opts.testId
        ? `<button class="btn btn-ghost btn-sm" data-act="${isDept ? 'test-dept-alert' : 'test-emp-alert'}" data-id="${opts.testId}">发送测试消息</button>`
        : '<p class="field-hint">新建保存后，可在列表里点「测试告警」验证通道。</p>'}
    </div>`;
}

/** 从表单读取告警配置 */
function readAlert(prefix) {
  const enabled = !!($(`#${prefix}-alert-enabled`) || {}).checked;
  if (!enabled) return { enabled: false, webhookUrl: '', thresholds: [], dimensions: [] };
  const thRaw = ($(`#${prefix}-alert-th`) || {}).value || '';
  const thresholds = thRaw.split(/[,，\s]+/).map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 100)
    .map((n) => Math.round(n))
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .sort((a, b) => a - b);
  const dimensions = $$(`.${prefix}-alert-dim`).filter((x) => x.checked).map((x) => x.value);
  return {
    enabled: true,
    webhookUrl: (($(`#${prefix}-alert-url`) || {}).value || '').trim(),
    thresholds,
    dimensions,
  };
}

/** 告警开关联动显示 */
function wireAlertToggle(prefix) {
  const box = $(`#${prefix}-alert-enabled`);
  if (!box) return;
  box.addEventListener('change', () => {
    $(`#${prefix}-alert-fields`).classList.toggle('hidden', !box.checked);
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
          allowedModels: $('#f-models').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
          alert: readAlert('f'),
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
            allowedModels: ovEnabled
              ? ($('#e-ov-models').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)) || null
              : null,
            expiresAt: ovEnabled ? ($('#e-ov-expire').value || '') : '',
            note: ovEnabled ? ($('#e-ov-note').value || '') : '',
          },
          alert: readAlert('e'),
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

      case 'log-detail':
        await logDetail(id);
        break;

      case 'edit-pricing':
        pricingForm(el.dataset.model);
        break;

      case 'pf-del-tier':
      case 'pf-del-period': {
        const row = el.closest('.pf-period') || el.closest('tr');
        if (row) row.remove();
        if (el.dataset.act === 'pf-del-period') {
          pfRenumberPeriods();
          const empty = $('#pf-period-empty');
          if (empty && !$$('#pf-period-list .pf-period').length) empty.style.display = '';
        }
        break;
      }

      case 'save-pricing-one': {
        const model = el.dataset.model;
        const entry = pricingEntryFromForm();
        const base = JSON.parse(JSON.stringify(state.rawPricing || {}));
        const merged = { ...(base[model] || {}) };
        for (const k of ['cacheIn', 'cacheWrite', 'idle', 'tiers', 'periods', 'perCall', 'multiplier', 'formula', 'note']) delete merged[k];
        base[model] = { ...merged, ...entry, in: entry.in ?? 0, out: entry.out ?? 0 };
        await api('/api/pricing', { method: 'PUT', body: JSON.stringify({ pricing: base }) });
        closeModal();
        await renderProviders();
        toast(`模型「${model}」的单价与计费规则已保存`, 'ok');
        break;
      }

      case 'test-dept-alert':
      case 'test-emp-alert': {
        el.disabled = true;
        const label = el.textContent;
        el.textContent = '发送中…';
        try {
          const path = act === 'test-dept-alert' ? `/api/departments/${id}/test-alert` : `/api/employees/${id}/test-alert`;
          const r = await api(path, { method: 'POST', body: JSON.stringify({}) });
          toast(r.ok ? '测试消息已发送，去群里看看（通道来源写在消息里）' : `发送失败：${r.message}`, r.ok ? 'ok' : 'err');
        } finally {
          el.disabled = false;
          el.textContent = label;
        }
        break;
      }

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

      case 'save-pricing': {
        // 以现有定价为底（保留 cacheWrite / tiers / idle.cacheIn 等高级字段），再套用表格输入
        const base = JSON.parse(JSON.stringify(state.rawPricing || {}));
        const num = (v) => (v !== '' && v !== undefined && v !== null ? Math.max(0, Number(v) || 0) : undefined);
        const setOrDel = (obj, key, val) => { if (val === undefined) delete obj[key]; else obj[key] = val; };
        const applyRow = (m, els) => {
          const entry = { ...(base[m] || {}) };
          entry.in = num(els.in) ?? 0;
          entry.out = num(els.out) ?? 0;
          setOrDel(entry, 'cacheIn', num(els.cacheIn));
          setOrDel(entry, 'cacheWrite', num(els.cacheWrite));
          const idle = { ...(entry.idle || {}) };
          setOrDel(idle, 'in', num(els.idleIn));
          setOrDel(idle, 'out', num(els.idleOut));
          setOrDel(idle, 'cacheIn', num(els.idleCacheIn));
          setOrDel(idle, 'cacheWrite', num(els.idleCacheWrite));
          if (Object.keys(idle).length) entry.idle = idle; else delete entry.idle;
          base[m] = entry;
        };
        for (const el of $$('.pr-in')) {
          const m = el.dataset.model;
          applyRow(m, {
            in: el.value,
            out: $$('.pr-out').find((x) => x.dataset.model === m)?.value ?? '',
            cacheIn: $$('.pr-cachein').find((x) => x.dataset.model === m)?.value ?? '',
            cacheWrite: $$('.pr-cachewrite').find((x) => x.dataset.model === m)?.value ?? '',
            idleIn: $$('.pr-idlein').find((x) => x.dataset.model === m)?.value ?? '',
            idleOut: $$('.pr-idleout').find((x) => x.dataset.model === m)?.value ?? '',
            idleCacheIn: $$('.pr-idlecachein').find((x) => x.dataset.model === m)?.value ?? '',
            idleCacheWrite: $$('.pr-idlecachewrite').find((x) => x.dataset.model === m)?.value ?? '',
          });
        }
        const nm = $('#pr-new-model').value.trim();
        if (nm) {
          applyRow(nm, {
            in: $('#pr-new-in').value,
            out: $('#pr-new-out').value,
            cacheIn: $('#pr-new-cachein').value,
            cacheWrite: $('#pr-new-cachewrite').value,
            idleIn: $('#pr-new-idlein').value,
            idleOut: $('#pr-new-idleout').value,
            idleCacheIn: $('#pr-new-idlecachein').value,
            idleCacheWrite: $('#pr-new-idlecachewrite').value,
          });
        }
        await api('/api/pricing', { method: 'PUT', body: JSON.stringify({ pricing: base }) });
        await api('/api/settings', { method: 'PUT', body: JSON.stringify({ peak: {
          enabled: $('#pr-peak-enabled').checked,
          days: $$('.pr-peak-day').filter((x) => x.checked).map((x) => Number(x.value)),
          windows: [
            [$('#pr-w1-start').value, $('#pr-w1-end').value],
            [$('#pr-w2-start').value, $('#pr-w2-end').value],
          ].filter(([s, e]) => s && e),
          holidays: $('#pr-holidays').value.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean),
        } }) });
        await renderProviders();
        toast('单价已保存，之后的调用将按新价格（含分时/缓存/分档）核算成本', 'ok');
        break;
      }

      case 'load-presets': {
        const ok = window.confirm(
          '将写入内置官方参考价（各厂商官方价，美元按汇率折算）。\n\n' +
          '同名模型的单价会被覆盖，自定义的其他模型保持不变。\n\n继续？',
        );
        if (!ok) break;
        const r = await api('/api/pricing/presets', { method: 'POST', body: JSON.stringify({ overwrite: true }) });
        await renderProviders();
        toast(`已载入官方参考价（${r.updatedAt}）：新增 ${r.added} 个、更新 ${r.updated} 个模型`, 'ok');
        break;
      }

      case 'save-pricing-advanced': {
        let parsed;
        try {
          parsed = JSON.parse($('#pr-advanced').value || '{}');
        } catch (e) {
          toast('JSON 格式有误：' + e.message, 'err');
          break;
        }
        if (typeof parsed !== 'object' || Array.isArray(parsed) || !parsed) {
          toast('高级定价需要是一个对象，如 { "模型名": { ... } }', 'err');
          break;
        }
        await api('/api/pricing', { method: 'PUT', body: JSON.stringify({ pricing: parsed }) });
        await renderProviders();
        toast('高级定价已保存', 'ok');
        break;
      }

      case 'save-settings': {
        await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            platformName: $('#set-name').value.trim(),
            onExceed: $('#set-onExceed').value,
            mockWhenNoProvider: $('#set-mock').checked,
            webhookUrl: $('#set-webhook').value.trim(),
            alertsEnabled: $('#set-alerts').checked,
            alertThresholds: $('#set-alert-th').value.split(/[,，\s]+/).map(Number).filter((n) => n > 0 && n <= 100),
            alertDimensions: $$('.set-alert-dim').filter((x) => x.checked).map((x) => x.value),
            logContent: $('#set-logmode').value,
            logContentMax: Number($('#set-logmax').value) || 2000,
            streamUsage: $('#set-stream-usage') ? $('#set-stream-usage').checked : true,
            retry: {
              enabled: $('#set-retry-on') ? $('#set-retry-on').checked : true,
              times: $('#set-retry-times') ? Number($('#set-retry-times').value) || 0 : 2,
              baseMs: $('#set-retry-base') ? Number($('#set-retry-base').value) || 800 : 800,
            },
          }),
        });
        await refreshAll();
        toast('设置已保存', 'ok');
        break;
      }

      case 'test-webhook': {
        el.disabled = true;
        el.textContent = '发送中…';
        try {
          const r = await api('/api/settings/test-webhook', {
            method: 'POST',
            body: JSON.stringify({ webhookUrl: $('#set-webhook').value.trim() }),
          });
          toast(r.ok ? '测试消息已发送，去群里看看' : `发送失败：${r.message}`, r.ok ? 'ok' : 'err');
        } finally {
          el.disabled = false;
          el.textContent = '发送测试消息';
        }
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
  checkServerVersion();
  const [initial, sub] = location.hash.replace('#/', '').split('/');
  if (ROUTES.some((r) => r.key === initial)) state.view = initial;
  if (initial === 'plugins' && sub) state.pluginId = sub;
  if (state.token) enterApp();
})();

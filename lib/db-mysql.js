'use strict';

/**
 * MySQL 持久化层（v1.7.0 起取代 db.json）。
 *
 * 存储模型（与内存态的对应关系见 lib/store.js）：
 *   kv          —— 单对象表：settings / plugins / stats.alerts / stats.alertLog / meta
 *   departments —— 部门（每行一条，data JSON 承载全部字段）
 *   employees   —— 员工
 *   providers   —— 上游渠道
 *   pricing     —— 模型单价（每模型一行）
 *   stats_daily —— 日聚合（每天一行）
 *   usage_log   —— 调用明细（最近 5000 条；常用查询维度抽成列并建索引，
 *                  便于外部 SQL / BI 直接做用量分析，其余字段在 data JSON 里）
 *
 * 同步策略：业务逻辑仍以进程内存为权威（单实例设计，与 v1.6 相同），
 * store.save() 防抖后把内存态写入 MySQL：
 *   - 小表直接事务内 DELETE + 批量 INSERT（行数少，几十毫秒）
 *   - usage_log 增量 INSERT，并清掉已从内存淘汰的旧行
 */

const mysql = require('mysql2/promise');

let pool = null;

/** 从环境变量取连接配置：MYSQL_URL 优先，其次分项 */
function config() {
  if (process.env.MYSQL_URL) {
    return { uri: process.env.MYSQL_URL.trim() };
  }
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'ai_gateway',
  };
}

/** 建立连接池并验证连通性，失败时抛出带指引的错误 */
async function connect() {
  const cfg = config();
  try {
    pool = cfg.uri
      ? mysql.createPool(`${cfg.uri}${cfg.uri.includes('?') ? '&' : '?'}connectionLimit=10&waitForConnections=true&namedPlaceholders=true&dateStrings=true`)
      : mysql.createPool({ ...cfg, connectionLimit: 10, waitForConnections: true, namedPlaceholders: true, dateStrings: true });
    await pool.query('SELECT 1');
    return pool;
  } catch (e) {
    pool = null;
    const hint = cfg.uri
      ? `请检查 MYSQL_URL（当前指向的库连不上：${e.code || e.message}）`
      : `请检查环境变量 MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD / MYSQL_DATABASE（当前 ${cfg.host}:${cfg.port}，库 ${cfg.database}：${e.code || e.message}）`;
    throw new Error(`MySQL 连接失败：${hint}`);
  }
}

function getPool() {
  if (!pool) throw new Error('MySQL 尚未连接（先调用 connect()）');
  return pool;
}

async function close() {
  if (pool) {
    await pool.end().catch(() => { /* ignore */ });
    pool = null;
  }
}

// ---------------------------------------------------------------- 建表

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  k VARCHAR(64) PRIMARY KEY,
  v JSON NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS departments (
  id VARCHAR(32) PRIMARY KEY,
  data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS employees (
  id VARCHAR(32) PRIMARY KEY,
  data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS providers (
  id VARCHAR(32) PRIMARY KEY,
  data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pricing (
  model VARCHAR(128) PRIMARY KEY,
  data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS stats_daily (
  d DATE PRIMARY KEY,
  data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS usage_log (
  id VARCHAR(32) PRIMARY KEY,
  ts DATETIME(3) NOT NULL,
  employee_id VARCHAR(32) NOT NULL DEFAULT '',
  dept_id VARCHAR(32) NOT NULL DEFAULT '',
  model VARCHAR(128) NOT NULL DEFAULT '',
  provider_id VARCHAR(32) NOT NULL DEFAULT '',
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  cache_tokens INT NOT NULL DEFAULT 0,
  cache_write_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  cost DECIMAL(18, 8) NOT NULL DEFAULT 0,
  latency_ms INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ok',
  source VARCHAR(16) NOT NULL DEFAULT '',
  usage_source VARCHAR(16) NOT NULL DEFAULT '',
  data JSON NOT NULL,
  KEY idx_ts (ts),
  KEY idx_emp (employee_id, ts),
  KEY idx_dept (dept_id, ts),
  KEY idx_model (model, ts),
  KEY idx_status (status, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function initSchema() {
  const p = getPool();
  for (const sql of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
    await p.query(sql);
  }
}

// ---------------------------------------------------------------- 读取

/**
 * 从 MySQL 读全量数据
 * @returns {{found: boolean, data: object}} found=false 表示空库（首次启动）
 */
async function loadAll() {
  const p = getPool();
  const out = {
    settings: null, plugins: null, statsAlerts: null, alertLog: null, meta: null,
    departments: [], employees: [], providers: [], pricing: {}, usage: [], daily: {},
  };

  const [kvRows] = await p.query('SELECT k, v FROM kv');
  for (const r of kvRows) {
    if (r.k === 'settings') out.settings = r.v;
    else if (r.k === 'plugins') out.plugins = r.v;
    else if (r.k === 'stats_alerts') out.statsAlerts = r.v;
    else if (r.k === 'alert_log') out.alertLog = r.v;
    else if (r.k === 'meta') out.meta = r.v;
  }

  const [deps] = await p.query('SELECT id, data FROM departments');
  out.departments = deps.map((r) => r.data);
  const [emps] = await p.query('SELECT id, data FROM employees');
  out.employees = emps.map((r) => r.data);
  const [provs] = await p.query('SELECT id, data FROM providers');
  out.providers = provs.map((r) => r.data);
  const [prices] = await p.query('SELECT model, data FROM pricing');
  for (const r of prices) out.pricing[r.model] = r.data;
  const [dailies] = await p.query('SELECT d, data FROM stats_daily');
  for (const r of dailies) out.daily[fmtDate(r.d)] = r.data;
  const [usageRows] = await p.query('SELECT id, data FROM usage_log ORDER BY ts ASC, id ASC');
  out.usage = usageRows.map((r) => r.data);

  const found = kvRows.length > 0;
  return { found, data: out };
}

function fmtDate(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ---------------------------------------------------------------- 写入

/**
 * 把内存态整体同步进 MySQL（一个事务；小表全量重写，usage 增量）。
 * @param {object} db        store 的内存态
 * @param {object} helpers
 *   - usageIds: Set —— 当前内存 usage 的全部 id（用于淘汰 DB 旧行）
 *   - pendingUsage: object[] —— 尚未写入过 MySQL 的明细
 *   - knownUsageIds: Set —— MySQL 里已有的 id 集合（增量判断用，调用方维护）
 */
async function syncAll(db, { usageIds, pendingUsage, knownUsageIds }) {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();

    // —— kv：单对象 upsert
    const kvPairs = [
      ['settings', db.settings || {}],
      ['plugins', db.plugins || {}],
      ['stats_alerts', (db.stats && db.stats.alerts) || null],
      ['alert_log', (db.stats && db.stats.alertLog) || []],
      ['meta', { version: db.version || 1 }],
    ];
    for (const [k, v] of kvPairs) {
      await conn.query(
        'INSERT INTO kv (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
        [k, JSON.stringify(v === undefined ? null : v)],
      );
    }

    // —— 小行表：事务内全量重写（行数少：部门/员工/渠道/单价/日聚合）
    await rewriteRows(conn, 'departments', db.departments.map((r) => ({ __key: r.id, __data: r })));
    await rewriteRows(conn, 'employees', db.employees.map((r) => ({ __key: r.id, __data: r })));
    await rewriteRows(conn, 'providers', db.providers.map((r) => ({ __key: r.id, __data: r })));
    await rewriteRows(conn, 'pricing', Object.entries(db.pricing || {}).map(([model, data]) => ({ __key: model, __data: data })));
    await rewriteRows(conn, 'stats_daily', Object.entries((db.stats && db.stats.daily) || {}).map(([d, data]) => ({ __key: d, __data: data })));

    // —— usage_log：增量插入
    for (const entry of pendingUsage || []) {
      await conn.query(
        `INSERT INTO usage_log
         (id, ts, employee_id, dept_id, model, provider_id,
          prompt_tokens, completion_tokens, cache_tokens, cache_write_tokens,
          total_tokens, cost, latency_ms, status, source, usage_source, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE data = VALUES(data)`,
        [
          entry.id,
          mysqlTimeStamp(entry.ts),
          entry.employeeId || '',
          entry.deptId || '',
          entry.model || '',
          entry.providerId || '',
          Math.round(entry.promptTokens || 0),
          Math.round(entry.completionTokens || 0),
          Math.round(entry.cacheTokens || 0),
          Math.round(entry.cacheWriteTokens || 0),
          Math.round(entry.totalTokens || 0),
          Number(entry.cost || 0),
          Math.round(entry.latencyMs || 0),
          entry.status || 'ok',
          entry.source || '',
          entry.usageSource || '',
          JSON.stringify(entry),
        ],
      );
      knownUsageIds.add(entry.id);
    }

    // —— usage_log：清掉已从内存淘汰的旧行（明细只留最近 N 条）
    if (knownUsageIds.size > usageIds.size) {
      const ids = [...usageIds];
      if (ids.length) {
        const holders = ids.map(() => '?').join(',');
        await conn.query(`DELETE FROM usage_log WHERE id NOT IN (${holders})`, ids);
      } else {
        await conn.query('DELETE FROM usage_log');
      }
      knownUsageIds.clear();
      for (const id of ids) knownUsageIds.add(id);
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback().catch(() => { /* ignore */ });
    throw e;
  } finally {
    conn.release();
  }
}

/** 事务内全量重写一张小行表（rows = [{__key, __data}]） */
async function rewriteRows(conn, table, rows) {
  await conn.query(`DELETE FROM ${table}`);
  if (!rows.length) return;
  const chunk = 100;
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const holders = part.map(() => '(?, ?)').join(',');
    const args = [];
    for (const r of part) {
      args.push(r.__key, JSON.stringify(r.__data));
    }
    await conn.query(
      `INSERT INTO ${table} (id, data) VALUES ${holders}`,
      args,
    );
  }
}

/** ISO 字符串 → MySQL DATETIME(3) */
function mysqlTimeStamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

module.exports = {
  config, connect, close, getPool, initSchema, loadAll, syncAll, rewriteRows, mysqlTimeStamp,
};

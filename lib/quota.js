'use strict';

/**
 * 配额引擎 —— 整个平台的核心规则实现
 *
 * 规则（对应需求："员工单独设置的特殊流量限制，优先于部门"）：
 *
 *   1. 每个员工都有一个「部门默认额度」（继承自所属部门）。
 *   2. 员工可以被单独设置「特例额度」，一旦开启，逐字段覆盖部门值：
 *        字段填数字  → 用这个数字
 *        字段留空    → 该字段仍继承部门
 *        字段填 0    → 不限（常用于给某个人开白名单）
 *   3. 特例可以设置 expiresAt，到期自动失效回到继承，适合临时提额。
 *   4. 特例可以关闭 countAgainstDept：此时该员工的用量不扣部门池，
 *      等于给这个人在部门预算之外单独拨了一块额度。
 *      默认仍然扣部门池 —— 这样"个人上限"和"部门总预算"是双重约束。
 *
 * 判定顺序（先入口后额度，先个人后部门）：
 *   并发 → RPM → 员工日额度 → 员工月额度 → 部门日额度 → 部门月额度
 */

const store = require('./store');

const QUOTA_FIELDS = ['dailyTokens', 'monthlyTokens', 'rpm', 'concurrency'];

const FIELD_LABEL = {
  dailyTokens: '每日 Token',
  monthlyTokens: '每月 Token',
  rpm: '每分钟请求',
  concurrency: '并发数',
};

const SCOPE_LABEL = {
  employee: '员工特例',
  department: '部门默认',
  none: '未设置',
};

/** 数字归一化：空值 → null（表示继承），其余转非负整数 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * 解析某个员工当前实际生效的配额
 * @returns {{fields: object, countAgainstDept: boolean, hasOverride: boolean,
 *            overrideActive: boolean, overrideNote: string, expiresAt: string}}
 */
function resolveQuota(employee, dept) {
  const deptQuota = (dept && dept.quota) || {};
  const ov = employee.override || {};
  const overrideConfigured = !!ov.enabled;

  // 过期判断：过期后等同于没有特例
  let overrideActive = overrideConfigured;
  let expired = false;
  if (overrideConfigured && ov.expiresAt) {
    const t = Date.parse(ov.expiresAt);
    if (Number.isFinite(t) && t < Date.now()) {
      overrideActive = false;
      expired = true;
    }
  }

  const fields = {};
  for (const f of QUOTA_FIELDS) {
    const ovVal = num(ov[f]);
    const deptVal = num(deptQuota[f]);
    if (overrideActive && ovVal !== null) {
      fields[f] = { value: ovVal, source: 'employee', raw: ovVal };
    } else if (deptVal !== null) {
      fields[f] = { value: deptVal, source: 'department', raw: deptVal };
    } else {
      fields[f] = { value: 0, source: 'none', raw: null }; // 0 = 不限
    }
  }

  return {
    fields,
    // 只有特例生效且明确关闭了才不占部门池
    countAgainstDept: overrideActive ? ov.countAgainstDept !== false : true,
    hasOverride: overrideConfigured,
    overrideActive,
    overrideExpired: expired,
    overrideNote: ov.note || '',
    expiresAt: ov.expiresAt || '',
  };
}

/** 把配额值渲染成可读文案 */
function limitText(v) {
  if (v === 0 || v === null || v === undefined) return '不限';
  return v.toLocaleString('en-US');
}

/**
 * 检查一次请求是否可以放行
 * @param {object} p { employee, dept, cost } cost 是预估 token（默认 0，只查入口限制）
 * @returns {{allowed:boolean, reason?:string, dimension?:string, scope?:string, effective:object}}
 */
function checkQuota({ employee, dept, cost = 0 }) {
  const effective = resolveQuota(employee, dept);
  const empId = employee.id;
  const deptId = dept ? dept.id : null;

  const empUsage = store.getEmpUsage(empId);
  const deptUsage = deptId ? store.getDeptUsage(deptId) : null;

  const violations = [];

  // —— 并发（员工级）
  const cLimit = effective.fields.concurrency.value;
  if (cLimit > 0) {
    const cur = store.getInflight('emp:' + empId);
    if (cur >= cLimit) {
      violations.push({
        dimension: 'concurrency', scope: effective.fields.concurrency.source,
        limit: cLimit, used: cur,
        message: `并发已达上限（${cur}/${cLimit}）`,
      });
    }
  }

  // —— RPM（员工级；未覆盖时该值本身就继承自部门）
  const rLimit = effective.fields.rpm.value;
  if (rLimit > 0) {
    const cur = store.peekRpm('emp:' + empId);
    if (cur >= rLimit) {
      violations.push({
        dimension: 'rpm', scope: effective.fields.rpm.source,
        limit: rLimit, used: cur,
        message: `每分钟请求数超限（${cur}/${rLimit}）`,
      });
    }
  }

  // —— 员工额度
  const dTokens = effective.fields.dailyTokens.value;
  if (dTokens > 0) {
    const remaining = dTokens - empUsage.dayTokens;
    if (remaining <= 0 || cost > remaining) {
      violations.push({
        dimension: 'dailyTokens', scope: effective.fields.dailyTokens.source,
        limit: dTokens, used: empUsage.dayTokens,
        message: `员工每日 Token 额度已用尽（${empUsage.dayTokens.toLocaleString()}/${dTokens.toLocaleString()}）`,
      });
    }
  }

  const mTokens = effective.fields.monthlyTokens.value;
  if (mTokens > 0) {
    const remaining = mTokens - empUsage.monthTokens;
    if (remaining <= 0 || cost > remaining) {
      violations.push({
        dimension: 'monthlyTokens', scope: effective.fields.monthlyTokens.source,
        limit: mTokens, used: empUsage.monthTokens,
        message: `员工每月 Token 额度已用尽（${empUsage.monthTokens.toLocaleString()}/${mTokens.toLocaleString()}）`,
      });
    }
  }

  // —— 部门池（特例关掉 countAgainstDept 时跳过）
  if (dept && effective.countAgainstDept) {
    const deptDaily = dept.quota && num(dept.quota.dailyTokens) ? num(dept.quota.dailyTokens) : 0;
    if (deptDaily > 0) {
      const remaining = deptDaily - deptUsage.dayTokens;
      if (remaining <= 0 || cost > remaining) {
        violations.push({
          dimension: 'deptDailyTokens', scope: 'department',
          limit: deptDaily, used: deptUsage.dayTokens,
          message: `部门每日 Token 池已用尽（${deptUsage.dayTokens.toLocaleString()}/${deptDaily.toLocaleString()}）`,
        });
      }
    }

    const deptMonthly = dept.quota && num(dept.quota.monthlyTokens) ? num(dept.quota.monthlyTokens) : 0;
    if (deptMonthly > 0) {
      const remaining = deptMonthly - deptUsage.monthTokens;
      if (remaining <= 0 || cost > remaining) {
        violations.push({
          dimension: 'deptMonthlyTokens', scope: 'department',
          limit: deptMonthly, used: deptUsage.monthTokens,
          message: `部门每月 Token 池已用尽（${deptUsage.monthTokens.toLocaleString()}/${deptMonthly.toLocaleString()}）`,
        });
      }
    }
  }

  if (violations.length) {
    return {
      allowed: false,
      reason: violations[0].message,
      dimension: violations[0].dimension,
      scope: violations[0].scope,
      violations,
      effective,
    };
  }
  return { allowed: true, violations: [], effective };
}

/** 放行后登记：占一个 RPM 名额和一个并发位 */
function acquire(employee) {
  const key = 'emp:' + employee.id;
  store.hitRpm(key);
  store.enterInflight(key);
}

/** 请求结束归还并发位 */
function release(employee) {
  store.leaveInflight('emp:' + employee.id);
}

/**
 * 给管理台用的完整快照：生效配额 + 当前用量 + 百分比
 */
function snapshot(employee, dept) {
  const effective = resolveQuota(employee, dept);
  const empUsage = store.getEmpUsage(employee.id);
  const deptUsage = dept ? store.getDeptUsage(dept.id) : null;

  const build = (field, used) => {
    const v = effective.fields[field].value;
    return {
      field,
      label: FIELD_LABEL[field],
      limit: v,
      limitText: limitText(v),
      unlimited: v === 0,
      used,
      percent: v > 0 ? Math.min(100, Math.round((used / v) * 1000) / 10) : 0,
      source: effective.fields[field].source,
      sourceText: SCOPE_LABEL[effective.fields[field].source],
    };
  };

  const fields = {
    dailyTokens: build('dailyTokens', empUsage.dayTokens),
    monthlyTokens: build('monthlyTokens', empUsage.monthTokens),
    rpm: build('rpm', store.peekRpm('emp:' + employee.id)),
    concurrency: build('concurrency', store.getInflight('emp:' + employee.id)),
  };

  return {
    employeeId: employee.id,
    employeeName: employee.name,
    deptId: dept ? dept.id : null,
    deptName: dept ? dept.name : '（未分配部门）',
    hasOverride: effective.hasOverride,
    overrideActive: effective.overrideActive,
    overrideExpired: effective.overrideExpired,
    overrideNote: effective.overrideNote,
    expiresAt: effective.expiresAt,
    countAgainstDept: effective.countAgainstDept,
    fields,
    usage: empUsage,
    deptUsage,
    // 部门池消耗情况（用于展示"部门剩余"）
    deptPool: dept ? {
      name: dept.name,
      dailyTokens: dept.quota ? num(dept.quota.dailyTokens) || 0 : 0,
      monthlyTokens: dept.quota ? num(dept.quota.monthlyTokens) || 0 : 0,
      dayUsed: deptUsage.dayTokens,
      monthUsed: deptUsage.monthTokens,
    } : null,
  };
}

module.exports = { resolveQuota, checkQuota, acquire, release, snapshot, QUOTA_FIELDS, FIELD_LABEL, limitText, num };

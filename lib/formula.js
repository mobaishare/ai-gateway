'use strict';

/**
 * 安全公式求值器（不依赖 eval / Function）
 *
 * 用途：给「模型单价」做 DIY 计费。用户可以为单个模型写一条算式，
 * 例如 `base * 1.2 + 0.001`、`prompt * 0.000002 + completion * 0.000008`。
 *
 * 支持：
 *   - 数字（含小数）、变量名
 *   - + - * / 与括号、一元正负号
 *   - 不做幂运算、不调用函数、不能访问任何全局对象
 *
 * 语法错误在保存时就会被 compile() 拦下，不会出现「配了公式但算不出成本」。
 */

const TOKEN_RE = /^[0-9]*\.?[0-9]+/;

function tokenize(src) {
  const out = [];
  const text = String(src || '');
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = TOKEN_RE.exec(text.slice(i));
      if (!m) return { error: `第 ${i + 1} 个字符处数字格式有误` };
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
      out.push({ t: 'var', v: m[0] });
      i += m[0].length;
      continue;
    }
    if ('+-*/()'.includes(c)) {
      out.push({ t: c });
      i++;
      continue;
    }
    return { error: `不支持的字符「${c}」（只支持 + - * / 和括号）` };
  }
  return { tokens: out };
}

function parse(tokens) {
  let p = 0;
  const peek = () => tokens[p];

  function expr() {
    let node = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = tokens[p++].t;
      node = { op, a: node, b: term() };
    }
    return node;
  }

  function term() {
    let node = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = tokens[p++].t;
      node = { op, a: node, b: unary() };
    }
    return node;
  }

  function unary() {
    if (peek() && (peek().t === '-' || peek().t === '+')) {
      const op = tokens[p++].t;
      const node = unary();
      return op === '-' ? { op: 'neg', a: node } : node;
    }
    return primary();
  }

  function primary() {
    const tk = tokens[p];
    if (!tk) throw new Error('表达式不完整');
    if (tk.t === 'num') { p++; return { num: tk.v }; }
    if (tk.t === 'var') { p++; return { name: tk.v }; }
    if (tk.t === '(') {
      p++;
      const node = expr();
      if (!peek() || peek().t !== ')') throw new Error('缺少右括号');
      p++;
      return node;
    }
    throw new Error(`意外的符号「${tk.t}」`);
  }

  const node = expr();
  if (p < tokens.length) throw new Error(`多余的符号「${tokens[p].t}」`);
  return node;
}

function evalNode(node, vars, used) {
  if (node.num !== undefined) return node.num;
  if (node.name !== undefined) {
    used.add(node.name);
    const v = vars[node.name];
    return Number.isFinite(v) ? v : 0;
  }
  if (node.op === 'neg') return -evalNode(node.a, vars, used);
  const a = evalNode(node.a, vars, used);
  const b = evalNode(node.b, vars, used);
  switch (node.op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b === 0 ? 0 : a / b;
    default: return 0;
  }
}

/**
 * 编译公式，语法错误立即返回
 * @param {string} src
 * @returns {{ok:boolean, error?:string, vars?:string[], evaluate?:(vars:object)=>number}}
 */
function compile(src) {
  const text = String(src || '').trim();
  if (!text) return { ok: false, error: '公式为空' };
  const tk = tokenize(text);
  if (tk.error) return { ok: false, error: tk.error };
  let ast;
  try {
    ast = parse(tk.tokens);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const vars = new Set();
  try {
    evalNode(ast, {}, vars);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return {
    ok: true,
    vars: [...vars],
    evaluate(values) {
      const used = new Set();
      const n = evalNode(ast, values || {}, used);
      return Number.isFinite(n) ? n : 0;
    },
  };
}

/** 一次性求值；出错返回 null */
function evalFormula(src, vars) {
  const c = compile(src);
  if (!c.ok) return { ok: false, error: c.error, value: null, vars: [] };
  return { ok: true, error: '', value: c.evaluate(vars || {}), vars: c.vars };
}

module.exports = { compile, evalFormula };

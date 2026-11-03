#!/usr/bin/env node
'use strict';

/**
 * 文档一致性检查
 *
 * 项目规则：任何功能改动都要同步手册（见 docs/README.md）。人工检查容易漏，
 * 这里把三件能自动判断的事固化成 CI 检查：
 *
 *   1. 每份手册头部的「适用版本」必须等于 package.json 的 version
 *   2. README 里写的「当前版本」必须等于 package.json 的 version
 *   3. 文档里的相对链接（xxx.md / xxx.yml）必须真实存在
 *   4. public/app.js 的 APP_VERSION 必须等于 package.json 的 version
 *      （前端靠它和 /healthz 对比，判断服务端是不是还在跑旧代码）
 *
 * 用法：node scripts/check-docs.js   失败退出码 1
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const errors = [];
const checked = [];

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/** 收集需要检查的 Markdown 文件 */
function mdFiles() {
  const list = [path.join(ROOT, 'README.md')];
  const docsDir = path.join(ROOT, 'docs');
  if (fs.existsSync(docsDir)) {
    for (const f of fs.readdirSync(docsDir)) {
      if (f.endsWith('.md')) list.push(path.join(docsDir, f));
    }
  }
  return list;
}

// —— 1 / 2. 版本号一致
const files = mdFiles();
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const name = rel(file);
  checked.push(name);

  if (name === 'README.md') {
    const m = text.match(/当前版本\s*\*\*(v[\d.]+)\*\*/);
    if (!m) errors.push(`${name}: 找不到「当前版本 **vX.Y.Z**」标记`);
    else if (m[1] !== 'v' + VERSION) errors.push(`${name}: 当前版本写的是 ${m[1]}，package.json 是 v${VERSION}`);
    continue;
  }

  // docs/*.md：要求有「适用版本」并且与 package.json 一致
  const m = text.match(/适用版本[：:]\s*\*{0,2}(v[\d.]+)\*{0,2}/);
  if (!m) {
    errors.push(`${name}: 缺少「适用版本：v${VERSION}」声明`);
  } else if (m[1] !== 'v' + VERSION) {
    errors.push(`${name}: 适用版本写的是 ${m[1]}，package.json 是 v${VERSION}`);
  }

  // —— 3. 相对链接存在性
  const linkRe = /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
  let lm;
  while ((lm = linkRe.exec(text))) {
    const target = lm[1].split('#')[0];
    if (!target) continue;
    const abs = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(abs)) errors.push(`${name}: 链接目标不存在 → ${target}`);
  }
}

// —— 4. 前端版本号与 package.json 一致
const appJsPath = path.join(ROOT, 'public', 'app.js');
if (fs.existsSync(appJsPath)) {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const am = appJs.match(/const APP_VERSION = '([\d.]+)';/);
  if (!am) errors.push('public/app.js: 找不到 `const APP_VERSION = \'x.y.z\';`');
  else if (am[1] !== VERSION) errors.push(`public/app.js: APP_VERSION 是 ${am[1]}，package.json 是 ${VERSION}`);
}

// —— 附加：文档里不该出现「项测试」以外的过时测试数量（常见笔误如 39 项）
const STALE_COUNTS = [/39\s*项测试/, /覆盖\s*39\s*项/];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  for (const re of STALE_COUNTS) {
    if (re.test(text)) errors.push(`${rel(file)}: 出现过时的测试数量（${re}），请同步为当前值`);
  }
}

if (errors.length) {
  console.error('✗ 文档检查未通过：\n');
  for (const e of errors) console.error('  - ' + e);
  console.error(`\n共 ${errors.length} 处问题。规则见 docs/README.md「改代码必须同步文档」。`);
  process.exit(1);
}

console.log(`✓ 文档检查通过（${checked.length} 份，版本 v${VERSION}，链接完整）`);

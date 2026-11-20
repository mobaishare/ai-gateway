'use strict';

/**
 * 轻量 .env 加载器（v1.7.4 起）
 *
 * 目的：改完项目根目录的 .env 后直接 `npm start` 即可，不必手动 export 一堆环境变量。
 * 刻意不引入 dotenv 等依赖——本项目只有 mysql2 一个 npm 依赖，能自己解析就不加包。
 *
 * 规则：
 *   - 文件位置固定为项目根目录（lib/ 的上一级）的 .env
 *   - 只填入 process.env 中「尚不存在」的变量：命令行/系统环境变量优先级更高，
 *     这样 CI 与测试可以用环境变量覆盖文件里的值
 *   - 支持 # 整行注释、可选 export 前缀、KEY=VALUE、单/双引号（去掉成对引号、
 *     还原 \n \r \t）、行尾注释（前面有空白的 #）
 *   - 文件不存在或读失败时静默跳过（没有 .env 时仍可用环境变量启动）
 */

const fs = require('fs');
const path = require('path');

let loaded = false;

function parseLine(line) {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  if (s.startsWith('export ')) s = s.slice(7).trim();
  const eq = s.indexOf('=');
  if (eq <= 0) return null;

  const key = s.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let val = s.slice(eq + 1).trim();
  // 成对引号：去掉引号并还原常见转义；行尾注释只在引号外才算
  if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
    const quote = val[0];
    val = val.slice(1, -1);
    if (quote === '"') {
      val = val.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    }
  } else {
    // 未加引号时，空白 + # 之后视为注释
    const hash = val.search(/\s+#/);
    if (hash >= 0) val = val.slice(0, hash).trim();
  }
  return [key, val];
}

function load() {
  if (loaded) return;
  loaded = true;

  const file = path.join(__dirname, '..', '.env');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return; // 没有 .env 是正常的：完全用环境变量启动
  }

  for (const line of text.split(/\r?\n/)) {
    const pair = parseLine(line);
    if (!pair) continue;
    const [key, val] = pair;
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

module.exports = { load, parseLine };

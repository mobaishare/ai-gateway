# API 参考

> 适用版本：**v1.6.4**。管理接口用于二次开发/批量运维，网关接口给员工程序调用。
>
> 手册索引见 [docs/README](README.md)。

---

## 1. 通用约定

### 1.1 地址与鉴权

| 分组 | 前缀 | 鉴权 |
| --- | --- | --- |
| 管理 API | `/api/*` | `Authorization: Bearer <登录令牌>`（登录后 12 小时有效） |
| 网关 API | `/v1/*` | `Authorization: Bearer <员工虚拟 Key，sk-ai- 开头>` |
| 健康检查 | `/healthz` | 无 |

令牌不是 JWT，形如 `<base64url(user|exp)>.<hmac>`，服务重启后依然有效（密钥存在 `db.json` 的 `settings.secret`），改密码不会让旧令牌立即失效——需要强制下线请换 `settings.secret`。

### 1.2 响应与错误

成功统一返回 JSON；出错统一为：

```json
{ "error": { "message": "人话原因", "code": "可选机器码", "...": "可选上下文" } }
```

| HTTP | 含义 |
| --- | --- |
| 200 | 成功（部分「业务失败」也是 200，看 `ok` 字段，如连通测试、Webhook 测试） |
| 400 | 参数错误 |
| 401 | 未登录 / 登录过期 / Key 无效 |
| 403 | 账号停用、部门停用、模型越权 |
| 404 | 资源或接口不存在 |
| 413 | 请求体过大 |
| 429 | 配额超限 |
| 500 / 502 / 503 | 服务端异常 / 上游全部失败 / 无可用渠道 |

### 1.3 快速拿令牌

```bash
TOKEN=$(curl -s -X POST localhost:8787/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")
```

---

## 2. 管理 API

### 2.1 登录与自身

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | `{username,password}` → `{token,user}` |
| GET | `/api/me` | 当前登录用户 |

### 2.2 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/overview` | 今日/本月用量与成本、部门排行、员工 Top、7 日趋势、预警、`nowPeak` / `nowIdle` / `hasIdlePricing`、`settings.platformName` |

返回结构（节选）：

```json
{
  "today": { "date": "2026-11-03", "tokens": 1234567, "reqs": 88, "cost": 1.2345 },
  "month": { "month": "2026-11", "tokens": 9876543, "reqs": 700, "cost": 12.34 },
  "counts": { "employees": 7, "activeEmployees": 7, "overrides": 2, "providers": 3, "activeProviders": 1 },
  "trend": [ { "date": "2026-10-28", "tokens": 0, "reqs": 0 } ],
  "deptRank": [ { "name": "研发部", "dayTokens": 0, "dailyLimit": 5000000, "percentDaily": 0, "dayCost": 0 } ],
  "empRank": [ { "name": "李娜", "deptName": "研发部", "limitText": "500万", "percent": 3, "dayTokens": 1, "dayCost": 0, "monthTokens": 1, "hasOverride": true, "countAgainstDept": true } ],
  "modelRank": [ { "model": "gpt-4o-mini", "reqs": 10, "tokens": 3000, "cost": 0.01 } ],
  "warnings": [ { "type": "employee", "name": "李娜", "deptName": "研发部", "percent": 82, "level": "warn" } ],
  "nowPeak": false, "nowIdle": true, "hasIdlePricing": true
}
```

### 2.3 部门

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/departments` | 部门列表（含人数、今日用量、百分比） |
| POST | `/api/departments` | 新建 |
| PUT | `/api/departments/:id` | 编辑（与现有值合并，可只传变更字段） |
| DELETE | `/api/departments/:id` | 删除；部门下还有员工时拒绝 |
| POST | `/api/departments/:id/test-alert` | 用该部门**解析后的真实通道**发一条测试消息 → `{ok,message,type?}` |

请求体：

```json
{
  "name": "研发部",
  "remark": "",
  "quota": { "dailyTokens": 5000000, "monthlyTokens": 100000000, "rpm": 600, "concurrency": 50 },
  "allowedModels": ["gpt-4o-mini", "deepseek*"],
  "providerIds": ["prov_xxx"],
  "status": "active",
  "alert": {
    "enabled": true,
    "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "thresholds": [80, 95, 100],
    "dimensions": ["dailyTokens", "monthlyTokens"]
  }
}
```

- `quota` 各字段 `0` 或省略 = 不限制；`allowedModels` 空数组 = 不限制，支持 `xxx*` 通配。
- `providerIds` 空数组 = 使用全部启用渠道。
- `alert` 可整体省略，省略即「不单独配置」：告警回落到全局设置。
  - `enabled:false`、`webhookUrl` 非 `http(s)://`、`thresholds` / `dimensions` 为空数组，都表示该项向上一级继承（详见 [告警与运维手册 §1.2](告警与运维手册.md)）。
  - `thresholds` 取 1–100 的整数，升序去重；`dimensions` 可选 `dailyTokens`、`monthlyTokens`。
  - `test-alert` 支持 `{webhookUrl?}` 临时覆盖地址，用于「先测再存」。

### 2.4 员工

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/employees` | 列表，每项带 `quotaSnapshot`（生效额度明细）与明文 `key` |
| POST | `/api/employees` | 新建（自动签发 Key） |
| PUT | `/api/employees/:id` | 编辑（**不能改 Key**） |
| DELETE | `/api/employees/:id` | 删除 |
| GET | `/api/employees/:id/quota` | 生效额度快照 |
| POST | `/api/employees/:id/rotate` | 重置虚拟 Key → `{key}` |
| POST | `/api/employees/:id/reset-usage` | 只清该员工的日/月用量，不动部门池 |
| POST | `/api/employees/:id/test-alert` | 用该员工**解析后的真实通道**（员工 → 部门 → 全局）发测试消息 |

请求体：

```json
{
  "name": "李娜",
  "email": "lina@corp.com",
  "deptId": "dept_xxx",
  "status": "active",
  "override": {
    "enabled": true,
    "dailyTokens": 8000000,
    "monthlyTokens": null,
    "rpm": 300,
    "concurrency": null,
    "countAgainstDept": false,
    "allowedModels": ["gpt-4o-mini"],
    "expiresAt": "2026-12-31T23:59:59.000Z",
    "note": "大促值班临时提额"
  },
  "alert": {
    "enabled": true,
    "webhookUrl": "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx",
    "thresholds": [95],
    "dimensions": ["monthlyTokens"]
  }
}
```

- `override` 各数值字段 `null` = 继承部门；数字（含 `0`）= 覆盖，`0` 表示不限制。
- `allowedModels`：`null` = 继承部门；数组 = 特例生效期间整体覆盖部门白名单。
- `override.enabled=false` 时所有特例都不生效。
- `alert` 结构同部门；员工级未配的项回落到**所属部门**，部门也未配则回落全局。

### 2.5 上游渠道

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/providers` | 列表，`apiKey` 已打码（`sk-abc••••••wxyz`），另给 `hasKey` |
| POST | `/api/providers` | 新建 |
| PUT | `/api/providers/:id` | 编辑；`apiKey` 留空或含 `••••` 时不覆盖原值 |
| DELETE | `/api/providers/:id` | 删除 |
| POST | `/api/providers/:id/probe` | 连通测试 → `{ok, message, latencyMs, ...}`（业务失败也是 200） |

请求体：

```json
{
  "name": "OpenAI 官方",
  "baseUrl": "https://api.openai.com",
  "apiKey": "sk-real-xxx",
  "models": ["gpt-4o", "gpt-4o-mini"],
  "weight": 3,
  "timeoutMs": 120000,
  "status": "active",
  "remark": ""
}
```

`models` 支持 `["*"]` 或逗号字符串；`weight` 最低 1；`timeoutMs` 最低 1000。

### 2.6 调用日志

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/logs` | 最近明细，倒序；返回**摘要**，正文不含 |
| GET | `/api/logs/:id` | 单条详情：摘要 + `log`（输入输出正文）+ `attempts`（渠道尝试链）；不存在或被裁剪返回 404 |

`GET /api/logs` 查询参数：

| 参数 | 说明 |
| --- | --- |
| `limit` | 条数，默认 100，上限 500 |
| `employeeId` / `deptId` | 按员工 / 部门过滤 |
| `status` | `ok` / `rejected` / `error` |
| `model` | 精确匹配模型名 |
| `q` | 关键词，只搜**员工名 / 模型 / 错误信息 / 最后一次 user 提问**（不扫全文，避免大库变慢） |

响应：

```json
{
  "items": [
    {
      "id": "u_xxx", "ts": "2026-11-03T03:00:00.000Z",
      "employeeId": "emp_xxx", "deptId": "dept_xxx", "employeeName": "李娜", "deptName": "研发部",
      "model": "deepseek-flash", "providerId": "prov_xxx", "providerName": "DeepSeek 官方",
      "promptTokens": 111, "completionTokens": 222, "cacheTokens": 5, "cacheWriteTokens": 0,
      "totalTokens": 333, "cost": 0.0012,
      "costDetail": { "base": 0.0012, "formula": null, "perCall": 0, "multiplier": 1,
                      "prices": { "in": 2, "out": 8, "cacheIn": 0.04 }, "tokens": { "hit": 5, "write": 0, "miss": 106 } },
      "latencyMs": 320, "status": "ok", "error": "", "source": "api", "countDept": true,
      "usageSource": "upstream", "upstreamModel": "deepseek-chat",
      "hasContent": true, "contentChars": 268,
      "preview": "帮我总结一下这份周报"
    }
  ],
  "total": 128, "logContent": "summary"
}
```

- `providerName` 为「内置模拟」表示走的是模拟响应。
- `usageSource`：`upstream`（上游返回的 usage）或 `estimated`（缺失时本地估算）；`upstreamModel` 是上游实际返回的模型名（可能与请求的不同，比如渠道做了别名映射）。
- `hasContent` / `contentChars` / `preview`：正文是否存在、总字符数、最后一条 user 消息前 80 字。列表页靠它显示摘要，不拉正文。
- `costDetail`：成本拆解（`base` token 费用、`formula` 公式结果、`perCall`、`multiplier`、`period` 命中的自定义时段、`tiers` / `idle` 命中情况、本次生效单价与 token 构成）；未定价模型为 `null`。
- `logContent` 回显当前留存策略：`off` / `summary` / `full`。

`GET /api/logs/:id` 在上面的字段之外多两块：

```json
{
  "log": {
    "request": {
      "messages": [ { "role": "system", "content": "你是…" }, { "role": "user", "content": "帮我总结一下这份周报" } ],
      "params": { "stream": false, "temperature": 0.3, "max_tokens": 1024, "tools": 0, "response_format": "text", "n": 1, "top_p": 1 },
      "truncated": false, "chars": 268
    },
    "response": { "content": "本周完成…", "finishReason": "stop", "truncated": false, "chars": 412 },
    "attempts": [ { "providerId": "prov_a", "ok": false, "status": 502, "error": "上游返回 502", "latencyMs": 1180 },
                  { "providerId": "prov_b", "ok": true, "status": 200, "latencyMs": 320 } ]
  }
}
```

顶层还会再给一份 `attempts`（与 `log.attempts` 内容相同），方便不判断 `log` 是否存在就直接遍历。

- `log` 为 `null` 表示该条没有留存正文（策略 `off`，或记录产生于开启之前）。
- 正文已按 `settings.logContentMax` 截断（超长时**保留最近的对话**，`truncated: true`）；首条 system 被挤掉时会补一条 ≤400 字摘要。
- 正文里的 `sk-…`、`Bearer …`、URL 上的 `?key=` / `api_key=` / `token=` 已替换为 `sk-xx***` 之类的打码形式——**接口不会返回原始密钥**。
- `attempts` 是选渠道的完整链路，失败渠道也保留，便于定位「为什么慢 / 为什么 502」。

### 2.7 模型单价

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pricing` | `{items, peak, nowPeak, nowIdle, hasIdlePricing, presets}` |
| PUT | `/api/pricing` | **整体替换**单价表（传 `{pricing: {...}}`，未传的模型会被删除） |
| POST | `/api/pricing/presets` | 载入内置参考价 |
| POST | `/api/pricing/test` | 试算：不落库、不记账，返回成本拆解 |

`PUT /api/pricing` 请求体：

```json
{
  "pricing": {
    "deepseek-flash": { "in": 2, "out": 8, "cacheIn": 0.04, "idle": { "in": 1, "out": 4, "cacheIn": 0.02 } },
    "claude-sonnet-5-5": { "in": 14.4, "out": 72, "cacheIn": 0.72, "cacheWrite": 18 },
    "qwen3.7-plus": { "in": 2, "out": 8, "tiers": [ { "upTo": 262144, "in": 2, "out": 8 }, { "upTo": 1048576, "in": 6, "out": 24 } ] },
    "gpt-image-2": { "in": 18, "out": 72, "perCall": 0.35, "note": "按张计费" },
    "reseller-gpt-4o": { "in": 1.08, "out": 4.32, "multiplier": 1.2, "note": "代理商加价 20%" },
    "legacy-ocr": { "in": 0, "out": 0, "formula": "prompt * 0.000002 + calls * 0.05" },
    "deepseek-flash-custom": {
      "in": 1, "out": 4,
      "periods": [
        { "name": "高峰", "days": [1,2,3,4,5], "windows": [["09:00","12:00"],["14:00","18:00"]], "in": 2, "out": 8 },
        { "name": "夜间", "windows": [["23:00","07:00"]], "in": 0.5, "out": 2 },
        { "name": "双十一", "dates": ["2026-11-11"], "in": 0.3, "out": 1.2 }
      ]
    }
  }
}
```

字段含义见 [计费与成本核算 §2](计费与成本核算.md#2-定价数据结构)。**这是整体替换语义**，只想改一个模型时请先 GET 再改再 PUT（管理台界面就是这么做的）。

- `in` / `out` 缺失按 0；负数一律夹到 0。
- `perCall`（元/次）、`multiplier`（倍率）：负数返回 **400**。
- `formula`：保存前用 `lib/formula.js` 预编译校验，语法错返回 **400**，`error.message` 形如 `公式有误：第 3 个字符「*」不是有效运算符`。
- `note`：纯展示字段，不参与计算。
- `idle` 里全是空值时该字段被丢弃（等于不分时）；`tiers` 里 `upTo<=0` 的行被忽略，并按 `upTo` 升序重排。
- `periods`（模型自定义时段，口径见 [计费与成本核算](计费与成本核算.md) §3.6）：可简写，保存后统一归一化——
  - `days`：`"1-5"` 或 `[1,2,3,4,5]`；缺省 = 每天。
  - `windows`：`"09:00-12:00, 14:00-18:00"` 或 `[["09:00","12:00"]]`；支持跨零点，`24:00` 表示到当天结束。
  - `dates`：`["YYYY-MM-DD"]`，该段当天整日生效（**优先于按星期的段**）。
  - 每段 `windows` 与 `dates` 至少要有一个，否则 **400**；时间写法非法（如 `"9-12"`）也 **400**。
  - 配了 `periods` 的模型不再参考 `settings.peak` 与 `idle`；同一模型上 `tiers` 仍优先于时段。

`POST /api/pricing/test` 请求体：

```json
{ "model": "legacy-ocr", "pricing": { "in": 10, "out": 40, "formula": "base * 2 + 0.001", "perCall": 0.002, "multiplier": 2 },
  "prompt": 1000, "completion": 500, "cacheHit": 0, "cacheWrite": 0, "at": "2026-11-03T10:00:00+08:00" }
```

- `pricing` 省略时用 `db.pricing[model]` 里已保存的配置；传了就用**传的这份**（管理台正是用未保存的表单值试算）。
- `at` 省略 = 现在，用来验证分时 / 分档 / **自定义时段**是否按预期命中。
- 返回：

```json
{
  "ok": true, "model": "legacy-ocr",
  "detail": { "priced": true, "base": 0.03, "formula": 0.061, "formulaError": null,
              "perCall": 0.002, "multiplier": 2, "total": 0.126,
              "idle": false, "period": { "index": 0, "name": "高峰" }, "tierUpTo": 0,
              "prices": { "in": 10, "out": 40, "cacheIn": 10, "cacheWrite": 10 },
              "tokens": { "hit": 0, "write": 0, "miss": 1000, "completion": 500 } },
  "nowPeak": true, "nowIdle": false
}
```

`detail.period` 为 `null` 表示该时刻不在任何自定义时段内（按基础价计）。

模型既没保存过定价、请求里也没传 `pricing` 时返回 **400**（「该模型还没有定价…」）。

`POST /api/pricing/presets` 请求体：

```json
{ "providers": ["deepseek", "openai"], "overwrite": true }
```

- `providers` 省略 = 全部厂商；可选值：`deepseek` `openai` `anthropic` `google` `qwen` `kimi` `doubao` `zhipu`。
- `overwrite: false` = 只补未定价模型，不动已有价。
- 返回 `{ok, added, updated, total, updatedAt}`。

### 2.8 设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 全部设置（剔除 `adminPassHash`、`secret`） |
| PUT | `/api/settings` | 局部更新 |
| POST | `/api/settings/test-webhook` | `{webhookUrl?}` → `{ok,message,type}` |
| POST | `/api/settings/password` | `{oldPassword,newPassword}`，新密码 ≥ 6 位 |

`PUT /api/settings` 可改字段：

```json
{
  "platformName": "AI API 分流平台",
  "onExceed": "block",
  "mockWhenNoProvider": true,
  "webhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
  "alertsEnabled": true,
  "alertThresholds": [80, 100],
  "alertDimensions": ["dailyTokens", "monthlyTokens"],
  "logContent": "summary",
  "logContentMax": 2000,
  "streamUsage": true,
  "peak": {
    "enabled": false,
    "days": [1, 2, 3, 4, 5],
    "windows": [["09:00", "12:00"], ["14:00", "18:00"]],
    "holidays": ["2026-10-01"]
  }
}
```

- `onExceed`：`block`（429）| `downgrade`（预留）。
- `webhookUrl` / `alertsEnabled`：**全局默认**告警通道与总开关；部门、员工没单独配置时用它。
- `alertThresholds`：全局默认阈值，1–100 的整数，升序去重；传空数组会被忽略（保留原值）。
- `alertDimensions`：全局默认监控维度，取值 `dailyTokens` / `monthlyTokens`；传空数组同样忽略。
- `logContent`：调用日志正文留存策略，`off` / `summary` / `full`，默认 `summary`；非这三个值会被忽略。
- `logContentMax`：摘要模式的最大字符数，**200–20000** 夹取，非数字按 2000。
- `streamUsage`：流式请求是否自动补 `stream_options.include_usage`（默认 `true`）。开启后上游会在流末尾返回真实 `usage`，日志的 `usageSource` 为 `upstream`；关闭则多半只能按文本估算（`estimated`）。遇到 400 且错误信息提到 `stream_options` 时，网关会自动用客户端原始请求重试一次。
- `peak`：**全局高峰规则，默认 `enabled: false`**。分时计价默认由每个模型的 `pricing[model].periods` 决定（见 2.7），这里只在「模型填了 `idle`、没配 `periods`」时才有意义；`days` 用 0–6（0=周日），`windows` 最多两项且支持跨零点，`holidays` 为 `YYYY-MM-DD`。
- 只传 `{peak: {enabled: true}}` 这类局部字段时，其余字段保持原值。
- `maxBodyBytes` 不在可改字段内，需改 `db.json`。

### 2.9 插件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugins` | 插件列表（`fields`、`config`、上次同步结果） |
| PUT | `/api/plugins/:id/config` | 保存配置 `{config:{...}}` |
| POST | `/api/plugins/:id/test` | 连接测试 `{config?}` → `{ok,message,...}` |
| POST | `/api/plugins/:id/sync` | 拉取并合并 `{config?}`；失败返回 400 |

### 2.10 告警记录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/alerts` | 最近告警发送记录（倒序），`?limit=50`（默认 50，内部最多保留 200 条） |

```json
{
  "items": [
    { "id": "al_xxx", "ts": "2026-11-03T07:12:00.000Z", "target": "employee",
      "targetId": "emp_xxx", "targetName": "李娜", "deptName": "研发部",
      "dimension": "dailyTokens", "threshold": 80, "percent": 82.3,
      "used": 4115000, "limit": 5000000, "channel": "department",
      "ok": true, "message": "已发送", "text": "【AI 网关】个人额度预警…", "test": false }
  ],
  "total": 20, "okCount": 19, "failCount": 1,
  "routes": {
    "departments": [ { "id": "dept_xxx", "name": "研发部", "url": "https://open.feishu.cn/…" } ],
    "employees": []
  }
}
```

- `target`：`employee` / `department` / `global`（系统设置里点「发送测试消息」时记一条 `target=global`、`targetName=全局默认` 的记录）；`channel`：`employee` / `department` / `global`，即这条实际走的是哪一级通道。
- `test:true` 表示由「发送测试消息」触发（`threshold` 为 0、`percent` 为 0）。
- `routes` 只列**已单独配置**告警的对象及其域名（Webhook 已打码为 `域名/…`），供设置页展示「谁有自己的通道」。
- 记录最多保留 200 条（`ALERT_LOG_LIMIT`），随 `db.json` 落盘。

### 2.11 数据管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/reset-data` | 清空部门/员工/日志/统计/告警记录，保留渠道与单价、设置、插件配置；先自动备份 |
| GET | `/api/export` | 导出脱敏配置（不含密钥/密码） |

---

## 3. 网关 API

### 3.1 对话补全

`POST /v1/chat/completions`，OpenAI 兼容，额外支持 `stream: true`（SSE 原样透传）。

请求：

```json
{
  "model": "deepseek-flash",
  "messages": [ { "role": "user", "content": "你好" } ],
  "stream": false
}
```

处理顺序（任一不通过即返回）：

```
1. 鉴权（401 missing_key / invalid_key）
2. 员工/部门状态（403 account_disabled / dept_disabled）
3. 模型权限（403 model_not_allowed）
4. 配额：并发 → RPM → 员工日 → 员工月 → 部门日 → 部门月（429）
5. 选渠道（权重随机）→ 失败切下一个 → 全失败 502 / 无渠道 503
6. 记账（token + 成本）+ 告警检查
```

成功响应即上游原始响应（用量在 `usage` 里）。429 响应示例：

```json
{
  "error": {
    "message": "员工每日 Token 额度已用尽（200,000/200,000）",
    "type": "quota_exceeded",
    "code": "quota_exceeded",
    "dimension": "dailyTokens",
    "scope": "employee",
    "detail": [ { "dimension": "dailyTokens", "scope": "employee", "limit": 200000, "used": 200000 } ]
  }
}
```

429 还会带响应头 `Retry-After: 60`、`X-RateLimit-Scope`、`X-RateLimit-Dimension`。

### 3.2 模型列表

`GET /v1/models` → 所有**启用渠道**声明的模型（去重，排除 `*`）；没有启用渠道时返回一组示例模型名。

### 3.3 健康检查

`GET /healthz`，无需鉴权：

```json
{
  "ok": true,
  "version": "1.6.1",
  "startedAt": "2026-11-03T03:58:00.000Z",
  "uptime": 123,
  "ts": "2026-11-03T04:00:03.000Z"
}
```

- `version` 取自 `package.json`，`startedAt` 是进程启动时刻。
- 管理台的静态文件是**每次请求从磁盘读**的，改完代码不重启就会出现「新界面 + 旧接口」。前端启动时会拿 `version` 和自身的 `APP_VERSION` 比对，不一致或字段缺失（旧进程）就在页面底部提示重启——排查「接口不存在」时先看这里。
- 容器/K8s 探针只需判断 HTTP 200 与 `ok`。

---

## 4. 错误码速查

| code | HTTP | 含义 |
| --- | --- | --- |
| `missing_key` | 401 | 没带 Authorization |
| `invalid_key` | 401 | Key 不存在（被重置或员工已删） |
| `account_disabled` | 403 | 员工已停用 |
| `dept_disabled` | 403 | 所属部门已停用 |
| `model_not_allowed` | 403 | 不在部门/个人模型白名单内 |
| `quota_exceeded` | 429 | 配额超限，看 `dimension` + `scope` |

配额 `dimension` 取值：`concurrency`、`rpm`、`dailyTokens`、`monthlyTokens`、`deptDailyTokens`、`deptMonthlyTokens`；`scope` 为 `employee` 或 `department`。

---

## 5. 数据结构（db.json 摘要）

```json
{
  "version": 1,
  "settings": { "platformName": "", "adminUser": "admin", "adminPassHash": "", "secret": "",
                "mockWhenNoProvider": true, "onExceed": "block", "webhookUrl": "", "alertsEnabled": true,
                "alertThresholds": [80, 100], "alertDimensions": ["dailyTokens", "monthlyTokens"],
                "logContent": "summary", "logContentMax": 2000, "streamUsage": true,
                "peak": { "enabled": false, "days": [1,2,3,4,5], "windows": [...], "holidays": [] },
                "periodsMigrated": true,
                "presetsVersion": "2026-11-03", "createdAt": "" },
  "pricing": { "模型": { "in": 0, "out": 0, "cacheIn": 0, "cacheWrite": 0, "idle": {}, "tiers": [],
                        "periods": [ { "name": "", "days": [], "windows": [], "dates": [], "in": 0, "out": 0 } ],
                        "perCall": 0, "multiplier": 1, "formula": "", "note": "" } },
  "departments": [ { "id": "", "name": "", "quota": {}, "providerIds": [], "allowedModels": [], "status": "active",
                     "alert": { "enabled": false, "webhookUrl": "", "thresholds": [], "dimensions": [] } } ],
  "employees": [ { "id": "", "name": "", "email": "", "deptId": "", "key": "sk-ai-...", "status": "active",
                   "override": { "enabled": false, "dailyTokens": null, "allowedModels": null, "countAgainstDept": true },
                   "alert": { "enabled": false, "webhookUrl": "", "thresholds": [], "dimensions": [] } } ],
  "providers": [ { "id": "", "baseUrl": "", "apiKey": "", "models": [], "weight": 1, "timeoutMs": 120000, "status": "disabled" } ],
  "plugins": { "feishu": { "config": {}, "lastSync": {} } },
  "usage": [ { "id": "", "ts": "", "employeeId": "", "model": "", "totalTokens": 0, "cost": 0, "status": "ok",
               "usageSource": "upstream", "upstreamModel": "", "costDetail": {},
               "log": { "request": { "messages": [], "params": {}, "truncated": false, "chars": 0 },
                        "response": { "content": "", "finishReason": "stop", "truncated": false, "chars": 0 },
                        "attempts": [] } } ],
  "stats": { "daily": { "2026-11-03": { "emp": {}, "dept": {}, "models": {} } },
             "alerts": { "day": "2026-11-03", "month": "2026-11", "sent": { "emp:xxx:dailyTokens:80:2026-11-03": true } },
             "alertLog": [ { "id": "", "ts": "", "target": "employee", "threshold": 80, "channel": "global", "ok": true } ] }
}
```

- `usage` 只保留最近 5000 条（`USAGE_DETAIL_LIMIT`），`stats.daily` 保留 120 天（`STATS_KEEP_DAYS`），`stats.alertLog` 保留 200 条，三者都在 `lib/store.js` 顶部。
- `usage[].log` 为 `null` 时表示该条没留正文（`settings.logContent = 'off'`，或早于开启时间）。
- 旧库无需迁移，`store.load()` 会补齐缺失字段，并清理 v1.3.0 遗留的 `settings.offPeak`。
- v1.6 首次启动会跑一次性迁移（`settings.periodsMigrated` 标记）：把 `peak.enabled` 置为 `false`，并把每个「有 `idle`、无 `periods`」的模型翻译成等价时段表（`高峰` / `空闲` / `空闲·非高峰日` / `节假日`）。迁移前后同一时刻成本一致，详见 [计费与成本核算 §4.2](计费与成本核算.md#42-从旧版升级idle-自动翻译成-periods)。

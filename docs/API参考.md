# API 参考

> 适用版本：**v1.3.3**。管理接口用于二次开发/批量运维，网关接口给员工程序调用。
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

请求体：

```json
{
  "name": "研发部",
  "remark": "",
  "quota": { "dailyTokens": 5000000, "monthlyTokens": 100000000, "rpm": 600, "concurrency": 50 },
  "allowedModels": ["gpt-4o-mini", "deepseek*"],
  "providerIds": ["prov_xxx"],
  "status": "active"
}
```

- `quota` 各字段 `0` 或省略 = 不限制；`allowedModels` 空数组 = 不限制，支持 `xxx*` 通配。
- `providerIds` 空数组 = 使用全部启用渠道。

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
  }
}
```

- `override` 各数值字段 `null` = 继承部门；数字（含 `0`）= 覆盖，`0` 表示不限制。
- `allowedModels`：`null` = 继承部门；数组 = 特例生效期间整体覆盖部门白名单。
- `override.enabled=false` 时所有特例都不生效。

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
| GET | `/api/logs` | 最近明细，倒序；`?limit=100`（上限 500）、`employeeId=`、`deptId=`、`status=ok\|rejected\|error` |

单条记录字段：

```json
{
  "id": "u_xxx", "ts": "2026-11-03T03:00:00.000Z",
  "employeeId": "emp_xxx", "deptId": "dept_xxx", "employeeName": "李娜", "deptName": "研发部",
  "model": "deepseek-flash", "providerId": "prov_xxx", "providerName": "DeepSeek 官方",
  "promptTokens": 111, "completionTokens": 222, "cacheTokens": 5, "cacheWriteTokens": 0,
  "totalTokens": 333, "cost": 0.0012,
  "latencyMs": 320, "status": "ok", "error": "", "source": "api"
}
```

`providerName` 为「内置模拟」表示走的是模拟响应。

### 2.7 模型单价

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/pricing` | `{items, peak, nowPeak, nowIdle, hasIdlePricing, presets}` |
| PUT | `/api/pricing` | **整体替换**单价表（传 `{pricing: {...}}`，未传的模型会被删除） |
| POST | `/api/pricing/presets` | 载入内置参考价 |

`PUT /api/pricing` 请求体：

```json
{
  "pricing": {
    "deepseek-flash": { "in": 2, "out": 8, "cacheIn": 0.04, "idle": { "in": 1, "out": 4, "cacheIn": 0.02 } },
    "claude-sonnet-5-5": { "in": 14.4, "out": 72, "cacheIn": 0.72, "cacheWrite": 18 },
    "qwen3.7-plus": { "in": 2, "out": 8, "tiers": [ { "upTo": 262144, "in": 2, "out": 8 }, { "upTo": 1048576, "in": 6, "out": 24 } ] }
  }
}
```

字段含义见 [计费与成本核算 §2](计费与成本核算.md#2-定价数据结构)。**这是整体替换语义**，只想改一个模型时请先 GET 再改再 PUT（管理台界面就是这么做的）。

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
  "peak": {
    "enabled": true,
    "days": [1, 2, 3, 4, 5],
    "windows": [["09:00", "12:00"], ["14:00", "18:00"]],
    "holidays": ["2026-10-01"]
  }
}
```

- `onExceed`：`block`（429）| `downgrade`（预留）。
- `peak.days` 用 0–6（0=周日），`windows` 最多两项且支持跨零点，`holidays` 为 `YYYY-MM-DD`。
- `maxBodyBytes` 不在可改字段内，需改 `db.json`。

### 2.9 插件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/plugins` | 插件列表（`fields`、`config`、上次同步结果） |
| PUT | `/api/plugins/:id/config` | 保存配置 `{config:{...}}` |
| POST | `/api/plugins/:id/test` | 连接测试 `{config?}` → `{ok,message,...}` |
| POST | `/api/plugins/:id/sync` | 拉取并合并 `{config?}`；失败返回 400 |

### 2.10 数据管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/reset-data` | 清空部门/员工/日志/统计，保留渠道与单价、设置、插件配置；先自动备份 |
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

`GET /healthz` → `{"ok":true,"uptime":123,"ts":"2026-11-03T03:00:00.000Z"}`，无需鉴权。

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
                "peak": { "enabled": true, "days": [1,2,3,4,5], "windows": [...], "holidays": [] },
                "presetsVersion": "2026-11-03", "createdAt": "" },
  "pricing": { "模型": { "in": 0, "out": 0, "cacheIn": 0, "cacheWrite": 0, "idle": {}, "tiers": [] } },
  "departments": [ { "id": "", "name": "", "quota": {}, "providerIds": [], "allowedModels": [], "status": "active" } ],
  "employees": [ { "id": "", "name": "", "email": "", "deptId": "", "key": "sk-ai-...", "status": "active",
                   "override": { "enabled": false, "dailyTokens": null, "allowedModels": null, "countAgainstDept": true } } ],
  "providers": [ { "id": "", "baseUrl": "", "apiKey": "", "models": [], "weight": 1, "timeoutMs": 120000, "status": "disabled" } ],
  "plugins": { "feishu": { "config": {}, "lastSync": {} } },
  "usage": [ { "id": "", "ts": "", "employeeId": "", "model": "", "totalTokens": 0, "cost": 0, "status": "ok" } ],
  "stats": { "daily": { "2026-11-03": { "emp": {}, "dept": {}, "models": {} } },
             "alerts": { "day": "2026-11-03", "sent": { "emp:xxx:80": true } } }
}
```

- `usage` 只保留最近 5000 条（`USAGE_DETAIL_LIMIT`），`stats.daily` 保留 120 天（`STATS_KEEP_DAYS`），两者都在 `lib/store.js` 顶部。
- 旧库无需迁移，`store.load()` 会补齐缺失字段，并清理 v1.3.0 遗留的 `settings.offPeak`。

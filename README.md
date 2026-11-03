# AI API 分流平台

![CI](https://github.com/mobaishare/ai-gateway/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A518-green.svg)

公司内部用的 AI 接口网关。**员工拿不到上游真实密钥**，每人一个平台签发的虚拟 Key，
按「部门 → 员工」两层分配用量额度，员工个人的特殊额度优先于部门默认值。

零外部依赖，`node server.js` 就能跑，数据存单个 JSON 文件，内网部署和备份都很省事。

**核心能力**：四维度配额（日/月 Token、RPM、并发）· 逐字段特例继承 ·
模型白名单（部门默认 + 个人覆盖）· **成本核算看板**（按模型单价折算 ¥，
支持**峰谷分时**（DeepSeek 官方规则：工作日高峰/节假日空闲）、**缓存命中/写入价**（OpenAI/Anthropic/Kimi，峰谷分别定价）、**按输入长度分档**（Qwen/豆包阶梯价、Gemini 长上下文）；内置 8 家厂商 37 个模型的**官方参考价**，一键载入）·
**用量告警**（80%/100% 推送飞书/企微机器人）· 加权分流 + 故障切换 · SSE 流式 ·
组织架构同步插件（飞书/企微/CSV）

---

## 先跑起来

```bash
cd ai-gateway
node server.js
```

- 管理台：<http://localhost:8787/>
- 网关地址：`http://localhost:8787/v1`
- 默认账号：`admin` / `admin123`（登录后请立刻在「系统设置」里改掉）

首次启动会自动生成一份演示数据（4 个部门、7 名员工、3 个示例渠道），
所有渠道默认停用，此时网关返回**内置模拟响应**——不用真实 Key 就能把整个配额流程跑通。

改成自定义端口：`PORT=9000 node server.js`

### Docker 部署

```bash
docker build -t ai-gateway .
docker run -d --name ai-gateway \
  -p 8787:8787 \
  -v ai-gateway-data:/app/data \
  --restart unless-stopped \
  ai-gateway
```

数据（`db.json` 与备份）全部在 `ai-gateway-data` 卷里，升级镜像不丢数据。

> 当前版本 **v1.3.4**，版本历史见 [CHANGELOG.md](CHANGELOG.md)。
>
> **文档**（全部在 [`docs/`](docs/README.md)，含文档维护规则）：
> - 📘 [操作手册](docs/操作手册.md) —— 管理员日常操作全流程、各页面字段说明、FAQ
> - 💰 [计费与成本核算](docs/计费与成本核算.md) —— 峰谷/缓存/分档计价规则、8 家厂商价格表、算例与对账
> - 🚨 [告警与运维手册](docs/告警与运维手册.md) —— 用量告警配置、部署（Docker/systemd/Nginx）、备份升级、排障
> - 🔌 [API 参考](docs/API参考.md) —— 管理 API 与网关 API、错误码、数据结构
> - 🛠 [插件开发手册](docs/插件开发手册.md) —— 接入钉钉 / LDAP / 自建 HR 系统的开发指南

---

## 额度是怎么算的（核心规则）

额度分两层，**员工特例优先于部门默认**：

```
员工的实际额度 = 特例里填了的字段 ？ 特例值 ： 部门默认值
```

具体到每个维度（每日 Token / 每月 Token / RPM / 并发数）**独立判断**，可以只覆盖其中一项：

| 特例里的填写 | 该维度的生效值 |
| --- | --- |
| 填一个数字 | 用这个数字，**压过部门**（可以比部门更大，也可以更小） |
| 留空 | 继续继承部门的值 |
| 填 `0` | 该维度不限制 |

举例：研发部日额度 500 万，给李娜开了特例只填 RPM = 300，那么她
日额度仍是 500 万（继承），RPM 变成 300（特例）。

### 特例还可以「不占部门池」

默认情况下员工的消耗会同时扣**个人额度**和**部门预算**，形成双重约束。
如果关掉「用量同时计入部门池」：

- 该员工的消耗只扣自己的额度，**不扣部门预算**
- 适合给算法组、外包团队、临时项目单独核算

### 特例可以设过期时间

填了有效期后，到期自动失效、回落到部门默认，适合「双十一期间临时提额」这种场景，
不用手动改回去。

### 判定顺序

一次请求进来，按下面的顺序检查：

```
鉴权 → 账号/部门状态 → 模型权限（403）→ 并发 → 每分钟请求
     → 员工每日 Token → 员工每月 Token → 部门每日 Token → 部门每月 Token（429）
```

被拦下的请求会写进调用日志（配额拦截为「配额拦截」，模型越权为「失败」），方便事后查是谁超了什么、用了什么不该用的模型。

---

## 员工怎么接入

把网关地址和该员工自己的 Key 发给他，兼容 OpenAI 协议，现有 SDK 只改 `base_url`：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://你的服务器:8787/v1",
    api_key="sk-ai-xxxxxxxx",   # 在「员工管理」里复制，每人一个
)

resp = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "你好"}],
)
```

支持 `stream: true` 流式输出。管理台的「接入文档」页会自动带上地址和 Key，直接复制即可。

超额时返回：

```json
{
  "error": {
    "type": "quota_exceeded",
    "message": "员工每日 Token 额度已用尽（200,000/200,000）",
    "dimension": "dailyTokens",
    "scope": "employee"
  }
}
```

`scope` 是 `employee` 说明触发的是员工特例，是 `department` 说明是部门池用完了。

---

## 接真实上游

在「上游渠道」里新增一条，填：

- **Base URL**：只填域名，如 `https://api.openai.com`（平台自动拼 `/v1/chat/completions`）
- **真实 API Key**：只存在服务端，任何接口都不会返回完整值
- **支持的模型**：逗号分隔，留空表示全部；支持前缀通配如 `gpt-4o*`
- **权重**：多个渠道时按权重加权随机分流

同一模型配多个渠道时，某个渠道失败（5xx / 超时）会自动切到下一个。

还可以给部门绑定渠道：在部门设置里勾选后，该部门的流量只在选中的渠道里分流，
用来实现「研发走内网代理、市场走官方 API」这种隔离。

---

## 模型权限（谁能用哪个模型）

和额度一样两层继承，**员工特例优先于部门白名单**：

- 部门里填「模型白名单」→ 该部门只能用这些模型，支持通配 `deepseek*`
- 员工特例里填「允许的模型」→ **整体覆盖**部门白名单（不是取交集）
- 两边都没填 → 不限制

越权调用返回 `403 model_not_allowed`，日志里写明允许列表与限制来源（个人 / 部门）。

---

## 成本核算

按模型单价（**元 / 百万 tokens**）把每次调用的 token 折算成钱，落到员工、部门、模型三个维度，
概览页直接看今日/本月成本、今日模型成本排行与占比。

计价引擎覆盖各家的真实计费模式：

| 模式 | 厂商 | 字段 |
| --- | --- | --- |
| 峰谷分时 | DeepSeek（工作日 9-12 / 14-18 高峰，其余空闲） | `idle` + 全局高峰规则 |
| 缓存命中价 | OpenAI、DeepSeek、Kimi | `cacheIn`（自动解析 `cached_tokens` / `prompt_cache_hit_tokens`） |
| 缓存写入价 | Anthropic、Kimi | `cacheWrite`（自动解析 `cache_creation_input_tokens`） |
| 输入长度分档 | 通义千问、豆包、Gemini | `tiers`（优先于分时） |
| 固定价 | 智谱等 | `in` / `out` |

内置 8 家厂商 37 个模型的**官方参考价**（2026-11-03 核对，美元按 1:7.2 折算），首次启动自动补入未定价模型，
也可在单价卡点「载入官方参考价」重载。规则、算例与对账口径见 [计费与成本核算](docs/计费与成本核算.md)。

---

## 用量告警

额度用到 **80% / 100%** 时推送到飞书或企业微信群机器人（按 Webhook 地址自动识别格式）。
每个员工/部门 × 每个阈值 × 每天只推一次，状态随统计落盘，重启不会重复；发送失败只记日志，不影响员工请求。

配置：系统设置 → 用量告警 → 粘贴 Webhook → 保存 → 「发送测试消息」。
详见 [告警与运维手册](docs/告警与运维手册.md#1-用量告警)。

---

## 组织架构同步（扩展插件）

员工不必一个个手工录。管理台「扩展插件」是一层**插件列表**，点某张卡片才进入该插件自己的功能页
（`#/plugins/feishu` 这样的地址可直接收藏或分享）。内置三个：

| 插件 | 需要什么 | 说明 |
| --- | --- | --- |
| 飞书通讯录 | 自建应用的 App ID / App Secret | 需开通「获取部门基础信息」「获取成员基础信息」权限 |
| 企业微信通讯录 | corpId / 通讯录同步 Secret | 管理后台 → 管理工具 → 通讯录同步 |
| 文本 / CSV 导入 | 无 | 粘贴 `姓名,邮箱,部门`，适合首次初始化或迁移 |

三个按钮：**保存配置**、**连接测试**（能拉到多少人/多少部门）、**立即同步**。

同步规则是幂等的，可以反复执行：

- 部门按**名称**合并，已存在不动，新部门自动创建（额度为 0，由你后续分配）
- 员工按**邮箱**匹配，其次**同名**；已有员工只更新归属部门，**不覆盖额度与密钥**
- 新员工自动签发虚拟 Key，可在「员工管理」列表里直接复制

想接钉钉、LDAP、HR 系统：在 `lib/plugins.js` 的 `REGISTRY` 里加一个对象，实现
`fetchOrg(config) → { departments: [{ name }], employees: [{ name, email, deptName }] }`
即可，配置表单和同步合并逻辑会自动生效。

---

## 清空演示数据

正式启用前想抹掉演示数据：**系统设置 → 数据管理 → 清空业务数据**。

会清空部门、员工、调用日志与统计，**保留上游渠道与模型配置、平台设置**；
清空前自动在 `data/` 下生成 `db-backup-<时间戳>.json` 完整备份。
清空后重启也不会再把演示数据灌回来（`settings.seeded` 标记已置位）。

---

## 目录结构

```
ai-gateway/
├── server.js            # HTTP 入口：管理 API + 网关路由 + 静态文件
├── lib/
│   ├── store.js         # JSON 持久化 + 用量计数器（日/月/RPM/并发）+ 计价引擎
│   ├── quota.js         # 配额与模型权限：特例解析、检查、放行、快照
│   ├── proxy.js         # 上游转发：加权分流、failover、SSE 透传、usage/缓存解析
│   ├── alerts.js        # 用量告警：飞书/企微 webhook、阈值去重
│   ├── preset-prices.js # 内置官方参考价（8 家厂商 37 个模型）
│   ├── plugins.js       # 扩展插件：飞书 / 企业微信 / CSV 通讯录同步
│   └── seed.js          # 首次启动的演示数据
├── public/              # 管理台（原生 JS，无框架、无 CDN）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── docs/                # 手册：操作 / 计费 / 告警运维 / API / 插件开发
├── test/run.js          # 端到端测试（76 项）
├── .github/workflows/ci.yml  # CI：语法检查 + 端到端测试
├── Dockerfile           # node:20-alpine + HEALTHCHECK + VOLUME /app/data
└── data/db.json         # 运行时生成，备份直接拷这个文件
```

---

## 接口一览

管理端（需要 `Authorization: Bearer <登录令牌>`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/login` | 登录换令牌（12 小时有效） |
| GET | `/api/overview` | 概览：用量、排行、趋势、预警 |
| GET/POST | `/api/departments` | 部门列表 / 新建 |
| PUT/DELETE | `/api/departments/:id` | 编辑 / 删除 |
| GET/POST | `/api/employees` | 员工列表（含生效额度快照）/ 新建 |
| PUT/DELETE | `/api/employees/:id` | 编辑 / 删除 |
| GET | `/api/employees/:id/quota` | 该员工当前的生效额度明细 |
| POST | `/api/employees/:id/rotate` | 重置虚拟密钥 |
| POST | `/api/employees/:id/reset-usage` | 只清该员工用量（不动部门池） |
| GET/POST | `/api/providers` | 渠道列表（密钥打码）/ 新建 |
| PUT/DELETE | `/api/providers/:id` | 编辑 / 删除 |
| POST | `/api/providers/:id/probe` | 连通性测试 |
| GET | `/api/logs` | 调用日志，支持 `status`/`employeeId`/`deptId`/`limit` |
| GET/PUT | `/api/pricing` | 模型单价表（含高峰规则与当前时段） |
| POST | `/api/pricing/presets` | 载入内置官方参考价（可按厂商、可只补空缺） |
| GET/PUT | `/api/settings` | 平台设置（含告警与高峰规则） |
| POST | `/api/settings/test-webhook` | 发送告警测试消息 |
| POST | `/api/settings/password` | 修改管理员密码 |
| GET | `/api/plugins` | 插件列表（含配置与上次同步结果） |
| PUT | `/api/plugins/:id/config` | 保存插件配置 |
| POST | `/api/plugins/:id/test` | 连接测试 |
| POST | `/api/plugins/:id/sync` | 拉取组织架构并合并到平台 |
| POST | `/api/reset-data` | 清空部门/员工/日志/统计（保留渠道），自动备份 |
| GET | `/api/export` | 导出脱敏配置 |

网关端（需要 `Authorization: Bearer <员工虚拟 Key>`）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/chat/completions` | 对话补全，支持流式 |
| GET | `/v1/models` | 可用模型列表 |
| GET | `/healthz` | 健康检查（无需鉴权） |

---

## 测试

```bash
node test/run.js
```

会用临时数据目录和独立端口起一个实例，跑完自动清理，不碰 `data/db.json`，
CI 每次 push 也会跑同一套。覆盖 **76 项**检查，包括：

- 员工特例优先于部门、且可以比部门更宽松
- 逐字段继承（只覆盖 RPM，其余仍继承部门）
- 独立额度确实不扣部门池
- 特例过期自动回落
- 模型白名单：部门限制、个人覆盖、通配匹配、403 `model_not_allowed`
- RPM 限流、部门池耗尽时的拦截维度与来源标注
- 真实上游转发、流式透传、usage 透传、渠道故障自动切换
- 分时定价：高峰/空闲切换、节假日、缓存命中与缓存写入计价
- 分档计价：档内命中、超档回落、分档优先于分时
- 参考价载入：只补空缺 / 按厂商覆盖
- 用量告警：阈值触发、每天只发一次、Webhook 失败不影响请求
- 无效密钥 / 停用账号的拒绝
- 拦截请求写入审计日志

---

## 部署到内网服务器

最简单的方式，用 systemd 托管：

```ini
# /etc/systemd/system/ai-gateway.service
[Unit]
Description=AI API Gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-gateway
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ai-gateway
```

前面如果再加一层 Nginx，注意关掉对 SSE 的缓冲，否则流式输出会卡住：

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;          # 关键：流式必须关
    proxy_read_timeout 300s;
}

location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
}
```

---

## 几个需要注意的点

**数据备份**：所有配置和用量都在 `data/db.json`，直接复制就是完整备份。
用量明细保留最近 5000 条，长期统计（日报/月报）存在聚合表里，保留 120 天。

**虚拟 Key 的存储**：为了管理员随时能把 Key 发给员工，Key 在服务端是明文存的
（界面上默认打码显示）。如果你们的安全要求更高，可以改成只存哈希、创建时展示一次，
代价是员工忘记 Key 只能重置。改动点在 `lib/store.js` 的 `findEmployeeByKey`。

**多实例**：当前用量计数在内存里，只适合单实例部署。
要横向扩展的话，需要把 `lib/store.js` 里的计数器换成 Redis。

**时区**：日/月的统计边界按服务器的本地时区切分，部署时确认一下机器的时区。

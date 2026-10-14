# 🤗 hf-waker (Cloudflare Workers Edition)

**全自动巡检并唤醒你的 Hugging Face Spaces，告别冷启动与 GitHub Actions 60 天停用限制！内置 Web 可视化控制台、多账号多 Space 并发管理、智能状态检测、Cloudflare KV 历史审计与 Telegram 通知。**

[![Cloudflare Workers](https://img.shields.io/badge/Deploy-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hugging Face Spaces](https://img.shields.io/badge/%F0%9F%A4%97%20Hugging%20Face-Spaces-FFD21E)](https://huggingface.co/spaces)
[![Telegram](https://img.shields.io/badge/Notify-Telegram-2CA5E0?logo=telegram&logoColor=white)](https://telegram.org)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE)

> 💡 **项目说明**：本项目借鉴自 [oversizexl/hf-waker](https://github.com/oversizexl/hf-waker)（原版基于 Python + GitHub Actions），在此基础上完全重构并迁移至 **Cloudflare Workers** 无服务器架构，新增了智能状态检测、多账号 Token 并发支持、可视化 Web 控制台以及 Cloudflare KV 历史日志审计等功能。

---

## ✨ 核心特性

| 功能模块 | 支持状态 | 详细说明 |
| :--- | :---: | :--- |
| **🧠 智能状态检测** | ✅ | 唤醒前自动查询 `runtime.stage`，**仅在休眠 (`SLEEPING` / `PAUSED`) 或报错时重启**，绝不打断正在运行 (`RUNNING`) 或构建中的任务 |
| **🖥️ Web 可视化控制台** | ✅ | 根路径 `/` 自带响应式暗色监控面板，实时展示硬件规格、运行状态，支持**单点精准唤醒 / 强制重启**与密钥本地记忆 |
| **👥 多 Token / 多账号支持** | ✅ | 支持单个或多个 Hugging Face 账号同时管理各自的多个公开/私有 Space，`Promise.all` 毫秒级并发处理 |
| **📜 KV 历史日志审计** | ✅ | 可选绑定 Cloudflare KV，在网页底部展示**最近 10 次**定时巡检与手动唤醒的时间轴明细，支持一键清空 |
| **✈️ Telegram 巡检报告** | ✅ | 详细区分 `🟢 运行中跳过`、`🔄 已唤醒` 与 `❌ 失败`，支持配置**静默免打扰模式**（全部正常运行时不打扰） |
| **♾️ 永久零维护运行** | ✅ | 基于 Cloudflare Workers 原生 `fetch` 与 Cron Triggers，网页端复制粘贴即可部署，永不因仓库无 Commit 而被暂停 |

---

## ⚠️ 风险提示与防封号指南 (必读)

本项目通过 Hugging Face 官方开放的 Hub API 进行状态查询与按需唤醒，且默认开启**“运行中跳过 (`RUNNING` Skip)”**保护机制，正常使用下非常安全。但为了保护你的 Hugging Face 账号安全，请务必遵守以下准则：

1. **严禁保活违规应用（封号头号原因）**：
   请勿将本工具用于保活违反 [Hugging Face 内容准则](https://huggingface.co/content-guidelines) 的 Space（例如：**代理/VPN 节点、加密货币挖矿、恶意爬虫、未授权商业 API 转发**等）。此类应用在 24 小时不间断运行下极易触发官方算力风控，从而导致账号被封禁。
2. **合理设置 Cron 巡检频率**：
   免费版 Hugging Face Space 默认在连续无交互 **48 小时**后才会进入 `SLEEPING` 状态。建议将 Cron 设置为**每天 1~4 次**（如 `0 */6 * * *` 或 `0 0 * * *`）即可，切勿设置成每分钟级别的高频轮询。
3. **避免滥用强制重启 (`force=true`)**：
   日常定时任务请保持默认的智能唤醒模式（仅在休眠时重启）。频繁强制重启正在运行的容器会大量消耗官方构建资源，可能触发 API 速率限制。
4. **控制单 Worker 挂载的账号数量**：
   多 Token 功能旨在方便开发者管理自己的工作号与个人号（建议控制在 2~3 个账号以内）。请勿在单个 Worker 中配置大量批量注册的小号，以免被识别为矩阵滥用（Sybil Attack）。

> **免责声明**：本项目仅供学习交流与合规 AI/Web 演示项目的自动化运维使用。因违反 Hugging Face 服务条款或不当配置导致的账号受限，需由使用者自行承担责任。

---

## 🚀 3 分钟网页端快速部署指南

无需本地配置命令行环境，直接在 Cloudflare 网页后台复制粘贴即可完成部署：

### 第一步：创建并部署 Worker
1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages**。
2. 点击 **Create application (创建应用程序)** → **Create Worker (创建 Worker)**。
3. 将名称设为 `hf-waker`，点击 **Deploy (部署)**。
4. 点击右上角 **Edit code (编辑代码)**，将本项目的 `worker.js` 代码完整粘贴进去，点击右上角 **Deploy** 保存。

### 第二步：配置环境变量 (Variables and Secrets)
进入 Worker 的 **Settings (设置) → Variables and Secrets (变量和机密)**，点击 **Add** 添加以下变量（敏感字段建议选择 **Secret** 加密类型）：

| 变量名 | 必填 | 示例值 | 说明 |
| :--- | :---: | :--- | :--- |
| `SPACE_REPO_ID` | **是** | `user1/demo,user1/app` | 要保活的 Space 列表（支持直接内联多 Token，详见下方说明） |
| `HF_TOKEN` | **是*** | `hf_xxxxxxxxxxxxxxxxxxxx` | Hugging Face Access Token（需具备 **Write** 权限）。*若已在 `SPACE_REPO_ID` 中内联绑定则可不填 |
| `SECRET_KEY` | 否 | `my_super_secret_123` | **强烈推荐**：用于保护 Web 控制台操作和 `/wake` 接口的访问密码 |
| `BOT_TOKEN` | 否 | `123456:ABC-DEF1234ghIkl...` | Telegram 机器人 Token（通过 `@BotFather` 获取） |
| `CHAT_ID` | 否 | `-1001234567890` | Telegram 接收通知的个人、群组或频道 ID |
| `SILENT_IF_RUNNING` | 否 | `true` | 设为 `true` 时开启**免打扰模式**：定时巡检若发现所有 Space 均正常运行跳过，则不发送 TG 通知 |

> 🔑 **HF_TOKEN 获取地址**：前往 [Hugging Face Settings - Access Tokens](https://huggingface.co/settings/tokens)，新建一个 Token 并确保勾选对应 Space 的 **Write** 权限。

### 第三步：配置多账号 / 多 Token（三种写法任选其一）

本项目完全兼容单账号与多账号管理，你可以根据习惯选择以下任意一种配置格式：

* **方式 A：在 `SPACE_REPO_ID` 中直接内联绑定（最推荐，清晰直观）**
  无需填写 `HF_TOKEN` 变量，直接按 `Token:Space1,Space2` 格式填写，多个账号之间用分号 `;` 或换行分隔：
  ```text
  hf_tokenAAA:alice/space1,alice/space2;hf_tokenBBB:bob/space3
  ```
* **方式 B：双变量按分号 `;` 分组一一对应**
  * `HF_TOKEN`: `hf_tokenAAA;hf_tokenBBB`
  * `SPACE_REPO_ID`: `alice/space1,alice/space2;bob/space3,bob/space4`
* **方式 C：单账号管理多个 Space（经典写法）**
  * `HF_TOKEN`: `hf_tokenAAA`
  * `SPACE_REPO_ID`: `alice/space1,alice/space2,alice/space3`

### 第四步：绑定 Cloudflare KV 开启历史日志（可选）
若希望在网页控制台下方查看最近 10 次唤醒记录，请按以下步骤绑定（不绑定也可正常使用所有唤醒功能）：
1. 在 Cloudflare 左侧菜单进入 **Storage & Databases (存储和数据库) → KV**。
2. 点击 **Create a namespace**，名称填写 `hf-waker-logs`，点击 **Add**。
3. 回到 Worker 的 **Settings → Bindings (绑定)**，点击 **Add → KV Namespace**：
   * **Variable name (变量名称)**：严格填写 `WAKE_KV`
   * **KV namespace (命名空间)**：选择 `hf-waker-logs`
4. 点击 **Deploy** 保存即可。

### 第五步：设置 Cron 定时自动巡检
1. 进入 Worker 的 **Settings → Triggers (触发器) → Cron Triggers**。
2. 点击 **Add Cron Trigger**，输入 Cron 表达式（注意 Cloudflare 采用 **UTC 时间**）：
   * **每 6 小时自动巡检一次（最推荐，温和且及时）**：`0 */6 * * *`
   * **每天北京时间 00:00（午夜）巡检**：`0 16 * * *`
   * **每天北京时间 08:00（早上）巡检**：`0 0 * * *`

---

## 🖥️ Web 可视化控制台与 API 接口说明

部署完成后，直接通过浏览器访问你的 Worker 域名（如 `https://hf-waker.yourname.workers.dev/`）即可进入控制台。

### API 路由一览

若设置了 `SECRET_KEY`，调用以下 API 时需在 URL 参数中携带 `?key=你的密码` 或在请求头中携带 `X-Secret-Key: 你的密码`。

| 路由路径 | 方法 | 参数说明 | 功能描述 |
| :--- | :---: | :--- | :--- |
| `/` | `GET` | 无 | 打开可视化 Web 监控与操作控制台 |
| `/api/status` | `GET` | `key` (可选) | 仅查询所有 Space 当前状态与最近 10 条 KV 历史记录，**不触发重启** |
| `/wake` | `GET` | `key`: 访问密码<br>`repo`: 指定单个 Space (不填则处理全部)<br>`force`: `true` 强制重启 / `false` 智能唤醒<br>`user`: 触发人名称<br>`reason`: 操作原因备注 | 触发智能唤醒或强制重启，并返回 JSON 统计结果 |
| `/api/logs/clear` | `POST` | `key` (可选) | 清空保存在 `WAKE_KV` 中的历史执行记录 |

### 常用 API 调用示例

1. **智能唤醒全部休眠中的 Space（跳过正在运行的 Space）**：
   ```bash
   curl "[https://hf-waker.yourname.workers.dev/wake?key=my_super_secret_123&user=Admin&reason=日常巡检](https://hf-waker.yourname.workers.dev/wake?key=my_super_secret_123&user=Admin&reason=日常巡检)"
   ```
2. **指定单独唤醒某一个 Space**：
   ```bash
   curl "[https://hf-waker.yourname.workers.dev/wake?key=my_super_secret_123&repo=alice/space1](https://hf-waker.yourname.workers.dev/wake?key=my_super_secret_123&repo=alice/space1)"
   ```
3. **无视运行状态，强制重启某一个卡死的 Space**：
   ```bash
   curl "[https://hf-waker.yourname.workers.dev/wake?key=my_super_secret_123&repo=alice/space1&force=true&reason=容器卡死强制重启](https://hf-waker.yourname.workers.dev/wake?key=my_super_secret_123&repo=alice/space1&force=true&reason=容器卡死强制重启)"
   ```

---

## 📲 Telegram 通知预览

**🤖 自动巡检通知**
```text
🤖 HF Space 自动巡检保活

⏰ 北京时间 2026-10-14 08:00:02
🛰 Space 状态明细：
 • alice/space1 🟢 运行中 (RUNNING，已跳过)
 • alice/space2 🔄 已唤醒 (原状态: SLEEPING)
 • bob/space3 🟢 运行中 (RUNNING，已跳过)

📊 统计：唤醒 1 个 | 跳过 2 个 | 失败 0 个
✅ 巡检保活 完成 🎉
```

**🖐 手动操作通知**
```text
🖐 HF Space 手动保活 (强制重启)

👤 触发人: WebDashboard
📝 原因: Web面板-强制重启
⏰ 北京时间 2026-10-14 14:35:10
🛰 Space 状态明细：
 • alice/space1 🔄 已唤醒 (原状态: RUNNING)

📊 统计：唤醒 1 个 | 跳过 0 个 | 失败 0 个
✅ 操作 完成 🎉
```

---

## 🙏 致谢与灵感来源 (Acknowledgements)

* 感谢 [@oversizexl](https://github.com/oversizexl) 开源的原项目 **[oversizexl/hf-waker](https://github.com/oversizexl/hf-waker)** 提供的核心设计思路与通知模板。本项目在其基础上完成了向 Cloudflare Workers Serverless 架构的移植与功能扩展。

---

## 📄 License

本项目基于 [MIT License](./LICENSE) 开源。如果这个项目帮到了你，欢迎给本项目及原项目点个 🌟 **Star** 支持一下！

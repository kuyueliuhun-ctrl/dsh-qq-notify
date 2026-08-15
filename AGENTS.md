# AGENTS.md

面向后续在此插件上工作的 Agent / 维护者的操作指引。

## 这是什么

`dsh-qq-notify`：让 QQ 私聊能驱动 DeepSeek Harness 的双向桥 bundle 插件。核心能力：
- 按**工作区 → 会话**两级菜单，选择并驱动**已有的工作区会话**（复用 live agent + inbox 队列，不打断 web）。
- QQ 自建会话：新建 / 选择 / 退出。
- 会话回复、完成通知、权限申请推送到 QQ。
- 独立守护 `qq-watch.js` 做 DSH 上下线通知。

## 关键架构决策（改之前务必先读）

1. **插件必须 `inject: []`**。曾因 `inject: ['sessions','agents','userQuestions']` 拖慢 dsh 启动（web 启动涨到 ~38s）。现在所有服务都用 `ctx.get()` 懒取，启动约 10.8s。**不要加回硬 inject**；新增服务依赖请用 `ctx.get()` 并做空值保护。

2. **驱动已有会话用「复用 + inbox」，不要 `agents.resume` 已占用会话**。
   - `agents.get(sessionId)` 取到 live agent → 返回 `{ agent }` → 调用方 `agent.send(...)` 投递到 inbox 队列。
   - 只有 `agents.get` 取不到（空闲/新建）才 `agents.resume` → `agents.create`。
   - 直接 `agents.resume` 一个正在被 web 用的会话会抛 `session "... already exists"`。

3. **回复路由靠 `lastReplyTarget`（Map<sessionId, {openid,lastMsgId}>）**。`session/event` 监听器对 `lastReplyTarget` 里登记的**任意** sessionId（不管是否 `qq:` 前缀）路由 `assistant/message` 和 `turn/end` 回 QQ。web 会话的完成通知也要跳过这些被驱动的会话，避免重复推送。

4. **userQuestions 单一 provider 约束**：浏览器 UI 已独占 `userQuestions` 服务，QQ 侧 `askUserBridge` 默认 false（浏览器优先）。如果要 QQ 兜底提问，不能直接 `registerProvider`（会 `DUPLICATE_PROVIDER`），需另寻方案。

## 目录 / 文件

| 文件 | 作用 |
|---|---|
| `dist/index.js` | 插件主逻辑（纯 ESM，node ≥22 全局 fetch；`.check` 语法自检） |
| `cordis.patch.yml` | bundle 层，插入 `qq-notify` 行 |
| `package.json` | 声明 `dsh.bundle.patch`，依赖 schemastery + ws |
| `READEME.md` | 用户文档 |
| `qq-watch.js` | 独立上下线守护（不随 dsh 死） |
| `qq-watch.config.json` | 守护凭据 |

## 工作流

### 在 Windows 原生 dsh 上调试（用户主环境）

- DSH 源码：`C:\Users\枯月流魂\deepseek-harness`
- 插件源目录：`C:\Users\枯月流魂\deepseek-harness\dsh-qq-notify\`（WSL 镜像在 `/root/12/dsh-qq-notify/`）
- web profile：`C:\Users\枯月流魂\.dsh\profiles\web`；`package.json` 里 `file:` 装了 plugin，`cordis.patch.yml` 是配置
- 日志：`C:\Users\枯月流魂\deepseek-harness\qq-notify.log`（追加）；会话状态 `qq-notify.sessions.json`；pid `qq-notify.pid`
- 启动：从该目录 `cmd.exe /c "pnpm dsh web --port 10082"`（后台 job 方式）
- 改 `dist/index.js` 后：同步复制到 `C:\Users\枯月流魂\deepseek-harness\dsh-qq-notify\dist\`（profile 副本与其**硬链接**，改一处即生效），然后重启 dsh。

> 注意：`$DSH_HOME` 在 Windows dsh 进程里常**未设置**，插件日志落在 `process.cwd()`（即 dsh 源码根）。查日志看那个目录，别去用户根目录找。

### 语法/导入自检

```sh
node --check dist/index.js
# 导入检查（在 profile 的 node_modules 环境下）
cd C:/Users/枯月流魂/.dsh/profiles/web && node --input-type=module -e "import('file:///C:/.../dsh-qq-notify/dist/index.js').then(m=>console.log(m.name, typeof m.apply))"
```

## 用户明确要求的功能边界

- **会话管理只保留**：选择会话（`/use` / 数字）、退出会话（`/exit`）、新建会话（`/new`）。
- **工作区**：只读列出并**选择驱动**，**不提供**新建 / 改名 / 删除 / 清空 / persona。
- 已移除：`/rename`、`/del`、`/clear`、`/persona`、`/recent`，以及 persona 注入、会话删除/清空逻辑。
- 保留：双向桥、多会话导航（`/menu` `/ws`）、完成通知、审批、待发送队列、上下线通知。
- **ask_user 依旧浏览器优先**（QQ 不强接管提问）。

不要重新引入被移除的命令/功能，除非用户明确要求。

## 待办/已知

- 启动时首次 QQ token 获取偶发超时（重试后网关可连上）；如需可在 `getToken`/`refreshToken` 收敛重试间隔与超时。
- 若要把 QQ 兜底 ask_user 做通，需避开 `userQuestions` 单 provider 冲突（当前浏览器优先，QQ 不接管）。

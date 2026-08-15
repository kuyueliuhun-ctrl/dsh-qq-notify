# dsh-qq-notify

DeepSeek Harness 的 QQ 双向桥插件：通过 QQ 官方机器人，把 QQ 私聊接入 DeepSeek Harness。

- **QQ → Harness**：QQ 私聊可直接驱动 harness 会话，QQ 收到模型的回复。
- **接入已有工作区/会话**：按工作区列出所有既有会话，选中后直接驱动它（继承历史、上下文、工作目录），通过 dsh 的消息队列（inbox）投递，不打断 web 端正在进行的会话。
- **Harness → QQ**：会话回复、回合完成通知、权限申请等推送到 QQ。
- **多会话**：可新建、选择、退出会话。
- **上下线通知**：由独立守护进程监控 DSH 进程，下线/恢复时发 QQ 通知（见 `watchdog` 一节）。

## 安装

把本目录作为 bundle 装进 DSH 的 web profile：

```sh
# 在 DSH 源码根目录
pnpm dsh plugin --profile web add file:C:/Users/<你的用户名>/<dsh-qq-notify 所在路径>
```

插件的 `package.json` 声明了 `dsh.bundle.patch`，安装后会自动挂载 `cordis.patch.yml` 层的 `qq-notify` 插件行。

### 依赖

- `@deepseek-ai/schemastery`
- `ws`（QQ 网关 WebSocket）

均随 profile 的 `pnpm install` 自动安装。

## 配置

在 web profile 的 `cordis.patch.yml` 里为 `qq-notify` 填配置：

```yaml
- id: qq-notify
  name: 'dsh-qq-notify'
  config:
    appId: '你的 QQ 机器人 AppID'
    appSecret: '你的 QQ 机器人 AppSecret'
    sandbox: true
    autoCapture: true
    openid: '你的 C2C user_openid'   # 私聊机器人一次后可自动捕获填回
    ownerOpenid: ''                  # 留空=任意私聊都可驱动；填 openid=仅自己
    bridge: true
    provider: 'deepseek-official'
    model: 'deepseek-v4-flash'
    cwd: 'C:/Users/你的用户名/deepseek-harness'
    outbox: true
    outboxIntervalMs: 2000
    notifyEvents:
      - completed
      - error
      - approval_requested
```

- **沙箱模式**（`sandbox: true`）时用沙箱网关；机器人上架后可改 `false`。
- `openid` 官方 API 需要平台的 user_openid（不是 QQ 号）；开启 `autoCapture` 后，你私聊机器人一次，插件会自动捕获并写入 `$DSH_HOME/qq-notify.openid.json`。

> 备注：本环境的 `agent-default-model` 用的是 `deepseek-official` / `deepseek-v4-flash`。`provider`/`model` 必须显式填写（留空会让 `deployment:persona` 的 `{{model}}` 无值而报错）。

## 用法（QQ 私聊）

### 会话管理（只保留三个核心操作）

| 操作 | 命令 |
|---|---|
| **选择会话** | 菜单里回复数字；或 `/use 会话名` |
| **退出会话** | `/exit` |
| **新建会话** | `/new 会话名` |

辅助导航：`/menu`（回菜单）、`/list`（会话列表）、`/ws`（进入已有工作区列表）、`/help`。

### 接入已有工作区/会话

1. `/ws`（或主菜单回 `W+数字`）→ 列出所有已有工作区（按 cwd）。
2. 回复数字选择工作区 → 列出该工作区下的会话。
3. 回复数字选择会话 → 进入「驱动该已有会话」模式。
4. 直接发消息 → 通过 dsh inbox 队列投递到该会话，QQ 收到回复。

> 已有工作区会话**只读选定后驱动，不提供新建/改名/删除**；QQ 新建会话只对 QQ 自建会话生效。

## 权限申请

harness 需要授权时，会推送到 QQ：

```
🔐 需要你的授权
工具：<toolName>（原因：...）
回复「同意 / 允许一次」放行，回复「拒绝」拒绝。
（5 分钟内未答复将自动拒绝）
```

## 完成通知

回合完成/出错/待审批会推送，含摘要、耗时、工具调用数、错误详情。

## 上下线通知（独立守护进程）

插件跑在 DSH 进程内，dsh 一旦被杀就来不及发通知。因此另配一个独立守护脚本 `qq-watch.js`（独立于 dsh 常驻）：

- **HTTP 探活** dsh 的 web 端口 + **PID 双重监控**。
- 判定下线（连续 N 次失败）→ 发「⚠️ 已停止/下线」；恢复 → 发「✅ 已恢复」。

配置见脚本头部注释；凭据可放 `qq-watch.config.json`（appId/appSecret/openid/sandbox/baseUrl）。启动：

```sh
DSH_HOME=... setsid nohup node qq-watch.js >/dev/null 2>&1 &
```

## 文件

- `dist/index.js` — 插件主逻辑（bundle）。
- `cordis.patch.yml` — bundle 层，插入 `qq-notify` 插件行。
- `package.json` — 声明 `dsh.bundle.patch`。
- `qq-watch.js` — 独立的 DSH 上下线守护脚本。
- `qq-watch.config.json` — 守护脚本凭据配置（可选）。

## 设计要点

- 插件 `inject: []`，所有服务（sessions/agents）用 `ctx.get()` 懒取，**不阻塞 dsh 启动**（web 启动约 10.8s）。
- 驱动已有会话时复用 `agents.get()` 拿到的 live agent，用 `agent.send` 投递到 **inbox 队列**，不 `agents.resume` 已占用的会话（避免 `already exists`），也不打断 web。
- 发射是不可逆副作用：QQ 推送失败只记录、不重试阻塞 agent 循环。

## 常见问题

- **QQ 驱动已有会话报「already exists」**：该会话正被 web 端占用。当前版本已改为复用 live agent + inbox 排队，不会再报；若仍出现，确认插件已更新。
- **启动时「token 请求超时」**：首次 token 获取偶发超时（Windows 网络/事件循环），插件会自动重试，网关稍后连上，不影响 web 可用。

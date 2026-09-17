# dsh-qq-notify

DeepSeek Harness 的 QQ 双向桥插件：通过 QQ 官方机器人，把 QQ 私聊接入 DeepSeek Harness。

- **QQ → Harness**：QQ 私聊可直接驱动 harness 会话，QQ 收到模型的回复。
- **接入已有工作区/会话**：按工作区列出所有既有会话，选中后直接驱动它（继承历史、上下文、工作目录），通过 dsh 的消息队列（inbox）投递，不打断 web 端正在进行的会话。
- **Harness → QQ**：会话回复、回合完成通知、权限申请等推送到 QQ。
- **多会话**：可新建、选择、退出会话。
- **上下线通知**：由独立守护进程监控 DSH 进程，下线/恢复时发 QQ 通知（见 `watchdog` 一节）。

## 版本与兼容性

| dsh 版本 | 状态 |
|---|---|
| ≤ 0.1.0-rc.5（旧 Windows 环境） | ✅ 兼容（旧 `session.events` 读取路径保留） |
| 0.1.5-rc.1 / 0.1.6-alpha.1（当前 WSL 环境） | ✅ 已修复并实测通过 |

**0.3.0（2026-09-17）修了什么**——dsh 升级后「完成通知静默失效」的根因：

1. **`session.events` 属性在新版 dsh 被删除**（改为 `session.snapshotEvents()` / `session.ownEvents()`）。
   旧代码在 `turn/end` 时遍历 `session.events` 生成摘要 → 抛 `TypeError: session.events is not iterable` → 被 dsh 的 session 观察者通道 try/catch 吞掉 → **通知一条都发不出来且日志无痕**。
   现在统一走 `sessionEventsOf()` 兼容层，两代 dsh 都能读。
2. **`userQuestions.registerProvider` 从来不存在**（新旧版都没有），QQ 接手 `ask_user` 的实际缝隙是 agent 作用域 waterfall 事件 `user-questions/request`；已改为监听该事件（`askUserBridge` 开关不变）。
3. 两个 `session/event` 监听器 + 两个 waterfall 监听器全部加 `guarded()` 包装：监听器内异常写进 `qq-notify.log`，不再静默消失。
4. 新增 `dryRun`、环境变量兜底、启动留痕日志，便于「通知没来」时一眼定位。

**0.3.1（2026-09-17）修了什么**：

1. **选会话时不再出现子代理会话**：`/ws` → 工作区明细里的会话列表现在只列**顶层会话**。
   子代理会话是某个任务的内部执行体（网页侧边栏也不平铺展示，只挂在父会话目录里），
   之前会混进列表，选中后你的每句话都会被打进那个子代理里。
   三处一起挡：列表过滤、选中时按 live 会话复核、以及「之前已接入的会话若被判定为子代理则自动断开回菜单」。
2. 工作区导航改用 **cwd 锚定**（不再只按编号），列表变动时不会翻到别的工作区。
3. 会话标题显示（0.3.0 起）与本修复的回归测试补齐：`tools/session-picker-e2e-test.mjs`（32 项）。

细节与证据见 `docs/dsh-compat-0.1.6.md`。


## 安装

把本目录作为 bundle 装进 DSH 的 web profile：

```sh
# 在 DSH 源码根目录
pnpm dsh plugin --profile web add file:C:/Users/<你的用户名>/<dsh-qq-notify 所在路径>
```

插件的 `package.json` 声明了 `dsh.bundle.patch`，安装后会自动挂载 `cordis.patch.yml` 层的 `qq-notify` 插件行。

没有网络/github 不通时，等价的本地装配（当前 WSL 环境就是这么装的）：

```sh
# 1) profile node_modules 下建 junction（Windows 用 mklink /J）
ln -s /mnt/e/dsh-qq-notify ~/.dsh/profiles/web/node_modules/dsh-qq-notify
# 2) profile package.json：dependencies 加 "dsh-qq-notify": "link:/mnt/e/dsh-qq-notify"，
#    dsh.profile.bundles 数组加 "dsh-qq-notify"
# 3) profile cordis.patch.yml 里填上面的 config 块
# 4) 重启 dsh web
```

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
    # —— 通知降噪（默认值即推荐值，一般不用写）——
    notifySubagents: false       # 子代理不单独推；折进顶层会话统计
    notifyOnlyQuiet: true        # 会话闲下来才推：连续回合/子代理来回合并成一条
    notifyQuietMs: 20000         # 「闲下来」判定窗口：20s 内没有新活动才推
    notifyStaleMs: 300000        # 兜底：持续忙碌也至少每 5 分钟汇报一次进度
    approvalBridge: true         # 被 QQ 驱动的会话，审批由 QQ 应答（false = 仍交给浏览器）
    # 可选：dryRun: true 只把要推送的内容写进 qq-notify.log，不真发（验证通知链路用）
```

- **沙箱模式**（`sandbox: true`）时用沙箱网关；机器人上架后可改 `false`。
- `openid` 官方 API 需要平台的 user_openid（不是 QQ 号）；开启 `autoCapture` 后，你私聊机器人一次，插件会自动捕获并写入 `$DSH_HOME/qq-notify.openid.json`。
- **凭据也可以走环境变量**（与 `qq-watch.js` 同一套变量名，用于不方便写 patch 的场景）：`QQ_APP_ID` / `QQ_APP_SECRET` / `QQ_OPENID` / `QQ_SANDBOX`。缺 appId/appSecret 时插件不启用，只记一行日志。
- `notifyEvents` 只认 `completed` / `error`；**显式给空数组即可关掉主动通知**（不给该字段才用默认值）。
- 提问/审批的优先级：`askUserBridge` 默认 **false**（提问仍由浏览器 UI 应答）；`approvalBridge` 默认 **true**（被 QQ 驱动的会话改由 QQ 应答审批，因为驱动来源就是 QQ）。

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
2. 回复数字选择工作区 → 列出该工作区下的会话（显示**会话标题** + 短 id）。
3. 回复数字选择会话 → 进入「驱动该已有会话」模式。
4. 直接发消息 → 通过 dsh inbox 队列投递到该会话，QQ 收到回复。

> 已有工作区会话**只读选定后驱动，不提供新建/改名/删除**；QQ 新建会话只对 QQ 自建会话生效。
> 列表里**只有顶层会话**：子代理会话（某个任务的内部执行体）不会出现，也选不到——
> 免得你的消息被打进一个已经跑完/正在跑的子任务里。

## 权限申请

harness 需要授权时（**被 QQ 驱动过的会话**），会推送到 QQ：

```
🔐 需要你的授权
工具：<toolName>（原因：...）
会话：<会话标题>（短 id）
回复「同意 / 允许一次」放行，回复「拒绝」拒绝。
（5 分钟内未答复将自动拒绝）
```

**失败关闭**：只有明确回复「同意 / 允许 / 可以 / 是 / yes / ok」才放行；拒绝、超时、被新请求抢占、无法识别的一律按拒绝处理。
不想让 QQ 接手审批（仍用浏览器 UI）：`approvalBridge: false`。

## 完成通知

**一个任务只推一条**（这是默认行为，不是每条回合/每个子代理都推）：

```
【任务完成】把 clash 模拟器重构一下
本任务共 3 个回合
含 2 个子代理
总耗时：4 分 12 秒
最后一轮工具调用：2 次
工作区：/mnt/e/clash-royale-simulator-main
时间：2026/9/17 23:30
```

**会话名显示的是「会话标题」，不是 `session-xxxx`**：取 DSH 自己的 `session/title`
（`dsh-session-title` 生成，网页侧边栏看到的就是它，LLM 标题优先、否则是内置 fallback），
所以 QQ 上的名字和网页上一致；拿不到标题才退回短 id（如 `bdc6683a`）。
需要用户挑一个会话的场景（`/ws` 列表、审批、接入确认）会额外带一个短 id 后缀做消歧。

降噪规则：

- **子代理不单独推**：`notifySubagents: false`（默认）。所有层级的子代理（含嵌套）都折进**顶层会话**，
  只贡献「含 N 个子代理」这个统计。
- **连续回合合并**：一个任务里父会话跑多个回合（含等子代理、继续下一步）时，
  只有整个会话**闲下来**（`notifyQuietMs` 内没有新活动）才推一条。
- **不会永远不推**：持续忙碌超过 `notifyStaleMs`（默认 15 分钟）会先推一次进度，且**一个任务只推一次**
  （推完仍会在任务真正结束时补一条完整的完成通知）。
- **正在跑的回合不会误报**：会话自己的回合还没结束时不推（否则「一件事」会被拆成两条）；
  连插件是在回合中途热装/重启的（没看到 `turn/start`）也能正确判断——从会话日志推断。
- 被 QQ 驱动过的会话不推完成通知（走桥接回复链路，避免重复）。
- 想回到「每个回合都推」：`notifyOnlyQuiet: false` + `notifySubagents: true`。

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
- `tools/smoke.mjs` — 离线冒烟自检（改完代码先跑它：抓「配置变量未声明」与「prepend 注册回归」）。
- `docs/dsh-compat-0.1.6.md` — dsh 升级兼容性记录（改了什么、怎么复验）。

## 设计要点

- 插件 `inject: []`，所有服务（sessions/agents）用 `ctx.get()` 懒取，**不阻塞 dsh 启动**（web 启动约 10.8s）。新版 dsh 实测：非作用域（untagged）监听器被全局接纳，所以 `inject: []` 依然能收到 `session/event`、`approval/request`、`user-questions/request`。
- 驱动已有会话时复用 `agents.get()` 拿到的 live agent，用 `agent.send` 投递到 **inbox 队列**，不 `agents.resume` 已占用的会话（避免 `already exists`），也不打断 web。
- 读会话日志一律走 `sessionEventsOf()`，不直接碰 `session.events`（新版已删除）。
- **通知按「会话 → 顶层会话」聚合**：`pendingNotices` 每个会话一个聚合条目，`noteActivity()` 重排静默定时器，
  `rootAncestorOf()` 把嵌套子代理上溯到顶层；`isTurnOpen()` 判断会话自己是否还在跑（事件状态 + 会话日志双保险）。
- 审批/提问两个 waterfall 用 `prepend` 注册：`dsh-api-remotes` 的浏览器转发器先注册且会直接应答，不抢占就永远轮不到 QQ。
- 发射是不可逆副作用：QQ 推送失败只记录、不阻塞 agent 循环；outbox 每条最多重投 8 次后丢弃（避免永久失败项无限重试）。

## 常见问题

排查顺序（**通知没来时按这个顺序看 `$DSH_HOME/qq-notify.log`**）：

1. `插件加载 appId=… bridge=… notifyEvents=… dryRun=…` —— 没有这行说明插件根本没起来（配置缺失/没装进 profile/被 disabled）。
2. `通知 turn/end 会话=… kind=completed（订阅=…）` —— 有这行说明事件收到了（`debug: true` 时每回合都打）。
3. `子代理结束 → 计入顶层会话 …` / `通知: 会话 … 仍在忙，推迟推送` —— 降噪在工作（子代理折进顶层、忙时推迟）。
4. `通知(quiet|stale) 会话=… 回合=… 子代理=… → QQ` —— 聚合通知出队（quiet=闲下来、stale=忙碌兜底）。
5. `pushQQ: 成功 …` / `pushQQ: 失败 …` —— 真正的投递结果；失败会保留在 outbox 里按 `outboxIntervalMs` 重试（最多 8 次）。
6. 出现 `监听器异常：…` 行 —— 说明 dsh 事件载荷又变了（把该行连同 dsh 版本一起反馈，通常改一个读取字段即可）。

> 觉得**太安静**（任务结束没收到）？先看第 3、4 步：正常最多等 `notifyQuietMs`（默认 20s）。
> 如果会话一直在跑，会推迟到它闲下来；超过 `notifyStaleMs`（默认 5 分钟）一定会推一条进度。

- **QQ 驱动已有会话报「already exists」**：该会话正被 web 端占用。当前版本复用 live agent + inbox 排队，不会再报；若仍出现，确认插件已更新。
- **启动时「token 请求超时」**：首次 token 获取偶发超时（网络/事件循环），插件会自动重试，网关稍后连上，不影响 web 可用。
- **通知只写日志没发出去**：检查是否误开了 `dryRun: true`。
- **日志文件不在 `$DSH_HOME`**：插件按 `DSH_HOME || process.cwd()` 落日志；某些启动方式（如 Windows 原生）没有 `DSH_HOME`，日志会落在 dsh 源码根目录。

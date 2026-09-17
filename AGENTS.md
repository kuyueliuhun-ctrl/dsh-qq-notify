# AGENTS.md

面向后续在此插件上工作的 Agent / 维护者的操作指引。

## 这是什么

`dsh-qq-notify`：让 QQ 私聊能驱动 DeepSeek Harness 的双向桥 bundle 插件。核心能力：
- 按**工作区 → 会话**两级菜单，选择并驱动**已有的工作区会话**（复用 live agent + inbox 队列，不打断 web）。
- QQ 自建会话：新建 / 选择 / 退出。
- 会话回复、完成通知、权限申请推送到 QQ。
- 独立守护 `qq-watch.js` 做 DSH 上下线通知。

## 关键架构决策（改之前务必先读）

1. **读会话日志必须走 `sessionEventsOf()`，永远不要直接写 `session.events`。**
   新版 dsh（0.1.5-rc.1 起）**删除了 `session.events` 属性**（旧版是 `get events()` 数组 getter），
   改为 `session.snapshotEvents()` /（deprecated）`session.ownEvents()`。2026-09-17 的通知静默失效
   就是这个原因：`turn/end` 处理器里 `for (const e of session.events)` 抛 TypeError，被 dsh 的
   session 观察者通道 try/catch 吞掉，**日志无痕、通知全丢**。兼容层在 `dist/index.js` 的
   `sessionEventsOf()`（旧 getter → snapshotEvents → ownEvents → log → `[]`）。
   同理：**新增任何 `session/event` 监听器都要用 `guarded(label, fn)` 包一层**，否则异常会再次静默消失。

2. **插件必须 `inject: []`**。曾因 `inject: ['sessions','agents','userQuestions']` 拖慢 dsh 启动（web 启动涨到 ~38s）。现在所有服务都用 `ctx.get()` 懒取，启动约 10.8s。**不要加回硬 inject**；新增服务依赖请用 `ctx.get()` 并做空值保护。
   实测确认（0.1.6-alpha.1）：`inject: []` 的插件依然能收到 `session/event`、`approval/request`、
   `user-questions/request`——dsh-scope 的 carrier 明确「无 tag 的监听器全局接纳」。

3. **驱动已有会话用「复用 + inbox」，不要 `agents.resume` 已占用会话**。
   - `agents.get(sessionId)` 返回**裸 live agent 对象**（不是 `{agent}`；它身上有 `.id` 和 `.session.id`）→ 调用方包成 `{ agent }` 后 `agent.send(...)` 投递到 inbox 队列。
   - `agents.create/resume(...)` 才返回 `{ agent, dispose }`（插件不 dispose：会话归 dsh 生命周期管）。
   - 只有 `agents.get` 取不到（空闲/新建）才 `agents.resume` → `agents.create`。
   - 直接 `agents.resume` 一个正在被 web 用的会话会抛 `session "... already exists"`。

4. **回复路由靠 `lastReplyTarget`（Map<sessionId, {openid,lastMsgId}>）**。`session/event` 监听器对 `lastReplyTarget` 里登记的**任意** sessionId（不管是否 `qq:` 前缀）路由 `assistant/message` 和 `turn/end` 回 QQ。web 会话的完成通知也要跳过这些被驱动的会话，避免重复推送。

5. **ask_user 走 waterfall `user-questions/request`，不是 `registerProvider`**。
   `userQuestions.registerProvider` 在新旧 dsh 里**都不存在**（历史误解：浏览器 UI 并不是靠 provider 抢的）。
   正确做法是 `ctx.on('user-questions/request', (request, next) => …)`：QQ 会话的提问返回
   `{answers:[{id, selected, custom?}]}` 接手，其他情况 `next()` 让给浏览器 UI。
   `askUserBridge` 默认在配置里设 false（浏览器优先），但代码路径已可用。

6. **审批/提问必须 `prepend` 注册（第三个参数 `true`），否则永远轮不到 QQ**。
   `dsh-api-remotes`（`lib/index.js:112-128`）把 `approval/request`、`user-questions/request`
   转发给浏览器 UI；浏览器在线时 `forwardWaterfall` 直接应答、**不再调 next()**。
   本插件是 bundles 里最后一个，按注册顺序排在浏览器转发器之后 → 必须抢到最前。
   （`ltrace` 级证据：`forwardWaterfall` 里 `if (!queue.push(dispatch)) …next()`。）

7. **审批一律失败关闭**。审批回复的判定是「只有明确同意才 `allowed-once`，其余全 `rejected`」。
   历史坑：原实现「非拒绝即同意」，而抢占用一句说明文字收尾 → 那条说明被当成用户许可（静默授权）。
   同理 `pendingInteraction` 是单槽：抢占/abort 必须只收尾「自己那条」（`settlePending` 带归属校验），
   绝不能动别人的 pending、也不能清掉别人的超时兜底。

8. **`turnStarts` 的 turn 配对要放在所有早退之前**（QQ 驱动中 / `notifySubagents` 跳过 /
   kind 未订阅都会 return）：否则 Map 泄漏，且下一次只有 turn/end 时耗时用陈旧起点。

9. **完成通知是「会话级聚合」，不是「每回合一条」**。用户明确要求过降噪（原行为：每个回合、
   每个子代理各推一条，编排一个任务能刷 5+ 条）。规则：
   - 子代理（`header.origin==='subagent'` 或 `delegationDepth>0`）默认**不单独推**，只把结束
     计入 `rootAncestorOf()` 上溯到的**顶层会话**（`pendingNotices` 的 `subagents` 计数）。
   - 顶层会话的连续回合合并：`noteActivity()` 每次活动重排 `notifyQuietMs` 定时器，
     只有静默满窗口才 `flushNotice(sid,'quiet')` 推一条。
   - `notifyStaleMs` 兜底：持续忙碌也先推一次进度，避免长时间没消息。
   - **`isTurnOpen()` 是双保险**：只看 `turn/start` 事件不够——插件热装/重启时是「回合中途」加载，
     根本没看到 `turn/start`，会误判为空闲并在回合中途推送（把一件事拆成两条）。
     所以再读会话日志（`turn/start` 与 `turn/end` 都入日志）推断。**改这块务必保留这个兜底。**
   - 聚合条目的标题只取**顶层会话**的会话标题（`rootTitle`），子代理的提示词不是任务名
     （曾经推出去过「【任务完成】sub-d1」这种），子代理标题只作 `fallbackTitle`。

10. **会话名一律用「会话标题」，不要甩 `session-xxxx`**（用户明确要求）。三级来源：
   `session/title` 事件（`foldTitleFromLog()`，即网页侧边栏看到的标题；LLM 标题或内置 fallback）
   → 首条**人类** `user/message` → 短 id。
   两个易踩的坑：
   - **`user/message` 不只有人类输入**：`source.kind === 'plugin'` 的注入消息（审批策略变更、
     定时任务、goal 续跑、子代理中转）也是 user 角色。真实案例：session-9e4a8729 的首条
     user/message 是「The approval policy changed from "ask" to "never"…」，直接取首条会把通知标题带偏。
     所以 `firstHumanText()` 必须过滤 `source.kind !== 'user'`。
   - 展示分两个函数：`sessionLabel()`（标题 +（短 id），用于**需要用户挑**的场景：`/ws` 列表、
     审批、接入确认）与 `sessionName()`（纯标题，用于通知正文——用户诉求就是别显示 id）。
   - DSH 标题 fallback 上限是 5 words / 40 bytes（`dsh-base/cordis.patch.yml` 的 `session-title`），
     所以中文标题可能被截断成「这是一个老版本dsh的项目，原」——这与网页 UI **一致**，是有意为之。

11. **「选择会话」只列顶层会话，子代理会话必须挡住**（2026-09-17 用户反馈）。
   症状：`/menu` → `W+数字` → 工作区明细里能选到子代理会话，选中后 QQ 的每句话都被打进
   某个任务的内部执行体（实测复现：选了 `02bc8532…` 后日志出现
   `选择驱动已有会话 02bc8532…` + `复用已有 live agent …（投递到 inbox 队列）`）。
   规则与实现：
   - **判定只看 `header.origin === 'subagent' || header.delegationDepth > 0`**（`isSubagentSession()`）。
     ⚠️ **不要用 `header.parentSession` 判定**——按 dsh-session 的 d.ts，它是「fork 血缘」
     （`isSeeded` 的种子来源），从别的会话 fork 出来的**顶层会话**同样带它，用它判定会误藏正常会话。
   - 过滤点统一在 `isDrivableSession()`（跳过 `qq:` 前缀 + 子代理），`workspaceInventory()` 只列它。
     **不要只按 `qq:` 前缀过滤**（这就是本次 bug）。
   - 三处兜底，缺一不可：① 清单过滤（不给编号）；② 选中时按 live 会话再核一次
     （`sessionById()` + `isDrivableSession()`，防清单与 live 状态不同步）；
     ③ **对话模式入口校验 `u.drivingWsSession`**——修好之前可能已经接入了子代理会话，
     状态是持久化的（`qq-notify.sessions.json`），发现不是可驱动顶层会话就断开并回菜单。
     没有 ③ 的话，老状态会让用户继续往子代理里发消息。
   - `menuNav` 用 **cwd 锚定**（`resolveNavWorkspace()`，`{kind:'wsdetail', wsIdx, cwd}`）：编号是每次
     实时重算的，过滤子代理本身就会让编号变化；只存 `wsIdx` 会在用户翻菜单时指到别的工作区。
   - 对齐网页 UI：DSH 侧边栏也不平铺展示子代理（挂在父会话目录里），
     判定用 `origin`（见 `dsh-api-session-controller/lib/types/client/sessions/manager.js:609`）。

12. **热换/卸载后残留的旧实例是「僵尸」，必须挡住它的定时器与推送**（2026-09-18 真实踩过）。
   症状：连续热更 3 次（dispose 旧 entry + `loader.create`）后，旧实例的**聚合通知定时器还在跑**
   ——`noteActivity()` 用的是普通 `setTimeout`，**不受 `ctx.effect` 管理**，dispose 不会清它。
   旧实例照样在 15 分钟（`notifyStaleMs`）后 `fetch` 到 QQ API 推一条，用户收到重复/过时通知
   （实测 16:26:09 一条：【任务完成】…，而那个任务其实还在跑）。
   三道防线（缺一个都会漏）：
   - **dispose 清理**：`ctx.effect(() => () => { …clearTimeout(entry.timer)… clearInterval(outboxTimer)… })`
     放在 `apply` 末尾（`qq-notify.dispose-timers()`）。
   - **推送守卫**（`installPushGuard`）：每个实例有 `instanceToken`，推送带
     `x-qq-notify-instance` 头；全局 `fetch` 包装器把发往 `/v2/users/<openid>/messages`
     但标记 ≠ 当前 token 的请求丢掉（旧实例的代码不带这个头 → 直接丢）。**这条能挡住已经排好队的定时器**。
   - **通知定时器守卫**（`installNoticeTimerGuard`）：全局 `setTimeout` 包装器把「回调源码含 `flushNotice`
     且没带当前实例标记」的定时器换成空转（旧实例的 re-arm 被吃掉，不再刷日志/不再到点推送）。
     其它定时器一律原样放行。
   排查用：`globalThis.__dshQqNotifyPushGuard.dropped` / `globalThis.__dshQqNotifyTimerGuard.dropped`。
   ⚠️ 装守卫时踩的坑：临时守卫里的日志函数用了 `require`（staging 函数作用域里没有）→ 抛错被守卫自己的
   `try/catch` 吞掉 → 代码继续往下走**把请求放行了**。守卫内部任何「可能抛的东西」都必须放在判定之后，
   并且**必须双向验证**（无标记的确实被丢 + 有标记的确实放行），只测一边等于没测。

## 目录 / 文件

| 文件 | 作用 |
|---|---|
| `dist/index.js` | 插件主逻辑（纯 ESM，node ≥22 全局 fetch；`node --check` 语法自检） |
| `cordis.patch.yml` | bundle 层，插入 `qq-notify` 行 |
| `package.json` | 声明 `dsh.bundle.patch`，依赖 schemastery + ws |
| `README.md` | 用户文档（含「通知没来」排查顺序） |
| `docs/dsh-compat-0.1.6.md` | dsh 升级兼容性记录（根因、契约对照、复验方法） |
| `tools/smoke.mjs` | 离线冒烟自检（假 ctx 调 apply；抓未声明配置变量 + prepend 注册回归） |
| `tools/notify-policy-test.mjs` | 通知降噪策略回归（嵌套子代理折顶层 / 热装中途加载 / 超长回合兜底 / 标题来源） |
| `tools/session-picker-e2e-test.mjs` | 会话选择菜单端到端回归（假 ws 模块 + 假网关跑通 `/menu` `/ws` 明细；断言子代理不可选） |
| `qq-watch.js` | 独立上下线守护（不随 dsh 死，与 dsh 版本无关） |
| `qq-watch.config.json` | 守护凭据 |

## 工作流

### WSL 主环境（当前部署地，dsh 0.1.6-alpha.1）

- DSH_HOME：`/root/.dsh-016`；DSH 安装：`/root/deepseek-harness-016`；web：`http://127.0.0.1:10081`
- 本仓库在 `/mnt/e/dsh-qq-notify`，profile 里以 **junction** 装配：
  `~/.dsh-016/profiles/web/node_modules/dsh-qq-notify -> /mnt/e/dsh-qq-notify`
- 配置在 `~/.dsh-016/profiles/web/cordis.patch.yml`（`id: qq-notify` 块）+ `package.json`
  （`dependencies` 的 `link:` + `dsh.profile.bundles`）
- 日志：`/root/.dsh-016/qq-notify.log`（`$DSH_HOME` 已设置时；Windows 原生常未设置 → 落 `process.cwd()`）
- ⚠️ **agent 的 bash 对 `/root` 只读**（bwrap `--ro-bind`）：改 profile、装插件要用
  `dsh-super-injector` 的 `dev_*` 工具，或用 `dev_stage_add`/`dev_stage_call` 在**服务进程内**跑
  `node:fs` 代码（dev 工具跑在 dsh 进程里，不受沙箱约束）。
- 热更代码后必须**清模块缓存**才能生效：
  `Map.prototype.delete.call(ctx.loader.internal.loadCache, url)`（key 是 realpath URL），
  否则 `ctx.loader.create({name})` 命中旧模块；连 `dev_reload_package` 也救不了非它自己建的 entry。

### 在 Windows 原生 dsh 上调试（旧版 dsh 0.1.0-rc.5）

- DSH 源码：`C:\Users\枯月流魂\deepseek-harness`
- 插件源目录：`C:\Users\枯月流魂\deepseek-harness\dsh-qq-notify\`
- web profile：`C:\Users\枯月流魂\.dsh\profiles\web`；`package.json` 里 `file:` 装了 plugin，`cordis.patch.yml` 是配置
- 该 profile 故意设 `autoCapture: false` / `bridge: false`：**Windows 只保留完成通知**，网关归 WSL 侧，避免两边抢网关
- 日志：`C:\Users\枯月流魂\deepseek-harness\qq-notify.log`（追加）；会话状态 `qq-notify.sessions.json`；pid `qq-notify.pid`
- 启动：从该目录 `cmd.exe /c "pnpm dsh web --port 10082"`（后台 job 方式）
- 改 `dist/index.js` 后：同步复制到 `C:\Users\枯月流魂\deepseek-harness\dsh-qq-notify\dist\`，然后重启 dsh。

> 本插件的兼容层同时支持两代 dsh，改代码时**不要只测一边**：`snapshotEvents()` 是主路径，
> 旧 `session.events` getter 是兼容路径。

### 语法/导入自检

```sh
node --check dist/index.js
node tools/smoke.mjs               # 配置变量未声明 / prepend 注册 / 会话可选性判定回归
node tools/notify-policy-test.mjs  # 通知降噪 + 会话标题回归（23 项）
node tools/session-picker-e2e-test.mjs  # 选会话菜单端到端（假 ws + 假网关，32 项）
# 导入检查（在工作区建 node_modules 软链到 profile 的 ws/schemastery 后）
node -e "import('/mnt/e/dsh-qq-notify/dist/index.js').then(m=>console.log(m.name, typeof m.apply))"
```

### 不重启 dsh 的端到端复验（推荐）

见 `docs/dsh-compat-0.1.6.md` 第 5 节：用 `dev_stage_add` 挂一个「拷成新包名 + `loader.create({config})`」
的临时实例（`dryRun: true`），再派一个只回 PONG 的子智能体触发真实 `turn/end`，看日志是否出现
`通知(web 会话) → QQ` 与 `pushQQ(dryRun)`。验证完把 junction 和 staging 工具清掉。

**菜单/选会话路径**用「假 QQ 网关 + 真实 dsh 服务」探针（`docs/dsh-compat-0.1.6.md` 第 8 节，含可复制代码）：
在 dsh 进程内起一个 `node:http`（`/gateway` 返回本地 ws url）+ 手写 WS 帧，把临时实例的 `endpoint`
指向它，就能真的给插件喂 `C2C_MESSAGE_CREATE`，拿到的就是**真实会话数据渲染出的菜单原文**。三个坑：
- **喂消息前必须清 `loadCache`**：`loader.create({name:'dsh-qq-notify'})` 命中同一 realpath URL 的缓存
  → 拿到的是**旧模块**（我第一次跑探针就是这样，反而把旧版的 bug 又现场复现了一遍）。
- **卸载要用 `loader.entries()` 里的 entry**：在 `create()` 的返回值上直接调 `_dispose()` 不生效 →
  fiber 还在、网关会一直重连（每 5s 打一次真实 QQ API）。要
  `[...ctx.loader.entries()].find(e => e.options.id === ID)` 再 `e._dispose()`，之后确认 `hasFiber === false`。
- 探针期间把 `process.env.DSH_HOME` 指到临时目录，日志/会话状态/pid 才不会污染真实运行态。


## 用户明确要求的功能边界

- **会话管理只保留**：选择会话（`/use` / 数字）、退出会话（`/exit`）、新建会话（`/new`）。
- **工作区**：只读列出并**选择驱动**，**不提供**新建 / 改名 / 删除 / 清空 / persona。
- 已移除：`/rename`、`/del`、`/clear`、`/persona`、`/recent`，以及 persona 注入、会话删除/清空逻辑。
- 保留：双向桥、多会话导航（`/menu` `/ws`）、完成通知、审批、待发送队列、上下线通知。
- **ask_user 依旧浏览器优先**（QQ 不强接管提问）。

不要重新引入被移除的命令/功能，除非用户明确要求。

## 待办/已知

- 启动时首次 QQ token 获取偶发超时（重试后网关可连上）；如需可在 `getToken`/`refreshToken` 收敛重试间隔与超时。
- QQ 兜底 ask_user：代码路径已按 `user-questions/request`（prepend）写好，随 `askUserBridge` 开关生效。
  当前部署设 false（浏览器优先）；若要 QQ 接管提问，设 true 并实测（会抢在浏览器 UI 前应答）。
- 完成通知已改为**会话级聚合**（见架构决策 9）：子代理默认静音、连续回合合并、忙时推迟。
  被 QQ 驱动过的 web 会话不推完成通知（走桥接回复链路，避免重复）——如需改语义，动 `lastReplyTarget` 判定。
- `notifyEvents` 只影响 `turn/end` 的 completed/error；审批推送由 `approvalBridge` 单独控制。
- **已端到端验证**（2026-09-17，假网关探针 + 真实 dsh 服务）：QQ 私聊 → `/menu` `/ws` → 工作区明细 →
  选会话 → `agent.send(msg,'next-turn',true)` 进 inbox 复用 live agent（日志实见
  `复用已有 live agent …（投递到 inbox 队列）`）。仍未验证的是**真机 QQ 网络那一小段**：
  真人从 QQ 发消息、以及被动回复窗口（`lastMsgId`）。
- `lastReplyTarget.lastMsgId` 目前恒为 undefined → 所有推送都是**主动消息**（不走 5 分钟被动窗口）。
  历史遗留（旧版亦然）；要改成被动回复需把触发消息 id 写进 lastMsgId 并加 5 分钟有效期。
- WSL 侧的 live entry 是**热换**出来的（`qqlive-*`），配置是从上一个 entry 原样接管的，因此带
  `debug: true`（日志里有「内容预览」行）；而 profile `cordis.patch.yml` 里没写 debug。
  **重启 dsh 后 debug 会回到 false**（内容预览行消失，其余通知日志不变）。
  想让两边一致：把 `debug: true` 写进 patch 的 config 块（会略增日志量）。
- Windows 侧 `C:\Users\枯月流魂\deepseek-harness\dsh-qq-notify\` 已同步为 0.3.1（该 profile 硬链接到这份 dist，
  重启 Windows dsh 即生效）。

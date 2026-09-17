# dsh 兼容性记录：0.1.5-rc.1 → 0.1.6-alpha.1（2026-09-17）

本文记录「dsh 升级后 QQ 通知静默失效」的根因、证据与复验方法。改这个插件前请先读本文。

## 1. 症状

- QQ 侧还在正常收消息（网关 `网关 WS open`），但**回合完成/出错的通知一条都不来**。
- `$DSH_HOME/qq-notify.log` 里既没有 `通知… → QQ` 也没有 `pushQQ: 失败`，**完全没有痕迹**。

## 2. 根因（实测确认）

旧代码在 `turn/end` 时遍历 `session.events` 生成摘要：

```js
for (const event of session.events) { ... }   // sessionTitle / summarizeTurn / countToolCalls
```

- **旧版 dsh（0.1.0-rc.5，Windows 环境）**：`Session` 有 `get events()` 只读数组 getter
  （`packages/core/session/src/index.ts:559`）。
- **新版 dsh（0.1.5-rc.1 / 0.1.6-alpha.1）**：该属性**已被删除**，改为
  `snapshotEvents(fromSeq?, toSeqExclusive?)` 与（deprecated）`ownEvents()`。

后果链：`session.events` 为 `undefined` → `for...of` 抛
`TypeError: session.events is not iterable` → 异常发生在 `session/event` 监听器里 →
dsh 的 session 观察者通道 `invokeContainedSessionObservers()` 用 try/catch 吞掉并只记一条
warn → **通知彻底静默**。

实测证据（在 0.1.6-alpha.1 进程内打的探针，`session/event` 回调里读）：

```
typeofEvents:"undefined"
emulateOldLoop:"THROW TypeError: session.events is not iterable"
newApi:{"snapshotEvents":"function","ownEvents":"function","surface":"object"}
```

## 3. 修复

1. 新增 `sessionEventsOf(session)` 兼容层，按顺序取：
   `session.events`（旧版数组 getter，属性读取也包在 try 里）→ `session.snapshotEvents()` →
   `session.ownEvents()` → `session.log` → `[]`。所有读日志的地方（`sessionTitle` /
   `summarizeTurn` / `countToolCalls` / `sessionSafeTitle`）都只走它。
2. 新增 `guarded(label, fn)`：监听器同步异常写日志并在 waterfall 场景降级 `next()`；
   自己返回的 promise 异常只记日志再抛出（**不再调 next()**，否则下游失败会把剩余监听器重跑一遍）。
3. 新增 `renderNotification()`：拼装通知文本失败时降级为最简文本，保证「通知必达」。
4. `userQuestions.registerProvider` → waterfall 事件 `user-questions/request`
   （新旧 dsh 都没有 `registerProvider`；这是既有 bug，不是升级破坏）。
5. **审批/提问必须 prepend 注册**：`dsh-api-remotes`（`lib/index.js:112-128`）把
   `approval/request` / `user-questions/request` 转发给浏览器 UI，且浏览器在线时
   `forwardWaterfall` 直接应答、不再调 `next()`；而本插件作为**最后一个 bundle** 注册在后，
   不 `prepend` 就永远收不到 → 「QQ 收审批」功能在开着 web 时静默失效。
6. 审批/提问的会话识别从「只认 `qq:` 前缀」扩展到「`qq:` 前缀 **或**
   `lastReplyTarget` 登记过的被驱动工作区会话」——后者才是 QQ 桥的主要用法。
7. **审批失败关闭**：只有明确同意（同意/允许/可以/是/yes/ok/allow）才 `allowed-once`，
   其余（拒绝/超时/被抢占/无法识别的文本）一律 `rejected`。原实现是「非拒绝即同意」，
   而抢占旧交互时回的是说明文字 → **静默授权**（安全缺陷，已修）。
8. 交互等待槽加归属校验（`settlePending`）：abort/抢占只收尾「自己那条」，
   不再误答别人的 pending、也不清掉别人的超时兜底。
9. `turnStarts` 配对提到所有早退之前（否则 QQ 驱动/子智能体跳过/未订阅 kind 会让它泄漏、
   并让下一次耗时用陈旧起点）。
10. outbox：每条最多重投 8 次（`MAX_OUTBOX_ATTEMPTS`）后丢弃，队列空时停表
    （原实现永久失败项每 2 秒重试一次、日志无限增长）。
11. `agentCache` 复用前校验该 agent 仍是 `agents.get()` 返回的 live agent（否则丢弃陈旧句柄）。
12. 顺带：`dryRun` / `approvalBridge` / `notifySubagents` 开关、`notifyEvents` 显式空数组 = 关闭、
    `QQ_APP_ID`/`QQ_APP_SECRET`/`QQ_OPENID`/`QQ_SANDBOX` 环境变量兜底、启动留痕日志。

## 3.1 复验产物

- `tools/smoke.mjs`：离线冒烟（假 ctx 调 `apply()`）。抓「新增 Config 字段忘了在 apply 取」
  这类 ReferenceError，以及「两个 waterfall 必须 prepend 注册」。
  实测有效：`approvalBridge` 当时只加了 schema 没加局部变量，就是它 + 一次真实 `loader.create` 抓出来的。

## 4. 新旧 dsh 契约对照（本次核对过的部分）

| 项 | 旧版（≤0.1.0-rc.5） | 新版（0.1.6-alpha.1） | 插件现状 |
|---|---|---|---|
| 会话事件读取 | `session.events`（getter 数组） | `session.snapshotEvents()` / `ownEvents()` | ✅ 兼容层 |
| `session/event` 签名 | `(session, event)` | 同 | ✅ |
| `turn/end` 载荷 | `{turn, reason:{kind}}` | 同（kind: completed/aborted/blocked/error/max-tokens/interrupted） | ✅ |
| `assistant/message` | `data.message.content` | 同（另有 usage/stream） | ✅ |
| `agent/error` | `{agent, turn, step, error}` | 同 | ✅ |
| `approval/request` | waterfall，返回 `'allowed-once'`/`'rejected'` | 同 | ✅（且必须 prepend 抢占浏览器转发器） |
| `ask_user` 应答 | waterfall `user-questions/request` | 同 | ✅（已改） |
| `agents.get(id)` | 返回**裸** live agent | 同（`create/resume` 才返回 `{agent, dispose}`） | ✅ |
| `sessions.list()` / `header.cwd` | 有 | 有 | ✅ |
| `ctx.on` 在 `inject: []` 下收事件 | 可以 | 可以（非作用域监听器全局接纳） | ✅ |
| 已删除事件 `agent/session-start` | 存在 | **已删除** | 插件未使用 |

## 5. 复验方法（不重启 dsh）

用 `dsh-super-injector` 的 `dev_*` 工具链（工具跑在 dsh 进程内，可绕过文件沙箱）：

1. 冒烟：把 `dist/index.js` 拷成一个新包名 junction 进 profile，`ctx.loader.create({name, config})`
   起一个 `dryRun: true` 的实例；触发一次真实回合（例如派一个只回 PONG 的子智能体），
   检查日志出现 `通知(web 会话) → QQ` 与 `pushQQ(dryRun)`。
2. 上线：`ctx.loader.create({name:'dsh-qq-notify', config})`（真配置，`dryRun:false`），
   看 `网关 WS open` 与 `pushQQ: 成功`。
3. 代码热更时要先清模块缓存：`Map.prototype.delete.call(ctx.loader.internal.loadCache, url)`
   （loadCache key 是 realpath URL），否则 `loader.create` 会命中旧模块。

## 6. 通知降噪（2026-09-17 第二轮，用户要求）

**问题**：修好兼容性后通知「太灵了」——每个回合、每个子代理各推一条。实测日志：一次 4 子代理的
编排任务推了 5 条；单个会话一晚上推了 16 条。用户明确要求「每个子代理、每个小段提示都发，不必要」。

**改成会话级聚合**（`pendingNotices` + `rootAncestorOf()` + `noteActivity()` + `isTurnOpen()`）：

| 规则 | 实现 | 默认 |
|---|---|---|
| 子代理不单独推，折进顶层会话 | `recordSubagentEnd()` 沿 `parentSession` 上溯到 `rootAncestorOf()` | `notifySubagents: false` |
| 连续回合合并成一条 | `noteActivity()` 重排 `notifyQuietMs` 定时器，静默满窗口才推 | `notifyOnlyQuiet: true`，`notifyQuietMs: 20000` |
| 忙碌也有进度 | 定时器里检查 `busyFor >= notifyStaleMs` 则按 stale 推（**一个任务只推一次**） | `notifyStaleMs: 900000` |
| 回合没结束不误报 | `isTurnOpen()`：事件状态 **+ 会话日志兜底**（热装时没看到 turn/start） | — |
| 标题是任务名不是子代理提示词 | `rootTitle` 取顶层会话的会话标题（`session/title`，第三轮后）；子代理只作 `fallbackTitle` | — |

**实测效果**（同一实例、同一类任务）：4 个子代理回合 → **1 条** QQ 消息；5 个子代理 → 1 条。

**踩过的三个坑**（都已写成回归测试 `tools/notify-policy-test.mjs`，23 项）：
1. 嵌套子代理（depth 2）原本各自聚合、各自推送 → 必须上溯到**顶层**。
2. 插件是**回合中途**加载的（热装/重启），没看到 `turn/start` → 误判空闲、回合中途推送，
   把一件事拆成两条。修法：`isTurnOpen()` 再读会话日志推断。
3. 单回合超长时，原实现只在 `turn/end` 时检查 stale → 永远不会兜底。修法：把 stale 判定放进
   定时器触发的 `flushNotice()` 里，让「至少每 N 分钟一条进度」这个承诺真的成立。
4. 标题曾推成「【任务完成】sub-d1」（子代理提示词）→ 改为只取**顶层**会话的标题。
5. stale 兜底原本每次评估都推（长回合里每 5 分钟刷一条）→ 改为**一个任务最多推一次进度**，
   默认阈值放宽到 15 分钟（900000ms），且任务结束时仍会补一条完整完成通知。


## 7. 会话名显示：session-xxxx → 会话标题（2026-09-17 第三轮，用户要求）

**问题**：通知里写 `会话：session-bdc6683a-ce34-4bbc-9f31-b37e0b17dde5`，用户读起来费劲。

**改为三级标题来源**（`sessionTitle()`）：
1. **`session/title` 事件**（`foldTitleFromLog()`，latest-wins）——DSH 自己维护的会话标题，
   由 `@deepseek-ai/dsh-session-title` 写入：LLM provider（`session-title-first-prompt-llm`）优先，
   否则内置 fallback。**这就是网页侧边栏显示的名字**，所以 QQ 与网页一致。
   也可用服务 `ctx.get('sessionTitle').get(session)`（等价，插件走日志折叠以免依赖服务）。
2. 首条**人类** `user/message`（`firstHumanText()`）。
3. 短 id（`shortSessionId()`，如 `bdc6683a`）——只在完全拿不到标题时出现。

**顺带修掉一个静默错误**：原 `sessionTitle()` 取「第一条 `user/message`」，但 `user/message`
不只有人类输入——`source.kind === 'plugin'` 的注入消息（审批策略变更、定时任务、goal 续跑）
也是 user 角色。实测 session-9e4a8729 的首条就是
「The approval policy changed from "ask" to "never" (changed by the user)」，
按旧逻辑通知标题会被带偏成这句话。现在过滤 `source.kind !== 'user'`。

**展示分两处**：
- `sessionName()`：纯标题 —— 通知正文（用户诉求：别显示 id）。
- `sessionLabel()`：标题（短 id）—— 需要用户**挑一个**的场景（`/ws` 会话列表、审批、接入确认），
  短 id 用于同名消歧。

**注意**：DSH fallback 标题上限 5 words / 40 bytes（`dsh-base/cordis.patch.yml` 的 `session-title`），
中文会被截断（如「这是一个老版本dsh的项目，原」）。这是 DSH 的默认行为，与网页 UI 一致，故不额外加工。

**回归覆盖**：`tools/notify-policy-test.mjs` 场景 4/5 —— 标题取 `session/title`、
不被 plugin 注入消息带偏、正文无 `session-` 前缀、带工作区行。

## 8. 选会话菜单混入子代理会话（2026-09-17 第四轮，用户反馈）

**症状**：`/menu` → `W+数字` → 工作区明细里出现了子代理会话，且**可以选中并驱动**。

**根因**：`workspaceInventory()` 只过滤了 QQ 自建会话（`qq:` 前缀），没有排除子代理会话
（`header.origin === 'subagent'` / `delegationDepth > 0`）。
子代理会话的 id 是**裸 UUID**（不带 `session-` 前缀），混在工作区列表里很难一眼认出。

**实测证据（同一份探针，改前 / 改后都在真实 dsh 上跑过）**：

```
# 改前（探针未清 loadCache，命中的是旧模块 —— 等于现场复现了 bug）
6            → 🏢 工作区：/mnt/e/dsh-wait-skill 选择会话：
                 1. 这是一个空项目，我要做的是（366e6557）
                 2. 把四份报告合并为一份「DSH 斜（02bc8532）      ← 子代理
2            → 已接入工作区会话：/mnt/e/dsh-wait-skill 会话：把四份报告合并为一份「DSH 斜（02bc8532）
               日志：选择驱动已有会话 02bc8532… / 复用已有 live agent 02bc8532…（投递到 inbox 队列）
               ⇒ QQ 的下一句话真的被打进了那个子代理

# 改后（清 loadCache 后同一探针）
6            → 🏢 工作区：/mnt/e/dsh-wait-skill 选择会话：
                 1. 这是一个空项目，我要做的是（366e6557）      ← 只剩顶层会话
2            → 无效会话编号。
               日志：枚举会话：跳过 1 个子代理会话（不提供给 QQ 选择）
…/menu 与 /ws 的工作区计数同步变小（dsh-wait-skill：2 → 1）
```

**修法（三处兜底 + 一处锚定）**：

| 位置 | 做法 |
|---|---|
| 清单 | `isDrivableSession()`：跳 `qq:` 前缀 + 跳子代理（`isSubagentSession()`）；`workspaceInventory()` 只列它 |
| 选中时 | `sessionById()` 取 live 会话再核一次 `isDrivableSession()`（防清单与 live 状态不同步） |
| 对话模式入口 | 校验 `u.drivingWsSession`：不是可驱动顶层会话就断开、退回菜单（老状态是持久化的，不校验会继续往子代理发消息） |
| 导航 | `menuNav` 用 `cwd` 锚定（`resolveNavWorkspace()`），不再只靠会漂移的编号 |

**⚠️ 判定字段的坑**：只能用 `header.origin` / `header.delegationDepth`。
`header.parentSession` 是 **fork 血缘**（`isSeeded` 的种子来源），fork 出来的**顶层**会话同样带它——
用它判定会把正常会话从菜单里藏掉（`tools/smoke.mjs` 里有一条专门断言）。

**回归覆盖**：`tools/session-picker-e2e-test.mjs`（32 项；把 dist 拷到临时目录 + 放假 `ws` 模块 +
假网关，真的跑 `apply()` 并喂 `C2C_MESSAGE_CREATE`）＋ `tools/smoke.mjs` 的判定断言。
用单行变异把过滤逻辑改回 bug 前行为，该测试 **12 项转 FAIL**，证明它抓得住这个 bug。

**怎么在真实 dsh 上验证菜单（可复制）**：`dev_stage_add` 挂一个在 dsh 进程内跑的探针——

1. `node:http` 起本地服务：任何请求都回 `{url:'ws://127.0.0.1:<port>/gw'}`；`upgrade` 时手写
   `Sec-WebSocket-Accept` 握手，连上后发 `{op:10,d:{heartbeat_interval:60000}}`；
2. 包一层 `globalThis.fetch`：只截 `getAppAccessToken` 且 body 里含探针 appId 的请求（返回假 token），
   其余透传；
3. **清 `loadCache`**（含 `dsh-qq-notify` 的 key）→ `ctx.loader.create({id, name:'dsh-qq-notify', config})`，
   config 用 `endpoint: 'http://127.0.0.1:<port>'` + `sandbox: false` + `dryRun: true` + `outbox: false`；
4. 收到 upgrade 后，往 socket 写 `{op:0,t:'C2C_MESSAGE_CREATE',d:{author:{user_openid},content}}`
   依次喂 `/menu`、`/ws`、`6`、`2`，每次隔 ~700ms 读 `$DSH_HOME/qq-notify.log` 里
   `pushQQ(dryRun) … 内容=` 后面的原文（= QQ 实际会收到的文本）；
5. 卸载：`[...ctx.loader.entries()].find(e => e.options.id === ID)._dispose()`（**不能**用 `create()`
   返回值上的 `_dispose`，否则 fiber 还在、网关每 5s 重连一次），确认 `hasFiber === false`；
   探针期间把 `process.env.DSH_HOME` 指到临时目录，避免污染真实 log / 会话状态 / pid。

## 9. 通知的正确性收尾：进度话术 / 被吞掉的完成通知 / 热换僵尸（2026-09-18 第五轮）

起因：给第 9 节的修复补测试时，发现「进度播报」这条链路上还有两个真 bug，另加一个热更自伤。

### 10.1 进度播报写成了【任务完成】
`notifyStaleMs` 兜底的 stale 播报走的是同一套渲染，标题用 `entry.lastKind`（= `completed`）→
推出去是「【任务完成】…」，而任务其实还在跑。真实日志（16:11:09）：

```
通知: 会话 session-366e6557 已忙碌 907s（超过 notifyStaleMs），播报一次进度
内容预览：【任务完成】这是一个空项目，我要做的是 含 15 个子代理 工作区：/mnt/e/dsh-wait-skill
```

修：`renderAggregateNotice(entry, { reason })`，`reason === 'stale'` 时标题改「【进度】」并加一行
「任务仍在进行，完成后会再通知一次」。

### 10.2 stale 分支把最终完成通知吞了
`turn/end` 分支里：`if (busyFor >= notifyStaleMs) void flushNotice(sid, 'stale')`。
`flushNotice(stale)` 会清掉静默定时器、保留条目、**不重排**；`recordTurnEnd` 刚排好的那个定时器
就这样没了 → 长任务结束时**只有一条【进度】，永远等不到完成通知**（旧测试之所以「通过」，
是因为它把那条 stale 当成了完成通知——标签一改，测试立刻红）。
修：① stale 播报后 `noteActivity()` 重排静默定时器（保证完成通知必达）；② `turn/end` 分支加
`&& !entry.staleNotified`（长任务不重复播报进度）。
回归：`tools/notify-policy-test.mjs` 场景 3/3b 现在断言「先【进度】后【任务完成】、且完成那条不含进度话术」。

### 10.3 热更留下的「僵尸实例」会推重复通知
`noteActivity()` 的 `setTimeout` **不受 `ctx.effect` 管理** → dispose 不清理。本轮连续热更 3 次
（每次 dispose + `loader.create`）后，旧实例的定时器仍在跑，15 分钟后各自推一条。实测受害：

```
16:26:09 通知: 会话 session-096b714e 已忙碌 901s（超过 notifyStaleMs），播报一次进度   ← 旧实例
16:26:11 pushQQ: 成功                                              ← 用户真收到一条过时消息
```

三道防线（细节见 `AGENTS.md` 决策 12）：dispose 清定时器；推送带 `x-qq-notify-instance` 标记头 +
全局 `fetch` 守卫丢弃无标记的 QQ 推送；全局 `setTimeout` 守卫丢弃无标记的 `flushNotice` 定时器。
验证（真实进程内）：无标记 → 0ms 丢弃、`dropped` +1；带当前标记 → 真实打到 QQ API（返回 401，
说明确实放行）；`timerGuard.dropped` 持续增长 = 旧实例的 re-arm 被吃掉。

> 教训：装守卫的那次尝试里，日志函数用了 `require`（staging 作用域没有）→ 抛错被守卫自己的
> `try/catch` 吞掉 → 判定后的代码没执行，请求**被放行**了。守卫必须双向验证。

## 10. 当前部署状态（WSL，DSH_HOME=/root/.dsh-016）

- 源码/装配源：`/mnt/e/dsh-qq-notify`（junction：`profiles/web/node_modules/dsh-qq-notify`）。
- profile：`package.json`（`link:` 依赖 + `dsh.profile.bundles`）与 `cordis.patch.yml`（config 块）均已恢复。
- profile patch：`bridge: true` / `autoCapture: true`（WSL 是完整双向桥主实例）、
  `askUserBridge: false`（提问浏览器优先）、`approvalBridge: true`（被 QQ 驱动的会话审批走 QQ）、
  `notifySubagents: false` / `notifyOnlyQuiet: true`（通知降噪）。
- 版本 0.3.1（`dist/index.js` sha256 `5640fe7ad3502e21f53c01f25b8f24c274f4828e87c6d7b08d67043e374ad43e`）。
- 运行中的实例是**热换**出来的 entry（`qqlive-*`，配置继承上一代，带 `debug: true`）；
  重启后由 profile patch 装配（无 debug）。两者行为一致，只有「内容预览」日志行在重启后消失。
- 跨实例守卫装在进程全局：`globalThis.__dshQqNotifyPushGuard` / `__dshQqNotifyTimerGuard`
  （重启后由插件重新安装，`dropped` 计数归零）。
- Windows 侧 `C:\Users\枯月流魂\deepseek-harness\dsh-qq-notify\` 同步为同版本（硬链接，重启即生效）。

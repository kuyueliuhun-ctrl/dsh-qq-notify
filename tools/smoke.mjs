#!/usr/bin/env node
/**
 * tools/smoke.mjs — 离线冒烟自检（不连 dsh、不连 QQ）。
 *
 * 用假 ctx 调 `apply()`，抓两类回归：
 *  1) 引用了未声明的配置变量（新增 Config 字段忘了在 apply 里取）→ ReferenceError；
 *  2) 监听器注册表回归：`session/event` ×2、`approval/request` 与
 *     `user-questions/request` 必须 **prepend** 注册（否则会被 dsh-api-remotes 的
 *     浏览器转发器先应答，QQ 永远收不到审批/提问）。
 *
 * 依赖：能解析 `ws` 与 `@deepseek-ai/schemastery`。工作区没有 node_modules 时，
 * 先软链 profile 的依赖：
 *   mkdir -p node_modules/@deepseek-ai
 *   ln -sfn ~/.dsh-016/profiles/web/node_modules/ws node_modules/ws
 *   ln -sfn ~/.dsh-016/profiles/web/node_modules/@deepseek-ai/schemastery node_modules/@deepseek-ai/schemastery
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'qq-smoke-'))

const mod = await import(new URL('../dist/index.js', import.meta.url))

const seen = []
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
  on: (name, _fn, opts) => {
    seen.push({ name, prepend: opts === true || opts?.prepend === true })
    return () => {}
  },
  get: () => undefined,
  effect: () => () => {}, // 不执行网关副作用（避免真连 QQ）
}

// 先装一个 fetch 探针：插件的「跨实例推送守卫」会捕获它当 native，于是能离线观测
// 「哪些请求被守卫丢了 / 哪些被放行」，不会真的打网络。
let spyCalls = 0
globalThis.fetch = () => { spyCalls += 1; return Promise.resolve(new Response('{}', { status: 200 })) }

mod.apply(ctx, {
  appId: 'smoke', appSecret: 'smoke',
  dryRun: true, bridge: true, autoCapture: false,
  askUserBridge: true, approvalBridge: true,
  notifyEvents: ['completed', 'error'], notifySubagents: false,
  debug: false,
})

const failures = []
if (mod.name !== 'qq-notify') failures.push(`name 应为 qq-notify，实际 ${mod.name}`)
if (JSON.stringify(mod.inject) !== '[]') failures.push(`inject 必须为空数组（启动性能），实际 ${JSON.stringify(mod.inject)}`)

const sessionListeners = seen.filter((s) => s.name === 'session/event')
if (sessionListeners.length !== 2) failures.push(`session/event 应注册 2 个，实际 ${sessionListeners.length}`)

for (const evt of ['approval/request', 'user-questions/request']) {
  const hit = seen.filter((s) => s.name === evt)
  if (hit.length !== 1) failures.push(`${evt} 应注册 1 个，实际 ${hit.length}`)
  else if (!hit[0].prepend) failures.push(`${evt} 必须 prepend 注册（抢占浏览器转发器）`)
}

console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject))
for (const s of seen) console.log('  listener:', s.name, s.prepend ? '(prepend)' : '')

// ---- 会话选择过滤：子代理会话不得出现在 QQ 的「选择会话」列表里 ----------------
// 数据取自 live dsh（0.1.6-alpha.1）`sessions.list()` 的真实快照：子代理会话的 id
// **没有 `session-` 前缀**（裸 UUID），只能靠 header.origin/delegationDepth 认出来。
const realSessions = [
  { id: 'session-bdc6683a-ce34-4bbc-9f31-b37e0b17dde5', header: { cwd: '/mnt/e/clash-royale-simulator-main', delegationDepth: 0 } },
  { id: 'session-096b714e-ea80-44bc-a3db-f1a409ec7f4f', header: { cwd: '/mnt/e/dsh-qq-notify' } }, // 无 depth 的顶层会话
  { id: 'session-366e6557-62ff-4cb2-8b81-b33c629624ed', header: { cwd: '/mnt/e/dsh-wait-skill' } },
  { id: 'f57cf5f3-2c46-46b2-8821-c87b72e63ffe', header: { cwd: '/mnt/e/dsh-wait-skill', origin: 'subagent', delegationDepth: 1, parentSession: 'session-366e6557-62ff-4cb2-8b81-b33c629624ed' } },
  { id: 'a3d1a4d8-745c-417f-8f74-f1732fb60229', header: { cwd: '/mnt/e/dsh-wait-skill', origin: 'subagent', delegationDepth: 2, parentSession: 'f57cf5f3-2c46-46b2-8821-c87b72e63ffe' } },
  { id: '648bf72b-b691-46dd-aaae-c1dd25147e28', header: { cwd: '/mnt/e/dsh-wait-skill', delegationDepth: 3, parentSession: '494f60f0-4ab6-4db7-b9bd-f2a70bece70f' } }, // 只有 depth
  { id: 'qq:OPENID1234567890', header: { cwd: '/tmp' } }, // QQ 自建会话
]
const drivable = realSessions.filter((s) => mod.isDrivableSession(s)).map((s) => s.id)
const expectDrivable = [
  'session-bdc6683a-ce34-4bbc-9f31-b37e0b17dde5',
  'session-096b714e-ea80-44bc-a3db-f1a409ec7f4f',
  'session-366e6557-62ff-4cb2-8b81-b33c629624ed',
]
if (JSON.stringify(drivable) !== JSON.stringify(expectDrivable)) {
  failures.push(`可驱动会话应为 3 个顶层会话，实际 ${JSON.stringify(drivable)}`)
}
for (const s of realSessions) {
  const isSub = s.id === 'f57cf5f3-2c46-46b2-8821-c87b72e63ffe'
    || s.id === 'a3d1a4d8-745c-417f-8f74-f1732fb60229'
    || s.id === '648bf72b-b691-46dd-aaae-c1dd25147e28'
  if (mod.isSubagentSession(s) !== isSub) failures.push(`isSubagentSession(${s.id}) 应为 ${isSub}`)
}
// fork 血缘（parentSession）不是子代理标记：从别的会话 fork 出来的顶层会话必须仍可选。
const forkedTopLevel = { id: 'session-forked-top', header: { cwd: '/tmp/x', parentSession: 'session-bdc6683a-ce34-4bbc-9f31-b37e0b17dde5', isSeeded: true } }
if (mod.isSubagentSession(forkedTopLevel)) failures.push('fork 出来的顶层会话（只有 parentSession）被误判为子代理')
if (!mod.isDrivableSession(forkedTopLevel)) failures.push('fork 出来的顶层会话不应被菜单过滤掉')
console.log('  drivable:', drivable.length, '顶层会话（跳过', realSessions.length - drivable.length, '个 QQ 自建/子代理会话）')

// ---- 跨实例守卫：热换/卸载后残留的旧实例不许再推 QQ 通知 --------------------
// 2026-09-18 真实踩过：连续热更 3 次留下 3 个僵尸实例，各自的定时器照样推消息（用户收到重复通知）。
const pushGuard = globalThis.__dshQqNotifyPushGuard
const timerGuard = globalThis.__dshQqNotifyTimerGuard
if (pushGuard === undefined || timerGuard === undefined) failures.push('apply 应安装「推送守卫 + 通知定时器守卫」')
else {
  const QQ_URL = 'https://api.sgroup.qq.com/v2/users/FAKEOPENID/messages'
  const header = 'x-qq-notify-instance'
  const before = spyCalls
  await fetch(QQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  if (spyCalls !== before) failures.push('不带实例标记的 QQ 推送必须被丢弃（残留实例防护），实际被放行')
  if (pushGuard.dropped < 1) failures.push(`丢弃计数应 +1，实际 ${pushGuard.dropped}`)
  await fetch(QQ_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', [header]: pushGuard.token }, body: '{}' })
  if (spyCalls !== before + 1) failures.push('带当前实例标记的 QQ 推送必须放行，实际被丢弃')

  // 定时器守卫：没标记的「通知形状」定时器（旧实例的）不执行；带当前标记的正常执行。
  let rogueFired = false
  let markedFired = false
  setTimeout(function flushNoticeRogue() { rogueFired = true }, 5)
  const okTimer = () => { markedFired = true }
  okTimer.__qqNotifyNoticeTimer = timerGuard.token
  setTimeout(okTimer, 5)
  await new Promise((r) => { setTimeout(r, 60) })
  if (rogueFired) failures.push('无标记的通知定时器必须被丢弃（残留实例的幽灵定时器）')
  if (!markedFired) failures.push('带当前实例标记的通知定时器必须执行')
  if (timerGuard.dropped < 1) failures.push(`定时器守卫丢弃计数应 ≥1，实际 ${timerGuard.dropped}`)
  console.log('  guards: push.dropped =', pushGuard.dropped, '| timer.dropped =', timerGuard.dropped, '| 标记 =', pushGuard.token)
}

if (failures.length > 0) {
  console.error('\nSMOKE FAIL:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log('\nSMOKE PASS')

#!/usr/bin/env node
/**
 * tools/notify-policy-test.mjs — 通知降噪策略的离线回归测试（不连 dsh、不连 QQ）。
 *
 * 覆盖三个真实踩过的坑（每个都对应线上出现过的问题）：
 *  1) 嵌套子代理（depth 2）必须折进**顶层**会话，且标题取顶层任务名，不是子代理提示词；
 *  2) 插件在**回合中途**加载（热装/重启，没看到 turn/start）时，不能把一件事拆成两条；
 *  3) 单个超长回合（一直不结束）也要按 notifyStaleMs 兜底推一次进度。
 *
 * 依赖同 tools/smoke.mjs（能解析 ws / @deepseek-ai/schemastery）。
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 起一个假 dsh：给定会话集合与配置，返回 { fire, log, pushCount }。
 * `preopenTurn` 模拟「插件加载时回合已经开着」（热装场景）。
 */
async function harness({ sessions, preopenTurn = false, quietMs = 120, staleMs = 60000, cfg = {} }) {
  const home = mkdtempSync(join(tmpdir(), 'qq-policy-'))
  process.env.DSH_HOME = home
  // 每次换 DSH_HOME 后重新 import 会命中缓存，但插件只在 apply 时读 env，所以够用。
  const mod = await import(new URL('../dist/index.js', import.meta.url))

  const handlers = {}
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on: (n, fn) => { (handlers[n] ??= []).push(fn); return () => {} },
    get: (svc) => svc === 'sessions'
      ? { list: () => sessions, get: (id) => sessions.find((s) => s.id === id) }
      : undefined,
    effect: () => () => {},
  }
  mod.apply(ctx, {
    appId: '1', appSecret: 'x', bridge: false, autoCapture: false, outbox: false,
    openid: 'OPENID1234567890', dryRun: true, notifyEvents: ['completed', 'error'],
    notifySubagents: false, notifyOnlyQuiet: true,
    notifyQuietMs: quietMs, notifyStaleMs: staleMs, debug: false, ...cfg,
  })
  if (preopenTurn) {
    for (const s of sessions) if (s.header.__openTurn) s.log.push({ type: 'turn/start', seq: 1, time: Date.now() - 92_000, data: { turn: 1 } })
  }
  const notify = handlers['session/event'].at(-1)
  const fire = (s, type, data) => notify(s, { type, seq: 9, time: Date.now(), data })
  const end = (s, turn = 1, kind = 'completed') => {
    s.log.push({ type: 'turn/end', seq: 5, data: { turn, reason: { kind } } })
    fire(s, 'turn/end', { turn, reason: { kind } })
  }
  const readLog = () => { try { return readFileSync(join(home, 'qq-notify.log'), 'utf8') } catch { return '' } }
  const pushCount = () => (readLog().match(/pushQQ\(dryRun\)/g) ?? []).length
  const contents = () => readLog().split('\n').filter((l) => l.includes('内容=')).map((l) => l.split('内容=')[1])
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  return { fire, end, pushCount, contents, readLog, wait, sessions }
}

const mkSession = (id, header = {}) => ({
  id, header: { id, ...header }, log: [],
  snapshotEvents() { return this.log },
})
const userMsg = (s, text) => s.log.push({
  type: 'user/message', seq: 0,
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

// ---------- 场景 1：嵌套子代理折进顶层，标题取顶层任务名 ----------
console.log('场景 1：嵌套子代理（depth 2）+ 顶层回合结束')
{
  const ROOT = mkSession('root-sess', { cwd: '/tmp/ws' })
  const D1 = mkSession('sub-d1', { cwd: '/tmp/ws', parentSession: 'root-sess', origin: 'subagent', delegationDepth: 1 })
  const D2 = mkSession('sub-d2', { cwd: '/tmp/ws', parentSession: 'sub-d1', origin: 'subagent', delegationDepth: 2 })
  userMsg(ROOT, '做个编排任务')
  const h = await harness({ sessions: [ROOT, D1, D2] })
  h.fire(ROOT, 'turn/start', { turn: 1 })
  h.end(D1); h.end(D2); h.end(ROOT)
  await h.wait(300)
  check('只推一条', h.pushCount() === 1, `实际 ${h.pushCount()}`)
  check('无子代理单独推送', !h.readLog().includes('通知(子代理单独)'))
  const text = h.contents()[0] ?? ''
  check('标题是顶层任务名', text.includes('做个编排任务'), text.slice(0, 40))
  check('统计到 2 个子代理', text.includes('含 2 个子代理'), text.slice(0, 60))
}

// ---------- 场景 2：回合中途加载（看不到 turn/start）不能拆成两条 ----------
console.log('场景 2：插件在回合中途加载（热装）')
{
  const ROOT = mkSession('root-sess', { cwd: '/tmp/ws', __openTurn: true })
  const SUB = mkSession('sub-1', { cwd: '/tmp/ws', parentSession: 'root-sess', origin: 'subagent', delegationDepth: 1 })
  userMsg(ROOT, '长任务')
  const h = await harness({ sessions: [ROOT, SUB], preopenTurn: true })
  h.end(SUB)
  await h.wait(300)
  check('子代理结束时未推送（父回合还开着）', h.pushCount() === 0, `实际 ${h.pushCount()}`)
  h.end(ROOT)
  await h.wait(300)
  check('父回合结束后共推一条', h.pushCount() === 1, `实际 ${h.pushCount()}`)
  check('标题是顶层任务名', (h.contents()[0] ?? '').includes('长任务'), (h.contents()[0] ?? '').slice(0, 40))
}

// ---------- 场景 2b：同上，但开 debug，核对「推迟」留痕 ----------
console.log('场景 2b：热装场景的推迟留痕（debug 开）')
{
  const ROOT = mkSession('root-sess', { cwd: '/tmp/ws', __openTurn: true })
  const SUB = mkSession('sub-1', { cwd: '/tmp/ws', parentSession: 'root-sess', origin: 'subagent', delegationDepth: 1 })
  userMsg(ROOT, '长任务')
  const h = await harness({ sessions: [ROOT, SUB], preopenTurn: true, cfg: { debug: true } })
  h.end(SUB)
  await h.wait(300)
  check('有「仍在忙，推迟」日志', h.readLog().includes('仍在忙'), h.readLog().split('\n').filter((l) => l.includes('仍在忙')).slice(-1)[0] ?? '(无)')
}

// ---------- 场景 3：单回合长时间运行 → notifyStaleMs 兜底 ----------
console.log('场景 3：超长单回合的进度兜底')
{
  const ROOT = mkSession('root-sess', { cwd: '/tmp/ws', __openTurn: true })
  const SUB = mkSession('sub-1', { cwd: '/tmp/ws', parentSession: 'root-sess', origin: 'subagent', delegationDepth: 1 })
  userMsg(ROOT, '超长任务')
  const h = await harness({ sessions: [ROOT, SUB], preopenTurn: true, quietMs: 100, staleMs: 300 })
  h.end(SUB)
  await h.wait(200)
  check('早期不推（回合还开着）', h.pushCount() === 0, `实际 ${h.pushCount()}`)
  await h.wait(600)
  check('超过 notifyStaleMs 兜底推一条', h.pushCount() === 1, `实际 ${h.pushCount()}`)
  check('有兜底日志', h.readLog().includes('播报一次进度'), h.readLog().split('\n').filter((l) => l.includes('播报')).slice(-1)[0] ?? '(无)')
  check('标题是顶层任务名', (h.contents()[0] ?? '').includes('超长任务'), (h.contents()[0] ?? '').slice(0, 40))
  // 进度播报不能写成【任务完成】——任务其实还在跑（真实踩过：900s 的会话推「【任务完成】…」）。
  check('进度播报标为【进度】', (h.contents()[0] ?? '').startsWith('【进度】'), (h.contents()[0] ?? '').slice(0, 20))
  check('进度播报说明还会再通知', (h.contents()[0] ?? '').includes('任务仍在进行'), (h.contents()[0] ?? '').slice(0, 60))
  // 热装（回合中途加载）看不到 turn/start 事件 → 必须从会话日志里补起点，否则通知没有「总耗时」。
  check('热装也报得出总耗时', /总耗时：1 分 [0-9]+ 秒/.test(h.contents()[0] ?? ''), (h.contents()[0] ?? '').match(/总耗时：[0-9]+ 分 [0-9]+ 秒/)?.[0] ?? '(无总耗时行)')
}

// ---------- 场景 4：标题来源（session/title 优先；不能被 plugin 注入的消息带偏） ----------
console.log('场景 4：会话标题解析')
{
  const ROOT = mkSession('root-sess', { cwd: '/tmp/ws' })
  // 关键：首条 user/message 是**插件注入**的（真实案例：审批策略变更通知），不是人类输入
  ROOT.log.push({
    type: 'user/message', seq: 0,
    data: { role: 'user', content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never"' }], source: { kind: 'plugin', plugin: 'x' } },
  })
  ROOT.log.push({ type: 'session/title', seq: 1, data: { title: '帮我查找两种插件', messageSeqs: [9], source: { kind: 'fallback' } } })
  ROOT.log.push({
    type: 'user/message', seq: 2,
    data: { role: 'user', content: [{ type: 'text', text: '帮我查找两种插件：一.可以在…' }], source: { kind: 'user' } },
  })
  const h = await harness({ sessions: [ROOT] })
  h.fire(ROOT, 'turn/start', { turn: 1 })
  h.end(ROOT)
  await h.wait(300)
  const text = h.contents()[0] ?? ''
  check('标题用 session/title', text.includes('帮我查找两种插件'), text.slice(0, 50))
  check('没被 plugin 注入消息带偏', !text.includes('approval policy changed'), text.slice(0, 60))
  check('通知正文里没有 session- 前缀', !text.includes('session-'), text.slice(0, 80))
  check('带上工作区便于定位', text.includes('工作区：/tmp/ws'), text.slice(0, 90))
}

// ---------- 场景 5：没有 session/title 时退回首条**人类**消息 ----------
console.log('场景 5：无标题时回落到人类消息（跳过 plugin 注入）')
{
  const ROOT = mkSession('root-sess-2', { cwd: '/tmp/ws2' })
  ROOT.log.push({
    type: 'user/message', seq: 0,
    data: { role: 'user', content: [{ type: 'text', text: '定时任务：检查依赖更新' }], source: { kind: 'plugin', plugin: 'cron' } },
  })
  ROOT.log.push({
    type: 'user/message', seq: 1,
    data: { role: 'user', content: [{ type: 'text', text: '把构建脚本里的旧依赖升一下' }], source: { kind: 'user' } },
  })
  const h = await harness({ sessions: [ROOT] })
  h.fire(ROOT, 'turn/start', { turn: 1 })
  h.end(ROOT)
  await h.wait(300)
  const text = h.contents()[0] ?? ''
  check('回落到人类消息', text.includes('把构建脚本里的旧依赖升一下'), text.slice(0, 50))
  check('跳过了 plugin 注入的定时任务文案', !text.includes('定时任务：检查依赖更新'), text.slice(0, 60))
}

// ---------- 场景 3b：stale 进度播报每个任务只发一次 ----------
console.log('场景 3b：stale 播报不重复（长任务最多一条进度 + 一条完成）')
{
  const ROOT = mkSession('root-sess', { cwd: '/tmp/ws', __openTurn: true })
  const SUB = mkSession('sub-1', { cwd: '/tmp/ws', parentSession: 'root-sess', origin: 'subagent', delegationDepth: 1 })
  userMsg(ROOT, '超长任务')
  const h = await harness({ sessions: [ROOT, SUB], preopenTurn: true, quietMs: 80, staleMs: 150 })
  h.end(SUB)
  await h.wait(400) // 足够触发 stale
  check('播报了一次进度', h.pushCount() === 1, `实际 ${h.pushCount()}`)
  check('日志标记为 stale', h.readLog().includes('通知(stale)'))
  // 再来一轮活动：回合还开着 → 不应再播报
  const SUB2 = mkSession('sub-2', { cwd: '/tmp/ws', parentSession: 'root-sess', origin: 'subagent', delegationDepth: 1 })
  h.sessions.push(SUB2)
  h.end(SUB2)
  await h.wait(500)
  check('重复活动不再刷 stale', h.pushCount() === 1, `实际 ${h.pushCount()}`)
  // 回合真正结束 → 应补一条完成通知
  ROOT.header.__openTurn = false
  ROOT.log.push({ type: 'turn/end', seq: 7, data: { turn: 1, reason: { kind: 'completed' } } })
  h.fire(ROOT, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await h.wait(300)
  check('任务结束补一条完成通知', h.pushCount() === 2, `实际 ${h.pushCount()}`)
  check('完成通知标题正确', (h.contents()[1] ?? '').includes('超长任务'), (h.contents()[1] ?? '').slice(0, 40))
  check('完成通知仍标【任务完成】', (h.contents()[1] ?? '').startsWith('【任务完成】'), h.contents().map((c, i) => `${i}:${c.slice(0, 18)}`).join(' | '))
  check('最终完成通知里不再出现进度话术', !(h.contents()[1] ?? '').includes('任务仍在进行'), h.contents()[1]?.slice(0, 40) ?? '')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'POLICY TEST PASS' : `POLICY TEST FAIL（${failed.length} 项）`}  [${results.length - failed.length}/${results.length}]`)
if (failed.length > 0) process.exit(1)

#!/usr/bin/env node
/**
 * tools/session-picker-e2e-test.mjs — 「QQ 私聊 → 插件渲染菜单 → 推送 QQ」离线端到端回归。
 *
 * 回归的 bug：**会话选择菜单里混进了子代理（subagent）会话**。
 * 期望的最终行为：子代理会话不得出现在任何「给用户挑」的列表里
 * （/menu 的工作区计数、/ws 的工作区列表、工作区明细的可选会话）。
 *
 * 与 tools/notify-policy-test.mjs 的区别（也是本文件的难点）：
 *   插件自己 `import WebSocket from 'ws'`，测试没法 monkey-patch 全局。
 *   所以本测试把 dist/index.js **拷到临时目录**，并在临时目录里造一个
 *   `<tmp>/node_modules/ws` 假模块（Node ESM 解析会先命中它），
 *   再软链 `@deepseek-ai/schemastery` 到真包。全局 fetch 用 `globalThis.fetch` 打桩。
 *   这样 apply() 会真正跑起来：建网关连接 → op:10 鉴权 → op:0 C2C_MESSAGE_CREATE → 业务逻辑。
 *
 * 运行：node tools/session-picker-e2e-test.mjs   （退出码非 0 = 有断言失败）
 * 不修改 dist/index.js、不连 dsh、不连真实 QQ。
 *
 * 灵敏度自检（变异测试，证明本测试不是在空跑）：
 *   环境变量 QQ_NOTIFY_DIST 可指向任意副本。把「只列可驱动会话」的那行改回
 *   bug 前的「只跳 qq: 前缀」，再跑一次，应当有 12 项 FAIL：
 *
 *     node -e 'const{readFileSync,writeFileSync}=require("node:fs");
 *       let s=readFileSync("dist/index.js","utf8");
 *       s=s.replace(/if \(!isDrivableSession\(s\)\) \{[^\n]*\n/,
 *         "if (!s || typeof s.id !== \"string\" || s.id.startsWith(\"qq:\")) continue\n");
 *       writeFileSync("/tmp/buggy-index.js",s)'
 *     QQ_NOTIFY_DIST=/tmp/buggy-index.js node tools/session-picker-e2e-test.mjs   # → 12 FAIL
 *
 *   （git HEAD 里的 dist/index.js 是更老的一代，没有 dryRun，无法直接拿来跑本测试，
 *     所以用上面的单行变异复刻同样的「只跳 qq: 前缀」行为。）
 */
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, symlinkSync, readFileSync, rmSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
// 默认测仓库里的 dist/index.js。QQ_NOTIFY_DIST 可指向别处的副本，
// 用于「变异测试」自检：把过滤逻辑改回旧的只跳 qq: 前缀，确认本测试确实会 FAIL。
const DIST = process.env.QQ_NOTIFY_DIST ? resolve(process.env.QQ_NOTIFY_DIST) : join(REPO, 'dist/index.js')
const OPENID = 'OPENID1234567890'

// ---------------------------------------------------------------- 断言台账
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (t) => console.log(`\n${t}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------- 假 ws（临时 node_modules）
const FAKE_WS_SRC = `// 假 ws 模块：只实现 dist/index.js 用到的那部分 API。
const instances = []
class FakeWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  constructor(url) {
    this.url = url
    this.readyState = FakeWebSocket.CONNECTING
    this.sent = []
    this.handlers = {}
    instances.push(this)
  }
  on(event, fn) { (this.handlers[event] ??= []).push(fn); return this }
  send(str) { this.sent.push(String(str)); return true }
  close(code = 1000, reason = '') {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.__emit('close', code, String(reason))
  }
  // --- 测试侧可控入口 ---
  __emit(event, ...args) { for (const fn of this.handlers[event] ?? []) fn(...args) }
  __open() { this.readyState = FakeWebSocket.OPEN; this.__emit('open') }
  __server(obj) { this.__emit('message', typeof obj === 'string' ? obj : JSON.stringify(obj)) }
}
export default FakeWebSocket
export { instances as __instances }
globalThis.__FAKE_WS__ = { instances, last: () => instances[instances.length - 1] }
`

/** 造临时插件副本 + 假 ws + schemastery 软链。返回 { tmp, home, distHash }。 */
function setupTempPlugin() {
  const source = readFileSync(DIST)
  const distHash = createHash('sha256').update(source).digest('hex')
  const tmp = mkdtempSync(join(tmpdir(), 'qq-picker-'))
  const home = join(tmp, 'home')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(tmp, 'dist'), { recursive: true })
  writeFileSync(join(tmp, 'dist/index.js'), source)
  const wsDir = join(tmp, 'node_modules/ws')
  mkdirSync(wsDir, { recursive: true })
  writeFileSync(join(wsDir, 'package.json'), JSON.stringify({
    name: 'ws', version: '0.0.0-fake', type: 'module', main: 'index.js', exports: { '.': './index.js' },
  }, null, 2))
  writeFileSync(join(wsDir, 'index.js'), FAKE_WS_SRC)
  mkdirSync(join(tmp, 'node_modules/@deepseek-ai'), { recursive: true })
  const realSchema = realpathSync(join(REPO, 'node_modules/@deepseek-ai/schemastery'))
  symlinkSync(realSchema, join(tmp, 'node_modules/@deepseek-ai/schemastery'), 'dir')
  return { tmp, home, distHash }
}

/** globalThis.fetch 打桩：token / gateway 两个真实 URL。 */
function installFetch() {
  const prev = globalThis.fetch
  const calls = []
  const jsonRes = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
  globalThis.fetch = async (url) => {
    const u = String(url)
    calls.push(u)
    if (u.includes('getAppAccessToken')) return jsonRes(200, { access_token: 'fake-token', expires_in: 7200 })
    if (u.endsWith('/gateway')) return jsonRes(200, { url: 'wss://fake-gateway.local' })
    return jsonRes(200, {})
  }
  return { calls, restore: () => { globalThis.fetch = prev } }
}

// ------------------------------------------------- 真实形状的假会话（照抄线上）
const WS_A = '/mnt/e/clash-royale-simulator-main'
const WS_B = '/mnt/e/dsh-wait-skill'   // 该 cwd 下「只有子代理会话」
const WS_C = '/mnt/e/dsh-qq-notify'    // 该 cwd 下 1 个顶层 + 1 个「仅 delegationDepth」子代理

/** 顶层会话：log 只放一条 session/title（标题来源）。 */
const mkTop = (id, cwd, title) => ({
  id,
  header: { id, cwd, delegationDepth: 0 },
  log: [{ type: 'session/title', seq: 1, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'fallback' } } }],
  snapshotEvents() { return this.log },
})
const mkSub = (id, cwd, title, extra) => ({
  id,
  header: { id, cwd, ...extra },
  log: [{ type: 'session/title', seq: 1, time: Date.now(), data: { title, messageSeqs: [], source: { kind: 'fallback' } } }],
  snapshotEvents() { return this.log },
})

// 会话列表顺序 = 会话存储顺序，决定工作区首次出现顺序：A → C → B
const T1 = mkTop('session-bdc6683a-ce34-4bbc-9f31-b37e0b17dde5', WS_A, '皇室战争模拟器重构')
const T2 = mkTop('session-366e6557-62ff-4cb2-8b81-b33c629624ed', WS_C, 'QQ 通知插件开发')
const S3 = mkSub('c9b2e5f1-77ab-4d3e-9c02-1f4e8b6d5a30', WS_C, '仅depth标记子代理', { delegationDepth: 1 }) // 无 origin
const T3 = mkTop('session-7c1f0a92-4d5b-4e88-9a30-2b6c8d1e4f07', WS_A, '卡组数据校对')
const S1 = mkSub('f57cf5f3-2c46-46b2-8821-c87b72e63ffe', WS_B, '等待技能子代理',
  { origin: 'subagent', delegationDepth: 1, parentSession: T2.id })
const S2 = mkSub('a3d1a4d8-9f2c-4a1b-8e77-3d5c6b0a91ee', WS_B, '深一层子代理',
  { origin: 'subagent', delegationDepth: 2, parentSession: S1.id })
const SESSIONS = [T1, T2, S3, T3, S1, S2]

const SUB_SHORT_IDS = ['f57cf5f3', 'a3d1a4d8', 'c9b2e5f1']
const SUB_TITLES = ['等待技能子代理', '深一层子代理', '仅depth标记子代理']
const TOP_TITLES = ['皇室战争模拟器重构', 'QQ 通知插件开发', '卡组数据校对']

// ---------------------------------------------------------------- 文本解析小工具
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** /menu 里的工作区行：`W2. <cwd> (3)` */
const menuWsLine = (text, cwd) => {
  const m = new RegExp(`W(\\d+)\\.\\s*${escapeRe(cwd)}\\s*\\((\\d+)\\)`).exec(text)
  return m ? { idx: Number(m[1]), count: Number(m[2]) } : null
}
/** /ws 里的工作区行：`2. <cwd> (3)` */
const wsLine = (text, cwd) => {
  const m = new RegExp(`(?:^|\\s)(\\d+)\\.\\s*${escapeRe(cwd)}\\s*\\((\\d+)\\)`).exec(text)
  return m ? { idx: Number(m[1]), count: Number(m[2]) } : null
}
/** 数出 /ws 正文里一共几行工作区。 */
const countWsLines = (text) => [...text.matchAll(/(?:^|\s)(\d+)\.\s*(\/[^\s]+)\s*\((\d+)\)/g)].length
/** 工作区明细里的会话行：`1. 标题（短id）` */
const detailSessions = (text) => [...text.matchAll(/(?:^|\s)(\d+)\.\s*([^（\s][^（]*?)（([^）]+)）/g)]
  .map((m) => ({ n: Number(m[1]), title: m[2].trim(), short: m[3].trim() }))

// ================================================================ 主流程
const observed = { menu: '', ws: '', detailA: '', detailC: '', detailB: '' }

async function main() {
  const { tmp, home, distHash } = setupTempPlugin()
  process.env.DSH_HOME = home
  const fetched = installFetch()

  console.log(`session-picker e2e — 被测文件 ${DIST}`)
  console.log(`  sha256=${distHash}`)
  console.log(`临时插件目录：${tmp}`)

  const mod = await import(new URL(`file://${join(tmp, 'dist/index.js')}`))
  check('dist/index.js 可被 ESM 导入且导出 apply/name',
    typeof mod.apply === 'function' && typeof mod.name === 'string', `name=${mod.name}`)

  // ---- 假 ctx（照抄 notify-policy-test 的 harness 风格）----
  const handlers = {}
  const disposers = []
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    on: (n, fn) => { (handlers[n] ??= []).push(fn); return () => {} },
    get: (svc) => svc === 'sessions'
      ? { list: () => SESSIONS, get: (id) => SESSIONS.find((s) => s.id === id) }
      : undefined,
    // 关键：必须真的执行 effect 回调，否则网关根本不会建（notify-policy-test 直接丢掉回调）
    effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d); return () => {} },
  }

  mod.apply(ctx, {
    appId: '1', appSecret: 'x', bridge: true, autoCapture: false, outbox: false,
    openid: OPENID, dryRun: true, debug: false, notifySubagents: false,
    notifyQuietMs: 600000, notifyStaleMs: 600000,
  })

  const readLog = () => { try { return readFileSync(join(home, 'qq-notify.log'), 'utf8') } catch { return '' } }
  const pushCount = () => (readLog().match(/pushQQ\(dryRun\)/g) ?? []).length
  const contents = () => readLog().split('\n').filter((l) => l.includes('内容=')).map((l) => l.split('内容=')[1])
  const waitPush = async (n, ms = 3000) => {
    const t0 = Date.now()
    while (pushCount() < n && Date.now() - t0 < ms) await sleep(10)
    return pushCount() >= n
  }

  // ---- 等网关连接建立（假 ws 实例出现）----
  const fake = globalThis.__FAKE_WS__
  const t0 = Date.now()
  while ((!fake || fake.instances.length === 0) && Date.now() - t0 < 3000) await sleep(10)

  section('一、网关链路是否真的走通（假 ws + 打桩 fetch）')
  check('apply() 经假 WebSocket 建立网关连接（未被真 ws 绕过）',
    !!fake && fake.instances.length === 1, `instances=${fake ? fake.instances.length : 'none'}`)
  const sock = fake?.instances?.[0] ?? fake?.last?.()
  check('网关 URL 来自打桩的 /gateway 响应', sock?.url === 'wss://fake-gateway.local', `url=${sock?.url}`)
  check('token 请求打到 /app_access_token 打桩',
    fetched.calls.some((u) => u.includes('getAppAccessToken')), fetched.calls.join(' , '))
  check('尚未发消息时没有任何推送（基线干净）', pushCount() === 0, `实际 ${pushCount()}`)

  // ---- op:10 hello → 插件应回 op:2 鉴权 ----
  sock.__open()
  sock.__server({ op: 10, d: { heartbeat_interval: 60000 } })
  await sleep(30)
  const authMsg = (sock.sent ?? []).map((s) => { try { return JSON.parse(s) } catch { return null } }).find((p) => p?.op === 2)
  check('收到 op:10 后插件发出 op:2 鉴权帧', !!authMsg,
    authMsg ? `op:2 token=${String(authMsg.d?.token).slice(0, 12)}…` : `sent=${JSON.stringify(sock.sent)}`)

  // ---- 测试侧「服务器推送」入口：发一条 C2C 私聊 ----
  let seq = 30
  const ask = async (content) => {
    const before = pushCount()
    sock.__server({
      op: 0, s: (seq += 1), t: 'C2C_MESSAGE_CREATE',
      d: { id: `msg-${seq}`, content, author: { user_openid: OPENID, member_openid: OPENID } },
    })
    const ok = await waitPush(before + 1)
    if (!ok) return `<<无推送，超时；日志尾巴：${readLog().split('\n').slice(-3).join(' | ')}>>`
    return contents().at(-1) ?? ''
  }

  // ---- 1) /menu ----
  section('二、/menu（主菜单：QQ 会话 + 工作区入口）')
  observed.menu = await ask('/menu')
  console.log(`  [观测原文 /menu] ${observed.menu}`)
  const menuWsCount = (() => { const m = /已有工作区（(\d+)）/.exec(observed.menu); return m ? Number(m[1]) : null })()
  const menuLineCount = [...observed.menu.matchAll(/W(\d+)\.\s*(\/[^\s]+)\s*\((\d+)\)/g)].length
  const mA = menuWsLine(observed.menu, WS_A)
  const mC = menuWsLine(observed.menu, WS_C)
  const mB = menuWsLine(observed.menu, WS_B)

  check('/menu 正文里出现工作区标题行', observed.menu.includes('已有工作区'), observed.menu.slice(0, 60))
  check('/menu 工作区计数 = 2（WS_A 2 个顶层 + WS_C 1 个顶层；WS_B 全是子代理不算）',
    menuWsCount === 2, `实际 ${menuWsCount}`)
  check('/menu 只列出 2 个工作区行', menuLineCount === 2, `实际 ${menuLineCount}`)
  check(`/menu 里 ${WS_A} 计数 = 2（同工作区多顶层会话）`,
    mA?.count === 2, `实际 ${mA ? mA.count : '未出现'}`)
  check(`/menu 里 ${WS_C} 计数 = 1（只算顶层，剔除 delegationDepth-only 子代理）`,
    mC?.count === 1, `实际 ${mC ? mC.count : '未出现'}`)
  check(`/menu 里子代理专属工作区 ${WS_B} 不出现、或计数为 0`,
    !mB || mB.count === 0, mB ? `实际出现且计数 ${mB.count}` : '未出现')
  check('/menu 正文不含任何子代理会话短 id',
    !SUB_SHORT_IDS.some((s) => observed.menu.includes(s)), SUB_SHORT_IDS.filter((s) => observed.menu.includes(s)).join(' , ') || '无')
  check('/menu 正文不含任何子代理标题',
    !SUB_TITLES.some((t) => observed.menu.includes(t)), SUB_TITLES.filter((t) => observed.menu.includes(t)).join(' , ') || '无')

  // ---- 2) /ws ----
  section('三、/ws（工作区编号列表）')
  observed.ws = await ask('/ws')
  console.log(`  [观测原文 /ws] ${observed.ws}`)
  const wA = wsLine(observed.ws, WS_A)
  const wC = wsLine(observed.ws, WS_C)
  const wB = wsLine(observed.ws, WS_B)

  check('/ws 列出工作区列表', observed.ws.includes('已有工作区'), observed.ws.slice(0, 60))
  check('/ws 只列出 2 个工作区', countWsLines(observed.ws) === 2, `实际 ${countWsLines(observed.ws)}`)
  check(`/ws 里 ${WS_A} 为 (2) 且编号=1`, wA?.count === 2 && wA?.idx === 1,
    wA ? `编号 ${wA.idx} 计数 ${wA.count}` : '未出现')
  check(`/ws 里 ${WS_C} 计数 = 1`, wC?.count === 1, wC ? `编号 ${wC.idx} 计数 ${wC.count}` : '未出现')
  check(`/ws 里子代理专属工作区 ${WS_B} 不出现、或计数为 0`,
    !wB || wB.count === 0, wB ? `实际出现且计数 ${wB.count}` : '未出现')

  // ---- 3) 回编号进工作区明细：WS_A（含 2 个顶层）----
  section('四、回编号进入工作区明细')
  observed.detailA = await ask(String(wA?.idx ?? 1))
  console.log(`  [观测原文 明细 WS_A] ${observed.detailA}`)
  const dA = detailSessions(observed.detailA)
  check(`明细 header 指向 ${WS_A}`, observed.detailA.includes(WS_A), observed.detailA.slice(0, 60))
  check('WS_A 明细里只有 2 个可选会话（两个顶层）', dA.length === 2,
    `实际 ${dA.length}：${dA.map((s) => s.title).join(' , ') || '(空)'}`)
  check('WS_A 明细含两个顶层标题', dA.some((s) => s.title.includes('皇室战争模拟器重构')) && dA.some((s) => s.title.includes('卡组数据校对')),
    dA.map((s) => s.title).join(' , '))
  check('WS_A 明细不含任何子代理短 id',
    !SUB_SHORT_IDS.some((s) => observed.detailA.includes(s)),
    SUB_SHORT_IDS.filter((s) => observed.detailA.includes(s)).join(' , ') || '无')

  // ---- 4) 回编号进 WS_C 明细（顶层 T2 + 仅 depth 标记的子代理 S3）----
  await ask('/ws')
  const cIdx = wsLine(contents().at(-1) ?? '', WS_C)?.idx
  observed.detailC = await ask(String(cIdx ?? 2))
  console.log(`  [观测原文 明细 WS_C] ${observed.detailC}`)
  const dC = detailSessions(observed.detailC)
  check(`明细 header 指向 ${WS_C}`, observed.detailC.includes(WS_C), observed.detailC.slice(0, 60))
  check('WS_C 明细里只有 1 个可选会话（剔除 delegationDepth-only 子代理）', dC.length === 1,
    `实际 ${dC.length}：${dC.map((s) => `${s.title}/${s.short}`).join(' , ') || '(空)'}`)
  check('WS_C 明细含顶层标题「QQ 通知插件开发」', observed.detailC.includes('QQ 通知插件开发'), observed.detailC.slice(0, 90))
  check('WS_C 明细不含 delegationDepth-only 子代理的短 id',
    !observed.detailC.includes('c9b2e5f1'), observed.detailC.slice(0, 120))
  check('WS_C 明细不含子代理标题「仅depth标记子代理」',
    !observed.detailC.includes('仅depth标记子代理'), observed.detailC.slice(0, 120))
  check('WS_C 明细不串入其它工作区的顶层会话（皇室战争/卡组数据）',
    !observed.detailC.includes('皇室战争模拟器重构') && !observed.detailC.includes('卡组数据校对'), observed.detailC.slice(0, 120))

  // ---- 5) 子代理专属工作区明细（若该工作区仍被列出）----
  section('五、子代理专属工作区（该 cwd 下没有任何顶层会话）')
  await ask('/ws')
  const wsText2 = contents().at(-1) ?? ''
  const bIdx = wsLine(wsText2, WS_B)?.idx
  if (bIdx === undefined) {
    check(`${WS_B} 未出现在 /ws 列表 → 无编号可选（期望的最终行为）`, true, '未出现')
  } else {
    observed.detailB = await ask(String(bIdx))
    console.log(`  [观测原文 明细 WS_B] ${observed.detailB}`)
    const dB = detailSessions(observed.detailB)
    check(`即使 ${WS_B} 被列出，其明细里也没有任何可选子代理会话`, dB.length === 0,
      `实际 ${dB.length}：${dB.map((s) => s.title).join(' , ')}`)
    check('WS_B 明细不含任何子代理短 id',
      !SUB_SHORT_IDS.some((s) => observed.detailB.includes(s)),
      SUB_SHORT_IDS.filter((s) => observed.detailB.includes(s)).join(' , ') || '无')
  }

  // ---- 6) 顶层会话仍可正常驱动（子代理被剔除不能误伤顶层）----
  section('六、反向保护：顶层会话仍可选可驱动')
  await ask('/ws')
  const aIdx2 = wsLine(contents().at(-1) ?? '', WS_A)?.idx
  const enter = await ask(String(aIdx2 ?? 1))
  const first = detailSessions(enter)[0]
  const joined = await ask(String(first?.n ?? 1))
  console.log(`  [观测原文 驱动 WS_A 首个会话] ${joined}`)
  check('选择顶层会话后进入「已接入工作区会话」并带上顶层标题',
    joined.includes('已接入工作区会话') && joined.includes('皇室战争模拟器重构'), joined.slice(0, 120))
  check('接入的会话 id 是顶层 id（bdc6683a），不是子代理 id',
    joined.includes('bdc6683a') && !SUB_SHORT_IDS.some((s) => joined.includes(s)), joined.slice(0, 140))

  disposers.forEach((d) => { try { d() } catch { /* ignore */ } })
  fetched.restore()
  await sleep(20)
  rmSync(tmp, { recursive: true, force: true })
  return distHash
}

// ================================================================ 汇总
let distHash = '(未跑通)'
let crashed = null
try {
  distHash = await main()
} catch (err) {
  crashed = err
  console.error('\n[FATAL] 测试执行中抛异常：', err?.stack ?? err)
}

const failed = results.filter((r) => !r.ok)
console.log('\n───────── PASS/FAIL 清单 ─────────')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`)
console.log(`\n被测文件 ${DIST}`)
console.log(`sha256=${String(distHash)}`)
console.log(`${results.length - failed.length}/${results.length} 通过`)
if (crashed) console.log(`测试自身异常：${crashed?.message ?? crashed}`)
if (failed.length > 0) {
  console.log(`\n结论：${failed.length} 项 FAIL → ` +
    (failed.some((f) => /子代理|WS_B|工作区计数|delegationDepth/.test(f.name))
      ? '复现「会话选择菜单混进子代理会话」bug（或修复不完整）'
      : '存在失败项，详见上方清单'))
}
process.exit(failed.length > 0 || crashed ? 1 : 0)

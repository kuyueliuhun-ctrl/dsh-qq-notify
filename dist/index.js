/**
 * dsh-qq-notify — DeepSeek Harness QQ 双向桥插件.
 *
 * 能力：
 *  1) QQ → Harness：QQ 私聊消息直接驱动 harness（为每个 QQ 用户建独立会话），
 *     你说什么就作为新一轮输入。
 *  2) Harness → QQ：
 *     - 模型提问（ask_user）：问题推到 QQ，你在 QQ 里回复即回填 harness。
 *     - 权限申请（approval）：权限请求推到 QQ，回复「同意/允许一次/拒绝」即回填。
 *     - 完成通知：回合完成/出错/待审批主动推送（原有）。
 *     - 会话回复：QQ 驱动产生的 assistant 回复以被动回复推回 QQ。
 *  3) 待发送队列（outbox）：harness 产生的推送先入队，按序/限频发送，
 *     失败保留重试（QQ 主动推送受平台窗口限制时，依旧排队）。
 *  4) 自动捕获 openid：网关收到私聊即记录 user_openid。
 *
 * 设计准则与 plugin-notify 一致：发射是不可逆副作用，只 console.warn、绝不
 * 阻塞 agent 循环。QQ 被动回复携带原始 msg_id。
 *
 * 版本兼容（2026-09-17，dsh 0.1.5-rc.1 / 0.1.6-alpha.1 起）：
 *  - `session.events` 属性已被移除（旧版是 getter 返回只读数组），改为
 *    `session.snapshotEvents()`（全量）与 `session.ownEvents()`（自身段）。
 *    本插件所有历史读取都走 sessionEventsOf() 兼容层，两代 dsh 都能用。
 *  - `userQuestions.registerProvider` 从来不存在；提问的正式缝隙是
 *    agent 作用域 waterfall 事件 `user-questions/request`。
 *  - `ctx.on('session/event')` 在 `inject: []` 下依旧可用（非作用域监听器
 *    被全局接纳），故继续不 inject，保住启动速度。
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import WebSocket from 'ws'
import Schema from '@deepseek-ai/schemastery'

export const name = 'qq-notify'

// 不 inject 任何服务：插件 apply 必须即时返回，彻底退出 dsh 启动关键路径。
// sessions/agents/userQuestions 都在用到时用 ctx.get() 懒取（此时 dsh 已就绪）。
// session/event 与 agent/error 是全局事件，ctx.on 无需注入即可监听。
export const inject = []

export const Config = Schema.object({
  appId: Schema.string().default('').description('QQ 官方机器人 AppID（缺省读环境变量 QQ_APP_ID）'),
  appSecret: Schema.string().default('').description('QQ 官方机器人 AppSecret（缺省读环境变量 QQ_APP_SECRET；不建议明文写进仓库）'),
  sandbox: Schema.boolean().default(true).description('是否使用 QQ 沙箱环境'),
  endpoint: Schema.string().default('https://api.sgroup.qq.com').description('QQ OpenAPI 接入点'),
  openid: Schema.string().description('（可选）手动指定接收通知的 C2C user_openid；留空则用网关自动捕获'),
  ownerOpenid: Schema.string().description('（可选）允许驱动 harness 的 QQ 用户 openid；留空则任意私聊都可驱动'),
  autoCapture: Schema.boolean().default(true).description('是否连接 QQ 网关自动捕获私聊发送者的 openid'),
  bridge: Schema.boolean().default(true).description('是否启用 QQ→Harness 双向桥（消息驱动 + 回复 + 提问/审批）'),
  askUserBridge: Schema.boolean().default(true).description('是否用 QQ 接手 ask_user 提问（监听 user-questions/request waterfall；浏览器 UI 优先时可设 false）'),
  approvalBridge: Schema.boolean().default(true).description('是否用 QQ 接手被 QQ 驱动会话的权限审批（approval/request waterfall，抢占浏览器转发器；设 false 则只由浏览器应答）'),
  provider: Schema.string().default('deepseek').description('QQ 会话默认使用的 AI 提供方'),
  model: Schema.string().default('deepseek-chat').description('QQ 会话默认使用的 AI 模型'),
  cwd: Schema.string().description('新建 QQ 会话运行的绝对工作目录'),
  notifyEvents: Schema.array(Schema.string()).description('主动推送触发的事件：completed / error；显式给空数组 = 关闭主动完成通知，不给该字段 = 用默认 completed+error'),
  notifySubagents: Schema.boolean().default(false).description('是否也为子智能体（subagent）会话的回合推完成通知。默认 false：子代理折进父会话统计，不单独刷屏'),
  notifyOnlyQuiet: Schema.boolean().default(true).description('只在会话「真的闲下来」时才推：连续回合（含子代理来回）合并成一条，避免每个小段提示都推'),
  notifyQuietMs: Schema.number().default(20000).description('判定「闲下来」的静默窗口（毫秒）：该窗口内没有新回合/新子代理结束才推送'),
  notifyStaleMs: Schema.number().default(900000).description('长任务进度播报阈值（毫秒）：一个任务忙超过这么久，先播报一次进度（每个任务最多一次，之后安静到任务结束）'),
  notifyIncludeSubagentCount: Schema.boolean().default(true).description('合并通知里附带「含 N 个子代理」统计'),
  outbox: Schema.boolean().default(true).description('是否启用待发送队列（限频 + 失败重试）'),
  outboxIntervalMs: Schema.number().default(2000).description('待发送队列 flush 间隔（毫秒）'),
  timeoutMs: Schema.number().default(5000).description('单次请求超时（毫秒）'),
  dryRun: Schema.boolean().default(false).description('只把要推送的内容写进日志、不真正发 QQ（验证通知链路用）'),
  debug: Schema.boolean().default(false).description('是否输出 QQ 网关调试日志'),
})

const DEFAULT_NOTIFY_EVENTS = ['completed', 'error', 'approval_requested']

// C2C 私聊消息事件位（官方文档：USER_MESSAGE = 1 << 25）。
const USER_MESSAGE = 1 << 25
const DEFAULT_INTENTS = USER_MESSAGE
const TOKEN_RETRY_MS = 10_000
const RECONNECT_DELAY_MS = 5_000
const SESSION_PREFIX = 'qq:'
/** outbox 里一条消息最多重投几次（之后丢弃，避免永久失败项无限重试）。 */
const MAX_OUTBOX_ATTEMPTS = 8

/**
 * 该会话是否是子智能体（subagent）会话：header 的 origin/delegationDepth 标记。
 *
 * ⚠️ 只能用这两个字段判定。`header.parentSession` **不能**当子代理标记用：
 * 按 dsh-session 的 d.ts，parentSession 是「fork 血缘」（`isSeeded` 的种子来源），
 * 一个从别的会话 fork 出来的**顶层会话**同样带 parentSession。用它判定会把
 * 正常会话误判成子代理、从菜单里藏掉。
 */
export function isSubagentSession(session) {
  const header = session?.header
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * 该会话是否可以出现在给 QQ 用户看的「选择会话」列表里。
 *
 * 排除两类：
 *  - QQ 自建会话（`qq:` 前缀）：它们是 `agents.create` 出来的，不是「已有工作区会话」；
 *  - 子代理会话（`isSubagentSession`）：子代理是某个任务的内部执行体，用户不该直接挑它
 *    （网页侧边栏也不平铺展示，而是挂在父会话目录里）。2026-09-17 用户反馈「选会话时
 *    能选到子代理会话」，根因就是这里只过滤了 `qq:` 前缀。
 */
export function isDrivableSession(session) {
  if (!session || typeof session !== 'object') return false
  const id = session.id
  if (typeof id !== 'string' || id.startsWith(SESSION_PREFIX)) return false
  return !isSubagentSession(session)
}

/** 追加一行到 $DSH_HOME/qq-notify.log（便于排查运行期问题）。 */
function fileLog(...parts) {
  try {
    const file = join(process.env.DSH_HOME || process.cwd(), 'qq-notify.log')
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `[${new Date().toISOString()}] ${parts.join(' ')}\n`, 'utf8')
  } catch { /* 日志失败不阻断 */ }
}

/** 持久化文件名（位于 $DSH_HOME 下）。 */
function persistPath() {
  return join(process.env.DSH_HOME || process.cwd(), 'qq-notify.openid.json')
}

/** 写入当前 DSH web 进程 PID，供外部守护进程做 PID 监控。 */
function writePidFile() {
  try {
    const file = join(process.env.DSH_HOME || process.cwd(), 'qq-notify.pid')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, String(process.pid), 'utf8')
  } catch { /* 忽略 */ }
}

function removePidFile() {
  try {
    const file = join(process.env.DSH_HOME || process.cwd(), 'qq-notify.pid')
    if (readFileSync(file, 'utf8').trim() === String(process.pid)) {
      rmSync(file, { force: true })
    }
  } catch { /* 忽略 */ }
}

function readPersisted() {
  try {
    const data = JSON.parse(readFileSync(persistPath(), 'utf8'))
    if (typeof data?.openid === 'string' && data.openid) return data
  } catch { /* 无文件/不可解析则忽略 */ }
  return {}
}

function writePersisted(patch) {
  try {
    const file = persistPath()
    mkdirSync(dirname(file), { recursive: true })
    const prev = readPersisted()
    writeFileSync(file, JSON.stringify({ ...prev, ...patch, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch (err) {
    console.warn(`[qq-notify] 持久化失败：${String(err)}`)
  }
}

/** 会话列表持久化文件（QQ 多会话注册表 + 交互状态）。 */
function sessionsPath() {
  return join(process.env.DSH_HOME || process.cwd(), 'qq-notify.sessions.json')
}

function readSessionsState() {
  try {
    const data = JSON.parse(readFileSync(sessionsPath(), 'utf8'))
    if (data && typeof data === 'object') return data
  } catch { /* 忽略 */ }
  return {}
}

function writeSessionsState(state) {
  try {
    const file = sessionsPath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
  } catch (err) {
    console.warn(`[qq-notify] 会话状态持久化失败：${String(err)}`)
  }
}

/** 检查字符串是否像是命令（/xxx）。 */
function isCommand(text) { return /^\//.test(text) }

/** 从一个 qq:* sessionId 里取出 openid（形态：qq:<openid> 或 qq:<openid>:<name>）。 */
function openidOfSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith(SESSION_PREFIX)) return undefined
  const rest = sessionId.slice(SESSION_PREFIX.length)
  const colon = rest.indexOf(':')
  return colon === -1 ? rest : rest.slice(0, colon)
}

/** 把 qq:* sessionId 对应到用户在注册表里的会话名；找不到则用默认。 */
function sessionNameOf(sessionId, u, openid) {
  if (sessionId === SESSION_PREFIX + openid) return '默认'
  const found = u.sessions.find((s) => s.sessionId === sessionId)
  return found ? found.name : '默认'
}

/** Apply QQ 沙箱前缀到 OpenAPI 接入点。 */
function apiEndpoint(endpoint, sandbox) {
  const normalized = String(endpoint).replace(/\/+$/, '')
  return sandbox ? normalized.replace(/^(https?:\/\/)/, '$1sandbox.') : normalized
}

export function apply(ctx, config = {}) {
  const cfg = config ?? {}
  const logger = ctx.logger?.(name) ?? console
  // 配置缺省时回落到环境变量（与 qq-watch.js 同一套变量名），
  // 这样无 cordis patch 的场景（注入器热装、systemd 单元）也能配起来。
  const appId = String(cfg.appId || process.env.QQ_APP_ID || '').trim()
  const appSecret = String(cfg.appSecret || process.env.QQ_APP_SECRET || '')
  const configuredOpenid = String(cfg.openid || process.env.QQ_OPENID || '').trim()
  const ownerOpenid = String(cfg.ownerOpenid || '').trim()
  const sandbox = cfg.sandbox ?? (process.env.QQ_SANDBOX !== undefined ? process.env.QQ_SANDBOX !== 'false' : true)
  const endpoint = apiEndpoint(cfg.endpoint ?? 'https://api.sgroup.qq.com', sandbox)
  const autoCapture = cfg.autoCapture ?? true
  const bridge = cfg.bridge ?? true
  const askUserBridge = cfg.askUserBridge ?? true
  const approvalBridge = cfg.approvalBridge ?? true
  const outbox = cfg.outbox ?? true
  const outboxIntervalMs = typeof cfg.outboxIntervalMs === 'number' ? cfg.outboxIntervalMs : 2000
  const timeoutMs = typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 5000
  const dryRun = cfg.dryRun ?? false
  const debug = cfg.debug ?? false
  const notifySubagents = cfg.notifySubagents ?? false
  const notifyOnlyQuiet = cfg.notifyOnlyQuiet ?? true
  const notifyQuietMs = typeof cfg.notifyQuietMs === 'number' ? cfg.notifyQuietMs : 20000
  const notifyStaleMs = typeof cfg.notifyStaleMs === 'number' ? cfg.notifyStaleMs : 900000
  const notifyIncludeSubagentCount = cfg.notifyIncludeSubagentCount ?? true
  const notifyEvents = new Set(normalizeEvents(cfg.notifyEvents))

  if (!appId || !appSecret) {
    logger.warn('[qq-notify] 未配置完整：需要 appId / appSecret（或环境变量 QQ_APP_ID / QQ_APP_SECRET），当前禁用')
    fileLog('插件未启用：缺少 appId / appSecret')
    return
  }

  // 写 PID 文件，供外部守护进程做「进程销毁通知」的 PID 监控。
  writePidFile()

  // 本实例身份标记：热换/卸载后残留的旧实例不许再往 QQ 推（见 installPushGuard / 定时器守卫）。
  const instanceToken = `qq-notify-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  installPushGuard(instanceToken)
  installNoticeTimerGuard(instanceToken)

  // 启动留痕：装没装上、跑的是哪套开关，一眼可见（排查「通知没来」第一现场）。
  fileLog(`插件加载 appId=${mask(appId)} sandbox=${sandbox} autoCapture=${autoCapture} `
    + `bridge=${bridge} askUserBridge=${askUserBridge} notifyEvents=${[...notifyEvents].join(',') || '(空)'} `
    + `dryRun=${dryRun} cwd=${process.cwd()}`)

  // 诊断：记录 QQ 驱动的 agent 回合错误详情（定位 error 根因用）。
  // 新版 dsh 的 live agent 有 agent.session.id，公开接口上则是 agent.id，两者都兜。
  ctx.on('agent/error', ({ agent, turn, step, error } = {}) => {
    const sid = agent?.session?.id ?? agent?.id
    if (typeof sid !== 'string' || !sid.startsWith(SESSION_PREFIX)) return
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
    fileLog(`agent/error 会话=${sid} turn=${turn} step=${step} 错误：\n${detail}`)
    logger.error(`[qq-notify] QQ 会话 ${sid} 回合出错：%o`, error)
  })

  // 自动捕获的 openid：优先持久化的，否则手动配置。
  const persisted = readPersisted()
  let capturedOpenid = persisted.openid || undefined
  const targetOpenid = () => configuredOpenid || capturedOpenid

  // ---- 多会话注册表 + 交互状态（每 openid） ------------------------
  const sessionsState = readSessionsState()
  // sessionsState = { [openid]: { sessions: [{name, sessionId, createdAt, ws?}], mode, currentName, menuNav, drivingWsSession } }
  // session 可标记 ws:true 表示这是一个「已有工作区会话」（用真实 sessionId 驱动）。
  const ensureUser = (openid) => {
    let u = sessionsState[openid]
    if (!u) { u = { sessions: [], mode: 'menu', currentName: null }; sessionsState[openid] = u }
    if (!Array.isArray(u.sessions)) u.sessions = []
    if (u.mode !== 'chat') u.mode = 'menu'
    if (!u.menuNav) u.menuNav = { kind: 'main' }
    return u
  }
  const persistSessions = () => { try { writeSessionsState(sessionsState) } catch { /* ignore */ } }

  /** 按 id 取 live 会话；sessions 服务不可用/查不到时返回 undefined（不误伤）。 */
  const sessionById = (sessionId) => {
    const sessionsSvc = ctx.get('sessions')
    if (!sessionsSvc || typeof sessionsSvc.get !== 'function') return undefined
    try { return sessionsSvc.get(sessionId) } catch { return undefined }
  }

  /** 枚举已有工作区及其会话（来自会话存储的 live 会话，按 cwd 分组）。 */
  const workspaceInventory = () => {
    const sessionsSvc = ctx.get('sessions')
    if (!sessionsSvc || typeof sessionsSvc.list !== 'function') return []
    let list = []
    try { list = sessionsSvc.list() } catch (err) { fileLog(`枚举会话失败 ${String(err)}`); return [] }
    const byCwd = new Map()
    let subagents = 0
    for (const s of list) {
      // 只列「可以驱动」的会话：跳过 QQ 自建会话（qq: 前缀）与子代理会话。
      // 子代理会话混进菜单 = 让用户挑到一个任务的内部执行体（2026-09-17 反馈）。
      if (!isDrivableSession(s)) { if (isSubagentSession(s)) subagents++; continue }
      const id = s.id
      const cwd = s.header?.cwd || '(未知工作区)'
      if (!byCwd.has(cwd)) byCwd.set(cwd, [])
      byCwd.get(cwd).push({
        sessionId: id,
        // 会话标题（DSH 的 session/title）优先；拿不到才退回短 id，不再直接甩 session-xxxx。
        title: sessionSafeTitle(s) || shortSessionId(id),
      })
    }
    if (subagents > 0) fileLog(`枚举会话：跳过 ${subagents} 个子代理会话（不提供给 QQ 选择）`)
    return [...byCwd.entries()].map(([cwd, sessions]) => ({ cwd, sessions }))
  }

  /** 找到一个用户下给定名称的会话。 */
  const findSession = (u, name) => u.sessions.find((s) => s.name === name)

  /** 确保存在默认会话（qq:<openid>）。刚接入时自动建。 */
  const ensureDefaultSession = (u, openid) => {
    if (u.sessions.length === 0) {
      u.sessions.push({ name: '默认', sessionId: SESSION_PREFIX + openid, createdAt: Date.now() })
      u.currentName = '默认'
      persistSessions()
    }
  }

  /** 新建（或复用同名）会话。 */
  const createSession = (u, openid, name) => {
    const normalized = (name || '').trim().replace(/[:\s/]+/g, '_') || '会话' + (u.sessions.length + 1)
    let s = findSession(u, normalized)
    if (!s) {
      // sessionId 用 qq:<openid>:<name>；避免与默认冲突。
      const sessionId = normalized === '默认' || normalized === 'default'
        ? SESSION_PREFIX + openid
        : `${SESSION_PREFIX}${openid}:${normalized}`
      s = { name: normalized, sessionId, createdAt: Date.now() }
      u.sessions.push(s)
      persistSessions()
    }
    u.currentName = s.name
    u.mode = 'chat'
    persistSessions()
    return s
  }

  /** 切到指定名称会话并进入对话模式。 */
  const selectSession = (u, name) => {
    const s = findSession(u, name)
    if (!s) return null
    u.currentName = s.name
    u.mode = 'chat'
    u.drivingWsSession = undefined // 切回 QQ 自建会话，不再驱动工作区会话
    persistSessions()
    return s
  }

  /** 生成主菜单：QQ 会话 + 已有工作区入口。 */
  const renderMenu = (u, openid) => {
    ensureDefaultSession(u, openid)
    const lines = ['📇 会话列表：']
    u.sessions.forEach((s, i) => {
      const cur = s.name === u.currentName && u.mode === 'chat' ? ' ✅' : ''
      lines.push(`${i + 1}. ${s.name}${cur}`)
    })
    const inventory = workspaceInventory()
    if (inventory.length > 0) {
      lines.push('')
      lines.push(`🏢 已有工作区（${inventory.length}）:`)
      inventory.forEach((ws, i) => lines.push(`  W${i + 1}. ${ws.cwd} (${ws.sessions.length})`))
    }
    lines.push('')
    lines.push('回复数字选会话；W+数字进工作区；/new /use /exit /menu /ws /help')
    return lines.join('\n')
  }

  /** 生成工作区列表。 */
  const renderWorkspaces = (u, openid) => {
    const inventory = workspaceInventory()
    const lines = ['🏢 已有工作区：']
    if (inventory.length === 0) { lines.push('（没有可用的已有工作区会话）') }
    inventory.forEach((ws, i) => lines.push(`${i + 1}. ${ws.cwd} (${ws.sessions.length})`))
    lines.push('回复数字选择工作区；/menu 返回')
    return lines.join('\n')
  }

  /**
   * 由 menuNav 定位工作区。优先按 **cwd** 锚定（跨时间稳定）、回落到编号。
   * 为什么：清单是每次实时重算的，编号会随会话增减漂移（本次修掉子代理会话就等于让编号
   * 变化）；持久化的 `wsIdx` 单独用会在用户「翻着菜单时」指到另一个工作区上。
   */
  const resolveNavWorkspace = (inventory, nav) => {
    if (nav && typeof nav.cwd === 'string') {
      const hit = inventory.find((w) => w.cwd === nav.cwd)
      if (hit) return hit
    }
    return inventory[nav?.wsIdx]
  }

  /** 生成某工作区的会话明细。缺省用 `u.menuNav` 定位。 */
  const renderWorkspaceDetail = (u, openid, nav = u.menuNav) => {
    const inventory = workspaceInventory()
    const ws = resolveNavWorkspace(inventory, nav)
    if (!ws) return '（工作区不存在）'
    const lines = [`🏢 工作区：${ws.cwd}`, '选择会话：']
    // 标题即会话名；短 id 只作消歧后缀（同工作区可能重名），不再刷整串 session-xxxx。
    ws.sessions.forEach((s, i) => lines.push(`${i + 1}. ${s.title}（${shortSessionId(s.sessionId)}）`))
    lines.push('回复数字驱动该会话；/menu 返回')
    return lines.join('\n')
  }

  /** 解析指令并返回是否已处理（true = 已消费）。 */
  const handleCommand = (u, openid, text) => {
    const [cmd, ...rest] = text.trim().split(/\s+/)
    const arg = rest.join(' ')
    const cur = () => u.currentName || (u.sessions[0] || {}).name || '默认'
    switch (cmd) {
      case '/menu': case '/list': {
        u.menuNav = { kind: 'main' }
        u.drivingWsSession = undefined
        u.mode = 'menu'
        persistSessions()
        enqueueOutbox({ openid, content: renderMenu(u, openid), msgId: undefined })
        return true
      }
      case '/ws': case '/workspace': {
        u.menuNav = { kind: 'wslist' }
        u.drivingWsSession = undefined
        u.mode = 'menu'
        persistSessions()
        enqueueOutbox({ openid, content: renderWorkspaces(u, openid), msgId: undefined })
        return true
      }
      case '/exit': {
        u.menuNav = { kind: 'main' }
        u.drivingWsSession = undefined
        u.mode = 'menu'
        persistSessions()
        enqueueOutbox({ openid, content: renderMenu(u, openid), msgId: undefined })
        return true
      }
      case '/new': {
        if (!arg) { enqueueOutbox({ openid, content: '用法：/new 会话名', msgId: undefined }); return true }
        const s = createSession(u, openid, arg)
        enqueueOutbox({ openid, content: `已进入会话「${s.name}」。直接发消息即可开始对话。`, msgId: undefined })
        return true
      }
      case '/use': {
        if (!arg) { enqueueOutbox({ openid, content: '用法：/use 会话名', msgId: undefined }); return true }
        const s = selectSession(u, arg)
        if (!s) { enqueueOutbox({ openid, content: `没有会话「${arg}」。用 /list 查看。`, msgId: undefined }); return true }
        enqueueOutbox({ openid, content: `已切换到会话「${s.name}」。`, msgId: undefined })
        return true
      }
      case '/help': {
        enqueueOutbox({ openid, content:
          '指令：\n'
          + '/new 名字 —— 新建会话\n'
          + '/use 名字 · 数字 —— 选择会话\n'
          + '/exit —— 退出回菜单\n'
          + '/menu · /ws —— 菜单 / 工作区\n'
          + '/help', msgId: undefined })
        return true
      }
      default:
        return false
    }
  }

  let token
  let tokenExpiry = 0
  let tokenPromise = null

  /** 获取并缓存 QQ access token（临近过期自动刷新）。 */
  const getToken = async () => {
    if (token && Date.now() < tokenExpiry) return token
    if (tokenPromise) return tokenPromise
    tokenPromise = (async () => {
      const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, clientSecret: appSecret }),
        signal: abortSignal(timeoutMs),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || typeof data?.access_token !== 'string') {
        throw new Error(`QQ token request failed with HTTP ${res.status}`)
      }
      token = data.access_token
      const rawExpires = data.expires_in
      const expiresIn = typeof rawExpires === 'number' ? rawExpires
        : typeof rawExpires === 'string' ? Number(rawExpires) || 300
        : 300
      tokenExpiry = Date.now() + Math.max(60, expiresIn - 60) * 1000
      return token
    })()
    try { return await tokenPromise } finally { tokenPromise = null }
  }

  // ---- outbox：待发送队列 ------------------------------------------
  const outboxQueue = []
  let outboxTimer = null

  const pushQQ = async ({ openid, content, msgId }) => {
    if (!openid) { fileLog('pushQQ: 无 openid，跳过'); return false }
    if (dryRun) {
      fileLog(`pushQQ(dryRun): 未发送 openid=${mask(openid)}${msgId ? ' 被动' : ' 主动'} 内容=${content.replace(/\s+/g, ' ').slice(0, 160)}`)
      return true
    }
    try {
      const tok = await getToken()
      const body = msgId
        ? { content, msg_type: 0, msg_id: msgId, msg_seq: nextSeq() }
        : { content, msg_type: 0, msg_seq: nextSeq() }
      const res = await fetch(`${endpoint}/v2/users/${openid}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${tok}`, [PUSH_MARK_HEADER]: instanceToken },
        body: JSON.stringify(body),
        signal: abortSignal(timeoutMs),
      })
      if (!res.ok) {
        const rt = await res.text().catch(() => '')
        throw new Error(`QQ send failed with HTTP ${res.status}${rt ? `：${rt.slice(0, 200)}` : ''}`)
      }
      fileLog(`pushQQ: 成功 openid=${mask(openid)}${msgId ? ' 被动' : ' 主动'}`)
      return true
    } catch (err) {
      logger.warn(`[qq-notify] pushQQ 失败：${String(err)}`)
      fileLog(`pushQQ: 失败 ${String(err)}`)
      return false
    }
  }

  const startOutboxTimer = () => {
    outboxTimer = setInterval(() => {
      if (outboxQueue.length === 0) {
        // 队列空了就停表，避免空转（下次 enqueueOutbox 会重新起）。
        clearInterval(outboxTimer)
        outboxTimer = null
        return
      }
      const item = outboxQueue.shift()
      item.attempts = (item.attempts ?? 0) + 1
      void pushQQ(item).then((ok) => {
        if (ok) return
        if (item.attempts >= MAX_OUTBOX_ATTEMPTS) {
          // 永久失败（如被平台限频/会话窗口过期）不再无限重投，否则日志与队列无限增长。
          fileLog(`outbox: 丢弃（已重试 ${item.attempts} 次）：${String(item.content).replace(/\s+/g, ' ').slice(0, 80)}`)
          return
        }
        outboxQueue.push(item)
      })
    }, outboxIntervalMs)
    outboxTimer.unref?.()
  }

  const enqueueOutbox = (item) => {
    if (!outbox) { void pushQQ(item); return }
    outboxQueue.push(item)
    if (outboxTimer === null) startOutboxTimer()
  }

  // ---- 网关：消息接收 ----------------------------------------------
  if (autoCapture || bridge) {
    ctx.effect(() => {
      let socket
      let heartbeat
      let reconnect
      let refresh
      let lastSequence = null
      let connecting = false
      let disposed = false

      const clearHeartbeat = () => { if (heartbeat !== undefined) { clearInterval(heartbeat); heartbeat = undefined } }
      const scheduleReconnect = (delay) => {
        if (disposed || reconnect !== undefined) return
        reconnect = setTimeout(() => { reconnect = undefined; void connectWebSocket() }, delay)
      }
      const scheduleTokenRefresh = (delay) => {
        if (disposed) return
        if (refresh !== undefined) clearTimeout(refresh)
        refresh = setTimeout(() => { refresh = undefined; void refreshToken() }, delay)
      }

      const refreshToken = async () => {
        if (disposed) return
        try {
          const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId, clientSecret: appSecret }),
            signal: abortSignal(timeoutMs),
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok || typeof data?.access_token !== 'string') {
            throw new Error(`QQ token request failed with HTTP ${res.status}`)
          }
          token = data.access_token
          const rawExpires = data.expires_in
          const expiresIn = typeof rawExpires === 'number' ? rawExpires
            : typeof rawExpires === 'string' ? Number(rawExpires) || 300
            : 300
          tokenExpiry = Date.now() + Math.max(60, expiresIn - 60) * 1000
          scheduleTokenRefresh(Math.max(60, expiresIn - 60) * 1000)
          void connectWebSocket()
        } catch (err) {
          logger.error('Unable to refresh QQ access token: %o', err)
          fileLog(`refreshToken: 失败 ${String(err)}`)
          scheduleTokenRefresh(TOKEN_RETRY_MS)
        }
      }

      const connectWebSocket = async () => {
        if (disposed || connecting) return
        if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
        let freshToken
        try { freshToken = await getToken() } catch (err) {
          fileLog(`connectWebSocket: 拿 token 失败 ${String(err)}`)
          scheduleReconnect(RECONNECT_DELAY_MS); return
        }
        if (freshToken === undefined) { scheduleReconnect(1000); return }
        connecting = true
        try {
          const res = await fetch(`${endpoint}/gateway`, { headers: { Authorization: `QQBot ${freshToken}` } })
          const gateway = await res.json().catch(() => ({}))
          if (!res.ok || typeof gateway?.url !== 'string') {
            throw new Error(`QQ gateway request failed with HTTP ${res.status}`)
          }
          const nextSocket = new WebSocket(gateway.url)
          socket = nextSocket
          nextSocket.on('open', () => { logger.info('[qq-notify] QQ 网关已连接'); fileLog('网关 WS open') })
          nextSocket.on('message', (raw) => {
            let payload
            try { payload = JSON.parse(raw.toString()) } catch (err) { logger.warn('Ignoring malformed QQ gateway payload: %o', err); return }
            if (payload == null || typeof payload.op !== 'number') return
            if (typeof payload.s === 'number') lastSequence = payload.s
            if (debug) { logger.debug('[qq-notify] QQ gateway op=%d type=%s', payload.op, payload.t); fileLog(`gateway op=${payload.op} t=${payload.t}`) }

            if (payload.op === 10) {
              const hello = payload.d
              if (!hello || typeof hello.heartbeat_interval !== 'number') { nextSocket.close(); return }
              clearHeartbeat()
              heartbeat = setInterval(() => {
                if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ op: 1, d: lastSequence }))
              }, hello.heartbeat_interval)
              nextSocket.send(JSON.stringify({ op: 2, d: { token: `QQBot ${freshToken}`, intents: DEFAULT_INTENTS, shard: [0, 1] } }))
              return
            }
            if (payload.op === 7 || payload.op === 9) { fileLog(`gateway op=${payload.op}（要求重连/失效）`); nextSocket.close(); return }
            if (payload.op !== 0 || typeof payload.t !== 'string') return

            if (payload.t === 'C2C_MESSAGE_CREATE' && payload.d?.author?.user_openid) {
              const openid = String(payload.d.author.user_openid)
              fileLog(`收到 C2C 消息 author=${openid} id=${payload.d?.id}`)
              if (autoCapture && (!capturedOpenid || capturedOpenid !== openid)) {
                capturedOpenid = openid
                writePersisted({ openid, appId })
                logger.info(`[qq-notify] 已自动捕获 user_openid：${openid}`)
                fileLog(`已捕获并持久化 user_openid=${openid}`)
              }
              if (bridge) {
                void handleQQIncoming({
                  openid,
                  messageId: payload.d?.id,
                  content: payload.d?.content ?? '',
                  authorName: payload.d?.author?.member_openid ?? openid,
                })
              }
            }
          })
          nextSocket.on('close', (code, reason) => {
            fileLog(`网关 close code=${code} reason=${String(reason)}`)
            if (socket !== nextSocket) return
            socket = undefined
            clearHeartbeat()
            if (!disposed) { logger.warn(`[qq-notify] QQ 网关关闭（${code}），5 秒后重连`); scheduleReconnect(RECONNECT_DELAY_MS) }
          })
          nextSocket.on('error', (err) => { logger.warn(`[qq-notify] QQ 网关错误：${String(err)}`); fileLog(`网关 error ${String(err)}`) })
        } catch (err) {
          logger.error('Unable to connect QQ WebSocket: %o', err)
          fileLog(`connectWebSocket: 失败 ${String(err)}`)
          scheduleReconnect(RECONNECT_DELAY_MS)
        } finally { connecting = false }
      }

      // 直接触发（async fire-and-forget）：不排队 setImmediate——实测 setImmediate
      // 会被 dsh 启动期间的忙事件循环推迟 27 秒，反而拖慢网关连接。
      // apply/effect 即刻返回，token 请求立即发出，网络在后台进行。
      void refreshToken()
      return () => {
        disposed = true
        clearHeartbeat()
        if (reconnect !== undefined) clearTimeout(reconnect)
        if (refresh !== undefined) clearTimeout(refresh)
        socket?.close()
      }
    }, 'qq-notify.gateway()')
  }

  // ---- 交互相应（ask_user / approval 的等待） ----------------------
  let pendingInteraction = null

  /**
   * 收尾某个未决交互（带归属校验：只有仍是当前在等的那条才动）。
   * 返回是否真的收尾了。
   */
  const settlePending = (entry, text) => {
    if (entry === null || entry === undefined || pendingInteraction !== entry) return false
    pendingInteraction = null
    if (entry.timer) clearTimeout(entry.timer)
    entry.resolve(text)
    return true
  }

  /** QQ 消息入口用：把「当前在等的那个」当作收到答复收尾。 */
  const resolvePending = (text) => {
    const p = pendingInteraction
    if (p === null) return false
    pendingInteraction = null
    if (p.timer) clearTimeout(p.timer)
    p.resolve(text)
    return true
  }

  /**
   * 等 QQ 侧答复。同一时刻只保留一个未决交互；可选 signal：请求被取消
   * （回合中止/浏览器接管）时立刻用 abortFallback 收尾，避免把 agent 挂到超时。
   */
  const waitForQQReply = (openid, kind, timeoutMs, onTimeout, signal, abortFallback) => {
    let self = null
    const base = new Promise((resolve) => {
      if (pendingInteraction !== null) {
        // 抢占必须「失败关闭」：被抢占的审批如果只回一句说明文字，
        // 审批消费端的「非拒绝即同意」会把它当成用户许可（静默授权）。
        const prev = pendingInteraction
        pendingInteraction = null
        if (prev.timer) clearTimeout(prev.timer)
        const answer = pendingFallback(prev.openid, prev.kind)
        fileLog(`${prev.kind} 未决交互被新的${kind}请求抢占 → 按「${answer}」收尾`)
        prev.resolve(answer)
      }
      self = { openid, kind, resolve, timer: null }
      pendingInteraction = self
      const t = setTimeout(() => {
        if (pendingInteraction === self) {
          pendingInteraction = null
          onTimeout?.()
          resolve(pendingFallback(openid, kind))
        }
      }, timeoutMs)
      self.timer = t
    })
    if (signal === undefined || signal === null) return base
    const fallback = abortFallback ?? pendingFallback(openid, kind)
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
      const onAbort = () => {
        fileLog(`${kind} 请求被取消（signal abort）`)
        // 只收尾「自己那条」：可能已被抢占或已答复，绝不动别人的 pending。
        settlePending(self, fallback)
        finish(fallback)
      }
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener?.('abort', onAbort, { once: true })
      base.then((value) => { signal.removeEventListener?.('abort', onAbort); finish(value) })
    })
  }

  function pendingFallback(openid, kind) {
    return kind === '审批' ? '拒绝' : '（超时未答复）'
  }

  /** QQ 收到用户消息时的统一入口。 */
  const handleQQIncoming = async ({ openid, messageId, content, authorName }) => {
    const text = cleanText(content)
    if (!text) return

    if (ownerOpenid && ownerOpenid !== openid) {
      fileLog(`忽略非 owner 消息 ${mask(openid)}`)
      return
    }

    // 若存在 pending 提问/审批，本次输入即答案（优先级最高）。
    if (pendingInteraction !== null && pendingInteraction.openid === openid) {
      fileLog(`把输入「${text.slice(0, 40)}」作为 ${pendingInteraction.kind} 的答案`)
      if (pendingInteraction.timer) clearTimeout(pendingInteraction.timer)
      resolvePending(text)
      return
    }

    const u = ensureUser(openid)
    ensureDefaultSession(u, openid)

    // 指令优先。
    if (isCommand(text)) {
      fileLog(`QQ 指令（${openid}）：${text.slice(0, 40)}`)
      handleCommand(u, openid, text)
      return
    }

    // 菜单模式下：按当前导航层级处理。
    if (u.mode !== 'chat') {
      const nav = u.menuNav || { kind: 'main' }
      // 主菜单：W+数字 进工作区明细；纯数字选 QQ 会话。
      if (nav.kind === 'main') {
        const wm = /^W(\d+)$/i.exec(text)
        if (wm) {
          const idx = Number(wm[1]) - 1
          const inventory = workspaceInventory()
          if (!inventory[idx]) { enqueueOutbox({ openid, content: '无效工作区编号。', msgId: undefined }); return }
          u.menuNav = { kind: 'wsdetail', wsIdx: idx, cwd: inventory[idx].cwd } // cwd 锚定，编号漂移也不错位
          persistSessions()
          enqueueOutbox({ openid, content: renderWorkspaceDetail(u, openid), msgId: undefined })
          return
        }
        if (/^\d+$/.test(text)) {
          const idx = Number(text) - 1
          const s = u.sessions[idx]
          if (!s) { enqueueOutbox({ openid, content: `没有第 ${text} 个会话。用 /list 查看。`, msgId: undefined }); return }
          selectSession(u, s.name)
          enqueueOutbox({ openid, content: `已进入会话「${s.name}」。直接发消息即可。`, msgId: undefined })
          return
        }
        if (/^\/ws/i.test(text) || /^\/workspace/i.test(text)) {
          u.menuNav = { kind: 'wslist' }
          persistSessions()
          enqueueOutbox({ openid, content: renderWorkspaces(u, openid), msgId: undefined })
          return
        }
        enqueueOutbox({ openid, content: renderMenu(u, openid), msgId: undefined })
        return
      }
      if (nav.kind === 'wslist') {
        if (/^\d+$/.test(text)) {
          const idx = Number(text) - 1
          const inventory = workspaceInventory()
          if (!inventory[idx]) { enqueueOutbox({ openid, content: '无效工作区编号。', msgId: undefined }); return }
          u.menuNav = { kind: 'wsdetail', wsIdx: idx, cwd: inventory[idx].cwd } // cwd 锚定，编号漂移也不错位
          persistSessions()
          enqueueOutbox({ openid, content: renderWorkspaceDetail(u, openid), msgId: undefined })
          return
        }
        enqueueOutbox({ openid, content: renderWorkspaces(u, openid), msgId: undefined })
        return
      }
      if (nav.kind === 'wsdetail') {
        if (/^\d+$/.test(text)) {
          const inventory = workspaceInventory()
          const ws = resolveNavWorkspace(inventory, nav)
          const s = ws?.sessions?.[Number(text) - 1]
          if (!s) { enqueueOutbox({ openid, content: '无效会话编号。', msgId: undefined }); return }
          // 双保险：清单里已过滤子代理，这里再按 live 会话核一次（防清单与 live 状态不同步）。
          const live = sessionById(s.sessionId)
          if (live !== undefined && !isDrivableSession(live)) {
            fileLog(`拒绝驱动子代理会话 ${s.sessionId}（菜单已过滤，此处兜底）`)
            enqueueOutbox({ openid, content: '⚠️ 该会话是子代理会话，不能直接驱动。请选顶层会话。', msgId: undefined })
            return
          }
          // 驱动已有工作区会话：直接用真实 sessionId，并记录为该用户当前驱动目标。
          u.menuNav = { kind: 'main' }
          u.mode = 'chat'
          u.currentName = ws.cwd // 用工作区路径作为标识
          u.drivingWsSession = s.sessionId
          persistSessions()
          fileLog(`选择驱动已有会话 ${s.sessionId}（工作区 ${ws.cwd}）`)
          lastReplyTarget.set(s.sessionId, { openid, lastMsgId: undefined, ws: true })
          enqueueOutbox({ openid, content: `已接入工作区会话：${ws.cwd}\n会话：${s.title}（${shortSessionId(s.sessionId)}）\n直接发消息即可驱动它。`, msgId: undefined })
          return
        }
        enqueueOutbox({ openid, content: renderWorkspaceDetail(u, openid), msgId: undefined })
        return
      }
      enqueueOutbox({ openid, content: renderMenu(u, openid), msgId: undefined })
      return
    }

    // 对话模式：发给当前会话（可能是 QQ 自建会话，或已接入的已有工作区会话）。
    let s = null
    let sessionId
    if (u.drivingWsSession) {
      // 正在驱动一个已有工作区会话（真实 sessionId）。
      // 兜底：修复前（或菜单/状态不同步时）可能已经接入了子代理会话，一旦发现就断开退回菜单，
      // 否则用户的每句话都会打进某个任务的内部执行体里。
      const live = sessionById(u.drivingWsSession)
      if (live !== undefined && !isDrivableSession(live)) {
        fileLog(`已接入的会话 ${u.drivingWsSession} 不是可驱动的顶层会话 → 断开并退回菜单`)
        u.drivingWsSession = undefined
        u.mode = 'menu'
        u.menuNav = { kind: 'main' }
        persistSessions()
        enqueueOutbox({ openid, content: '⚠️ 之前接入的会话是子代理会话，不能直接驱动。已返回菜单，用 /ws 重新选择顶层会话。', msgId: undefined })
        return
      }
      sessionId = u.drivingWsSession
      lastReplyTarget.set(sessionId, { openid, messageId, lastMsgId: undefined, ws: true })
    } else {
      s = findSession(u, u.currentName) || u.sessions[0]
      sessionId = s.sessionId
      const target = lastReplyTarget.get(sessionId) || {}
      lastReplyTarget.set(sessionId, { openid, messageId, lastMsgId: target.lastMsgId })
    }

    fileLog(`驱动会话 ${sessionId} 输入「${text.slice(0, 40)}」`)
    try {
      const handle = await resumeOrCreateAgent(sessionId, { openid })
      handle.agent.send({
        id: messageId,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user', id: openid, name: authorName || openid },
      }, 'next-turn', true)
    } catch (err) {
      logger.error(`[qq-notify] QQ→Harness 驱动失败：%o`, err)
      fileLog(`QQ→Harness 驱动失败 ${String(err)}`)
      agentCache.delete(sessionId) // 句柄可能已失效（agent 被回收）→ 下次重新解析
      enqueueOutbox({ openid, content: `⚠️ 发送失败：${String(err).slice(0, 120)}\n可重试，或 /exit 返回后重进。`, msgId: undefined })
    }
  }

  const lastReplyTarget = new Map()
  const agentCache = new Map()
  // 记录每个会话最后一次 turn/start 的时间，用于完成通知的耗时。
  const turnStarts = new Map()
  // QQ 会话需要一个有效工作目录，否则 prompt 的 {{cwd}} 无值导致回合直接报错。
  const defaultCwd = cfg.cwd || process.cwd()

  const resumeOrCreateAgent = async (sessionId, { openid }) => {
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents 服务尚未就绪')
    // 关键：若该会话已有 live agent（例如被 web 端占用），直接复用它的 agent，
    // 用 agent.send 把消息排进它的 inbox（dsh 消息队列机制），不新建、不打断。
    const live = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    const cached = agentCache.get(sessionId)
    // 缓存命中且该 agent 仍是 dsh 里的 live agent → 复用
    if (cached && cached.agent === live) return cached
    // 缓存里的 agent 已被 dsh 回收（web 关闭/会话 detach）→ 丢句柄，重新解析
    if (cached) agentCache.delete(sessionId)
    if (live) {
      fileLog(`复用已有 live agent ${sessionId}（投递到 inbox 队列）`)
      return { agent: live }
    }
    let handle
    try {
      handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: cfg.provider ? { provider: cfg.provider, model: cfg.model } : {},
      })
    } catch (err) {
      if (cfg.debug) logger.debug('[qq-notify] QQ 会话 %s 不可恢复：%o', sessionId, err)
      handle = await agents.create({
        sessionId,
        agentOptions: cfg.provider ? { provider: cfg.provider, model: cfg.model } : {},
        meta: { cwd: defaultCwd },
      })
    }
    agentCache.set(sessionId, handle)
    return handle
  }

  // ---- Harness → QQ：桥接会话回复 + 完成通知 ------------------------
  const onSessionEvent = ctx.on

  onSessionEvent('session/event', guarded('桥接 session/event', (session, event) => {
    const sessionId = String(session.id)
    // 只处理本插件正在驱动的会话：QQ 自建会话（qq:）或在 lastReplyTarget 中登记的已有工作区会话。
    const target = lastReplyTarget.get(sessionId)
    if (target === undefined) return
    const openid = target.openid

    if (event.type === 'turn/start') {
      turnStarts.set(sessionId, Date.now())
      return
    }

    if (event.type === 'turn/end') {
      const kind = event.data?.reason?.kind
      if (debug) fileLog(`桥接 turn/end 会话=${sessionId} kind=${kind}`)
      if (notifyEvents.has(mapKind(kind))) {
        const started = turnStarts.get(sessionId)
        turnStarts.delete(sessionId)
        const text = renderNotification({
          kind: mapKind(kind),
          session,
          sessionId,
          turn: event.data.turn,
          durationMs: started === undefined ? undefined : Date.now() - started,
          reason: event.data?.reason,
        })
        fileLog(`QQ 桥接 turn/end kind=${kind} → 推送`)
        enqueueOutbox({ openid, content: text, msgId: target.lastMsgId })
      }
      return
    }

    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content
      const text = Array.isArray(blocks)
        ? blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n').trim()
        : ''
      if (text) {
        fileLog(`assistant 回复 → QQ: ${text.slice(0, 40)}`)
        enqueueOutbox({ openid, content: text, msgId: target.lastMsgId })
      }
    }
  }))

  // 提问（ask_user）：新版 dsh 无 userQuestions.registerProvider，正式缝隙是
  // agent 作用域的 waterfall 事件 user-questions/request：返回答案即接手，
  // 调 next() 则让给别的应答者（浏览器 UI）。
  // prepend: dsh-api-remotes 的浏览器转发器先注册且会直接应答，不抢占则 QQ 永远收不到。
  if (bridge && askUserBridge) {
    try {
      const onAsk = guarded('user-questions/request', (request, next) => {
        const agentId = request?.agent?.session?.id ?? request?.agent?.id
        if (typeof agentId !== 'string') return next()
        // QQ 自建会话，或被 QQ 驱动的工作区会话（openid 记在 lastReplyTarget 里）。
        const openid = openidOfSession(agentId) || lastReplyTarget.get(agentId)?.openid
        if (!openid) return next() // 其余交给浏览器 UI 等其他应答者
        // 自动把该用户的当前会话切到发起提问的会话（对话模式），方便直接回答。
        const u = ensureUser(openid)
        const askingName = sessionNameOf(agentId, u, openid)
        const s = findSession(u, askingName) || u.sessions[0]
        if (s) {
          u.currentName = s.name
          u.mode = 'chat'
          persistSessions()
        }
        const questions = Array.isArray(request?.questions) ? request.questions : []
        fileLog(`ask_user → QQ（openid=${mask(openid)}，${questions.length} 问）`)
        enqueueOutbox({ openid, content: renderQuestion(questions), msgId: undefined })
        return waitForQQReply(openid, '提问', 300_000, () => {
          fileLog('ask_user 等待超时')
        }, request?.signal).then((answer) => ({
          answers: questions.map((q) => ({
            id: q.id,
            selected: [suggestedAnswer(q, answer)],
            custom: suggestedAnswer(q, answer) === answer ? undefined : answer,
          })),
        }))
      })
      ctx.on('user-questions/request', onAsk, true)
      fileLog('user-questions/request 监听已注册（QQ 接手提问，prepend 抢占浏览器转发器）')
    } catch (err) {
      logger.warn('[qq-notify] ask_user 的 QQ 应答监听注册失败（降级）：%o', err)
      fileLog(`user-questions/request 监听注册失败（降级，QQ 提问桥接不可用）：${String(err)}`)
    }
  }

  // 权限申请（approval）：监听 approval/request waterfall。
  // prepend：dsh-api-remotes 把该事件转发给浏览器 UI 的转发器先注册、且浏览器在
  // 线时会直接应答（forwardWaterfall 不再调 next），不抢占则 QQ 永远收不到审批。
  if (bridge && approvalBridge) {
    const onApproval = guarded('approval/request', (request, next) => {
      const agentSessionId = request?.agent?.session?.id ?? request?.agent?.id
      if (typeof agentSessionId !== 'string') return next()
      // QQ 自建会话，或被 QQ 驱动的工作区会话（openid 记在 lastReplyTarget 里）。
      const openid = openidOfSession(agentSessionId) || lastReplyTarget.get(agentSessionId)?.openid
      if (!openid) return next() // 不由 QQ 驱动的会话 → 交给浏览器转发器
      // 自动把该用户切到发起审批的会话。
      const u = ensureUser(openid)
      ensureDefaultSession(u, openid)
      const name = sessionNameOf(agentSessionId, u, openid)
      const s = findSession(u, name) || u.sessions[0]
      if (s) {
        u.currentName = s.name
        u.mode = 'chat'
        persistSessions()
      }
      const why = request.reason ? `（原因：${request.reason}）` : ''
      fileLog(`approval/request → QQ（openid=${mask(openid)} tool=${request.toolName}）`)
      // 审批正文里的会话用标题（可读），不再是 session-xxxx。
      const approvalSession = ctx.get?.('sessions')?.get?.(agentSessionId)
      enqueueOutbox({ openid, content:
        `🔐 需要你的授权\n`
        + `工具：${request.toolName ?? '未知'}${why}\n`
        + `会话：${sessionLabel(approvalSession, agentSessionId)}\n\n`
        + `回复「同意 / 允许一次」放行，回复「拒绝」拒绝。\n`
        + `（5 分钟内未答复将自动拒绝）`, msgId: undefined })
      return waitForQQReply(openid, '审批', 300_000, () => {
        fileLog('approval 等待超时 → 默认拒绝')
        enqueueOutbox({ openid, content: '⏰ 审批超时，已自动拒绝。', msgId: undefined })
      }, request?.signal, 'rejected').then((answer) => {
        const a = (answer || '').trim()
        // 失败关闭：只有明确同意才放行，其余（拒绝/超时/被抢占/异常文本）一律 rejected。
        if (/^(同意|允许|可以|是|yes|ok|allow|\/allow|\/同意|\/yes)/i.test(a)) {
          fileLog(`approval 用户同意：${a}`)
          enqueueOutbox({ openid, content: '✅ 已授权（允许一次）。', msgId: undefined })
          return 'allowed-once'
        }
        fileLog(`approval 未获同意（${a || '空答复'}）→ 拒绝`)
        enqueueOutbox({ openid, content: '🚫 已拒绝授权。', msgId: undefined })
        return 'rejected'
      })
    })
    ctx.on('approval/request', onApproval, true)
  }

  // ---- 完成通知：会话级聚合 ----------------------------------------
  //
  // 目标：QQ 上「一件事结束」才收一条，而不是每个回合、每个子代理都刷屏。
  // 做法：
  //  - 子代理会话默认不单独推（notifySubagents: false），只把它的结束计入父会话统计；
  //  - 每个会话维护一个 pending 聚合：期间任何新回合/子代理结束都刷新「最后活动时间」；
  //    只有静默满 notifyQuietMs 才真正推送（= 整件事结束）；
  //  - 持续忙碌超过 notifyStaleMs 也先推一条进度，避免长时间毫无消息。
  const pendingNotices = new Map() // sessionId -> 聚合条目
  const maxTurnOf = new Map()      // sessionId -> 已知的最大 turn（找回父会话最后一条回复用）
  const busySessions = new Set()   // 自己的回合还没结束的会话（此时不能推，否则一件事会被拆成两条）

  /**
   * 该会话是否「自己的回合还没结束」。
   * 优先用事件观察到的状态；但如果插件是在回合中途加载的（热装/重启），
   * 我们没看到 turn/start —— 这时从会话日志判断（turn/start 与 turn/end 都入日志）。
   */
  const isTurnOpen = (sid, session) => {
    if (busySessions.has(sid)) return true
    const events = sessionEventsOf(session)
    let open = false
    for (const e of events) {
      if (e.type === 'turn/start') open = true
      else if (e.type === 'turn/end') open = false
    }
    return open
  }

  /** 从任意会话沿 parentSession 上溯到「顶层会话」（用户的会话）。 */
  const rootAncestorOf = (sid) => {
    const sessionsSvc = ctx.get?.('sessions')
    if (!sessionsSvc || typeof sessionsSvc.get !== 'function') return sid
    let cur = sid
    for (let i = 0; i < 32; i += 1) {
      let parent
      try { parent = sessionsSvc.get(cur)?.header?.parentSession } catch { parent = undefined }
      if (typeof parent !== 'string' || parent.length === 0) return cur
      cur = parent
    }
    return cur
  }

  /** 推送（或清掉）一个会话的聚合通知。reason: 'quiet' | 'stale' | 'flush' */
  const flushNotice = (sid, reason) => {
    const entry = pendingNotices.get(sid)
    if (entry === undefined) return false
    const busyFor = Date.now() - entry.firstActivityAt
    // 本会话自己的回合还在跑（例如编排主会话仍在等子代理/继续下一步）：
    // 此时推送会把「一件事」拆成两条，所以只把定时器往后推。
    // 但长时间忙碌时按 stale **播报一次**进度（每个任务最多一次，绝不反复刷）。
    if (reason !== 'stale' && isTurnOpen(sid, entry.session)) {
      busySessions.add(sid)
      if (busyFor >= notifyStaleMs && !entry.staleNotified) {
        fileLog(`通知: 会话 ${sid} 已忙碌 ${Math.round(busyFor / 1000)}s（超过 notifyStaleMs），播报一次进度`)
        reason = 'stale'
      } else {
        noteActivity(sid, entry)
        // 节流留痕：每次推迟都写会把日志刷爆（长回合每 20s 一条），只在明显间隔时记一次。
        if (debug && Date.now() - (entry.lastDeferLogAt ?? 0) >= 60_000) {
          entry.lastDeferLogAt = Date.now()
          fileLog(`通知: 会话 ${sid} 仍在忙，推迟推送（已忙 ${Math.round(busyFor / 1000)}s）`)
        }
        return false
      }
    }
    if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null }
    // stale 只是进度播报：条目**保留**给最终完成通知，并标记已播报（每个任务只播一次）。
    if (reason === 'stale') {
      entry.staleNotified = true
      // 关键：下面没删条目，但这次推送清掉了静默定时器 —— 必须重新排一次，
      // 否则「任务完成」那条永远不来（真实踩过：长任务结束时只收到一条【进度】）。
      noteActivity(sid, entry)
    } else pendingNotices.delete(sid)
    const openid = targetOpenid()
    if (!openid) { fileLog('notify: 尚无 openid，跳过'); return false }
    // 子代理数在推送这一刻统计（含嵌套层级），最准。
    if (notifyIncludeSubagentCount) {
      entry.subagents = Math.max(entry.subagents, countSubagentDescendants(sid))
    }
    const text = renderAggregateNotice(entry, { includeSubagents: notifyIncludeSubagentCount, reason })
    fileLog(`通知(${reason}) 会话=${sid} 回合=${entry.turns} 子代理=${entry.subagents} 错误=${entry.errors} → QQ`)
    // 留一份内容预览：QQ 实际收到什么，日志里能核对（标题是否解析对，一眼可见）。
    if (debug) fileLog(`  内容预览：${text.replace(/\s+/g, ' ').slice(0, 160)}`)
    enqueueOutbox({ openid, content: text, msgId: undefined })
    return true
  }

  /** 记一次「这个会话有活动」，并重排静默定时器。 */
  const noteActivity = (sid, entry) => {
    entry.lastActivityAt = Date.now()
    if (entry.timer !== null) clearTimeout(entry.timer)
    // 回调打上本实例标记：全局定时器守卫只放行当前实例的通知定时器（热换残留实例的会被丢掉）。
    const onQuiet = () => { void flushNotice(sid, 'quiet') }
    onQuiet[NOTICE_TIMER_MARK] = instanceToken
    entry.timer = setTimeout(onQuiet, notifyQuietMs)
    entry.timer.unref?.()
  }

  const ensureNotice = (sid, session) => {
    let entry = pendingNotices.get(sid)
    if (entry === undefined) {
      // 由子代理结束时创建时没有 root session 对象，这里补取，供「最后一轮工具调用」统计用。
      if (session === undefined) {
        try { session = ctx.get?.('sessions')?.get?.(sid) } catch { session = undefined }
      }
      entry = {
        sessionId: sid, session,
        firstActivityAt: Date.now(), lastActivityAt: Date.now(),
        turns: 0, subagents: 0, errors: 0, lastKind: 'completed',
        lastTurn: undefined, rootTitle: undefined, fallbackTitle: undefined,
        // 回合中途加载（热装/重启）时补一个起点，否则完成通知里没有「总耗时」。
        startedAt: openTurnStartedAt(session), timer: null, staleNotified: false,
      }
      pendingNotices.set(sid, entry)
    } else if (entry.session === undefined && session !== undefined) {
      entry.session = session
    }
    return entry
  }

  /** 汇总某会话下已结束的子代理数量（递归覆盖嵌套子代理）。 */
  const countSubagentDescendants = (rootSid) => {
    const sessionsSvc = ctx.get?.('sessions')
    if (!sessionsSvc || typeof sessionsSvc.list !== 'function') return 0
    let n = 0
    try {
      for (const s of sessionsSvc.list()) {
        const h = s?.header
        if (!h || typeof h.parentSession !== 'string') continue
        // 只看本会话的后代：上溯到根是不是 rootSid
        if (rootAncestorOf(h.id) !== rootSid) continue
        if (sessionEventsOf(s).some((e) => e.type === 'turn/end')) n += 1
      }
    } catch (err) { fileLog(`统计子代理失败 ${String(err)}`) }
    return n
  }

  /** 把一次 turn/end 计入聚合条目。 */
  const recordTurnEnd = (sid, session, event, startedAt, kind) => {
    const entry = ensureNotice(sid, session)
    entry.turns += 1
    entry.lastKind = kind
    if (kind === 'error') entry.errors += 1
    if (typeof event.data?.turn === 'number') {
      entry.lastTurn = event.data.turn
      maxTurnOf.set(sid, Math.max(maxTurnOf.get(sid) ?? 0, event.data.turn))
    }
    if (startedAt !== undefined && entry.startedAt === undefined) entry.startedAt = startedAt
    // 标题用会话标题（dsh 的 session/title），不是 session-xxxx；子代理的提示词不作任务名。
    if (entry.rootTitle === undefined) entry.rootTitle = sessionTitle(session)
    noteActivity(sid, entry)
    return entry
  }

  /**
   * 顶层会话自己还没跑完回合时的标题：按 id 取回它的 session 再读标题。
   * 不能用子代理的提示词——那推出来会是「【任务完成】sub-d1」这种。
   */
  const rootTaskTitle = (sid) => {
    try {
      const rootSession = ctx.get?.('sessions')?.get?.(sid)
      if (rootSession === undefined) return undefined
      const title = sessionTitle(rootSession)
      return title === String(sid) ? undefined : title
    } catch { return undefined }
  }

  /** 子代理结束 → 计入顶层父会话（子代理自身默认不单独推，嵌套层级也一并上溯）。 */
  const recordSubagentEnd = (session, event, kind) => {
    const parent = session?.header?.parentSession
    if (typeof parent !== 'string' || parent.length === 0) return
    const root = rootAncestorOf(parent)
    if (root.startsWith(SESSION_PREFIX) || lastReplyTarget.has(root)) return
    const entry = ensureNotice(root, undefined)
    entry.subagents += 1
    if (kind === 'error') entry.errors += 1
    // 顶层会话自己还没跑完回合时，按 id 取回它的会话读标题（子代理提示词只作最后兜底）。
    if (entry.rootTitle === undefined) entry.rootTitle = rootTaskTitle(root)
    if (entry.fallbackTitle === undefined) entry.fallbackTitle = sessionTitle(session)
    noteActivity(root, entry)
    if (debug) fileLog(`子代理结束 → 计入顶层会话 ${root}（子代理=${entry.subagents}）`)
  }

  if (notifyEvents.size > 0) {
    onSessionEvent('session/event', guarded('通知 session/event', (session, event) => {
      const sid2 = String(session.id)
      // turn 配对先做：后面任何早退都不能让 turnStarts 泄漏，也不能让耗时用到陈旧起点。
      if (event.type === 'turn/start') {
        turnStarts.set(sid2, Date.now())
        busySessions.add(sid2)
        // 本会话正忙 → 把它的聚合推送往后推（连续回合合并成一条）。
        const entry = pendingNotices.get(sid2)
        if (entry !== undefined) noteActivity(sid2, entry)
        return
      }
      if (event.type !== 'turn/end') return
      const startedAt = turnStarts.get(sid2)
      turnStarts.delete(sid2)
      busySessions.delete(sid2)
      // QQ 自建会话 + 被 QQ 驱动的已有工作区会话，由上面桥接分支处理，跳过避免重复。
      if (sid2.startsWith(SESSION_PREFIX) || lastReplyTarget.has(sid2)) return

      const kind = event.data?.reason?.kind
      if (debug) fileLog(`通知 turn/end 会话=${sid2} kind=${kind}（订阅=${[...notifyEvents].join(',')}）`)
      if (!kind) return

      // 子代理：默认静音，只把「结束了」计入顶层会话；嵌套子代理同样上溯到顶层。
      if (isSubagentSession(session)) {
        if (!notifySubagents) { recordSubagentEnd(session, event, kind); return }
      } else if (!notifyEvents.has(mapKind(kind))) {
        return // 主会话只对订阅的 kind（completed/error）计数
      }

      if (isSubagentSession(session) && notifySubagents) {
        // 显式要求子代理也单独推：走一次性通知（不聚合）。
        const openid = targetOpenid()
        if (!openid) { fileLog('notify: 尚无 openid，跳过'); return }
        const text = renderNotification({
          kind: mapKind(kind), session, sessionId: sid2, turn: event.data.turn,
          durationMs: startedAt === undefined ? undefined : Date.now() - startedAt,
          reason: event.data?.reason,
        })
        fileLog(`通知(子代理单独) kind=${kind} → QQ`)
        enqueueOutbox({ openid, content: text, msgId: undefined })
        return
      }

      // 顶层会话：计入聚合（含期间结束的子代理），等它闲下来再推一条。
      const entry = recordTurnEnd(sid2, session, event, startedAt, kind)
      if (notifyIncludeSubagentCount) entry.subagents = Math.max(entry.subagents, countSubagentDescendants(sid2))
      if (!notifyOnlyQuiet) { void flushNotice(sid2, 'flush'); return }
      // 持续忙碌兜底：第一次活动起超过 notifyStaleMs 就先汇报一次进度（**每个任务最多一次**）。
      // 注意两个「不」：不在已播报过时再播（否则长任务会收到重复进度），也不能因为播报
      // 就丢掉最终完成通知（`flushNotice(stale)` 内部会重排静默定时器）。
      const busyFor = Date.now() - entry.firstActivityAt
      if (busyFor >= notifyStaleMs && !entry.staleNotified) {
        fileLog(`通知: 会话 ${sid2} 持续忙碌 ${Math.round(busyFor / 1000)}s，先推一次进度`)
        void flushNotice(sid2, 'stale')
      }
    }))
  }

  // 卸载/热换（dispose）时必须清掉这两类定时器：它们不是 ctx.effect 直接管理的资源。
  // 不清的话旧实例会变成「僵尸」——回合结束后照样推一条重复通知（2026-09-18 真实踩过）。
  ctx.effect(() => () => {
    for (const entry of pendingNotices.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = null
    }
    pendingNotices.clear()
    if (outboxTimer !== null) { clearInterval(outboxTimer); outboxTimer = null }
    outboxQueue.length = 0
  }, 'qq-notify.dispose-timers()')
}

// ---- 工具函数 ----

/**
 * 读取一个 session 的事件数组，兼容两代 dsh：
 *  - ≤ 0.1.0-rc.x：`session.events` 是只读数组 getter（旧写法）
 *  - ≥ 0.1.5-rc.1：`session.events` 已删除，改用 `session.snapshotEvents()`
 *    （全量，语义等同旧 getter）或 `session.ownEvents()`（fork 后仅自身段）
 * 只读、失败一律降级为空数组——通知链路不允许因为读日志失败而中断。
 */
function sessionEventsOf(session) {
  if (!session || typeof session !== 'object') return []
  // 旧属性读取也要兜：某些版本可能把已废弃的 `events` 做成「抛错 getter」强制迁移，
  // 裸读会直接抛在监听器之外——那正是历史上「日志无痕、通知全丢」的复现路径。
  let legacy
  try { legacy = session.events } catch { legacy = undefined }
  if (Array.isArray(legacy)) return legacy
  for (const reader of ['snapshotEvents', 'ownEvents']) {
    if (typeof session[reader] === 'function') {
      try {
        const events = session[reader]()
        if (Array.isArray(events)) return events
      } catch { /* 落到下一个读取器 */ }
    }
  }
  if (Array.isArray(session.log)) return session.log
  return []
}

/**
 * 包一层观察者：把监听器里抛出的异常写进 qq-notify.log。
 * dsh 的 session 观察者通道会吞掉监听器异常（只记一条 warn），
 * 不包一层就会像 session.events 那次一样「静默失效」。
 *
 * waterfall 场景（approval/request、user-questions/request）最后一个参数是 next()：
 * 异常时降级为「不接手」交给其他应答者（浏览器 UI），而不是把调用方（工具调用）搞崩。
 */
function guarded(label, fn) {
  /** 同步异常：写日志；waterfall 场景降级为「不接手」交给其他应答者。 */
  const recoverSync = (args, err) => {
    fileLog(`${label} 监听器异常：${String(err)}`)
    const next = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined
    if (next) {
      try { return next() } catch (err2) { fileLog(`${label} next() 也失败：${String(err2)}`) }
    }
    throw err
  }
  return (...args) => {
    let result
    try {
      result = fn(...args)
    } catch (err) {
      return recoverSync(args, err)
    }
    // 自己返回的 promise 只记日志再抛出，**不能**再调 next()：
    // next() 的 promise 也在里面，下游失败时二次 next() 会把剩余监听器重跑一遍。
    if (result && typeof result.then === 'function') {
      return result.catch((err) => {
        fileLog(`${label} 监听器异步异常：${String(err)}`)
        throw err
      })
    }
    return result
  }
}

/** 推送实例标记头：热换/卸载后旧实例的推送带不上当前标记，被下面的守卫丢掉。 */
const PUSH_MARK_HEADER = 'x-qq-notify-instance'
/** 通知定时器回调上的标记字段名（见 installNoticeTimerGuard）。 */
const NOTICE_TIMER_MARK = '__qqNotifyNoticeTimer'

/**
 * 全局推送守卫：只放行「当前实例」发往 QQ 的推送。
 *
 * 为什么需要：`ctx.effect` 只能管住注册进去的资源。热换（先 dispose 旧 entry 再
 * `loader.create`）时旧实例的**已排队定时器**仍会触发，它照样能 `fetch` 到 QQ API →
 * 用户在回合结束后收到重复通知。2026-09-18 实测：连续热更 3 次 = 3 个僵尸实例，
 * 各自在 15 分钟后推一条（`【任务完成】…`）。
 *
 * 规则：本实例的推送带 `x-qq-notify-instance: <token>`；发往
 * `/v2/users/<openid>/messages` 但标记不等于当前 token 的请求直接丢掉（并留日志）。
 * 其它任何请求原样透传——守卫本身绝不改变正常网络行为。
 */
function installPushGuard(token) {
  const g = globalThis
  let guard = g.__dshQqNotifyPushGuard
  if (guard === undefined) {
    const native = g.fetch
    guard = { token: undefined, dropped: 0 }
    g.fetch = function guardedFetch(input, init) {
      try {
        const url = typeof input === 'string' ? input : String(input?.url ?? input ?? '')
        if (/\/v2\/users\/[^/]+\/messages$/.test(url.split('?')[0])) {
          const headers = init?.headers
          const marked = headers === undefined || headers === null ? undefined
            : (typeof headers.get === 'function' ? headers.get(PUSH_MARK_HEADER) : headers[PUSH_MARK_HEADER])
          if (marked !== guard.token) {
            guard.dropped += 1
            fileLog(`丢弃非当前实例的 QQ 推送（热换/卸载残留实例，第 ${guard.dropped} 条）`)
            return Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
          }
        }
      } catch { /* 守卫出错时按正常请求放行 */ }
      return native(input, init)
    }
    g.__dshQqNotifyPushGuard = guard
  }
  guard.token = token
  return guard
}

/**
 * 全局通知定时器守卫：只允许「当前实例」的聚合通知定时器生效。
 *
 * 同上的僵尸问题：`noteActivity()` 的静默定时器是普通 `setTimeout`，不受 `ctx.effect` 管理，
 * 旧实例被卸载后它还会继续 20 秒一轮地跑（日志刷「仍在忙」、到 stale 阈值还会推一条）。
 * 装一次守卫后，新实例的定时器回调带标记 → 放行；没标记（旧代码实例）或标记已过期的
 * 通知定时器 → 丢弃。判定用回调源码里的 `flushNotice`，只可能命中本插件自己的通知定时器。
 */
function installNoticeTimerGuard(token) {
  const g = globalThis
  let guard = g.__dshQqNotifyTimerGuard
  if (guard === undefined) {
    const native = g.setTimeout
    guard = { token: undefined, dropped: 0 }
    g.setTimeout = function guardedSetTimeout(fn, ms, ...rest) {
      if (typeof fn === 'function' && /flushNotice/.test(String(fn))) {
        const mark = fn[NOTICE_TIMER_MARK]
        if (mark === undefined || mark !== guard.token) {
          guard.dropped += 1
          return native(() => {}, ms, ...rest) // 空转替身：保持句柄/返回值语义
        }
      }
      return native(fn, ms, ...rest)
    }
    g.__dshQqNotifyTimerGuard = guard
  }
  guard.token = token
  return guard
}

function cleanText(raw) {
  return String(raw ?? '')
    .replace(/<@!\d+>/g, '')
    .replace(/<\/(s|@)#[^>]*>/g, '')
    .trim()
}

function nextSeq() {
  return Date.now() % 1_000_000_000
}

function normalizeEvents(configured) {
  // 未配置 → 默认三件套；显式给了数组（含空数组）→ 完全按用户说的来（空 = 关掉主动通知）。
  if (!Array.isArray(configured)) return [...DEFAULT_NOTIFY_EVENTS]
  return DEFAULT_NOTIFY_EVENTS.filter((k) => configured.includes(k))
}

function mapKind(kind) {
  if (kind === 'completed') return 'completed'
  if (kind === 'error' || kind === 'aborted' || kind === 'blocked' || kind === 'max-tokens' || kind === 'interrupted') return 'error'
  return kind
}

function suggestedAnswer(q, answer) {
  if (Array.isArray(q.options) && q.options.length) {
    const match = q.options.find((o) => o.label && answer.includes(o.label))
    if (match) return match.label
  }
  return answer
}

function renderQuestion(questions) {
  const lines = ['❓ 你在 DeepSeek Harness 里被问到：']
  for (const q of questions) {
    lines.push(`Q: ${q.question}`)
    if (Array.isArray(q.options) && q.options.length) {
      lines.push(`选项：${q.options.map((o) => o.label).join(' / ')}`)
    }
  }
  lines.push('（直接回复你的答案即可）')
  return lines.join('\n')
}

function abortSignal(ms) {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined
}

function renderText(n) {
  const lines = [`【${kindLabel(n.kind)}】${n.title ?? ''}`]
  if (n.summary) lines.push(`摘要：${n.summary}`)
  if (n.durationMs !== undefined) lines.push(`耗时：${formatDuration(n.durationMs)}`)
  if (n.toolCalls) lines.push(`工具调用：${n.toolCalls} 次`)
  if (n.kind === 'error' && n.error) lines.push(`错误：${n.error}`)
  lines.push(`会话：${n.label ?? shortSessionId(n.sessionId)}`)
  lines.push(`时间：${new Date().toLocaleString('zh-CN')}`)
  return lines.join('\n')
}

/** 从 reason.error 里取一段可读错误文本。 */
function errorText(err) {
  if (!err) return undefined
  if (typeof err === 'string') return err.slice(0, 200)
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string') return err.message.slice(0, 200)
    if (typeof err.error === 'string') return err.error.slice(0, 200)
  }
  return String(err).slice(0, 200)
}

/** 统计一个回合内工具调用次数。 */
function countToolCalls(session, turn) {
  let n = 0
  if (turn === undefined) return 0
  for (const event of sessionEventsOf(session)) {
    if (event.type === 'tool/call' && event.data?.turn === turn) n += 1
  }
  return n
}

function kindLabel(kind) {
  switch (kind) {
    case 'completed': return '任务完成'
    case 'error': return '运行出错'
    case 'aborted': return '已中止'
    case 'blocked': return '被阻断'
    case 'max-tokens': return '达到最大 token'
    case 'interrupted': return '中断'
    case 'approval_requested': return '等待审批'
    default: return kind
  }
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分钟` : `${minutes} 分 ${rest} 秒`
}

/**
 * 会话标题读取（纯函数，从日志折叠）——优先 DSH 自己维护的 `session/title` 事件，
 * 而不是自己猜首条消息。`session/title` 是 latest-wins 的日志事件，由 dsh-session-title
 * 生成（LLM provider 或内置 fallback，source 字段标明来源）。
 */
function foldTitleFromLog(session) {
  const events = sessionEventsOf(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e.type !== 'session/title') continue
    const title = e.data?.title
    if (typeof title === 'string' && title.trim()) return title.trim()
  }
  return undefined
}

/**
 * 「当前还没结束的那个回合」的开始时间（Unix epoch ms）。
 * 用途：插件是回合中途加载的（热装/重启）时**看不到 turn/start 事件**，没有它通知里就没有总耗时。
 * 没有开着的回合（或日志里没记时间）就返回 undefined。
 */
function openTurnStartedAt(session) {
  const events = sessionEventsOf(session)
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i]
    if (e.type === 'turn/end') return undefined
    if (e.type === 'turn/start' && typeof e.time === 'number') return e.time
  }
  return undefined
}

/** 该 user/message 是否是人类输入（排除插件注入 / 工具结果 / 子代理中转）。 */
function isHumanMessage(event) {
  const source = event?.data?.source
  if (source === undefined || source === null) return true // 老日志没 source：当作人类
  return source.kind === 'user'
}

/**
 * 取会话的首条**人类**输入作为标题候选。
 * 坑：`user/message` 不只有人类输入——插件注入（`source.kind === 'plugin'`，例如审批策略变更通知、
 * 定时任务、goal 续跑）也是 user 角色，直接取首条会拿到「The approval policy changed from …」这种。
 */
function firstHumanText(session, maxLen = 60) {
  for (const event of sessionEventsOf(session)) {
    if (event.type !== 'user/message') continue
    if (!isHumanMessage(event)) continue
    const text = textOf(event.data?.content).replace(/\s+/g, ' ').trim()
    if (text) return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text
  }
  return undefined
}

/** 会话展示名：session/title → 首条人类消息 → 会话 id（最后的兜底）。 */
function sessionTitle(session) {
  return foldTitleFromLog(session) ?? firstHumanText(session) ?? String(session?.id ?? '')
}

/** 会话的简短 id（标题拿不到 / 需要消歧时用，避免刷一长串 UUID）。 */
function shortSessionId(sessionId) {
  const s = String(sessionId ?? '')
  if (!s) return ''
  if (s.startsWith(SESSION_PREFIX)) return s // qq:<openid>[:<name>] 本身可读
  const core = s.replace(/^session-/, '')
  const head = core.split('-')[0] // UUID 的第一段就够唯一了
  if (head.length >= 6 && head.length <= 12) return head
  return core.length > 12 ? `${core.slice(0, 12)}…` : core
}

/**
 * 「会话：」那一行的消歧展示：标题（短 id）。
 * 用在**需要用户挑一个**的场景（工作区会话列表、审批、接入确认）：标题可能重名，短 id 用于区分。
 */
function sessionLabel(session, sessionId) {
  const id = String(sessionId ?? session?.id ?? '')
  const title = session ? sessionTitle(session) : undefined
  const short = shortSessionId(id)
  if (title && title !== id && title !== short) return `${title}（${short}）`
  return title || short
}

/**
 * 纯标题展示（不带 id）：用于通知正文——用户诉求就是「别显示 session-xxxx」。
 * 拿不到任何标题时才退回短 id。
 */
function sessionName(session, sessionId) {
  const id = String(sessionId ?? session?.id ?? '')
  const title = session ? sessionTitle(session) : undefined
  if (title && title !== id) return title
  return shortSessionId(id)
}

function summarizeTurn(session, turn) {
  let toolCalls = 0
  let lastText = ''
  for (const event of sessionEventsOf(session)) {
    if (event.type === 'tool/call' && event.data.turn === turn) toolCalls += 1
    if (event.type === 'assistant/message' && event.data.turn === turn) {
      const text = textOf(event.data.message.content)
      if (text) lastText = text
    }
  }
  const parts = []
  if (lastText) {
    const trimmed = lastText.replace(/\s+/g, ' ').trim()
    parts.push(trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed)
  }
  if (toolCalls > 0) parts.push(`调用了 ${toolCalls} 次工具`)
  return parts.join('；') || '（无文本输出）'
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && block.type === 'text') {
      const text = block.text
      if (typeof text === 'string') out += text
    }
  }
  return out
}

/**
 * 渲染「会话级聚合通知」：一个任务（含其间所有子代理与连续回合）只推一条。
 * 内容：任务标题 + 最后一轮结论 + 总耗时 + 工具调用数 + 子代理数。
 * 标题用会话标题（DSH 的 session/title），不是 session-xxxx。
 */
function renderAggregateNotice(entry, { includeSubagents = true, reason } = {}) {
  const totalMs = entry.startedAt === undefined ? undefined : Date.now() - entry.startedAt
  const kind = entry.errors > 0 ? 'error' : entry.lastKind
  const short = shortSessionId(entry.sessionId)
  const title = entry.rootTitle ?? entry.fallbackTitle ?? short
  // stale 只是「任务还在跑」的进度播报（回合还没结束），不能写成【任务完成】——
  // 真实案例：一个跑了 900s 的会话推出去是「【任务完成】…含 15 个子代理」，
  // 用户会以为任务已经结束了。
  const stale = reason === 'stale'
  const head = `【${stale ? '进度' : kindLabel(kind)}】${title}`
  const lines = [head]
  try {
    if (stale) lines.push('任务仍在进行，完成后会再通知一次')
    if (entry.turns > 1) lines.push(`本任务共 ${entry.turns} 个回合`)
    if (includeSubagents && entry.subagents > 0) lines.push(`含 ${entry.subagents} 个子代理`)
    if (entry.errors > 0) lines.push(`其中 ${entry.errors} 次出错`)
    if (totalMs !== undefined) lines.push(`总耗时：${formatDuration(totalMs)}`)
    // 最后一轮的工具调用数：需要 session 与 turn，缺一个就跳过（不阻断通知）。
    if (entry.session && entry.lastTurn !== undefined) {
      const calls = countToolCalls(entry.session, entry.lastTurn)
      if (calls > 0) lines.push(`最后一轮工具调用：${calls} 次`)
    }
  } catch (err) {
    fileLog(`聚合通知统计失败（只发基础信息）：${String(err)}`)
  }
  lines.push(`工作区：${entry.session?.header?.cwd ?? shortSessionId(entry.sessionId)}`)
  lines.push(`时间：${new Date().toLocaleString('zh-CN')}`)
  return lines.join('\n')
}

/**
 * 组装一条完成通知的文本。读会话日志/拼装任何一步失败都降级为最简文本，
 * 保证「通知必达」——绝不因为一条畸形事件让该会话的通知永久静默。
 */
function renderNotification({ kind, session, sessionId, turn, durationMs, reason }) {
  try {
    return renderText({
      kind,
      sessionId,
      label: sessionName(session, sessionId),
      title: sessionTitle(session),
      summary: summarizeTurn(session, turn),
      durationMs,
      error: kind === 'error' ? errorText(reason?.error) : undefined,
      toolCalls: countToolCalls(session, turn),
    })
  } catch (err) {
    fileLog(`组装通知文本失败（降级为最简文本）：${String(err)}`)
    return `【${kindLabel(kind)}】${shortSessionId(sessionId)}\n时间：${new Date().toLocaleString('zh-CN')}`
  }
}

function mask(id) {
  if (!id) return ''
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id
}

/** 安全的会话标题（用于已有会话枚举展示）：DSH 的 session/title 优先，否则退回首条人类消息。 */
function sessionSafeTitle(session) {
  try {
    if (!session) return ''
    return sessionTitle(session) || ''
  } catch { return '' }
}

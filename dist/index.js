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
  appId: Schema.string().required().description('QQ 官方机器人 AppID'),
  appSecret: Schema.string().required().description('QQ 官方机器人 AppSecret'),
  sandbox: Schema.boolean().default(true).description('是否使用 QQ 沙箱环境'),
  endpoint: Schema.string().default('https://api.sgroup.qq.com').description('QQ OpenAPI 接入点'),
  openid: Schema.string().description('（可选）手动指定接收通知的 C2C user_openid；留空则用网关自动捕获'),
  ownerOpenid: Schema.string().description('（可选）允许驱动 harness 的 QQ 用户 openid；留空则任意私聊都可驱动'),
  autoCapture: Schema.boolean().default(true).description('是否连接 QQ 网关自动捕获私聊发送者的 openid'),
  bridge: Schema.boolean().default(true).description('是否启用 QQ→Harness 双向桥（消息驱动 + 回复 + 提问/审批）'),
  askUserBridge: Schema.boolean().default(true).description('是否注册 userQuestions provider（QQ 接手 ask_user 提问）。web 浏览器 UI 已占用时请设 false，让浏览器提问'),
  provider: Schema.string().default('deepseek').description('QQ 会话默认使用的 AI 提供方'),
  model: Schema.string().default('deepseek-chat').description('QQ 会话默认使用的 AI 模型'),
  cwd: Schema.string().description('新建 QQ 会话运行的绝对工作目录'),
  notifyEvents: Schema.array(Schema.string()).description('主动推送触发的事件：completed / error / approval_requested'),
  outbox: Schema.boolean().default(true).description('是否启用待发送队列（限频 + 失败重试）'),
  outboxIntervalMs: Schema.number().default(2000).description('待发送队列 flush 间隔（毫秒）'),
  timeoutMs: Schema.number().default(5000).description('单次请求超时（毫秒）'),
  debug: Schema.boolean().default(false).description('是否输出 QQ 网关调试日志'),
})

const DEFAULT_NOTIFY_EVENTS = ['completed', 'error', 'approval_requested']

// C2C 私聊消息事件位（官方文档：USER_MESSAGE = 1 << 25）。
const USER_MESSAGE = 1 << 25
const DEFAULT_INTENTS = USER_MESSAGE
const TOKEN_RETRY_MS = 10_000
const RECONNECT_DELAY_MS = 5_000
const SESSION_PREFIX = 'qq:'

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
  const appId = String(cfg.appId ?? '').trim()
  const appSecret = String(cfg.appSecret ?? '')
  const configuredOpenid = String(cfg.openid ?? '').trim()
  const ownerOpenid = String(cfg.ownerOpenid ?? '').trim()
  const sandbox = cfg.sandbox ?? true
  const endpoint = apiEndpoint(cfg.endpoint ?? 'https://api.sgroup.qq.com', sandbox)
  const autoCapture = cfg.autoCapture ?? true
  const bridge = cfg.bridge ?? true
  const askUserBridge = cfg.askUserBridge ?? true
  const outbox = cfg.outbox ?? true
  const outboxIntervalMs = typeof cfg.outboxIntervalMs === 'number' ? cfg.outboxIntervalMs : 2000
  const timeoutMs = typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 5000
  const debug = cfg.debug ?? false
  const notifyEvents = new Set(normalizeEvents(cfg.notifyEvents))

  if (!appId || !appSecret) {
    logger.warn('[qq-notify] 未配置完整：需要 appId / appSecret，当前禁用')
    return
  }

  // 写 PID 文件，供外部守护进程做「进程销毁通知」的 PID 监控。
  writePidFile()

  // 诊断：记录 QQ 驱动的 agent 回合错误详情（定位 error 根因用）。
  ctx.on('agent/error', ({ agent, turn, step, error }) => {
    const sid = agent?.session?.id
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

  /** 枚举已有工作区及其会话（来自会话存储的 live 会话，按 cwd 分组）。 */
  const workspaceInventory = () => {
    const sessionsSvc = ctx.get('sessions')
    if (!sessionsSvc || typeof sessionsSvc.list !== 'function') return []
    let list = []
    try { list = sessionsSvc.list() } catch (err) { fileLog(`枚举会话失败 ${String(err)}`); return [] }
    const byCwd = new Map()
    for (const s of list) {
      if (!s || typeof s !== 'object') continue
      const id = s.id
      if (typeof id !== 'string' || id.startsWith(SESSION_PREFIX)) continue // 跳过 QQ 自建会话
      const cwd = s.header?.cwd || '(未知工作区)'
      if (!byCwd.has(cwd)) byCwd.set(cwd, [])
      byCwd.get(cwd).push({
        sessionId: id,
        title: sessionSafeTitle(s) || id.slice(0, 20),
      })
    }
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

  /** 生成某工作区的会话明细。 */
  const renderWorkspaceDetail = (u, openid, wsIdx) => {
    const inventory = workspaceInventory()
    const ws = inventory[wsIdx]
    if (!ws) return '（工作区不存在）'
    const lines = [`🏢 工作区：${ws.cwd}`, '选择会话：']
    ws.sessions.forEach((s, i) => lines.push(`${i + 1}. ${s.title} (${s.sessionId.slice(0, 12)}…)`))
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
    try {
      const tok = await getToken()
      const body = msgId
        ? { content, msg_type: 0, msg_id: msgId, msg_seq: nextSeq() }
        : { content, msg_type: 0, msg_seq: nextSeq() }
      const res = await fetch(`${endpoint}/v2/users/${openid}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${tok}` },
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
      if (outboxQueue.length === 0) return
      const item = outboxQueue.shift()
      void pushQQ(item).then((ok) => { if (!ok) outboxQueue.push(item) })
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

  const resolvePending = (text) => {
    const p = pendingInteraction
    if (p === null) return false
    pendingInteraction = null
    p.resolve(text)
    return true
  }

  const waitForQQReply = (openid, kind, timeoutMs, onTimeout) => new Promise((resolve) => {
    if (pendingInteraction !== null) {
      // 串行化：前一个未决时先不阻塞（正常单用户场景不会发生）。
      pendingInteraction.resolve('（忽略：前一交互尚未答复）')
    }
    pendingInteraction = { openid, kind, resolve, timer: null }
    const t = setTimeout(() => {
      if (pendingInteraction !== null && pendingInteraction.resolve === resolve) {
        pendingInteraction = null
        onTimeout?.()
        resolve(pendingFallback(openid, kind))
      }
    }, timeoutMs)
    pendingInteraction.timer = t
  })

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
          u.menuNav = { kind: 'wsdetail', wsIdx: idx }
          persistSessions()
          enqueueOutbox({ openid, content: renderWorkspaceDetail(u, openid, idx), msgId: undefined })
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
          u.menuNav = { kind: 'wsdetail', wsIdx: idx }
          persistSessions()
          enqueueOutbox({ openid, content: renderWorkspaceDetail(u, openid, idx), msgId: undefined })
          return
        }
        enqueueOutbox({ openid, content: renderWorkspaces(u, openid), msgId: undefined })
        return
      }
      if (nav.kind === 'wsdetail') {
        if (/^\d+$/.test(text)) {
          const inventory = workspaceInventory()
          const ws = inventory[nav.wsIdx]
          const s = ws?.sessions?.[Number(text) - 1]
          if (!s) { enqueueOutbox({ openid, content: '无效会话编号。', msgId: undefined }); return }
          // 驱动已有工作区会话：直接用真实 sessionId，并记录为该用户当前驱动目标。
          u.menuNav = { kind: 'main' }
          u.mode = 'chat'
          u.currentName = ws.cwd // 用工作区路径作为标识
          u.drivingWsSession = s.sessionId
          persistSessions()
          fileLog(`选择驱动已有会话 ${s.sessionId}（工作区 ${ws.cwd}）`)
          lastReplyTarget.set(s.sessionId, { openid, lastMsgId: undefined, ws: true })
          enqueueOutbox({ openid, content: `已接入工作区会话：${ws.cwd}\n会话 ${s.sessionId}\n直接发消息即可驱动它。`, msgId: undefined })
          return
        }
        enqueueOutbox({ openid, content: renderWorkspaceDetail(u, openid, nav.wsIdx), msgId: undefined })
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
    let cached = agentCache.get(sessionId)
    if (cached) return cached
    const agents = ctx.get('agents')
    if (!agents) throw new Error('agents 服务尚未就绪')
    // 关键：若该会话已有 live agent（例如被 web 端占用），直接复用它的 agent，
    // 用 agent.send 把消息排进它的 inbox（dsh 消息队列机制），不新建、不打断。
    const existing = typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    if (existing) {
      fileLog(`复用已有 live agent ${sessionId}（投递到 inbox 队列）`)
      return { agent: existing }
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

  onSessionEvent('session/event', (session, event) => {
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
      if (notifyEvents.has(mapKind(kind))) {
        const started = turnStarts.get(sessionId)
        turnStarts.delete(sessionId)
        const text = renderText({
          kind: mapKind(kind),
          sessionId,
          title: sessionTitle(session),
          summary: summarizeTurn(session, event.data.turn),
          durationMs: started === undefined ? undefined : Date.now() - started,
          error: kind === 'error' ? errorText(event.data?.reason?.error) : undefined,
          toolCalls: countToolCalls(session, event.data.turn),
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
  })

  // 提问（ask_user）：注册 userQuestions provider，推给 QQ。
  // userQuestions 不注入（避免拖慢启动），这里用 ctx.get 可选访问。
  const userQuestions = ctx.get?.('userQuestions')
  if (bridge && askUserBridge && userQuestions) {
    try {
      const disposeProvider = userQuestions.registerProvider({
        ask: (request) => {
          const agentId = request.agent?.session?.id
          const openid = openidOfSession(agentId) || targetOpenid()
          // 自动把该用户的当前会话切到发起提问的会话（对话模式），方便直接回答。
          if (openid && typeof agentId === 'string' && agentId.startsWith(SESSION_PREFIX)) {
            const u = ensureUser(openid)
            const askingName = sessionNameOf(agentId, u, openid)
            const s = findSession(u, askingName) || u.sessions[0]
            u.currentName = s.name
            u.mode = 'chat'
            persistSessions()
          }
          fileLog(`ask_user → QQ（openid=${mask(openid)}，${request.questions.length} 问）`)
          const qText = renderQuestion(request.questions)
          enqueueOutbox({ openid, content: qText, msgId: undefined })
          return waitForQQReply(openid, '提问', 300_000, () => {
            fileLog('ask_user 等待超时')
          }).then((answer) => ({
            answers: request.questions.map((q) => ({
              id: q.id,
              selected: [suggestedAnswer(q, answer)],
              custom: suggestedAnswer(q, answer) === answer ? undefined : answer,
            })),
          }))
        },
      })
      ctx.effect(() => () => disposeProvider(), 'qq-notify.userQuestions()')
      fileLog('userQuestions provider 注册成功（QQ 接手提问）')
    } catch (err) {
      // 单一 provider：浏览器 UI 已占用时会抛 DUPLICATE_PROVIDER。不崩溃，降级。
      logger.warn('[qq-notify] ask_user 的 QQ provider 注册被占用（多半是浏览器 UI 已接手提问）：%o', err)
      fileLog(`userQuestions provider 注册失败（降级，QQ 提问桥接不可用）：${String(err)}`)
    }
  }

  // 权限申请（approval）：监听 approval/request waterfall。
  if (bridge) {
    ctx.on('approval/request', (request, next) => {
      const agentSessionId = request.agent?.session?.id
      const isQQ = typeof agentSessionId === 'string' && agentSessionId.startsWith(SESSION_PREFIX)
      if (!isQQ) return next()
      const openid = openidOfSession(agentSessionId)
      // 自动把该用户切到发起审批的会话。
      if (openid) {
        const u = ensureUser(openid)
        ensureDefaultSession(u, openid)
        const name = sessionNameOf(agentSessionId, u, openid)
        const s = findSession(u, name) || u.sessions[0]
        u.currentName = s.name
        u.mode = 'chat'
        persistSessions()
      }
      const why = request.reason ? `（原因：${request.reason}）` : ''
      fileLog(`approval/request → QQ（openid=${mask(openid)} tool=${request.toolName}）`)
      enqueueOutbox({ openid, content:
        `🔐 需要你的授权\n`
        + `工具：${request.toolName ?? '未知'}${why}\n`
        + `会话：${agentSessionId}\n\n`
        + `回复「同意 / 允许一次」放行，回复「拒绝」拒绝。\n`
        + `（5 分钟内未答复将自动拒绝）`, msgId: undefined })
      return waitForQQReply(openid, '审批', 300_000, () => {
        fileLog('approval 等待超时 → 默认拒绝')
        enqueueOutbox({ openid, content: '⏰ 审批超时，已自动拒绝。', msgId: undefined })
      }).then((answer) => {
        const a = (answer || '').trim()
        if (/^(拒绝|不要|否|no|reject|\/reject|\/拒绝|\/no)/i.test(a)) {
          fileLog(`approval 用户拒绝：${a}`)
          enqueueOutbox({ openid, content: '🚫 已拒绝授权。', msgId: undefined })
          return 'rejected'
        }
        fileLog(`approval 用户同意：${a}`)
        enqueueOutbox({ openid, content: '✅ 已授权（允许一次）。', msgId: undefined })
        return 'allowed-once'
      })
    })
  }

  // 完成通知（非桥接 web 会话也推）。
  if (notifyEvents.size > 0) {
    onSessionEvent('session/event', (session, event) => {
      const sid2 = String(session.id)
      // QQ 自建会话 + 被 QQ 驱动的已有工作区会话，都由上面桥接分支处理，这里跳过避免重复通知。
      if (sid2.startsWith(SESSION_PREFIX) || lastReplyTarget.has(sid2)) return
      if (event.type !== 'turn/end' && event.type !== 'turn/start') return
      if (event.type === 'turn/start') {
        turnStarts.set(sid2, Date.now())
        return
      }
      const kind = event.data?.reason?.kind
      if (!kind || !notifyEvents.has(mapKind(kind))) return
      const openid = targetOpenid()
      if (!openid) { fileLog('notify: 尚无 openid，跳过'); return }
      const started = turnStarts.get(sid2)
      turnStarts.delete(sid2)
      const text = renderText({
        kind: mapKind(kind),
        sessionId: sid2,
        title: sessionTitle(session),
        summary: summarizeTurn(session, event.data.turn),
        durationMs: started === undefined ? undefined : Date.now() - started,
        error: kind === 'error' ? errorText(event.data?.reason?.error) : undefined,
        toolCalls: countToolCalls(session, event.data.turn),
      })
      fileLog(`通知(web 会话) kind=${kind} → QQ`)
      enqueueOutbox({ openid, content: text, msgId: undefined })
    })
  }
}

// ---- 工具函数 ----

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
  if (!configured || configured.length === 0) return [...DEFAULT_NOTIFY_EVENTS]
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
  lines.push(`会话：${n.sessionId}`)
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
  for (const event of session.events) {
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

function sessionTitle(session) {
  for (const event of session.events) {
    if (event.type === 'user/message') {
      const text = textOf(event.data.content).replace(/\s+/g, ' ').trim()
      if (text) return text.length > 60 ? `${text.slice(0, 60)}…` : text
    }
  }
  return String(session.id)
}

function summarizeTurn(session, turn) {
  let toolCalls = 0
  let lastText = ''
  for (const event of session.events) {
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
  let out = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && block.type === 'text') {
      const text = block.text
      if (typeof text === 'string') out += text
    }
  }
  return out
}

function mask(id) {
  if (!id) return ''
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id
}

/** 安全的会话标题（用于已有会话枚举展示）：优先第一条用户消息，否则返回空。 */
function sessionSafeTitle(session) {
  try {
    if (!session || !Array.isArray(session.events)) return ''
    return sessionTitle(session) || ''
  } catch { return String(session?.id ?? '') }
}

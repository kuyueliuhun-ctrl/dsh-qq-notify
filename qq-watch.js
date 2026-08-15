#!/usr/bin/env node
/**
 * qq-watch.js — 独立于 DSH 进程的守护：DSH web 下线/恢复时向 QQ 发通知。
 *
 * 为什么独立：如果这个脚本跑在 DSH 进程内部，DSH 一死它也死，发不出通知。
 * 所以它独立常驻（nohup），用「HTTP 探活 + PID 双重监控」判断 DSH 状态。
 *
 * 判定：
 *   - up：HTTP 探活成功，且（若 pid 文件存在）指向的进程仍存活。
 *   - down：HTTP 连续失败 N 次（防抖），或 pid 文件指向的进程消失。
 * 状态迁移：up→down 发「下线」；down→up 发「恢复」。
 *
 * 配置来源（优先级从高到低）：
 *   1. 环境变量 QQ_APP_ID / QQ_APP_SECRET / QQ_OPENID / QQ_SANDBOX / DSH_URL
 *   2. ./qq-watch.config.json
 *   3. $DSH_HOME/qq-notify.openid.json（openid / appId）
 *   appSecret 不落盘在 openid 文件里，请用环境变量或 config.json 提供。
 */
'use strict'
const { readFileSync, appendFileSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

const DSH_HOME = process.env.DSH_HOME || process.cwd()
const PID_FILE = join(DSH_HOME, 'qq-notify.pid')
const OPENID_FILE = join(DSH_HOME, 'qq-notify.openid.json')
const LOG_FILE = join(DSH_HOME, 'qq-watch.log')

const CFG = {
  appId: process.env.QQ_APP_ID || '',
  appSecret: process.env.QQ_APP_SECRET || '',
  openid: process.env.QQ_OPENID || '',
  sandbox: (process.env.QQ_SANDBOX || 'true') !== 'false',
  baseUrl: process.env.DSH_URL || 'http://127.0.0.1:10081',
  probeEveryMs: Number(process.env.QQ_WATCH_INTERVAL || 5000),
  failsToDown: Number(process.env.QQ_WATCH_FAILS || 3),
  timeoutMs: Number(process.env.QQ_WATCH_TIMEOUT || 4000),
}

try {
  Object.assign(CFG, JSON.parse(readFileSync(join(process.cwd(), 'qq-watch.config.json'), 'utf8')))
} catch { /* 可选 */ }

try {
  const o = JSON.parse(readFileSync(OPENID_FILE, 'utf8'))
  if (!CFG.openid && o.openid) CFG.openid = o.openid
  if (!CFG.appId && o.appId) CFG.appId = o.appId
} catch { /* 可选 */ }

function log(...parts) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${parts.join(' ')}\n`, 'utf8')
  } catch { /* 忽略 */ }
  console.log(`[qq-watch] ${parts.join(' ')}`)
}

async function getToken() {
  if (!CFG.appId || !CFG.appSecret) {
    log('未配置 QQ_APP_ID / QQ_APP_SECRET，无法取 token')
    return null
  }
  try {
    const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: CFG.appId, clientSecret: CFG.appSecret }),
      signal: AbortSignal.timeout(CFG.timeoutMs),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || typeof data?.access_token !== 'string') {
      log(`token 请求失败 HTTP ${res.status}`)
      return null
    }
    return data.access_token
  } catch (err) {
    log(`token 请求异常：${String(err)}`)
    return null
  }
}

async function sendQQ(text) {
  if (!CFG.openid) { log(`未配置 openid，跳过发送：${text}`); return }
  const token = await getToken()
  if (!token) { log(`拿不到 token，未能发送：${text}`); return }
  const base = CFG.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com'
  try {
    const res = await fetch(`${base}/v2/users/${CFG.openid}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${token}` },
      body: JSON.stringify({ content: text, msg_type: 0, msg_seq: Math.floor(Date.now() / 1000) }),
      signal: AbortSignal.timeout(CFG.timeoutMs),
    })
    if (!res.ok) log(`发送失败 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 160)}`)
    else log(`已发送 QQ 通知：${text}`)
  } catch (err) {
    log(`发送异常：${String(err)}`)
  }
}

async function httpUp() {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), CFG.timeoutMs)
    const res = await fetch(CFG.baseUrl, { signal: ctrl.signal })
    clearTimeout(t)
    return res.status >= 200 && res.status < 600
  } catch { return false }
}

function pidAlive() {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
    if (!Number.isFinite(pid)) return true
    try { process.kill(pid, 0); return true } catch { return false }
  } catch { return true }
}

async function main() {
  log(`守护启动：探活 ${CFG.baseUrl}；每 ${CFG.probeEveryMs}ms；连挂 ${CFG.failsToDown} 次判下线`)
  let state = 'unknown'
  let failStreak = 0

  const initial = await httpUp()
  state = initial ? 'up' : 'down'
  log(`初始状态：${state}`)

  setInterval(async () => {
    const up = (await httpUp()) && pidAlive()
    if (up) {
      if (state === 'down') {
        log('DSH 恢复在线 → 发【恢复】通知')
        await sendQQ('✅ DeepSeek Harness 已恢复在线。')
      }
      state = 'up'
      failStreak = 0
      return
    }
    failStreak += 1
    if (state === 'down') return
    if (failStreak >= CFG.failsToDown) {
      log(`DSH 下线（连续 ${failStreak} 次探活失败/PID 消失）→ 发【下线】通知`)
      await sendQQ('⚠️ DeepSeek Harness 已停止/下线。')
      state = 'down'
    }
  }, CFG.probeEveryMs)

  const stop = (sig) => { log(`守护收到 ${sig}，退出`); process.exit(0) }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

main().catch((err) => { log(`守护异常：${String(err)}`); process.exit(1) })

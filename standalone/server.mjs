#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Kimi Code 会话管理器 — 零依赖独立服务器
// 只用 Node 内置模块，直接 `node server.mjs [--port N]` 即可运行。
// 提供与开发版完全相同的 5 个 API 端点，并静态伺服 ./dist（SPA 回退）。
// ---------------------------------------------------------------------------

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSea } from 'node:sea'

// SEA（CJS bundle）里 import.meta.url 可能不可用，回退到 exe 所在目录
const __dirname = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return path.dirname(process.execPath)
  }
})()

// SEA 单文件模式：资源内嵌在全局映射里，数据目录取 exe 所在目录。
// 普通 node 模式：从磁盘读 dist/（分享包结构 server.mjs 与 dist/ 同级；
// 主项目结构 server.mjs 在 standalone/ 内、dist/ 在项目根），不依赖 cwd。
const IS_SEA = (() => {
  try {
    return isSea()
  } catch {
    return false
  }
})()
const EMBEDDED_ASSETS = globalThis.__KIMI_EMBEDDED_ASSETS__ ?? null
const BASE_DIR = IS_SEA ? path.dirname(process.execPath) : __dirname
const DIST_DIR = fs.existsSync(path.join(BASE_DIR, 'dist', 'index.html'))
  ? path.join(BASE_DIR, 'dist')
  : path.join(BASE_DIR, '..', 'dist')
const META_FILE = path.join(os.homedir(), '.kimi-session-manager', 'session-meta.json')

// ---------------------------------------------------------------------------
// Session stores (same layout on any Windows machine, derived from homedir)
// ---------------------------------------------------------------------------

const HOME = os.homedir()

const SESSION_STORES = [
  {
    source: 'cli',
    indexFile: path.join(HOME, '.kimi-code', 'session_index.jsonl'),
  },
  {
    source: 'desktop',
    indexFile: path.join(
      HOME,
      'AppData',
      'Roaming',
      'kimi-desktop',
      'daimon-share',
      'daimon',
      'runtime',
      'kimi-code',
      'home',
      'session_index.jsonl',
    ),
  },
]

const FALLBACK_KIMI_EXE = path.join(HOME, '.kimi-code', 'bin', 'kimi.exe')
const RECENTLY_ACTIVE_MS = 6 * 60 * 60 * 1000 // 6 hours

// Handoff documents exported for Kimi Work.
const HANDOFF_DIR = path.join(HOME, '.kimi-session-manager', 'handoff')
const MAX_ASSISTANT_BLOCK_CHARS = 2000
const MAX_HANDOFF_BYTES = 200 * 1024

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonl(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const out = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') out.push(obj)
    } catch {
      // skip corrupt line
    }
  }
  return out
}

function readMeta() {
  try {
    const raw = fs.readFileSync(META_FILE, 'utf8')
    const obj = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {}
      for (const [key, value] of Object.entries(obj)) {
        if (value && typeof value === 'object') {
          out[key] = {
            alias: typeof value.alias === 'string' && value.alias.trim() ? value.alias : null,
            favorite: value.favorite === true,
          }
        }
      }
      return out
    }
  } catch {
    // missing/corrupt meta file → treat as empty
  }
  return {}
}

function writeMeta(meta) {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true })
  const tmp = META_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
  fs.renameSync(tmp, META_FILE)
}

function scanSessions() {
  const sessions = []
  const storeErrors = []
  const now = Date.now()
  const meta = readMeta()

  for (const store of SESSION_STORES) {
    if (!fs.existsSync(store.indexFile)) {
      storeErrors.push(`未找到会话索引：${store.indexFile}`)
      continue
    }
    let entries
    try {
      entries = readJsonl(store.indexFile)
    } catch (err) {
      storeErrors.push(`读取会话索引失败：${store.indexFile}（${String(err)}）`)
      continue
    }

    for (const entry of entries) {
      const sessionId = String(entry.sessionId ?? '')
      const sessionDir = String(entry.sessionDir ?? '')
      const indexWorkDir = String(entry.workDir ?? '')
      if (!sessionId) continue

      // state.json is best-effort
      let title = sessionId
      let lastPrompt = ''
      let workDir = indexWorkDir
      let createdAt = null
      let updatedAt = null

      if (sessionDir) {
        try {
          const stateRaw = fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')
          const state = JSON.parse(stateRaw)
          if (typeof state.title === 'string' && state.title.trim()) title = state.title
          if (typeof state.lastPrompt === 'string') lastPrompt = state.lastPrompt
          if (typeof state.workDir === 'string' && state.workDir.trim()) workDir = state.workDir
          if (typeof state.createdAt === 'string') createdAt = state.createdAt
          if (typeof state.updatedAt === 'string') updatedAt = state.updatedAt
        } catch {
          // tolerate missing/corrupt state.json
        }
      }

      const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN
      const entryMeta = meta[sessionId]
      sessions.push({
        sessionId,
        title,
        lastPrompt,
        workDir,
        createdAt,
        updatedAt,
        source: store.source,
        sessionDir,
        recentlyActive: Number.isFinite(updatedMs) && now - updatedMs < RECENTLY_ACTIVE_MS,
        alias: entryMeta?.alias ?? null,
        favorite: entryMeta?.favorite ?? false,
      })
    }
  }

  sessions.sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0
    const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0
    return (Number.isFinite(tb) ? tb : 0) - (Number.isFinite(ta) ? ta : 0)
  })

  return { sessions, storeErrors }
}

// ---------------------------------------------------------------------------
// Handoff (export conversation to a Markdown document for Kimi Work)
// ---------------------------------------------------------------------------

function extractTextParts(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((p) => p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
}

// Parse <sessionDir>/agents/main/wire.jsonl into an ordered conversation.
// - user messages: context.append_message with role=user
// - assistant text: context.append_loop_event / content.part with part.type=text
// - tool calls compressed to one-line notes; thinking/systemPrompt/tool results skipped
function parseWireJsonl(wireFile) {
  const raw = fs.readFileSync(wireFile, 'utf8')
  const blocks = []

  const pushAssistant = (text) => {
    const last = blocks[blocks.length - 1]
    if (last && last.role === 'assistant') last.text += `\n\n${text}`
    else blocks.push({ role: 'assistant', text })
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }

    if (obj.type === 'context.append_message') {
      const m = obj.message
      if (m && m.role === 'user') {
        const text = extractTextParts(m.content).trim()
        if (text) blocks.push({ role: 'user', text })
      }
    } else if (obj.type === 'context.append_loop_event') {
      const ev = obj.event
      if (!ev) continue
      if (ev.type === 'content.part') {
        const part = ev.part
        if (part && part.type === 'text' && typeof part.text === 'string') {
          const text = part.text.trim()
          if (text) pushAssistant(text)
        }
      } else if (ev.type === 'tool.call') {
        const name = String(ev.name ?? 'tool')
        let brief = ''
        if (typeof ev.description === 'string') brief = ev.description
        else if (ev.args && typeof ev.args === 'object' && typeof ev.args.command === 'string') {
          brief = String(ev.args.command)
        }
        brief = brief.replace(/\s+/g, ' ').trim()
        if (brief.length > 100) brief = brief.slice(0, 100) + '…'
        pushAssistant(`> [调用了 ${name}${brief ? `：${brief}` : ''}]`)
      }
    }
    // turn.prompt duplicates user input; config.update carries systemPrompt;
    // think parts and tool results are intentionally skipped.
  }
  return blocks
}

function renderHandoffMarkdown({ title, source, workDir, sessionId, sessionDir, blocks }) {
  const sourceLabel = source === 'cli' ? 'Kimi Code CLI' : 'Kimi Work 桌面端'
  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })

  // Assistant blocks capped per-block; if the file still exceeds the total
  // cap, shrink assistant blocks progressively. User messages stay intact.
  let truncated = false
  let body = ''
  for (const limit of [MAX_ASSISTANT_BLOCK_CHARS, 400, 150]) {
    truncated = false
    body = blocks
      .map((b) => {
        let text = b.text
        if (b.role === 'assistant' && text.length > limit) {
          text = text.slice(0, limit) + ' …（截断）'
          truncated = true
        }
        return `${b.role === 'user' ? '## 用户' : '## 助手'}\n\n${text}`
      })
      .join('\n\n')
    if (Buffer.byteLength(body, 'utf8') <= MAX_HANDOFF_BYTES) break
  }

  const header =
    `# 会话交接：${title}\n\n` +
    `- 来源：${sourceLabel}\n` +
    `- 工作目录：${workDir || '(未知)'}\n` +
    `- 会话 ID：${sessionId}\n` +
    `- 会话目录：${sessionDir}\n` +
    `- 导出时间：${exportedAt}\n` +
    (truncated
      ? `\n> 注意：对话较长，部分助手消息已截断；完整记录见会话目录下的 agents/main/wire.jsonl\n`
      : '') +
    `\n---\n\n`

  return { markdown: header + body + '\n', truncated }
}

// Compact handoff: header + last ~15 user/assistant blocks, each capped,
// total ≤ ~30KB, no file written — for pasting into web AIs.
const COMPACT_MAX_BLOCKS = 15
const COMPACT_MAX_BLOCK_CHARS = 1500
const COMPACT_MAX_BYTES = 30 * 1024

function renderCompactHandoff({ title, source, workDir, sessionId, sessionDir, blocks }) {
  const sourceLabel = source === 'cli' ? 'Kimi Code CLI' : 'Kimi Work 桌面端'
  const recent = blocks.slice(-COMPACT_MAX_BLOCKS)
  const omitted = blocks.length - recent.length

  let body = ''
  for (const limit of [COMPACT_MAX_BLOCK_CHARS, 600, 200]) {
    body = recent
      .map((b) => {
        let text = b.text
        if (text.length > limit) text = text.slice(0, limit) + ' …（截断）'
        return `${b.role === 'user' ? '## 用户' : '## 助手'}\n\n${text}`
      })
      .join('\n\n')
    if (Buffer.byteLength(body, 'utf8') <= COMPACT_MAX_BYTES) break
  }

  const header =
    `# 会话交接（紧凑版）：${title}\n\n` +
    `- 来源：${sourceLabel}\n` +
    `- 工作目录：${workDir || '(未知)'}\n` +
    `- 会话 ID：${sessionId}\n` +
    `- 会话目录：${sessionDir}\n` +
    (omitted > 0 ? `\n> 注意：仅保留最近 ${recent.length} 条消息（共省略 ${omitted} 条早期消息），单条消息可能已截断。\n` : '') +
    `\n---\n\n`

  return header + body + '\n'
}

function countKimiProcesses() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', 'IMAGENAME eq kimi.exe', '/NH'],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const text = String(stdout)
        if (/no tasks are running|没有运行的任务/i.test(text)) {
          resolve(0)
          return
        }
        const matches = text.match(/kimi\.exe/gi)
        resolve(matches ? matches.length : 0)
      },
    )
  })
}

function resolveKimiExe() {
  return new Promise((resolve) => {
    execFile('where.exe', ['kimi'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (!err) {
        const first = String(stdout).split(/\r?\n/).map((s) => s.trim()).find(Boolean)
        if (first) {
          resolve(first)
          return
        }
      }
      resolve(FALLBACK_KIMI_EXE)
    })
  })
}

let kimiExePromise = null
function getKimiExe() {
  if (!kimiExePromise) kimiExePromise = resolveKimiExe()
  return kimiExePromise
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, data) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

async function handleApi(req, res, pathname) {
  // GET /api/sessions -------------------------------------------------------
  if (pathname === '/api/sessions' && req.method === 'GET') {
    try {
      const { sessions, storeErrors } = scanSessions()
      const kimiRunning = await countKimiProcesses()
      sendJson(res, 200, {
        sessions,
        kimiRunning,
        scannedAt: new Date().toISOString(),
        storeErrors,
      })
    } catch (err) {
      sendJson(res, 500, { error: `扫描会话失败：${String(err)}` })
    }
    return
  }

  // POST /api/resume --------------------------------------------------------
  if (pathname === '/api/resume' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const sessionId = String(body.sessionId ?? '')
      const workDir = String(body.workDir ?? '')

      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        sendJson(res, 400, { error: 'sessionId 不合法' })
        return
      }
      if (String(body.source ?? '') === 'desktop') {
        sendJson(res, 400, {
          error: '该会话属于 Kimi Work 桌面端，命令行版 kimi 找不到它，请在桌面端的历史会话中继续。',
        })
        return
      }
      if (!workDir || !fs.existsSync(workDir)) {
        sendJson(res, 400, { error: `工作目录不存在，可能被移动：${workDir || '(空)'}` })
        return
      }

      const kimiExe = await getKimiExe()

      // Write a tiny launcher .bat so we never have to nest quotes inside
      // `cmd /c start "title" cmd /k "..."`, which cmd.exe mis-parses.
      // NOTE: keep the .bat pure ASCII — cmd parses batch files in the
      // system codepage, so Chinese workDir goes via spawn cwd instead.
      const batDir = path.join(os.tmpdir(), 'kimi-session-manager')
      fs.mkdirSync(batDir, { recursive: true })
      const batPath = path.join(batDir, `resume-${sessionId}.bat`)
      const batContent =
        '@echo off\r\n' +
        'title Kimi Code Session\r\n' +
        `"${kimiExe}" -S ${sessionId}\r\n`
      fs.writeFileSync(batPath, batContent, 'ascii')

      const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', batPath], {
        cwd: workDir,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      child.on('error', () => {})
      child.unref()

      sendJson(res, 200, { ok: true, command: `kimi -S ${sessionId}` })
    } catch (err) {
      sendJson(res, 500, { error: `打开终端失败：${String(err)}` })
    }
    return
  }

  // POST /api/rename --------------------------------------------------------
  if (pathname === '/api/rename' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const sessionId = String(body.sessionId ?? '')
      const title = String(body.title ?? '').trim()
      const source = String(body.source ?? '')
      const sessionDir = String(body.sessionDir ?? '')

      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        sendJson(res, 400, { error: 'sessionId 不合法' })
        return
      }
      if (!title) {
        sendJson(res, 400, { error: '标题不能为空' })
        return
      }
      if (title.length > 200) {
        sendJson(res, 400, { error: '标题不能超过 200 个字符' })
        return
      }

      // 1) Always persist the alias in our own meta file.
      try {
        const meta = readMeta()
        const prev = meta[sessionId] ?? { alias: null, favorite: false }
        meta[sessionId] = { ...prev, alias: title }
        writeMeta(meta)
      } catch (err) {
        sendJson(res, 500, { error: `保存别名失败：${String(err)}` })
        return
      }

      // 2) For CLI sessions, also write the title back into state.json so
      //    kimi itself shows the custom name. Failure does not block the alias.
      let stateWritten = false
      if (source === 'cli' && sessionDir && fs.existsSync(sessionDir)) {
        try {
          const statePath = path.join(sessionDir, 'state.json')
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
          state.title = title
          state.isCustomTitle = true
          fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8')
          stateWritten = true
        } catch {
          stateWritten = false
        }
      }

      sendJson(res, 200, { ok: true, alias: title, stateWritten })
    } catch (err) {
      sendJson(res, 500, { error: `重命名失败：${String(err)}` })
    }
    return
  }

  // POST /api/favorite ------------------------------------------------------
  if (pathname === '/api/favorite' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const sessionId = String(body.sessionId ?? '')
      const favorite = body.favorite === true

      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        sendJson(res, 400, { error: 'sessionId 不合法' })
        return
      }

      try {
        const meta = readMeta()
        const prev = meta[sessionId] ?? { alias: null, favorite: false }
        meta[sessionId] = { ...prev, favorite }
        writeMeta(meta)
      } catch (err) {
        sendJson(res, 500, { error: `保存收藏状态失败：${String(err)}` })
        return
      }

      sendJson(res, 200, { ok: true, favorite })
    } catch (err) {
      sendJson(res, 500, { error: `收藏操作失败：${String(err)}` })
    }
    return
  }

  // POST /api/handoff -------------------------------------------------------
  if (pathname === '/api/handoff' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const sessionId = String(body.sessionId ?? '')
      const sessionDir = String(body.sessionDir ?? '')
      const workDir = String(body.workDir ?? '')
      const title = String(body.title ?? '')
      const alias = typeof body.alias === 'string' ? body.alias : ''
      const source = String(body.source ?? '')

      if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
        sendJson(res, 400, { error: 'sessionId 不合法' })
        return
      }
      if (!sessionDir || !fs.existsSync(sessionDir)) {
        sendJson(res, 400, { error: `会话目录不存在：${sessionDir || '(空)'}` })
        return
      }
      const wireFile = path.join(sessionDir, 'agents', 'main', 'wire.jsonl')
      if (!fs.existsSync(wireFile)) {
        sendJson(res, 404, { error: '未找到该会话的对话记录（wire.jsonl）' })
        return
      }

      let blocks
      try {
        blocks = parseWireJsonl(wireFile)
      } catch (err) {
        sendJson(res, 500, { error: `解析对话记录失败：${String(err)}` })
        return
      }
      if (blocks.length === 0) {
        sendJson(res, 400, { error: '该会话没有可导出的对话内容' })
        return
      }

      const displayTitle = alias.trim() || title.trim() || sessionId
      const mode = String(body.mode ?? 'full')

      // compact：不写文件，直接返回紧凑版 markdown 文本
      if (mode === 'compact') {
        const content = renderCompactHandoff({
          title: displayTitle,
          source,
          workDir,
          sessionId,
          sessionDir,
          blocks,
        })
        sendJson(res, 200, { ok: true, content })
        return
      }

      const { markdown } = renderHandoffMarkdown({
        title: displayTitle,
        source,
        workDir,
        sessionId,
        sessionDir,
        blocks,
      })

      fs.mkdirSync(HANDOFF_DIR, { recursive: true })
      const filePath = path.join(HANDOFF_DIR, `${sessionId}.md`)
      fs.writeFileSync(filePath, markdown, 'utf8')

      // prompt 文案按交接方向区分：
      // CLI 会话 → 粘贴给 Kimi Work；桌面端会话 → 粘贴给 Kimi Code CLI
      const prompt =
        source === 'cli'
          ? `这是我在 Kimi Code CLI 里的一个对话记录。` +
            `请先用 Read 工具阅读 ${filePath} 了解完整上下文` +
            `（该会话的工作目录是 ${workDir || '(未知)'}，原始会话目录 ${sessionDir} 里有完整记录），` +
            `读完告诉我你理解的任务现状，然后继续协助我。`
          : `这是我在 Kimi Work 桌面端的一段对话记录。` +
            `请先用 Read 工具阅读 ${filePath} 了解完整上下文` +
            `（工作目录是 ${workDir || '(未知)'}），` +
            `读完告诉我你理解的任务现状，然后继续协助我。`

      sendJson(res, 200, { ok: true, filePath, prompt })
    } catch (err) {
      sendJson(res, 500, { error: `生成交接文档失败：${String(err)}` })
    }
    return
  }

  // POST /api/open-terminal -------------------------------------------------
  if (pathname === '/api/open-terminal' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const dirPath = String(body.path ?? '')
      if (!dirPath || !fs.existsSync(dirPath)) {
        sendJson(res, 400, { error: `目录不存在：${dirPath || '(空)'}` })
        return
      }
      const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k'], {
        cwd: dirPath,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      })
      child.on('error', () => {})
      child.unref()
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendJson(res, 500, { error: `打开终端失败：${String(err)}` })
    }
    return
  }

  // POST /api/open-folder ---------------------------------------------------
  if (pathname === '/api/open-folder' && req.method === 'POST') {
    try {
      const body = await readBody(req)
      const folderPath = String(body.path ?? '')
      if (!folderPath || !fs.existsSync(folderPath)) {
        sendJson(res, 400, { error: `目录不存在：${folderPath || '(空)'}` })
        return
      }
      const child = spawn('explorer.exe', [folderPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => {})
      child.unref()
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendJson(res, 500, { error: `打开目录失败：${String(err)}` })
    }
    return
  }

  sendJson(res, 404, { error: `未知 API：${pathname}` })
}

// ---------------------------------------------------------------------------
// Static file serving (dist/, SPA fallback to index.html)
// ---------------------------------------------------------------------------

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function serveStatic(req, res, pathname) {
  // SEA embedded mode: serve from the in-memory asset map.
  if (EMBEDDED_ASSETS) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '')
    if (rel === '') rel = 'index.html'
    let b64 = EMBEDDED_ASSETS[rel]
    if (b64 == null) {
      // SPA fallback
      rel = 'index.html'
      b64 = EMBEDDED_ASSETS[rel]
    }
    if (b64 == null) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    const ext = path.extname(rel).toLowerCase()
    res.statusCode = 200
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
    res.end(Buffer.from(b64, 'base64'))
    return
  }

  let rel = decodeURIComponent(pathname)
  if (rel === '/' || rel === '') rel = '/index.html'

  // Prevent path traversal: resolve and require the result to stay in DIST_DIR.
  const filePath = path.resolve(DIST_DIR, '.' + rel)
  if (!filePath.startsWith(DIST_DIR)) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }

  let target = filePath
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    // SPA fallback
    target = path.join(DIST_DIR, 'index.html')
    if (!fs.existsSync(target)) {
      res.statusCode = 503
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('未找到前端构建产物 dist/，请先在项目根目录运行 npm run build。')
      return
    }
  }

  const ext = path.extname(target).toLowerCase()
  res.statusCode = 200
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream')
  fs.createReadStream(target).pipe(res)
}

// ---------------------------------------------------------------------------
// Server bootstrap (port auto-increment, graceful shutdown)
// ---------------------------------------------------------------------------

function parsePort() {
  const idx = process.argv.indexOf('--port')
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number.parseInt(process.argv[idx + 1], 10)
    if (Number.isFinite(n) && n > 0 && n < 65536) return n
  }
  if (process.env.PORT) {
    const n = Number.parseInt(process.env.PORT, 10)
    if (Number.isFinite(n) && n > 0 && n < 65536) return n
  }
  return 7100
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname.startsWith('/api/')) {
    void handleApi(req, res, url.pathname)
    return
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, url.pathname)
    return
  }
  res.statusCode = 405
  res.end('Method Not Allowed')
})

const basePort = parsePort()
const MAX_TRIES = 10

function tryListen(port, attempt) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < MAX_TRIES) {
      tryListen(port + 1, attempt + 1)
    } else {
      console.error(`启动失败：${err.message}`)
      process.exit(1)
    }
  })
  server.listen(port, () => {
    const address = `http://localhost:${port}`
    console.log('')
    console.log('  Kimi Code 会话管理器')
    console.log('  ────────────────────────────────────')
    console.log(`  地址：${address}`)
    if (port !== basePort) console.log(`  （端口 ${basePort} 被占用，已自动切换到 ${port}）`)
    console.log('')
    console.log('  使用说明：')
    console.log('  · 在浏览器中打开上面的地址即可使用')
    console.log('  · 「继续会话」会在新终端窗口中运行 kimi -S <会话ID>')
    console.log(`  · 改名与收藏数据保存在：${path.dirname(META_FILE)}`)
    console.log('  · 按 Ctrl+C 停止服务')
    console.log('')

    // 仅单文件 exe（SEA）模式自动打开浏览器；普通 node 运行保持手动。
    if (IS_SEA) {
      const child = spawn('cmd.exe', ['/c', 'start', '""', address], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', () => {})
      child.unref()
    }
  })
}

process.on('SIGINT', () => {
  console.log('\n正在停止…')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
})
process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1000).unref()
})

tryListen(basePort, 1)

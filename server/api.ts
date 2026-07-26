import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'

// ---------------------------------------------------------------------------
// Session stores
// ---------------------------------------------------------------------------

const HOME = os.homedir()

const SESSION_STORES = [
  {
    source: 'cli' as const,
    indexFile: path.join(HOME, '.kimi-code', 'session_index.jsonl'),
  },
  {
    source: 'desktop' as const,
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
const HANDOFF_DIR = path.join(os.homedir(), '.kimi-session-manager', 'handoff')
const MAX_ASSISTANT_BLOCK_CHARS = 2000
const MAX_HANDOFF_BYTES = 200 * 1024

// Tool-owned metadata (aliases / favorites), stored inside the project.
const META_FILE = path.join(os.homedir(), '.kimi-session-manager', 'session-meta.json')

interface SessionMetaEntry {
  alias: string | null
  favorite: boolean
}

type SessionMeta = Record<string, SessionMetaEntry>

export interface SessionInfo {
  sessionId: string
  title: string
  lastPrompt: string
  workDir: string
  createdAt: string | null
  updatedAt: string | null
  source: 'cli' | 'desktop'
  sessionDir: string
  recentlyActive: boolean
  alias: string | null
  favorite: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readJsonl(file: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(file, 'utf8')
  const out: Array<Record<string, unknown>> = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') out.push(obj as Record<string, unknown>)
    } catch {
      // skip corrupt line
    }
  }
  return out
}

function readMeta(): SessionMeta {
  try {
    const raw = fs.readFileSync(META_FILE, 'utf8')
    const obj: unknown = JSON.parse(raw)
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out: SessionMeta = {}
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        if (value && typeof value === 'object') {
          const e = value as Record<string, unknown>
          out[key] = {
            alias: typeof e.alias === 'string' && e.alias.trim() ? e.alias : null,
            favorite: e.favorite === true,
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

function writeMeta(meta: SessionMeta): void {
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true })
  const tmp = META_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8')
  fs.renameSync(tmp, META_FILE)
}

function scanSessions(): { sessions: SessionInfo[]; storeErrors: string[] } {
  const sessions: SessionInfo[] = []
  const storeErrors: string[] = []
  const now = Date.now()
  const meta = readMeta()

  for (const store of SESSION_STORES) {
    if (!fs.existsSync(store.indexFile)) {
      storeErrors.push(`未找到会话索引：${store.indexFile}`)
      continue
    }
    let entries: Array<Record<string, unknown>>
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
      let createdAt: string | null = null
      let updatedAt: string | null = null

      if (sessionDir) {
        try {
          const stateRaw = fs.readFileSync(path.join(sessionDir, 'state.json'), 'utf8')
          const state = JSON.parse(stateRaw) as Record<string, unknown>
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

interface ConvoBlock {
  role: 'user' | 'assistant'
  text: string
}

function extractTextParts(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (p): p is { type: string; text: string } =>
        !!p &&
        typeof p === 'object' &&
        (p as Record<string, unknown>).type === 'text' &&
        typeof (p as Record<string, unknown>).text === 'string',
    )
    .map((p) => p.text)
    .join('\n')
}

// Parse <sessionDir>/agents/main/wire.jsonl into an ordered conversation.
// - user messages: context.append_message with role=user
// - assistant text: context.append_loop_event / content.part with part.type=text
// - tool calls compressed to one-line notes; thinking/systemPrompt/tool results skipped
function parseWireJsonl(wireFile: string): ConvoBlock[] {
  const raw = fs.readFileSync(wireFile, 'utf8')
  const blocks: ConvoBlock[] = []

  const pushAssistant = (text: string) => {
    const last = blocks[blocks.length - 1]
    if (last && last.role === 'assistant') last.text += `\n\n${text}`
    else blocks.push({ role: 'assistant', text })
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      continue
    }

    if (obj.type === 'context.append_message') {
      const m = obj.message as Record<string, unknown> | undefined
      if (m && m.role === 'user') {
        const text = extractTextParts(m.content).trim()
        if (text) blocks.push({ role: 'user', text })
      }
    } else if (obj.type === 'context.append_loop_event') {
      const ev = obj.event as Record<string, unknown> | undefined
      if (!ev) continue
      if (ev.type === 'content.part') {
        const part = ev.part as Record<string, unknown> | undefined
        if (part && part.type === 'text' && typeof part.text === 'string') {
          const text = part.text.trim()
          if (text) pushAssistant(text)
        }
      } else if (ev.type === 'tool.call') {
        const name = String(ev.name ?? 'tool')
        let brief = ''
        if (typeof ev.description === 'string') brief = ev.description
        else if (
          ev.args &&
          typeof ev.args === 'object' &&
          typeof (ev.args as Record<string, unknown>).command === 'string'
        ) {
          brief = String((ev.args as Record<string, unknown>).command)
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

function renderHandoffMarkdown(opts: {
  title: string
  source: string
  workDir: string
  sessionId: string
  sessionDir: string
  blocks: ConvoBlock[]
}): { markdown: string; truncated: boolean } {
  const { title, source, workDir, sessionId, sessionDir, blocks } = opts
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

function renderCompactHandoff(opts: {
  title: string
  source: string
  workDir: string
  sessionId: string
  sessionDir: string
  blocks: ConvoBlock[]
}): string {
  const { title, source, workDir, sessionId, sessionDir, blocks } = opts
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

function countKimiProcesses(): Promise<number | null> {
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

function resolveKimiExe(): Promise<string> {
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

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

// ---------------------------------------------------------------------------
// Vite plugin
// ---------------------------------------------------------------------------

export function sessionManagerApi(): Plugin {
  let kimiExePromise: Promise<string> | null = null
  const getKimiExe = () => {
    if (!kimiExePromise) kimiExePromise = resolveKimiExe()
    return kimiExePromise
  }

  return {
    name: 'kimi-session-manager-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const pathname = url.pathname

        // GET /api/sessions -------------------------------------------------
        if (pathname === '/api/sessions' && req.method === 'GET') {
          void (async () => {
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
          })()
          return
        }

        // POST /api/resume --------------------------------------------------
        if (pathname === '/api/resume' && req.method === 'POST') {
          void (async () => {
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

              // Write a tiny launcher .bat so we never have to nest quotes
              // inside `cmd /c start "title" cmd /k "..."`, which cmd.exe
              // mis-parses (Windows then looks for a file named "Kimi Code").
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

              // `start` without a quoted title: first token is the program,
              // no embedded quotes anywhere, so cmd parsing is trivial.
              const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', batPath], {
                cwd: workDir,
                detached: true,
                stdio: 'ignore',
                windowsHide: false,
              })
              child.on('error', () => {
                // swallow — terminal spawn errors surface via unref'd process
              })
              child.unref()

              sendJson(res, 200, { ok: true, command: `kimi -S ${sessionId}` })
            } catch (err) {
              sendJson(res, 500, { error: `打开终端失败：${String(err)}` })
            }
          })()
          return
        }

        // POST /api/rename --------------------------------------------------
        if (pathname === '/api/rename' && req.method === 'POST') {
          void (async () => {
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

              // 2) For CLI sessions, also write the title back into state.json
              //    so kimi itself shows the custom name. Failure here does not
              //    block the alias save.
              let stateWritten = false
              if (source === 'cli' && sessionDir && fs.existsSync(sessionDir)) {
                try {
                  const statePath = path.join(sessionDir, 'state.json')
                  const state = JSON.parse(
                    fs.readFileSync(statePath, 'utf8'),
                  ) as Record<string, unknown>
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
          })()
          return
        }

        // POST /api/favorite ------------------------------------------------
        if (pathname === '/api/favorite' && req.method === 'POST') {
          void (async () => {
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
          })()
          return
        }

        // POST /api/handoff -------------------------------------------------
        if (pathname === '/api/handoff' && req.method === 'POST') {
          void (async () => {
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

              let blocks: ConvoBlock[]
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
          })()
          return
        }

        // POST /api/open-terminal -------------------------------------------
        if (pathname === '/api/open-terminal' && req.method === 'POST') {
          void (async () => {
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
          })()
          return
        }

        // POST /api/open-folder ---------------------------------------------
        if (pathname === '/api/open-folder' && req.method === 'POST') {
          void (async () => {
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
          })()
          return
        }

        next()
      })
    },
  }
}

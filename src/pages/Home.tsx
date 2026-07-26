import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast, Toaster } from 'sonner'
import {
  RefreshCw,
  Search,
  Copy,
  FolderOpen,
  Play,
  Terminal,
  MonitorSmartphone,
  Folder,
  AlertCircle,
  Star,
  Pencil,
  Send,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionInfo {
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

interface SessionsResponse {
  sessions: SessionInfo[]
  kimiRunning: number | null
  scannedAt: string
  storeErrors?: string[]
}

type SourceFilter = 'all' | 'cli' | 'desktop'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string | null): string {
  if (!iso) return '未知时间'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '未知时间'
  const diff = Date.now() - t
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const d = new Date(t)
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (t >= startOfToday - 86400000) return `昨天 ${hhmm}`
  const days = Math.floor((startOfToday - t) / 86400000) + 1
  if (days < 7) return `${days} 天前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

function displayName(s: SessionInfo): string {
  return s.alias ?? s.title
}

// 复制到剪贴板：优先 navigator.clipboard，失败时降级到 execCommand
// （Kimi Work 内置浏览器等环境会拒绝 clipboard API）
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Home() {
  const [data, setData] = useState<SessionsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const [handoffId, setHandoffId] = useState<string | null>(null)
  const [handoffTarget, setHandoffTarget] = useState<SessionInfo | null>(null)
  const [handoffAction, setHandoffAction] = useState<'cli' | 'web' | 'terminal' | null>(null)
  const [renaming, setRenaming] = useState<SessionInfo | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [handoffPrompt, setHandoffPrompt] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)

  const fetchSessions = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await fetch('/api/sessions')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as SessionsResponse
      setData(json)
      setError(null)
    } catch (err) {
      setError(`无法获取会话列表：${String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchSessions()
  }, [fetchSessions])

  useEffect(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    if (autoRefresh) {
      timerRef.current = window.setInterval(() => void fetchSessions(true), 15000)
    }
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current)
    }
  }, [autoRefresh, fetchSessions])

  const patchSession = useCallback((sessionId: string, patch: Partial<SessionInfo>) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            sessions: prev.sessions.map((s) =>
              s.sessionId === sessionId ? { ...s, ...patch } : s,
            ),
          }
        : prev,
    )
  }, [])

  const filtered = useMemo(() => {
    const sessions = data?.sessions ?? []
    const q = query.trim().toLowerCase()
    return sessions.filter((s) => {
      if (sourceFilter !== 'all' && s.source !== sourceFilter) return false
      if (!q) return true
      return (
        displayName(s).toLowerCase().includes(q) ||
        s.title.toLowerCase().includes(q) ||
        (s.alias ?? '').toLowerCase().includes(q) ||
        s.lastPrompt.toLowerCase().includes(q) ||
        s.workDir.toLowerCase().includes(q) ||
        s.sessionId.toLowerCase().includes(q)
      )
    })
  }, [data, query, sourceFilter])

  // Favorites float to a dedicated top section (already updatedAt-desc).
  const favorites = useMemo(() => filtered.filter((s) => s.favorite), [filtered])

  const groups = useMemo(() => {
    const map = new Map<string, SessionInfo[]>()
    for (const s of filtered) {
      if (s.favorite) continue
      const key = s.workDir || '(未知目录)'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return [...map.entries()].map(([workDir, sessions]) => ({ workDir, sessions }))
  }, [filtered])

  const handleResume = async (s: SessionInfo) => {
    if (s.source === 'desktop') {
      toast.info('桌面端会话无法用命令行恢复', {
        description: '该对话保存在 Kimi 桌面端的数据目录中，请在桌面端的历史会话里继续。',
      })
      return
    }
    setResumingId(s.sessionId)
    try {
      const res = await fetch('/api/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s.sessionId, workDir: s.workDir, source: s.source }),
      })
      const json = (await res.json()) as { ok?: boolean; command?: string; error?: string }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      toast.success('已在新终端窗口中打开', { description: `命令：${json.command}` })
    } catch (err) {
      toast.error('恢复会话失败', { description: String(err) })
    } finally {
      setResumingId(null)
    }
  }

  const handleCopy = async (s: SessionInfo) => {
    const cmd = `kimi -S ${s.sessionId}`
    if (await copyText(cmd)) {
      toast.success('已复制命令', { description: cmd })
    } else {
      toast.error('复制失败', { description: cmd })
    }
  }

  const handleOpenFolder = async (s: SessionInfo) => {
    try {
      const res = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: s.workDir }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      toast.success('已在资源管理器中打开目录')
    } catch (err) {
      toast.error('打开目录失败', { description: String(err) })
    }
  }

  const openRenameDialog = (s: SessionInfo) => {
    setRenaming(s)
    setRenameValue(displayName(s))
  }

  const handleRenameSave = async () => {
    if (!renaming) return
    const title = renameValue.trim()
    if (!title) {
      toast.error('标题不能为空')
      return
    }
    if (title.length > 200) {
      toast.error('标题不能超过 200 个字符')
      return
    }
    setSavingRename(true)
    try {
      const res = await fetch('/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: renaming.sessionId,
          title,
          source: renaming.source,
          sessionDir: renaming.sessionDir,
        }),
      })
      const json = (await res.json()) as {
        ok?: boolean
        alias?: string
        stateWritten?: boolean
        error?: string
      }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      patchSession(renaming.sessionId, { alias: json.alias ?? title })
      if (renaming.source === 'cli' && json.stateWritten === false) {
        toast.warning('已保存别名，但写入 kimi 标题失败', {
          description: '会话的 state.json 无法写入，kimi 内可能仍显示旧标题。',
        })
      } else {
        toast.success('已重命名', { description: title })
      }
      setRenaming(null)
    } catch (err) {
      toast.error('重命名失败', { description: String(err) })
    } finally {
      setSavingRename(false)
    }
  }

  const handleToggleFavorite = async (s: SessionInfo) => {
    const next = !s.favorite
    try {
      const res = await fetch('/api/favorite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s.sessionId, favorite: next }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      patchSession(s.sessionId, { favorite: next })
      toast.success(next ? '已收藏到常用对话' : '已取消收藏', {
        description: truncate(displayName(s), 40),
      })
    } catch (err) {
      toast.error('收藏操作失败', { description: String(err) })
    }
  }

  const postHandoff = async (s: SessionInfo, mode: 'full' | 'compact') => {
    const res = await fetch('/api/handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: s.sessionId,
        sessionDir: s.sessionDir,
        workDir: s.workDir,
        title: s.title,
        alias: s.alias,
        source: s.source,
        mode,
      }),
    })
    const json = (await res.json()) as {
      ok?: boolean
      filePath?: string
      prompt?: string
      content?: string
      error?: string
    }
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
    return json
  }

  // CLI 会话：一键交接到 Kimi Work（full 模式，复制引导指令）
  const handleHandoff = async (s: SessionInfo) => {
    setHandoffId(s.sessionId)
    try {
      const json = await postHandoff(s, 'full')
      if (await copyText(json.prompt ?? '')) {
        toast.success('交接文档已生成，指令已复制到剪贴板', {
          description: '到 Kimi Work 对话里粘贴即可',
        })
      } else {
        // 两种复制方式都失败：弹出可手动全选复制的对话框
        setHandoffPrompt(json.prompt ?? '')
      }
    } catch (err) {
      toast.error('生成交接文档失败', { description: String(err) })
    } finally {
      setHandoffId(null)
    }
  }

  // 桌面端会话 → Kimi Code CLI（full 模式，prompt 为面向 Kimi Code 的版本）
  const handleHandoffToCli = async (s: SessionInfo) => {
    setHandoffAction('cli')
    try {
      const json = await postHandoff(s, 'full')
      if (await copyText(json.prompt ?? '')) {
        toast.success('交接文档已生成，指令已复制', {
          description: '在终端启动 kimi 后粘贴即可继续',
        })
      } else {
        setHandoffPrompt(json.prompt ?? '')
      }
    } catch (err) {
      toast.error('生成交接文档失败', { description: String(err) })
    } finally {
      setHandoffAction(null)
    }
  }

  // 桌面端会话 → 其他网页 AI（compact 模式，加引导行后复制）
  const handleHandoffToWeb = async (s: SessionInfo) => {
    setHandoffAction('web')
    try {
      const json = await postHandoff(s, 'compact')
      const text =
        '以下是我之前与 AI 助手的对话记录，请阅读后了解任务上下文并继续协助我：\n\n' +
        (json.content ?? '')
      if (await copyText(text)) {
        toast.success('交接内容已复制', { description: '到目标 AI 对话框粘贴即可' })
      } else {
        setHandoffPrompt(text)
      }
    } catch (err) {
      toast.error('生成交接内容失败', { description: String(err) })
    } finally {
      setHandoffAction(null)
    }
  }

  // 在指定目录打开一个新的 cmd 终端窗口
  const handleOpenTerminal = async (s: SessionInfo) => {
    setHandoffAction('terminal')
    try {
      const res = await fetch('/api/open-terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: s.workDir }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      toast.success('已在工作目录打开新终端', {
        description: '输入 kimi 启动后，粘贴刚才复制的指令即可',
      })
    } catch (err) {
      toast.error('打开终端失败', { description: String(err) })
    } finally {
      setHandoffAction(null)
    }
  }

  const renderSessionCard = (s: SessionInfo) => (
    <Card key={`${s.source}-${s.sessionId}`} className="transition-shadow hover:shadow-md">
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3
                className="font-semibold leading-snug"
                title={s.alias ? `原名：${s.title}` : undefined}
              >
                {truncate(displayName(s), 60)}
              </h3>
              {s.alias && (
                <Badge variant="secondary" className="text-xs font-normal">
                  已改名
                </Badge>
              )}
              {s.recentlyActive && (
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100">
                  可能正在进行
                </Badge>
              )}
              <Badge variant="outline" className="gap-1 text-neutral-500">
                {s.source === 'cli' ? (
                  <Terminal className="h-3 w-3" />
                ) : (
                  <MonitorSmartphone className="h-3 w-3" />
                )}
                {s.source === 'cli' ? 'Kimi Code CLI' : 'Kimi Work 桌面端'}
              </Badge>
            </div>
            {s.lastPrompt && (
              <p className="mt-1 text-sm text-neutral-500">{truncate(s.lastPrompt, 100)}</p>
            )}
            <p className="mt-2 text-xs text-neutral-400">
              <span>{relativeTime(s.updatedAt)}</span>
              <span className="mx-2">·</span>
              <span className="font-mono" title={s.sessionId}>
                {truncate(s.sessionId, 32)}
              </span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {s.source === 'cli' ? (
              <>
                <Button
                  size="sm"
                  onClick={() => void handleResume(s)}
                  disabled={resumingId === s.sessionId}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  继续会话
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="复制命令"
                  onClick={() => void handleCopy(s)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                title="该会话属于 Kimi Work 桌面端，无法用命令行恢复"
                onClick={() => void handleResume(s)}
              >
                桌面端会话
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              title={s.source === 'cli' ? '交接到 Kimi Work' : '交接会话'}
              onClick={() => {
                if (s.source === 'cli') void handleHandoff(s)
                else setHandoffTarget(s)
              }}
              disabled={handoffId === s.sessionId}
            >
              <Send className={`h-4 w-4 ${handoffId === s.sessionId ? 'animate-pulse' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="重命名对话"
              onClick={() => openRenameDialog(s)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title={s.favorite ? '取消收藏' : '收藏为常用对话'}
              onClick={() => void handleToggleFavorite(s)}
            >
              <Star
                className={`h-4 w-4 ${s.favorite ? 'fill-yellow-400 text-yellow-400' : ''}`}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="打开目录"
              onClick={() => void handleOpenFolder(s)}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )

  const totalCount = data?.sessions.length ?? 0
  const storeErrors = data?.storeErrors ?? []

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <Toaster position="top-center" richColors />
      <div className="mx-auto max-w-4xl px-6 py-8">
        {/* Header */}
        <header className="mb-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neutral-900 text-white">
                <Terminal className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">Kimi Code 会话管理器</h1>
                <p className="text-sm text-neutral-500">
                  {data?.kimiRunning != null
                    ? data.kimiRunning > 0
                      ? `当前有 ${data.kimiRunning} 个 kimi 进程运行中`
                      : '当前没有运行中的 kimi 进程'
                    : 'kimi 进程状态未知'}
                  {data?.scannedAt &&
                    ` · 上次扫描 ${new Date(data.scannedAt).toLocaleTimeString('zh-CN')}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-neutral-500">
                <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
                自动刷新
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchSessions()}
                disabled={loading}
              >
                <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
          </div>
        </header>

        {/* Controls */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
            <TabsList>
              <TabsTrigger value="all">全部（{totalCount}）</TabsTrigger>
              <TabsTrigger value="cli">Kimi Code CLI</TabsTrigger>
              <TabsTrigger value="desktop">Kimi Work 桌面端</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <Input
              className="pl-9"
              placeholder="搜索标题、别名、提示词或目录…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Store warnings */}
        {storeErrors.length > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              {storeErrors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          </div>
        )}

        {/* Error state */}
        {error && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-center gap-3 py-6 text-red-700">
              <AlertCircle className="h-5 w-5" />
              <div>
                <p className="font-medium">加载失败</p>
                <p className="text-sm">{error}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Loading */}
        {!error && loading && !data && (
          <p className="py-16 text-center text-sm text-neutral-400">正在扫描本地会话…</p>
        )}

        {/* Empty state */}
        {!error && data && groups.length === 0 && favorites.length === 0 && (
          <p className="py-16 text-center text-sm text-neutral-400">
            {totalCount === 0 ? '没有找到任何本地会话' : '没有匹配的会话'}
          </p>
        )}

        {/* Favorites */}
        {favorites.length > 0 && (
          <section className="mb-8">
            <div className="mb-3 flex items-center gap-2 text-sm text-neutral-500">
              <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
              <span className="font-medium text-neutral-700">常用对话</span>
              <Badge variant="secondary" className="shrink-0">
                {favorites.length} 个会话
              </Badge>
            </div>
            <div className="space-y-3">{favorites.map(renderSessionCard)}</div>
          </section>
        )}

        {/* Session groups */}
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.workDir}>
              <div className="mb-3 flex items-center gap-2 text-sm text-neutral-500">
                <Folder className="h-4 w-4 shrink-0" />
                <span className="truncate font-mono" title={group.workDir}>
                  {group.workDir}
                </span>
                <Badge variant="secondary" className="shrink-0">
                  {group.sessions.length} 个会话
                </Badge>
              </div>
              <div className="space-y-3">{group.sessions.map(renderSessionCard)}</div>
            </section>
          ))}
        </div>
      </div>

      {/* Desktop handoff target dialog */}
      <Dialog
        open={handoffTarget !== null}
        onOpenChange={(open) => {
          if (!open) setHandoffTarget(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>交接会话</DialogTitle>
            <DialogDescription>
              该会话属于 Kimi Work 桌面端，选择交接目标：
            </DialogDescription>
          </DialogHeader>
          {handoffTarget && (
            <div className="space-y-3">
              <p className="truncate font-mono text-xs text-neutral-400" title={handoffTarget.workDir}>
                工作目录：{handoffTarget.workDir || '(未知)'}
              </p>
              <div className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Kimi Code CLI</p>
                    <p className="mt-1 text-sm text-neutral-500">
                      生成交接文档并复制引导指令，在终端启动 kimi 后粘贴即可继续
                    </p>
                  </div>
                  <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
                    <Button
                      size="sm"
                      onClick={() => void handleHandoffToCli(handoffTarget)}
                      disabled={handoffAction !== null}
                    >
                      {handoffAction === 'cli' ? '生成中…' : '生成并复制'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleOpenTerminal(handoffTarget)}
                      disabled={handoffAction !== null}
                    >
                      {handoffAction === 'terminal' ? '打开中…' : '打开终端到工作目录'}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">其他 AI（网页版）</p>
                    <p className="mt-1 text-sm text-neutral-500">
                      复制紧凑版交接内容，直接粘贴到 ChatGPT / Claude 等对话框
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="w-full shrink-0 sm:w-auto"
                    onClick={() => void handleHandoffToWeb(handoffTarget)}
                    disabled={handoffAction !== null}
                  >
                    {handoffAction === 'web' ? '生成中…' : '复制交接内容'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
            <DialogDescription>
              {renaming?.source === 'cli'
                ? '新名字会同步写入 kimi 的会话标题。'
                : '别名仅保存在本工具中，桌面端内的标题不受影响。'}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRenameSave()
            }}
            maxLength={200}
            placeholder="输入新的对话名称"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              取消
            </Button>
            <Button
              onClick={() => void handleRenameSave()}
              disabled={savingRename || !renameValue.trim()}
            >
              {savingRename ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Handoff prompt fallback dialog（复制失败时手动复制） */}
      <Dialog
        open={handoffPrompt !== null}
        onOpenChange={(open) => {
          if (!open) setHandoffPrompt(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>交接文档已生成</DialogTitle>
            <DialogDescription>
              自动复制失败，请全选下面的指令（点一下文本框再按 Ctrl+A），按 Ctrl+C
              复制后到 Kimi Work 对话里粘贴。
            </DialogDescription>
          </DialogHeader>
          <textarea
            readOnly
            value={handoffPrompt ?? ''}
            rows={8}
            className="w-full resize-y rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm focus:outline-none"
            onFocus={(e) => e.target.select()}
            autoFocus
          />
          <DialogFooter>
            <Button
              onClick={() => {
                void copyText(handoffPrompt ?? '').then((ok) => {
                  if (ok) {
                    toast.success('已复制到剪贴板')
                    setHandoffPrompt(null)
                  } else {
                    toast.error('仍然失败，请手动全选复制')
                  }
                })
              }}
            >
              再试一次复制
            </Button>
            <Button variant="outline" onClick={() => setHandoffPrompt(null)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

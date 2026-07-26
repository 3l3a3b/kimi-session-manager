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
  Languages,
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
import { useLang, type Lang } from '@/i18n'

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
  const { lang, setLang, t } = useLang()
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

  useEffect(() => {
    document.title = t('appTitle')
  }, [t])

  const relativeTime = useCallback(
    (iso: string | null): string => {
      if (!iso) return t('unknownTime')
      const ts = Date.parse(iso)
      if (!Number.isFinite(ts)) return t('unknownTime')
      const diff = Date.now() - ts
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return t('justNow')
      if (minutes < 60) return t('minutesAgo', { n: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('hoursAgo', { n: hours })
      const d = new Date(ts)
      const now = new Date()
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      if (ts >= startOfToday - 86400000) return t('yesterday', { time: hhmm })
      const days = Math.floor((startOfToday - ts) / 86400000) + 1
      if (days < 7) return t('daysAgo', { n: days })
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    },
    [t],
  )

  const fetchSessions = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const res = await fetch('/api/sessions')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as SessionsResponse
        setData(json)
        setError(null)
      } catch (err) {
        setError(t('fetchSessionsFailed', { err: String(err) }))
      } finally {
        setLoading(false)
      }
    },
    [t],
  )

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
      const key = s.workDir || t('unknownDir')
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(s)
    }
    return [...map.entries()].map(([workDir, sessions]) => ({ workDir, sessions }))
  }, [filtered, t])

  const handleResume = async (s: SessionInfo) => {
    if (s.source === 'desktop') {
      toast.info(t('desktopResumeTip'), {
        description: t('desktopResumeInfoDesc'),
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
      toast.success(t('resumeOpened'), {
        description: t('commandLabel', { cmd: json.command ?? '' }),
      })
    } catch (err) {
      toast.error(t('resumeFailed'), { description: String(err) })
    } finally {
      setResumingId(null)
    }
  }

  const handleCopy = async (s: SessionInfo) => {
    const cmd = `kimi -S ${s.sessionId}`
    if (await copyText(cmd)) {
      toast.success(t('commandCopied'), { description: cmd })
    } else {
      toast.error(t('copyFailed'), { description: cmd })
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
      toast.success(t('folderOpened'))
    } catch (err) {
      toast.error(t('openFolderFailed'), { description: String(err) })
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
      toast.error(t('titleEmpty'))
      return
    }
    if (title.length > 200) {
      toast.error(t('titleTooLong'))
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
        toast.warning(t('aliasSavedStateFailed'), {
          description: t('aliasSavedStateFailedDesc'),
        })
      } else {
        toast.success(t('renamed'), { description: title })
      }
      setRenaming(null)
    } catch (err) {
      toast.error(t('renameFailed'), { description: String(err) })
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
      toast.success(t(next ? 'pinned' : 'unpinned'), {
        description: truncate(displayName(s), 40),
      })
    } catch (err) {
      toast.error(t('pinFailed'), { description: String(err) })
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
        toast.success(t('handoffCopiedWork'), {
          description: t('handoffCopiedWorkDesc'),
        })
      } else {
        // 两种复制方式都失败：弹出可手动全选复制的对话框
        setHandoffPrompt(json.prompt ?? '')
      }
    } catch (err) {
      toast.error(t('handoffFailed'), { description: String(err) })
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
        toast.success(t('handoffCopiedCli'), {
          description: t('handoffCopiedCliDesc'),
        })
      } else {
        setHandoffPrompt(json.prompt ?? '')
      }
    } catch (err) {
      toast.error(t('handoffFailed'), { description: String(err) })
    } finally {
      setHandoffAction(null)
    }
  }

  // 桌面端会话 → 其他网页 AI（compact 模式，加引导行后复制）
  const handleHandoffToWeb = async (s: SessionInfo) => {
    setHandoffAction('web')
    try {
      const json = await postHandoff(s, 'compact')
      const text = `${t('handoffGuideLine')}\n\n${json.content ?? ''}`
      if (await copyText(text)) {
        toast.success(t('handoffWebCopied'), { description: t('handoffWebCopiedDesc') })
      } else {
        setHandoffPrompt(text)
      }
    } catch (err) {
      toast.error(t('handoffWebFailed'), { description: String(err) })
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
      toast.success(t('terminalOpened'), {
        description: t('terminalOpenedDesc'),
      })
    } catch (err) {
      toast.error(t('openTerminalFailed'), { description: String(err) })
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
                title={s.alias ? t('originalTitle', { title: s.title }) : undefined}
              >
                {truncate(displayName(s), 60)}
              </h3>
              {s.alias && (
                <Badge variant="secondary" className="text-xs font-normal">
                  {t('badgeRenamed')}
                </Badge>
              )}
              {s.recentlyActive && (
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100">
                  {t('badgeActive')}
                </Badge>
              )}
              <Badge variant="outline" className="gap-1 text-neutral-500">
                {s.source === 'cli' ? (
                  <Terminal className="h-3 w-3" />
                ) : (
                  <MonitorSmartphone className="h-3 w-3" />
                )}
                {s.source === 'cli' ? 'Kimi Code CLI' : t('sourceDesktop')}
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
                  {t('resume')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title={t('copyCommand')}
                  onClick={() => void handleCopy(s)}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                title={t('desktopResumeTip')}
                onClick={() => void handleResume(s)}
              >
                {t('desktopOnly')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              title={s.source === 'cli' ? t('handoffToKimiWork') : t('handoffSession')}
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
              title={t('renameAction')}
              onClick={() => openRenameDialog(s)}
            >
              <Pencil className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title={s.favorite ? t('unpin') : t('pin')}
              onClick={() => void handleToggleFavorite(s)}
            >
              <Star
                className={`h-4 w-4 ${s.favorite ? 'fill-yellow-400 text-yellow-400' : ''}`}
              />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title={t('openFolder')}
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
  const scanTime = data?.scannedAt
    ? new Date(data.scannedAt).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US')
    : ''

  const langButton = (target: Lang, label: string) => (
    <button
      type="button"
      onClick={() => setLang(target)}
      className={`rounded-md px-2 py-0.5 text-xs transition-colors ${
        lang === target
          ? 'bg-neutral-900 text-white'
          : 'text-neutral-500 hover:bg-neutral-100'
      }`}
    >
      {label}
    </button>
  )

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
                <h1 className="text-xl font-semibold tracking-tight">{t('appTitle')}</h1>
                <p className="text-sm text-neutral-500">
                  {data?.kimiRunning != null
                    ? data.kimiRunning > 0
                      ? t('kimiRunning', { n: data.kimiRunning })
                      : t('noKimiRunning')
                    : t('kimiStatusUnknown')}
                  {scanTime && ` · ${t('lastScan', { time: scanTime })}`}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1 rounded-lg border border-neutral-200 p-0.5">
                <Languages className="ml-1 h-3.5 w-3.5 text-neutral-400" />
                {langButton('zh', '中文')}
                {langButton('en', 'EN')}
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-500">
                <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
                {t('autoRefresh')}
              </label>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void fetchSessions()}
                disabled={loading}
              >
                <RefreshCw className={`mr-1.5 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                {t('refresh')}
              </Button>
            </div>
          </div>
        </header>

        {/* Controls */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Tabs value={sourceFilter} onValueChange={(v) => setSourceFilter(v as SourceFilter)}>
            <TabsList>
              <TabsTrigger value="all">{t('tabAll', { n: totalCount })}</TabsTrigger>
              <TabsTrigger value="cli">Kimi Code CLI</TabsTrigger>
              <TabsTrigger value="desktop">{t('sourceDesktop')}</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="relative sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <Input
              className="pl-9"
              placeholder={t('searchPlaceholder')}
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
                <p className="font-medium">{t('loadFailed')}</p>
                <p className="text-sm">{error}</p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Loading */}
        {!error && loading && !data && (
          <p className="py-16 text-center text-sm text-neutral-400">{t('loadingSessions')}</p>
        )}

        {/* Empty state */}
        {!error && data && groups.length === 0 && favorites.length === 0 && (
          <p className="py-16 text-center text-sm text-neutral-400">
            {totalCount === 0 ? t('emptyNoSessions') : t('emptyNoMatches')}
          </p>
        )}

        {/* Favorites */}
        {favorites.length > 0 && (
          <section className="mb-8">
            <div className="mb-3 flex items-center gap-2 text-sm text-neutral-500">
              <Star className="h-4 w-4 fill-yellow-400 text-yellow-400" />
              <span className="font-medium text-neutral-700">{t('favorites')}</span>
              <Badge variant="secondary" className="shrink-0">
                {t('sessionCount', { n: favorites.length })}
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
                  {t('sessionCount', { n: group.sessions.length })}
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
            <DialogTitle>{t('handoffSession')}</DialogTitle>
            <DialogDescription>{t('handoffDialogDesc')}</DialogDescription>
          </DialogHeader>
          {handoffTarget && (
            <div className="space-y-3">
              <p className="truncate font-mono text-xs text-neutral-400" title={handoffTarget.workDir}>
                {t('workDirLabel', { dir: handoffTarget.workDir || t('unknown') })}
              </p>
              <div className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">Kimi Code CLI</p>
                    <p className="mt-1 text-sm text-neutral-500">{t('targetCliDesc')}</p>
                  </div>
                  <div className="flex w-full shrink-0 flex-col gap-2 sm:w-auto">
                    <Button
                      size="sm"
                      onClick={() => void handleHandoffToCli(handoffTarget)}
                      disabled={handoffAction !== null}
                    >
                      {handoffAction === 'cli' ? t('generating') : t('generateAndCopy')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleOpenTerminal(handoffTarget)}
                      disabled={handoffAction !== null}
                    >
                      {handoffAction === 'terminal' ? t('opening') : t('openTerminalToDir')}
                    </Button>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-neutral-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{t('targetWeb')}</p>
                    <p className="mt-1 text-sm text-neutral-500">{t('targetWebDesc')}</p>
                  </div>
                  <Button
                    size="sm"
                    className="w-full shrink-0 sm:w-auto"
                    onClick={() => void handleHandoffToWeb(handoffTarget)}
                    disabled={handoffAction !== null}
                  >
                    {handoffAction === 'web' ? t('generating') : t('copyHandoffContent')}
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
            <DialogTitle>{t('renameTitle')}</DialogTitle>
            <DialogDescription>
              {renaming?.source === 'cli' ? t('renameDescCli') : t('renameDescDesktop')}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleRenameSave()
            }}
            maxLength={200}
            placeholder={t('renamePlaceholder')}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => void handleRenameSave()}
              disabled={savingRename || !renameValue.trim()}
            >
              {savingRename ? t('saving') : t('save')}
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
            <DialogTitle>{t('fallbackTitle')}</DialogTitle>
            <DialogDescription>{t('fallbackDesc')}</DialogDescription>
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
                    toast.success(t('copied'))
                    setHandoffPrompt(null)
                  } else {
                    toast.error(t('stillFailed'))
                  }
                })
              }}
            >
              {t('retryCopy')}
            </Button>
            <Button variant="outline" onClick={() => setHandoffPrompt(null)}>
              {t('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

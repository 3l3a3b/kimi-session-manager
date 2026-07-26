import { createContext, useContext, useState, type ReactNode } from 'react'

export type Lang = 'zh' | 'en'

const STORAGE_KEY = 'kimi-session-manager-lang'

const messages = {
  zh: {
    appTitle: 'Kimi Code 会话管理器',
    kimiRunning: '当前有 {n} 个 kimi 进程运行中',
    noKimiRunning: '当前没有运行中的 kimi 进程',
    kimiStatusUnknown: 'kimi 进程状态未知',
    lastScan: '上次扫描 {time}',
    autoRefresh: '自动刷新',
    refresh: '刷新',
    tabAll: '全部（{n}）',
    searchPlaceholder: '搜索标题、别名、提示词或目录…',
    loadingSessions: '正在扫描本地会话…',
    emptyNoSessions: '没有找到任何本地会话',
    emptyNoMatches: '没有匹配的会话',
    loadFailed: '加载失败',
    fetchSessionsFailed: '无法获取会话列表：{err}',
    favorites: '常用对话',
    sessionCount: '{n} 个会话',
    badgeActive: '可能正在进行',
    badgeRenamed: '已改名',
    sourceDesktop: 'Kimi Work 桌面端',
    unknownDir: '(未知目录)',
    originalTitle: '原名：{title}',
    resume: '继续会话',
    desktopOnly: '桌面端会话',
    desktopResumeTip: '该会话属于 Kimi Work 桌面端，无法用命令行恢复',
    copyCommand: '复制命令',
    renameAction: '重命名对话',
    pin: '收藏为常用对话',
    unpin: '取消收藏',
    openFolder: '打开目录',
    handoffToKimiWork: '交接到 Kimi Work',
    handoffSession: '交接会话',
    desktopResumeInfoDesc: '该对话保存在 Kimi 桌面端的数据目录中，请在桌面端的历史会话里继续。',
    resumeOpened: '已在新终端窗口中打开',
    commandLabel: '命令：{cmd}',
    resumeFailed: '恢复会话失败',
    commandCopied: '已复制命令',
    copyFailed: '复制失败',
    folderOpened: '已在资源管理器中打开目录',
    openFolderFailed: '打开目录失败',
    titleEmpty: '标题不能为空',
    titleTooLong: '标题不能超过 200 个字符',
    aliasSavedStateFailed: '已保存别名，但写入 kimi 标题失败',
    aliasSavedStateFailedDesc: '会话的 state.json 无法写入，kimi 内可能仍显示旧标题。',
    renamed: '已重命名',
    renameFailed: '重命名失败',
    pinned: '已收藏到常用对话',
    unpinned: '已取消收藏',
    pinFailed: '收藏操作失败',
    handoffCopiedWork: '交接文档已生成，指令已复制到剪贴板',
    handoffCopiedWorkDesc: '到 Kimi Work 对话里粘贴即可',
    handoffCopiedCli: '交接文档已生成，指令已复制',
    handoffCopiedCliDesc: '在终端启动 kimi 后粘贴即可继续',
    handoffFailed: '生成交接文档失败',
    handoffWebCopied: '交接内容已复制',
    handoffWebCopiedDesc: '到目标 AI 对话框粘贴即可',
    handoffWebFailed: '生成交接内容失败',
    terminalOpened: '已在工作目录打开新终端',
    terminalOpenedDesc: '输入 kimi 启动后，粘贴刚才复制的指令即可',
    openTerminalFailed: '打开终端失败',
    copied: '已复制到剪贴板',
    stillFailed: '仍然失败，请手动全选复制',
    handoffGuideLine: '以下是我之前与 AI 助手的对话记录，请阅读后了解任务上下文并继续协助我：',
    renameTitle: '重命名对话',
    renameDescCli: '新名字会同步写入 kimi 的会话标题。',
    renameDescDesktop: '别名仅保存在本工具中，桌面端内的标题不受影响。',
    renamePlaceholder: '输入新的对话名称',
    cancel: '取消',
    save: '保存',
    saving: '保存中…',
    handoffDialogDesc: '该会话属于 Kimi Work 桌面端，选择交接目标：',
    workDirLabel: '工作目录：{dir}',
    unknown: '(未知)',
    targetCliDesc: '生成交接文档并复制引导指令，在终端启动 kimi 后粘贴即可继续',
    generateAndCopy: '生成并复制',
    generating: '生成中…',
    openTerminalToDir: '打开终端到工作目录',
    opening: '打开中…',
    targetWeb: '其他 AI（网页版）',
    targetWebDesc: '复制紧凑版交接内容，直接粘贴到 ChatGPT / Claude 等对话框',
    copyHandoffContent: '复制交接内容',
    fallbackTitle: '交接文档已生成',
    fallbackDesc: '自动复制失败，请全选下面的指令（点一下文本框再按 Ctrl+A），按 Ctrl+C 复制后到目标 AI 对话里粘贴。',
    retryCopy: '再试一次复制',
    close: '关闭',
    justNow: '刚刚',
    minutesAgo: '{n} 分钟前',
    hoursAgo: '{n} 小时前',
    yesterday: '昨天 {time}',
    daysAgo: '{n} 天前',
    unknownTime: '未知时间',
  },
  en: {
    appTitle: 'Kimi Code Session Manager',
    kimiRunning: '{n} kimi processes running',
    noKimiRunning: 'No kimi processes running',
    kimiStatusUnknown: 'kimi process status unknown',
    lastScan: 'Last scan {time}',
    autoRefresh: 'Auto-refresh',
    refresh: 'Refresh',
    tabAll: 'All ({n})',
    searchPlaceholder: 'Search title, alias, prompt or directory…',
    loadingSessions: 'Scanning local sessions…',
    emptyNoSessions: 'No local sessions found',
    emptyNoMatches: 'No matching sessions',
    loadFailed: 'Load failed',
    fetchSessionsFailed: 'Failed to load sessions: {err}',
    favorites: 'Pinned',
    sessionCount: '{n} sessions',
    badgeActive: 'Possibly active',
    badgeRenamed: 'Renamed',
    sourceDesktop: 'Kimi Work Desktop',
    unknownDir: '(unknown directory)',
    originalTitle: 'Original: {title}',
    resume: 'Resume',
    desktopOnly: 'Desktop session',
    desktopResumeTip: 'This session belongs to Kimi Work desktop and cannot be resumed from the CLI',
    copyCommand: 'Copy command',
    renameAction: 'Rename',
    pin: 'Pin to favorites',
    unpin: 'Unpin',
    openFolder: 'Open folder',
    handoffToKimiWork: 'Hand off to Kimi Work',
    handoffSession: 'Hand off session',
    desktopResumeInfoDesc: 'This conversation lives in the Kimi desktop app data. Please continue it from the desktop app history.',
    resumeOpened: 'Opened in a new terminal window',
    commandLabel: 'Command: {cmd}',
    resumeFailed: 'Failed to resume session',
    commandCopied: 'Command copied',
    copyFailed: 'Copy failed',
    folderOpened: 'Folder opened in Explorer',
    openFolderFailed: 'Failed to open folder',
    titleEmpty: 'Title cannot be empty',
    titleTooLong: 'Title must be 200 characters or fewer',
    aliasSavedStateFailed: 'Alias saved, but writing the kimi title failed',
    aliasSavedStateFailedDesc: "The session's state.json could not be written; kimi may still show the old title.",
    renamed: 'Renamed',
    renameFailed: 'Rename failed',
    pinned: 'Pinned to favorites',
    unpinned: 'Unpinned',
    pinFailed: 'Favorite operation failed',
    handoffCopiedWork: 'Handoff document generated; instructions copied',
    handoffCopiedWorkDesc: 'Paste it into a Kimi Work conversation',
    handoffCopiedCli: 'Handoff document generated; instructions copied',
    handoffCopiedCliDesc: 'Start kimi in a terminal and paste to continue',
    handoffFailed: 'Failed to generate handoff document',
    handoffWebCopied: 'Handoff content copied',
    handoffWebCopiedDesc: 'Paste it into the target AI chat',
    handoffWebFailed: 'Failed to generate handoff content',
    terminalOpened: 'New terminal opened in the working directory',
    terminalOpenedDesc: 'Run kimi, then paste the copied instructions',
    openTerminalFailed: 'Failed to open terminal',
    copied: 'Copied to clipboard',
    stillFailed: 'Still failed — please select all and copy manually',
    handoffGuideLine: 'Below is my previous conversation with an AI assistant. Please read it to understand the context and continue helping me:',
    renameTitle: 'Rename conversation',
    renameDescCli: "The new name will be written back to kimi's session title.",
    renameDescDesktop: 'The alias is only stored in this tool; the title in the desktop app is unaffected.',
    renamePlaceholder: 'Enter a new name',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    handoffDialogDesc: 'This session belongs to Kimi Work desktop. Choose a handoff target:',
    workDirLabel: 'Working directory: {dir}',
    unknown: '(unknown)',
    targetCliDesc: 'Generate a handoff document and copy the instructions; start kimi in a terminal and paste to continue',
    generateAndCopy: 'Generate & copy',
    generating: 'Generating…',
    openTerminalToDir: 'Open terminal here',
    opening: 'Opening…',
    targetWeb: 'Other AI (web)',
    targetWebDesc: 'Copy a compact handoff and paste it into ChatGPT, Claude, etc.',
    copyHandoffContent: 'Copy handoff',
    fallbackTitle: 'Handoff document generated',
    fallbackDesc: 'Auto-copy failed. Select all text below (click the box, then Ctrl+A) and press Ctrl+C, then paste it into your target AI conversation.',
    retryCopy: 'Retry copy',
    close: 'Close',
    justNow: 'just now',
    minutesAgo: '{n} min ago',
    hoursAgo: '{n} h ago',
    yesterday: 'Yesterday {time}',
    daysAgo: '{n} days ago',
    unknownTime: 'Unknown time',
  },
} as const

export type MessageKey = keyof (typeof messages)['zh']

interface LangContextValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: MessageKey, vars?: Record<string, string | number>) => string
}

const LangContext = createContext<LangContextValue | null>(null)

function readInitialLang(): Lang {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readInitialLang)

  const setLang = (next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // private mode etc. — ignore
    }
  }

  const t = (key: MessageKey, vars?: Record<string, string | number>): string => {
    let text: string = messages[lang][key] ?? messages.zh[key] ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replaceAll(`{${k}}`, String(v))
      }
    }
    return text
  }

  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>
}

export function useLang(): LangContextValue {
  const ctx = useContext(LangContext)
  if (!ctx) throw new Error('useLang must be used inside LangProvider')
  return ctx
}

// 复刻 /api/resume 的启动机制，弹出一个 2 秒后自动关闭的测试窗口
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const batDir = path.join(os.tmpdir(), 'kimi-session-manager')
fs.mkdirSync(batDir, { recursive: true })
const batPath = path.join(batDir, 'spawn-test.bat')
fs.writeFileSync(
  batPath,
  '@echo off\r\n' +
    'title Kimi Code Session\r\n' +
    'echo [TEST] terminal launcher OK\r\n' +
    'timeout /t 2 >nul\r\n' +
    'exit\r\n',
  'ascii',
)

const child = spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', batPath], {
  cwd: 'F:\\Kimi Work\\杂项任务',
  detached: true,
  stdio: 'ignore',
  windowsHide: false,
})
child.on('error', (err) => {
  console.error('SPAWN ERROR:', err)
  process.exit(1)
})
child.unref()
console.log('spawn ok, bat =', batPath)

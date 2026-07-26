#!/usr/bin/env node
// ---------------------------------------------------------------------------
// 构建单文件 exe（Node SEA 方案）。用法：node scripts/build-exe.mjs
// 前置条件：已执行 npm run build（生成最新 dist/）、已安装 postject（devDep）。
// 产物：build/kimi-session-manager.exe
// ---------------------------------------------------------------------------

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_DIR = path.join(ROOT, 'dist')
const BUILD_DIR = path.join(ROOT, 'build')
const EXE_PATH = path.join(BUILD_DIR, 'kimi-session-manager.exe')

function log(msg) {
  console.log(`[build-exe] ${msg}`)
}

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) walk(full, base, out)
    else out.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return out
}

// 1) 前置检查 ---------------------------------------------------------------
if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  console.error('[build-exe] 未找到 dist/index.html，请先运行 npm run build')
  process.exit(1)
}
fs.mkdirSync(BUILD_DIR, { recursive: true })

// 2) 生成内嵌资源模块 --------------------------------------------------------
const files = walk(DIST_DIR)
const assets = {}
for (const rel of files) {
  assets[rel] = fs.readFileSync(path.join(DIST_DIR, rel)).toString('base64')
}
const assetsModule =
  '// 自动生成，请勿手改（scripts/build-exe.mjs）\n' +
  `export default ${JSON.stringify(assets)}\n`
fs.writeFileSync(path.join(BUILD_DIR, 'embedded-assets.mjs'), assetsModule)
log(`内嵌资源：${files.length} 个文件（${files.join(', ')}）`)

// 3) SEA 入口：先注入资源映射，再加载服务器 ----------------------------------
const entry =
  '// 自动生成，请勿手改（scripts/build-exe.mjs）\n' +
  "import assets from './embedded-assets.mjs'\n" +
  'globalThis.__KIMI_EMBEDDED_ASSETS__ = assets\n' +
  "import('../standalone/server.mjs')\n"
fs.writeFileSync(path.join(BUILD_DIR, 'sea-entry.mjs'), entry)

// 4) esbuild 打包为 CJS 单文件 ------------------------------------------------
const esbuild = await import('esbuild')
await esbuild.build({
  entryPoints: [path.join(BUILD_DIR, 'sea-entry.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['node:*'],
  outfile: path.join(BUILD_DIR, 'sea-bundle.cjs'),
  logLevel: 'silent',
})
log('esbuild 打包完成：build/sea-bundle.cjs')

// 5) 生成 SEA blob ------------------------------------------------------------
// 关键：blob 生成与 exe 本体必须使用同一个 node 二进制，版本不一致会导致
// exe 启动即崩溃（v8::ToLocalChecked Empty MaybeLocal）。
// process.execPath 在 Kimi Work 的 shell 里会解析到 kimi-desktop 内置的 node，
// 所以固定使用 Program Files 的 Node。
const STABLE_NODE = 'C:\\Program Files\\nodejs\\node.exe'
const nodeSource = fs.existsSync(STABLE_NODE) ? STABLE_NODE : process.execPath
log(`使用 Node 运行时：${nodeSource}`)

const seaConfig = {
  main: path.join(BUILD_DIR, 'sea-bundle.cjs'),
  output: path.join(BUILD_DIR, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  disableSnapshotSEACodeCache: true,
}
fs.writeFileSync(path.join(BUILD_DIR, 'sea-config.json'), JSON.stringify(seaConfig, null, 2))
execFileSync(nodeSource, ['--experimental-sea-config', path.join(BUILD_DIR, 'sea-config.json')], {
  cwd: ROOT,
  stdio: 'inherit',
})
log('SEA blob 生成完成：build/sea-prep.blob')

// 6) 复制 node.exe 并注入 blob -------------------------------------------------
fs.rmSync(EXE_PATH, { force: true }) // 先删旧文件，避免瞬时锁定导致 EBUSY
fs.copyFileSync(nodeSource, EXE_PATH)
const { inject } = await import('postject')
await inject(
  EXE_PATH,
  'NODE_SEA_BLOB',
  fs.readFileSync(path.join(BUILD_DIR, 'sea-prep.blob')),
  { sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2' },
)

const sizeMB = (fs.statSync(EXE_PATH).size / 1024 / 1024).toFixed(1)
log(`完成：${EXE_PATH}（${sizeMB} MB）`)

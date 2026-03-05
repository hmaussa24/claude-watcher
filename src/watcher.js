const chokidar = require('chokidar')
const { diffLines } = require('diff')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.cache', '.parcel-cache', '.turbo', 'out', '.svelte-kit'
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.ttf', '.otf', '.woff', '.woff2',
  '.exe', '.dll', '.so', '.dylib',
  '.db', '.sqlite', '.bin'
])

const MAX_SIZE = 2 * 1024 * 1024

function isBinary(fp) {
  return BINARY_EXTENSIONS.has(path.extname(fp).toLowerCase())
}

function shouldIgnore(name) {
  return IGNORED_DIRS.has(name) || name.startsWith('.')
}

function buildFileTree(dirPath, rootPath) {
  const name = path.basename(dirPath)
  const relativePath = path.relative(rootPath, dirPath) || '.'
  let stat
  try { stat = fs.statSync(dirPath) } catch { return null }

  if (!stat.isDirectory()) {
    return { type: 'file', name, path: dirPath, relativePath }
  }

  let children = []
  try {
    for (const entry of fs.readdirSync(dirPath)) {
      if (shouldIgnore(entry)) continue
      const child = buildFileTree(path.join(dirPath, entry), rootPath)
      if (child) children.push(child)
    }
  } catch { /* skip */ }

  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { type: 'directory', name, path: dirPath, relativePath, children }
}

function isGitRepo(dir) {
  try { execSync(`git -C "${dir}" rev-parse --git-dir`, { stdio: 'ignore' }); return true }
  catch { return false }
}

function gitContent(fp, root) {
  try {
    const rel = path.relative(root, fp).replace(/\\/g, '/')
    return execSync(`git -C "${root}" show HEAD:"${rel}"`, {
      encoding: 'utf8', maxBuffer: MAX_SIZE
    })
  } catch { return null }
}

function readSafe(fp) {
  try {
    const stat = fs.statSync(fp)
    if (stat.size > MAX_SIZE) return null
    return fs.readFileSync(fp, 'utf8')
  } catch { return null }
}

function initStore(dir, store) {
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (shouldIgnore(entry)) continue
      const fp = path.join(dir, entry)
      try {
        const stat = fs.statSync(fp)
        if (stat.isDirectory()) initStore(fp, store)
        else if (!isBinary(fp)) {
          const c = readSafe(fp)
          if (c !== null) store.set(fp, c)
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
}

function createWatcher(rootPath, onChange) {
  const store = new Map()
  const diffs = new Map()
  const hasGit = isGitRepo(rootPath)

  initStore(rootPath, store)

  const watcher = chokidar.watch(rootPath, {
    ignored: [/(^|[/\\])\../, /node_modules/, /\.git/, /dist[/\\]/, /build[/\\]/, /\.next/, /coverage/],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 }
  })

  function handle(fp, eventType) {
    if (isBinary(fp)) return
    const current = eventType === 'unlink' ? '' : readSafe(fp)
    if (current === null) return

    let prev = ''
    if (hasGit) {
      const g = gitContent(fp, rootPath)
      prev = g !== null ? g : (store.get(fp) || '')
    } else {
      prev = store.get(fp) || ''
    }

    if (eventType !== 'unlink') store.set(fp, current)

    const diffResult = diffLines(prev, current)
    let added = 0, removed = 0
    for (const p of diffResult) {
      if (p.added) added += p.count || 0
      else if (p.removed) removed += p.count || 0
    }

    const record = {
      filepath: fp,
      relativePath: path.relative(rootPath, fp),
      eventType,
      timestamp: Date.now(),
      added,
      removed,
      diff: diffResult,
      previousContent: prev,
      currentContent: current
    }

    diffs.set(fp, record)
    onChange(eventType, { filepath: fp, relativePath: record.relativePath, eventType, timestamp: record.timestamp, added, removed })
  }

  watcher
    .on('change', fp => handle(fp, 'change'))
    .on('add',    fp => handle(fp, 'add'))
    .on('unlink', fp => handle(fp, 'unlink'))

  // ── Escaneo inicial: detecta cambios que ya existían antes de abrir la app
  function initialScan() {
    if (hasGit) {
      // Archivos modificados vs HEAD (tracked)
      try {
        const modified = execSync(`git -C "${rootPath}" diff --name-only HEAD`, {
          encoding: 'utf8', maxBuffer: 512 * 1024
        }).trim().split('\n').filter(Boolean)

        for (const rel of modified) {
          const fp = path.join(rootPath, rel.trim())
          if (!isBinary(fp)) {
            try { handle(fp, 'change') } catch { /* skip */ }
          }
        }
      } catch { /* sin cambios o sin commits */ }

      // Archivos nuevos no rastreados por git
      try {
        const untracked = execSync(`git -C "${rootPath}" ls-files --others --exclude-standard`, {
          encoding: 'utf8', maxBuffer: 512 * 1024
        }).trim().split('\n').filter(Boolean)

        for (const rel of untracked) {
          const fp = path.join(rootPath, rel.trim())
          if (!isBinary(fp)) {
            try {
              const current = readSafe(fp)
              if (current === null) continue
              // prev vacío = archivo completamente nuevo
              const diffResult = diffLines('', current)
              const added = current.split('\n').length
              const record = {
                filepath: fp,
                relativePath: path.relative(rootPath, fp),
                eventType: 'add',
                timestamp: Date.now(),
                added,
                removed: 0,
                diff: diffResult,
                previousContent: '',
                currentContent: current
              }
              diffs.set(fp, record)
              onChange('add', { filepath: fp, relativePath: record.relativePath, eventType: 'add', timestamp: record.timestamp, added, removed: 0 })
            } catch { /* skip */ }
          }
        }
      } catch { /* sin archivos nuevos */ }
    }
  }

  // Ejecutar en el siguiente tick para que el caller reciba el watcher primero
  setImmediate(initialScan)

  return {
    stop: () => watcher.close(),
    getFileTree: () => buildFileTree(rootPath, rootPath),
    getFileDiff: fp => diffs.get(fp) || null
  }
}

module.exports = { createWatcher }

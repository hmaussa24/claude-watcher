const React = require('react')
const { useState, useEffect, useCallback, useMemo, useRef } = React
const { render, Box, Text, useInput, useApp } = require('ink')
const TextInput = require('ink-text-input').default
const { createWatcher } = require('./watcher')
const nodePath = require('path')
const fs = require('fs')
const os = require('os')
// ── History (persists recent projects) ────────────────────────────────────
const HISTORY_FILE = nodePath.join(os.homedir(), '.claude-watcher-history.json')

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) }
  catch { return [] }
}

function saveHistory(folder) {
  const prev = loadHistory().filter(p => p !== folder)
  const next = [folder, ...prev].slice(0, 8)
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(next)) } catch { /* ignore */ }
}

// ── Vim launchers ─────────────────────────────────────────────────────────
const { spawnSync } = require('child_process')

function openVimdiff(diffData) {
  if (!diffData) return
  const ext     = nodePath.extname(diffData.filepath) || '.txt'
  const tmpDir  = os.tmpdir()
  const before  = nodePath.join(tmpDir, `cw_before${ext}`)
  const after   = nodePath.join(tmpDir, `cw_after${ext}`)

  fs.writeFileSync(before, diffData.previousContent || '')
  fs.writeFileSync(after,  diffData.currentContent  || '')

  // vimdiff config: read-only, syntax on, sensible diff options
  const vimrc = [
    'set noswapfile',
    'set readonly',
    'syntax on',
    'set diffopt+=iwhite',
    'set number',
    'nnoremap q :qa!<CR>'
  ].join(' | ')

  spawnSync('vimdiff', ['-c', vimrc, before, after], { stdio: 'inherit' })

  try { fs.unlinkSync(before); fs.unlinkSync(after) } catch { /* ignore */ }
}

function openInVim(filepath, lineNum = 1) {
  if (!filepath) return
  spawnSync('vim', [`+${lineNum}`, filepath], { stdio: 'inherit' })
}

// ── Terminal size ──────────────────────────────────────────────────────────
function useTermSize() {
  const [size, setSize] = useState({
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 30
  })
  useEffect(() => {
    const update = () => setSize({ cols: process.stdout.columns || 120, rows: process.stdout.rows || 30 })
    process.stdout.on('resize', update)
    return () => process.stdout.off('resize', update)
  }, [])
  return size
}

// ── File tree helpers ──────────────────────────────────────────────────────
function flattenTree(node, depth, expanded, modified) {
  if (!node) return []
  const modData = modified.get(node.path)
  const item = { ...node, depth, isExpanded: expanded.has(node.path), modified: !!modData, eventType: modData?.eventType }
  const result = [item]
  if (node.type === 'directory' && expanded.has(node.path) && node.children) {
    for (const child of node.children) result.push(...flattenTree(child, depth + 1, expanded, modified))
  }
  return result
}

function trunc(str, len) {
  if (!str || len <= 0) return ''
  return str.length > len ? str.slice(0, len - 1) + '…' : str
}

// ── Diff helpers ───────────────────────────────────────────────────────────

// Side-by-side rows: each row has left (before) and right (after) columns.
// Change pairs (removed + immediately-following added) are aligned on the same row.
function buildSideBySideRows(diffResult) {
  const rows = []
  let L = 1, R = 1

  const split = str => {
    const lines = str.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    return lines
  }

  let i = 0
  while (i < diffResult.length) {
    const part  = diffResult[i]
    const lines = split(part.value)

    if (!part.added && !part.removed) {
      for (const c of lines) rows.push({ type: 'ctx', left: { n: L++, c }, right: { n: R++, c } })
      i++
    } else if (part.removed) {
      const removedLines = lines
      const next = diffResult[i + 1]
      if (next && next.added) {
        const addedLines = split(next.value)
        const max = Math.max(removedLines.length, addedLines.length)
        for (let j = 0; j < max; j++) {
          rows.push({
            type:  'change',
            left:  j < removedLines.length ? { n: L++, c: removedLines[j] } : null,
            right: j < addedLines.length   ? { n: R++, c: addedLines[j]   } : null
          })
        }
        i += 2
      } else {
        for (const c of removedLines) rows.push({ type: 'removed', left: { n: L++, c }, right: null })
        i++
      }
    } else {
      for (const c of lines) rows.push({ type: 'added', left: null, right: { n: R++, c } })
      i++
    }
  }
  return rows
}

// Groups of consecutive non-context rows = one hunk
function computeHunks(rows) {
  const hunks = []
  let start = -1
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== 'ctx') {
      if (start === -1) start = i
    } else {
      if (start !== -1) { hunks.push({ start, end: i - 1 }); start = -1 }
    }
  }
  if (start !== -1) hunks.push({ start, end: rows.length - 1 })
  return hunks
}

function scrollForHunk(hunk, contentH) {
  if (!hunk) return 0
  const center = Math.floor((hunk.start + hunk.end) / 2)
  return Math.max(0, center - Math.floor(contentH / 2))
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

// ── File icons (Nerd Fonts) ────────────────────────────────────────────────
const FILE_ICONS = {
  'package.json':      { icon: '\ue71e', color: 'red' },
  'package-lock.json': { icon: '\ue71e', color: 'red' },
  'yarn.lock':         { icon: '\ue71e', color: 'cyan' },
  '.gitignore':        { icon: '\ue702', color: 'gray' },
  '.gitconfig':        { icon: '\ue702', color: 'gray' },
  '.gitattributes':    { icon: '\ue702', color: 'gray' },
  'dockerfile':        { icon: '\ue7b0', color: 'blue' },
  '.dockerignore':     { icon: '\ue7b0', color: 'blue' },
  'makefile':          { icon: '\uf489', color: 'gray' },
  'cmakelists.txt':    { icon: '\uf489', color: 'gray' },
  'readme.md':         { icon: '\uf48a', color: 'blue' },
  'readme':            { icon: '\uf48a', color: 'blue' },
}
const EXT_ICONS = {
  '.js':    { icon: '\ue781', color: 'yellow' },
  '.mjs':   { icon: '\ue781', color: 'yellow' },
  '.cjs':   { icon: '\ue781', color: 'yellow' },
  '.ts':    { icon: '\ue628', color: 'blue' },
  '.tsx':   { icon: '\ue7ba', color: 'cyan' },
  '.jsx':   { icon: '\ue7ba', color: 'cyan' },
  '.vue':   { icon: '\ue6a0', color: 'green' },
  '.svelte':{ icon: '\uf783', color: 'red' },
  '.py':    { icon: '\ue606', color: 'yellow' },
  '.rb':    { icon: '\ue791', color: 'red' },
  '.go':    { icon: '\ue627', color: 'cyan' },
  '.rs':    { icon: '\ue7a8', color: 'red' },
  '.java':  { icon: '\ue738', color: 'red' },
  '.kt':    { icon: '\ue634', color: 'magenta' },
  '.c':     { icon: '\ue61d', color: 'blue' },
  '.cpp':   { icon: '\ue61d', color: 'blue' },
  '.h':     { icon: '\ue61d', color: 'magenta' },
  '.hpp':   { icon: '\ue61d', color: 'magenta' },
  '.cs':    { icon: '\uf81a', color: 'blue' },
  '.php':   { icon: '\ue608', color: 'magenta' },
  '.swift': { icon: '\ue755', color: 'red' },
  '.html':  { icon: '\ue736', color: 'red' },
  '.htm':   { icon: '\ue736', color: 'red' },
  '.css':   { icon: '\ue749', color: 'blue' },
  '.scss':  { icon: '\ue749', color: 'magenta' },
  '.sass':  { icon: '\ue749', color: 'magenta' },
  '.less':  { icon: '\ue749', color: 'magenta' },
  '.json':  { icon: '\ue60b', color: 'yellow' },
  '.yaml':  { icon: '\uf481', color: 'yellow' },
  '.yml':   { icon: '\uf481', color: 'yellow' },
  '.toml':  { icon: '\uf481', color: 'yellow' },
  '.xml':   { icon: '\uf05c', color: 'yellow' },
  '.csv':   { icon: '\uf1c3', color: 'green' },
  '.md':    { icon: '\uf48a', color: 'blue' },
  '.txt':   { icon: '\uf15c', color: 'gray' },
  '.pdf':   { icon: '\uf1c1', color: 'red' },
  '.sh':    { icon: '\uf489', color: 'gray' },
  '.bash':  { icon: '\uf489', color: 'gray' },
  '.zsh':   { icon: '\uf489', color: 'gray' },
  '.fish':  { icon: '\uf489', color: 'gray' },
  '.env':   { icon: '\uf462', color: 'yellow' },
  '.lock':  { icon: '\uf023', color: 'yellow' },
  '.log':   { icon: '\uf18d', color: 'gray' },
  '.sql':   { icon: '\uf472', color: 'gray' },
  '.db':    { icon: '\uf472', color: 'gray' },
  '.sqlite':{ icon: '\uf472', color: 'gray' },
  '.png':   { icon: '\uf1c5', color: 'magenta' },
  '.jpg':   { icon: '\uf1c5', color: 'magenta' },
  '.jpeg':  { icon: '\uf1c5', color: 'magenta' },
  '.gif':   { icon: '\uf1c5', color: 'magenta' },
  '.svg':   { icon: '\uf1c5', color: 'magenta' },
  '.ico':   { icon: '\uf1c5', color: 'magenta' },
  '.webp':  { icon: '\uf1c5', color: 'magenta' },
  '.zip':   { icon: '\uf410', color: 'yellow' },
  '.tar':   { icon: '\uf410', color: 'yellow' },
  '.gz':    { icon: '\uf410', color: 'yellow' },
  '.7z':    { icon: '\uf410', color: 'yellow' },
  '.rar':   { icon: '\uf410', color: 'yellow' },
}

function getFileIcon(name) {
  const lower = name.toLowerCase()
  if (FILE_ICONS[lower]) return FILE_ICONS[lower]
  if (lower.startsWith('.env'))          return { icon: '\uf462', color: 'yellow' }
  if (lower.startsWith('docker-compose'))return { icon: '\ue7b0', color: 'blue' }
  const ext = nodePath.extname(lower)
  return EXT_ICONS[ext] || { icon: '\uf15b', color: 'gray' }
}

// ── FileTree Panel ─────────────────────────────────────────────────────────
function FileTree({ items, selIdx, focused, width, height }) {
  const SCROLL_W = 1
  const innerH   = height - 2              // quitar borde
  const itemsH   = Math.max(0, innerH - 1) // quitar fila del header
  const half     = Math.floor(itemsH / 2)
  const start    = Math.max(0, Math.min(selIdx - half, Math.max(0, items.length - itemsH)))
  const visible  = items.slice(start, start + itemsH)
  const rowW     = width - 2 - SCROLL_W   // ancho disponible por fila

  // Scrollbar
  const maxScroll = Math.max(0, items.length - itemsH)
  const thumbH    = maxScroll > 0
    ? Math.max(1, Math.round(itemsH * itemsH / items.length))
    : itemsH
  const thumbPos  = maxScroll > 0
    ? Math.round(start / maxScroll * (itemsH - thumbH))
    : 0
  const scrollbar = Array.from({ length: itemsH }, (_, i) => {
    if (maxScroll === 0) return '│'
    if (i === 0 && start > 0) return '▲'
    if (i === itemsH - 1 && start + itemsH < items.length) return '▼'
    return (i >= thumbPos && i < thumbPos + thumbH) ? '█' : '░'
  })

  const modCount = items.filter(i => i.modified).length

  return (
    <Box flexDirection="column" width={width} height={height}
      borderStyle="round" borderColor={focused ? 'blueBright' : 'gray'}>

      {/* Header */}
      <Box>
        <Text bold color="gray"> EXPLORADOR </Text>
        {modCount > 0 && <Text color="yellow">{modCount}M</Text>}
      </Box>

      {/* Items + scrollbar */}
      <Box flexDirection="row" alignItems="flex-start">
        <Box flexDirection="column" width={rowW}>
          {visible.map((item, idx) => {
            const realIdx = start + idx
            const isSel   = realIdx === selIdx
            const indent  = ' '.repeat(item.depth * 2)
            let icon, iconColor

            if (item.type === 'directory') {
              icon      = item.isExpanded ? '\uf74b' : '\uf74a'
              iconColor = 'yellow'
            } else {
              const fi  = getFileIcon(item.name)
              icon      = fi.icon
              iconColor = item.modified
                ? (item.eventType === 'add'    ? 'green'
                :  item.eventType === 'unlink' ? 'red'
                :  'yellow')
                : fi.color
            }

            const badge    = !item.modified ? ''
                           : item.eventType === 'add'    ? ' N'
                           : item.eventType === 'unlink' ? ' D'
                           : ' M'
            // nameAreaW: rowW minus indent, icon(1)+space(1), badge, 1 left-margin
            const nameAreaW = Math.max(1, rowW - indent.length - 2 - badge.length - 1)
            const name      = trunc(item.name, nameAreaW).padEnd(nameAreaW)

            return (
              <Text key={item.path} backgroundColor={isSel ? 'blue' : undefined} wrap="truncate">
                {indent}
                <Text color={isSel ? 'white' : iconColor}>{icon} </Text>
                <Text color={isSel ? 'white' : (item.modified ? iconColor : 'white')}>{name}</Text>
                {item.modified && <Text color={iconColor} dimColor={!isSel}>{badge}</Text>}
              </Text>
            )
          })}
        </Box>

        {/* Scrollbar */}
        <Box flexDirection="column" width={SCROLL_W}>
          {scrollbar.map((ch, i) => (
            <Text key={i} color={focused ? 'blueBright' : 'gray'} dimColor={!focused}>{ch}</Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

// ── Diff Panel ─────────────────────────────────────────────────────────────
function DiffView({ diffData, focused, width, height, scroll, hunks, currentHunk }) {
  const innerW   = width - 2
  const innerH   = height - 2
  const SCROLL_W = 1                          // scrollbar column width
  const contentH = innerH - 3                 // col-header + separator + footer

  if (!diffData) {
    return (
      <Box flexDirection="column" width={width} height={height}
        borderStyle="round" borderColor={focused ? 'blueBright' : 'gray'}
        alignItems="center" justifyContent="center">
        <Text color="gray">Selecciona un archivo del árbol</Text>
        <Text color="gray" dimColor>[↑↓] navegar  [Enter] abrir  [Tab] cambiar panel</Text>
      </Box>
    )
  }

  const rows        = buildSideBySideRows(diffData.diff)
  const maxScroll   = Math.max(0, rows.length - contentH)
  const clampScroll = Math.min(scroll, maxScroll)
  const visible     = rows.slice(clampScroll, clampScroll + contentH)
  const hunk        = hunks[currentHunk]
  const inHunk      = (i) => hunk && (clampScroll + i) >= hunk.start && (clampScroll + i) <= hunk.end

  // ── Scrollbar ──
  const thumbH   = maxScroll > 0
    ? Math.max(1, Math.round(contentH * contentH / rows.length))
    : contentH
  const thumbPos = maxScroll > 0
    ? Math.round(clampScroll / maxScroll * (contentH - thumbH))
    : 0
  const scrollbar = Array.from({ length: contentH }, (_, i) => {
    if (maxScroll === 0) return '│'
    if (i === 0 && clampScroll > 0) return '▲'
    if (i === contentH - 1 && clampScroll < maxScroll) return '▼'
    return (i >= thumbPos && i < thumbPos + thumbH) ? '█' : '░'
  })

  // Column widths: split 50/50, minus divider and scrollbar
  const halfW  = Math.floor((innerW - 1 - SCROLL_W) / 2)
  const numW   = 4
  const codeW  = halfW - numW - 2

  const prep = (s) => {
    const raw = (s || '').replace(/\t/g, '    ')
    return raw.length >= codeW ? raw.slice(0, codeW) : raw + ' '.repeat(codeW - raw.length)
  }

  // Scroll position label for footer
  const scrollLabel = rows.length > contentH
    ? ` ${clampScroll + 1}–${Math.min(clampScroll + contentH, rows.length)} / ${rows.length} líneas`
    : ` ${rows.length} líneas`

  return (
    <Box flexDirection="column" width={width} height={height}
      borderStyle="round" borderColor={focused ? 'blueBright' : 'gray'}>

      {/* ── Column headers ── */}
      <Box>
        <Box width={halfW}>
          <Text color="gray" dimColor>{'─'.repeat(numW + 1)}ANTES{'─'.repeat(Math.max(0, codeW - 5))}</Text>
        </Box>
        <Text color="gray">┼</Text>
        <Box width={halfW}>
          <Text color="gray" dimColor>{'─'.repeat(numW + 1)}DESPUÉS{'─'.repeat(Math.max(0, codeW - 7))}</Text>
        </Box>
      </Box>

      {/* ── Contenido: filas diff + scrollbar lateral ── */}
      <Box flexDirection="row" flexGrow={1} alignItems="flex-start">
      {/* Filas del diff */}
      <Box flexDirection="column" flexGrow={1} alignItems="flex-start">
      {visible.map((row, i) => {
        const active = inHunk(i)
        const isChange = row.type !== 'ctx'

        const lNum = row.left  ? String(row.left.n).padStart(numW)  : ' '.repeat(numW)
        const rNum = row.right ? String(row.right.n).padStart(numW) : ' '.repeat(numW)

        const leftIsRemoved  = row.type === 'removed' || (row.type === 'change' && row.left)
        const rightIsAdded   = row.type === 'added'   || (row.type === 'change' && row.right)
        const leftGutter     = leftIsRemoved  ? '-' : ' '
        const rightGutter    = rightIsAdded   ? '+' : ' '

        const leftCode  = prep(row.left?.c)
        const rightCode = prep(row.right?.c)

        const leftBg    = leftIsRemoved  && active ? 'red'   : undefined
        const rightBg   = rightIsAdded   && active ? 'green' : undefined
        const leftColor = leftIsRemoved  ? (active ? 'white' : 'red')   : undefined
        const rightColor= rightIsAdded   ? (active ? 'white' : 'green') : undefined
        const dim       = !isChange && !active

        return (
          <Box key={i}>
            {/* LEFT side */}
            <Box width={halfW} flexShrink={0}>
              <Text color="gray" dimColor={dim}>{lNum}</Text>
              <Text color={leftColor || (dim ? undefined : 'gray')}
                    backgroundColor={leftBg} dimColor={dim} wrap="truncate">
                {leftGutter}{leftCode}
              </Text>
            </Box>
            {/* Divider */}
            <Text color={active ? 'yellow' : 'gray'} dimColor={!active}>│</Text>
            {/* RIGHT side */}
            <Box width={halfW} flexShrink={0}>
              <Text color="gray" dimColor={dim}>{rNum}</Text>
              <Text color={rightColor || (dim ? undefined : 'gray')}
                    backgroundColor={rightBg} dimColor={dim} wrap="truncate">
                {rightGutter}{rightCode}
              </Text>
            </Box>
          </Box>
        )
      })}
      </Box>
      {/* Scrollbar lateral */}
      <Box flexDirection="column" width={SCROLL_W}>
        {scrollbar.map((ch, i) => (
          <Text key={i} color={focused ? 'blueBright' : 'gray'} dimColor={!focused}>{ch}</Text>
        ))}
      </Box>
      </Box>

      {/* ── Footer ── */}
      <Text color="gray" dimColor>{'─'.repeat(innerW)}</Text>
      <Box>
        <Text color="gray" dimColor>  [v] vimdiff  [o] vim  [g] inicio  [G] fin</Text>
        <Text color="gray" dimColor>{scrollLabel}</Text>
      </Box>
    </Box>
  )
}

// ── Top Bar (fija, siempre visible, ~3 filas) ──────────────────────────────
function TopBar({ watchPath, modCount, diff, hunks, currentHunk, fileIdx, fileCount, cols }) {
  const hunk     = hunks[currentHunk]
  const hunkDots = hunks.length > 0 ? hunks.map((_, i) => i === currentHunk ? '●' : '○').join('') : ''
  const fileName = diff ? nodePath.basename(diff.filepath) : null
  const relPath  = diff ? diff.relativePath : null

  return (
    <Box flexDirection="column" width={cols} borderStyle="single" borderColor="gray">
      {/* Fila 1: app + proyecto + conteo */}
      <Box>
        <Text backgroundColor="blue" color="white" bold> ◉ Claude Watcher </Text>
        <Text color="gray"> │ </Text>
        <Text color="cyan" dimColor>{trunc(watchPath || '', cols - 40)}</Text>
        <Text color="gray">  </Text>
        {modCount > 0
          ? <Text backgroundColor="yellow" color="black"> {modCount} archivo{modCount !== 1 ? 's' : ''} modificado{modCount !== 1 ? 's' : ''} </Text>
          : <Text color="gray" dimColor> observando cambios… </Text>
        }
      </Box>
      {/* Fila 2: navegación de archivos + info del archivo actual */}
      <Box>
        <Text color="gray"> </Text>
        <Text color={fileCount > 1 ? 'white' : 'gray'}>◀ </Text>
        <Text color="yellow" bold>{fileIdx + 1}</Text>
        <Text color="gray">/{fileCount}</Text>
        <Text color={fileCount > 1 ? 'white' : 'gray'}> ▶</Text>
        <Text color="gray">  │  </Text>
        {relPath
          ? <>
              <Text bold color="cyan">{trunc(relPath, cols - 55)}</Text>
              <Text color="gray">  </Text>
              <Text color="green">+{diff.added}</Text>
              <Text color="gray"> </Text>
              <Text color="red">-{diff.removed}</Text>
              <Text color="gray">  {timeAgo(diff.timestamp)}  │  </Text>
              <Text color={currentHunk > 0 ? 'white' : 'gray'}>[b]◀ </Text>
              <Text color="yellow">{hunkDots || '·'}</Text>
              <Text color={currentHunk < hunks.length - 1 ? 'white' : 'gray'}> ▶[n]</Text>
              {hunk && <Text color="gray" dimColor>  cambio {currentHunk + 1}/{hunks.length} · ln {hunk.start + 1}</Text>}
            </>
          : <Text color="gray" dimColor>sin archivo seleccionado</Text>
        }
      </Box>
    </Box>
  )
}

// ── Status Bar (atajos, siempre al fondo) ──────────────────────────────────
function StatusBar({ focus }) {
  const hints = focus === 'tree'
    ? '[↑↓/jk] navegar  [Enter] abrir  [Tab] → diff  [q] salir'
    : '[↑↓/jk] scroll  [n/b] cambio  [←/→] archivo  [v] vimdiff  [o] vim  [Tab] árbol  [q] salir'

  return (
    <Box>
      <Text color="gray" dimColor> {hints}</Text>
    </Box>
  )
}

// ── Directory Browser ──────────────────────────────────────────────────────
function DirBrowser({ onSelect }) {
  const { rows } = useTermSize()
  const [cwd, setCwd]         = useState(process.cwd())
  const [entries, setEntries] = useState([])
  const [selIdx, setSelIdx]   = useState(0)
  const [manualMode, setManualMode] = useState(false)
  const [manualVal, setManualVal]   = useState('')
  const history = useMemo(() => loadHistory(), [])

  // Load directory entries
  useEffect(() => {
    try {
      const raw = fs.readdirSync(cwd)
        .map(name => {
          try {
            const stat = fs.statSync(nodePath.join(cwd, name))
            return { name, isDir: stat.isDirectory() }
          } catch { return null }
        })
        .filter(Boolean)
        .filter(e => !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
          return a.name.localeCompare(b.name)
        })
      setEntries([{ name: '..', isDir: true, special: 'up' }, ...raw])
      setSelIdx(0)
    } catch { /* unreadable, silently ignore */ }
  }, [cwd])

  const enter = useCallback((entry) => {
    if (!entry) return
    if (entry.special === 'up') {
      setCwd(p => nodePath.dirname(p))
    } else if (entry.isDir) {
      setCwd(nodePath.join(cwd, entry.name))
    }
  }, [cwd])

  useInput((input, key) => {
    if (manualMode) {
      if (key.escape) setManualMode(false)
      return
    }
    if (key.upArrow   || input === 'k') setSelIdx(i => Math.max(0, i - 1))
    if (key.downArrow || input === 'j') setSelIdx(i => Math.min(entries.length - 1, i + 1))
    if (key.return)   enter(entries[selIdx])
    if (input === ' ') onSelect(cwd)           // select current directory
    if (input === '~') setCwd(os.homedir())
    if (input === '.') onSelect(process.cwd()) // select cwd immediately
    if (input === '/') setManualMode(true)     // manual path input
    // Open recent by number
    const num = parseInt(input)
    if (num >= 1 && num <= 5 && history[num - 1]) onSelect(history[num - 1])
  })

  const maxEntries = rows - (history.length > 0 ? 12 : 8)
  const half   = Math.floor(maxEntries / 2)
  const start  = Math.max(0, Math.min(selIdx - half, entries.length - maxEntries))
  const visible = entries.slice(start, start + maxEntries)

  return (
    <Box flexDirection="column" padding={1} gap={1}>
      {/* Title */}
      <Text bold color="cyan">◉ Claude Code Watcher — Seleccionar proyecto</Text>

      {/* Current path */}
      <Box borderStyle="round" borderColor="blue" paddingX={1}>
        <Text color="blue">📁 </Text>
        <Text bold color="white">{cwd}</Text>
      </Box>

      {/* Manual input */}
      {manualMode && (
        <Box gap={1}>
          <Text color="yellow">❯ ruta: </Text>
          <TextInput value={manualVal} onChange={setManualVal}
            onSubmit={v => { if (v.trim()) onSelect(v.trim()) }}
            placeholder="/ruta/absoluta/al/proyecto" />
          <Text color="gray" dimColor> [Esc] cancelar</Text>
        </Box>
      )}

      {/* Directory listing */}
      <Box flexDirection="column" borderStyle="single" borderColor="gray">
        {visible.map((entry, idx) => {
          const realIdx = start + idx
          const isSel   = realIdx === selIdx
          const icon    = entry.special === 'up' ? '↑' : entry.isDir ? '▶' : ' '
          const color   = entry.special === 'up' ? 'gray'
                        : entry.isDir             ? 'cyan'
                        : 'white'
          const label   = entry.special === 'up'
                        ? `..  (subir a ${nodePath.basename(nodePath.dirname(cwd)) || '/'})`
                        : entry.name + (entry.isDir ? '/' : '')
          return (
            <Text key={entry.name}
              backgroundColor={isSel ? 'blue' : undefined}
              color={isSel ? 'white' : color}>
              {' '}{icon} {label}
            </Text>
          )
        })}
      </Box>

      {/* Recent projects */}
      {history.length > 0 && (
        <Box flexDirection="column" gap={0}>
          <Text color="gray" dimColor> Recientes:</Text>
          {history.slice(0, 5).map((p, i) => (
            <Text key={p} color="gray">  {i + 1}  {trunc(p, 60)}</Text>
          ))}
          <Text color="gray" dimColor>  [1-5] abrir reciente</Text>
        </Box>
      )}

      {/* Hints */}
      <Text color="gray" dimColor>
        {' [↑↓/jk] navegar  [Enter] entrar  [Espacio] seleccionar aquí  [~] home  [.] directorio actual  [/] escribir ruta'}
      </Text>
    </Box>
  )
}

// ── Main App ───────────────────────────────────────────────────────────────
function App() {
  const { exit }        = useApp()
  const { cols, rows }  = useTermSize()

  const [phase, setPhase]               = useState(process.argv[2] ? 'watch' : 'input')
  const [watchPath, setWatchPath]       = useState(null)
  const [fileTree, setFileTree]         = useState(null)
  const [modFiles, setModFiles]         = useState(new Map())
  const [expanded, setExpanded]         = useState(new Set())
  const [selIdx, setSelIdx]             = useState(0)
  const [selFile, setSelFile]           = useState(null)
  const [diff, setDiff]                 = useState(null)
  const [focus, setFocus]               = useState('tree')
  const [diffScroll, setDiffScroll]     = useState(0)
  const [currentFileIdx, setCurrentFileIdx] = useState(0)
  const [currentHunkIdx, setCurrentHunkIdx] = useState(0)

  const watcherRef = useRef(null)

  // Sorted list of modified files, newest first
  const modFilesArr = useMemo(() =>
    [...modFiles.values()].sort((a, b) => b.timestamp - a.timestamp),
    [modFiles]
  )

  // Side-by-side rows and hunks derived from current diff
  const diffRows = useMemo(() => diff ? buildSideBySideRows(diff.diff) : [], [diff])
  const hunks    = useMemo(() => computeHunks(diffRows), [diffRows])

  const TOP_H    = 4        // TopBar: borde + 2 filas de contenido + borde
  const BOT_H    = 1        // StatusBar
  const treeW    = Math.min(35, Math.floor(cols * 0.28))
  const diffW    = cols - treeW
  const mainH    = rows - TOP_H - BOT_H
  const contentH = mainH - 2 - 2  // borde panel + columnas + footer

  // ── Load diff for a file and jump to first hunk ──
  const loadDiff = useCallback((filepath, hunkIdx = 0) => {
    if (!watcherRef.current) return
    const d = watcherRef.current.getFileDiff(filepath)
    if (!d) return
    setDiff(d)
    setCurrentHunkIdx(hunkIdx)
    // Scroll will be computed in the effect below when hunks update
  }, [])

  // Auto-scroll when hunk changes
  useEffect(() => {
    if (hunks.length === 0) { setDiffScroll(0); return }
    const idx = Math.min(currentHunkIdx, hunks.length - 1)
    setDiffScroll(scrollForHunk(hunks[idx], contentH))
  }, [currentHunkIdx, hunks])

  // ── Start watching ──
  const startWatching = useCallback((folder) => {
    if (watcherRef.current) watcherRef.current.stop()
    const watcher = createWatcher(folder, (evType, data) => {
      setModFiles(prev => {
        const next = new Map(prev)
        next.set(data.filepath, data)
        return next
      })
    })
    watcherRef.current = watcher
    setWatchPath(folder)
    setFileTree(watcher.getFileTree())
    setExpanded(new Set([folder]))
    saveHistory(folder)
    setPhase('watch')
  }, [])

  useEffect(() => {
    if (process.argv[2]) startWatching(process.argv[2])
    return () => { if (watcherRef.current) watcherRef.current.stop() }
  }, [])

  // ── React to new file changes: auto-select newest file ──
  useEffect(() => {
    if (!watcherRef.current || modFilesArr.length === 0) return
    setFileTree(watcherRef.current.getFileTree())

    const newest = modFilesArr[0]
    setCurrentFileIdx(0)
    setSelFile(newest.filepath)
    loadDiff(newest.filepath, 0)

    // Expand parent dirs so file is visible
    setExpanded(prev => {
      const next = new Set(prev)
      const parts = newest.filepath.split(nodePath.sep)
      for (let i = 1; i < parts.length; i++) {
        next.add(parts.slice(0, i).join(nodePath.sep))
      }
      return next
    })
  }, [modFiles])

  // ── Sync tree cursor when selected file changes ──
  const items = useMemo(() => flattenTree(fileTree, 0, expanded, modFiles), [fileTree, expanded, modFiles])

  useEffect(() => {
    if (!selFile) return
    const idx = items.findIndex(i => i.path === selFile)
    if (idx !== -1) setSelIdx(idx)
  }, [selFile, items])

  // ── Navigate to a file by index in modFilesArr (circular) ──
  const goToFile = useCallback((idx) => {
    if (modFilesArr.length === 0) return
    const wrapped = ((idx % modFilesArr.length) + modFilesArr.length) % modFilesArr.length
    setCurrentFileIdx(wrapped)
    setSelFile(modFilesArr[wrapped].filepath)
    loadDiff(modFilesArr[wrapped].filepath, 0)
  }, [modFilesArr, loadDiff])

  // ── Keyboard ──
  useInput((input, key) => {
    if (phase !== 'watch') return

    // ── Quit ──
    if (input === 'q' || (key.ctrl && input === 'c')) { exit(); return }

    // ── Tab: cicla tree ↔ diff ──
    if (key.tab) {
      setFocus(f => f === 'tree' ? 'diff' : 'tree')
      return
    }

    if (focus === 'tree') {
      if (key.upArrow   || input === 'k') setSelIdx(i => Math.max(0, i - 1))
      if (key.downArrow || input === 'j') setSelIdx(i => Math.min(items.length - 1, i + 1))
      if (key.return || input === ' ') {
        const item = items[selIdx]
        if (!item) return
        if (item.type === 'directory') {
          setExpanded(prev => {
            const next = new Set(prev)
            if (next.has(item.path)) next.delete(item.path)
            else next.add(item.path)
            return next
          })
        } else {
          setSelFile(item.path)
          loadDiff(item.path, 0)
          const fIdx = modFilesArr.findIndex(f => f.filepath === item.path)
          if (fIdx !== -1) setCurrentFileIdx(fIdx)
          setFocus('diff')
        }
      }
    } else {
      // Scroll
      if (key.upArrow   || input === 'k') setDiffScroll(s => Math.max(0, s - 1))
      if (key.downArrow || input === 'j') setDiffScroll(s => s + 1)
      if (key.pageUp)   setDiffScroll(s => Math.max(0, s - Math.floor(contentH * 0.8)))
      if (key.pageDown) setDiffScroll(s => s + Math.floor(contentH * 0.8))

      // Ir al inicio / final del archivo
      if (input === 'g') setDiffScroll(0)
      if (input === 'G') setDiffScroll(Number.MAX_SAFE_INTEGER) // DiffView clampea

      // Hunk navigation
      if (input === 'n') setCurrentHunkIdx(i => Math.min(i + 1, hunks.length - 1))
      if (input === 'b') setCurrentHunkIdx(i => Math.max(0, i - 1))

      // File navigation
      if (key.leftArrow)  goToFile(currentFileIdx + 1)  // older
      if (key.rightArrow) goToFile(currentFileIdx - 1)  // newer

      // Open in vim
      if (input === 'v') openVimdiff(diff)
      if (input === 'o') {
        const hunk = hunks[Math.min(currentHunkIdx, hunks.length - 1)]
        const line = hunk ? (hunk.start + 1) : 1
        openInVim(selFile, line)
      }
    }
  })

  if (phase === 'input') return <DirBrowser onSelect={folder => startWatching(folder)} />

  const clampedHunk = Math.min(currentHunkIdx, Math.max(0, hunks.length - 1))

  return (
    <Box flexDirection="column">
      {/* Panel superior fijo */}
      <TopBar
        watchPath={watchPath}
        modCount={modFiles.size}
        diff={diff}
        hunks={hunks}
        currentHunk={clampedHunk}
        fileIdx={currentFileIdx}
        fileCount={Math.max(1, modFilesArr.length)}
        cols={cols}
      />
      {/* Paneles principales */}
      <Box height={mainH}>
        <FileTree
          items={items}
          selIdx={selIdx}
          focused={focus === 'tree'}
          width={treeW}
          height={mainH}
        />
        <DiffView
          diffData={diff}
          focused={focus === 'diff'}
          width={diffW}
          height={mainH}
          scroll={diffScroll}
          hunks={hunks}
          currentHunk={clampedHunk}
        />
      </Box>
      {/* Barra de atajos inferior */}
      <StatusBar focus={focus} />
    </Box>
  )
}

render(<App />, { exitOnCtrlC: false })

#!/usr/bin/env node
require('@babel/register')({
  configFile: false,
  babelrc: false,
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    ['@babel/preset-react', {}]
  ],
  extensions: ['.js', '.jsx']
})

// ── Synchronized output (DEC private mode 2026) ───────────────────────────
// Agrupa todos los writes de stdout de un mismo tick en un solo bloque
// atómico rodeado de marcadores de sincronización. El terminal renderiza
// el frame completo de una sola vez → elimina el parpadeo de "borra/dibuja".
// Terminales compatibles: Windows Terminal ≥1.9, kitty, ghostty, foot, etc.
;(function enableSyncOutput() {
  const _write = process.stdout.write.bind(process.stdout)
  let buf = null
  process.stdout.write = function (chunk, enc, cb) {
    const str = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
    if (buf === null) {
      buf = str
      queueMicrotask(() => {
        const out = buf; buf = null
        _write('\x1b[?2026h' + out + '\x1b[?2026l')
      })
    } else {
      buf += str
    }
    if (typeof enc === 'function') enc()
    else if (typeof cb === 'function') cb()
    return true
  }
})()

require('./src/App')

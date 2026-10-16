function leb(bytes: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  for (let i = at; i < bytes.length && i < at + 5; i++) {
    value += (bytes[i]! & 0x7f) * 2 ** shift
    if ((bytes[i]! & 0x80) === 0) return { value, next: i + 1 }
    shift += 7
  }
  return null
}

function skipLimits(bytes: Uint8Array, cursor: number): number | null {
  const flags = bytes[cursor]!
  const min = leb(bytes, cursor + 1)
  if (!min) return null
  let next = min.next
  if (flags & 0x01) { const max = leb(bytes, next); if (!max) return null; next = max.next }
  return next
}

/**
 * Whether a WebAssembly module imports or declares a shared linear memory
 * (limits flag 0x02): such a module needs SharedArrayBuffer, which needs a
 * cross-origin isolated page. Same reading as Portal's `coep-scan`.
 */
export function wasmUsesSharedMemory(bytes: Uint8Array): boolean | null {
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) return null
  let at = 8
  const name = (from: number) => { const length = leb(bytes, from); return length ? length.next + length.value : null }
  while (at < bytes.length) {
    const id = bytes[at]!
    const size = leb(bytes, at + 1)
    if (!size) return null
    const start = size.next
    const end = start + size.value
    if (id === 2 || id === 5) {
      if (end > bytes.length) return null
      const count = leb(bytes, start)
      if (!count) return null
      let cursor: number | null = count.next
      for (let i = 0; i < count.value && cursor !== null && cursor < end; i++) {
        if (id === 2) {
          const afterModule = name(cursor)
          const afterField = afterModule === null ? null : name(afterModule)
          if (afterField === null) return null
          const kind = bytes[afterField]
          cursor = afterField + 1
          if (kind === 0x00) { const index = leb(bytes, cursor); if (!index) return null; cursor = index.next; continue }
          if (kind === 0x01) { cursor = skipLimits(bytes, cursor + 1); continue }
          if (kind === 0x02) { if (bytes[cursor]! & 0x02) return true; cursor = skipLimits(bytes, cursor); continue }
          if (kind === 0x03) { cursor += 2; continue }
          if (kind === 0x04) { const tag = leb(bytes, cursor + 1); if (!tag) return null; cursor = tag.next; continue }
          return null
        }
        if (bytes[cursor]! & 0x02) return true
        cursor = skipLimits(bytes, cursor)
      }
      if (cursor === null) return null
      if (id === 5) return false
    } else if (id > 5 && id !== 0) {
      return false
    }
    at = end
  }
  return false
}

export const THREAD_SIGNALS: Array<[RegExp, string]> = [
  [/"ensureCrossOriginIsolationHeaders"\s*:\s*true/, 'godot-threads'],
  [/GODOT_THREADS_ENABLED\s*=\s*true/, 'godot-threads'],
  [/ENVIRONMENT_IS_PTHREAD/, 'emscripten-pthreads'],
  [/WebAssembly\.Memory\(\s*\{[^}]*\bshared\s*:\s*(?:true|!0)/, 'shared-wasm-memory'],
]

import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'
import { DEFAULT_LIMITS, IMAGE_RULES } from './constants.js'

export type ImageKind = 'cover' | 'poster'

/** Width and height from PNG or JPEG bytes, or null. */
export function imageSize(bytes: Buffer): { width: number; height: number; type: 'png' | 'jpeg' } | null {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: 'png' }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) { at++; continue }
      const marker = bytes[at + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue }
      const length = bytes.readUInt16BE(at + 2)
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7), type: 'jpeg' }
      }
      at += 2 + length
    }
  }
  return null
}

/** Portal's acceptance rule for a cover (16:9, ≥ 640×360) or poster (3:4, ≥ 600×800), at most `maxBytes` (`limits.portal.maxImageBytes`). */
export function acceptable(kind: ImageKind, bytes: Buffer, maxBytes = DEFAULT_LIMITS.portal.maxImageBytes): boolean {
  const size = imageSize(bytes)
  if (!size || bytes.length > maxBytes) return false
  const rule = IMAGE_RULES[kind]
  return size.width >= rule.minWidth && size.height >= rule.minHeight && Math.abs(size.width / size.height - rule.ratio) <= rule.tolerance
}

interface Raster { width: number; height: number; data: Uint8Array }

function decode(bytes: Buffer): Raster {
  const size = imageSize(bytes)
  if (!size) throw new Error('not a PNG or JPEG image')
  if (size.width * size.height > 40_000_000) throw new Error('image too large to process')
  if (size.type === 'png') {
    const png = PNG.sync.read(bytes)
    return { width: png.width, height: png.height, data: png.data }
  }
  const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 })
  return { width: raw.width, height: raw.height, data: raw.data }
}

/** Area-averaging resample of the centered crop of `source` with the target's aspect ratio. */
function cropResize(source: Raster, width: number, height: number): Raster {
  const target = width / height
  let cropW = source.width
  let cropH = Math.round(source.width / target)
  if (cropH > source.height) { cropH = source.height; cropW = Math.round(source.height * target) }
  const x0 = Math.floor((source.width - cropW) / 2)
  const y0 = Math.floor((source.height - cropH) / 2)
  const out = new Uint8Array(width * height * 4)
  const sx = cropW / width
  const sy = cropH / height
  for (let y = 0; y < height; y++) {
    const top = y0 + y * sy
    const bottom = top + sy
    for (let x = 0; x < width; x++) {
      const left = x0 + x * sx
      const right = left + sx
      let r = 0, g = 0, b = 0, a = 0, weight = 0
      for (let yy = Math.floor(top); yy < Math.ceil(bottom); yy++) {
        const wy = Math.min(bottom, yy + 1) - Math.max(top, yy)
        if (wy <= 0 || yy >= source.height) continue
        for (let xx = Math.floor(left); xx < Math.ceil(right); xx++) {
          const wx = Math.min(right, xx + 1) - Math.max(left, xx)
          if (wx <= 0 || xx >= source.width) continue
          const w = wx * wy
          const i = (yy * source.width + xx) * 4
          r += source.data[i]! * w; g += source.data[i + 1]! * w; b += source.data[i + 2]! * w; a += source.data[i + 3]! * w
          weight += w
        }
      }
      const o = (y * width + x) * 4
      out[o] = Math.round(r / weight); out[o + 1] = Math.round(g / weight); out[o + 2] = Math.round(b / weight); out[o + 3] = Math.round(a / weight)
    }
  }
  return { width, height, data: out }
}

/**
 * Turns any generated or person-supplied image into what Portal accepts:
 * center-cropped to the exact aspect, scaled to `output`, JPEG of at most `maxBytes`.
 */
export function normalizeImage(kind: ImageKind, bytes: Buffer, output: { width: number; height: number }, maxBytes = DEFAULT_LIMITS.portal.maxImageBytes): Buffer {
  const raster = cropResize(decode(bytes), output.width, output.height)
  for (const quality of [90, 82, 72, 60]) {
    const encoded = jpeg.encode({ width: raster.width, height: raster.height, data: Buffer.from(raster.data.buffer, raster.data.byteOffset, raster.data.byteLength) }, quality).data
    if (acceptable(kind, encoded, maxBytes)) return encoded
  }
  throw new Error(`could not produce an acceptable ${kind}`)
}

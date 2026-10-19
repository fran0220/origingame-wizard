import { readFileSync } from 'node:fs'

/** The platform this build talks to unless `--host` or `OG_HOST` says otherwise. */
export const DEFAULT_HOST = 'https://origingame.ai'

/**
 * Where the public, versioned adaptation rules and prompts are served.
 * Single source: `packages/game-knowledge/production/wizard/` in the platform
 * repository, published by the site. The Wizard never ships a bundled copy.
 */
export const RULES_PATH = '/wizard/v1/rules.json'

/** Identity device client this tool signs in as (shown as "Origin Wizard"). */
export const DEVICE_CLIENT = 'wizard'

/**
 * Engines Portal accepts for `engine` (its catalog ids). Portal stores any
 * other value as `html`, so an older Portal treats `unity` as `html`. Engines
 * Portal does not list (Construct, GameMaker, Phaser …) are a *family* of the
 * detection, shown to the person, and publish as `html`.
 */
export const PORTAL_ENGINES = ['html', 'threejs', 'godot', 'unity'] as const
export type Engine = (typeof PORTAL_ENGINES)[number]

/**
 * Portal's source-upload limits (server/src/storage/source-uploads.ts) and how
 * the Wizard uploads to it. The platform serves the current values in the
 * rules document (`limits`, read by `parseLimits`); these defaults apply when
 * it does not, and are Portal's own since 0.5.0.
 */
export interface Limits {
  portal: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number; maxImageBytes: number }
  upload: { concurrency: number }
}

export const DEFAULT_LIMITS: Limits = {
  portal: {
    maxFiles: 20_000,
    maxFileBytes: 512 * 1024 * 1024,
    maxTotalBytes: 1024 * 1024 * 1024,
    maxImageBytes: 5 * 1024 * 1024,
  },
  upload: { concurrency: 8 },
}

/** What the rules may set `limits` to; a value outside is clamped into the range. */
export const LIMIT_BOUNDS = {
  portal: {
    maxFiles: [1, 1_000_000],
    maxFileBytes: [1024 * 1024, 16 * 1024 * 1024 * 1024],
    maxTotalBytes: [1024 * 1024, 64 * 1024 * 1024 * 1024],
    maxImageBytes: [256 * 1024, 64 * 1024 * 1024],
  },
  upload: { concurrency: [1, 32] },
} as const

/** A byte count as people read limits: `512 MiB`, `1 GiB`, `1.5 GiB`, `300 KiB`. */
export function formatBytes(bytes: number): string {
  const units: Array<[number, string]> = [[1024 ** 3, 'GiB'], [1024 ** 2, 'MiB'], [1024, 'KiB']]
  for (const [size, unit] of units) {
    if (bytes >= size) {
      const value = bytes / size
      return `${Number.isInteger(value) ? value : Number(value.toFixed(1))} ${unit}`
    }
  }
  return `${bytes} bytes`
}

/**
 * Source upload limits. Agent Service takes at most 64 files and 512 KiB of
 * content per server-side commit (agent-service docs/facts.md); files above
 * `lfsThreshold` go through Git LFS, which shares the account's 2 GiB quota.
 */
export const SOURCE_LIMITS = {
  maxFiles: 5_000,
  maxFileBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  lfsThreshold: 256 * 1024,
  commitFiles: 64,
  commitBytes: 448 * 1024,
  scanBytes: 4 * 1024 * 1024,
} as const

/** Portal's cover/poster acceptance (server/src/lib/game-media.ts). */
export const IMAGE_RULES = {
  cover: { ratio: 16 / 9, tolerance: 0.08, minWidth: 640, minHeight: 360 },
  poster: { ratio: 3 / 4, tolerance: 0.04, minWidth: 600, minHeight: 800 },
} as const

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = readVersion()
export const AGENT_CLIENT = `origingame-wizard/${VERSION}`

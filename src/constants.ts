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

/** Engines Portal accepts for `engine`. */
export const PORTAL_ENGINES = ['html', 'threejs', 'godot'] as const
export type Engine = (typeof PORTAL_ENGINES)[number]

/** Portal source-upload limits (server/src/storage/source-uploads.ts). */
export const PORTAL_LIMITS = {
  maxFiles: 10_000,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxImageBytes: 5 * 1024 * 1024,
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

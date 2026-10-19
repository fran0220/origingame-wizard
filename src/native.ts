import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { NativeBuild } from './detect.js'

/**
 * A folder with a build OriginGame cannot publish (a Windows .exe, a macOS
 * .app, an Android .apk …). OriginGame publishes Web builds only, so the
 * Wizard looks for the project the build came from, nearby, and builds that
 * for the Web instead; otherwise it says exactly how to export for the Web.
 */

const PLATFORM: Record<NativeBuild['platform'], string> = {
  windows: 'a Windows build', macos: 'a macOS app', linux: 'a Linux build', android: 'an Android package', ios: 'an iOS Xcode project', project: 'an engine project',
}

const ENGINE: Record<NonNullable<NativeBuild['engine']>, string> = {
  unity: 'Unity', godot: 'Godot', unreal: 'Unreal Engine', gamemaker: 'GameMaker', renpy: "Ren'Py", electron: 'Electron', nwjs: 'NW.js',
  love: 'LÖVE', defold: 'Defold', construct: 'Construct', cocos: 'Cocos Creator', rpgmaker: 'RPG Maker',
}

/** How to get a Web build out of each engine, in its own menu names. */
const EXPORT: Record<NonNullable<NativeBuild['engine']> | 'unknown', string> = {
  unity: 'In Unity, export WebGL (File > Build Settings > WebGL > Switch Platform > Build; in Unity 6 File > Build Profiles > Web) and run npx origingame in the folder it writes, or run npx origingame in the Unity project folder (the one with Assets/ and ProjectSettings/) and the Wizard builds WebGL with your Unity Editor.',
  godot: 'In Godot, add a Web export (Project > Export > Add… > Web, then Export Project) and run npx origingame in that folder, or export it into a folder of the Godot project (the one with project.godot) and run npx origingame there. It is published as the static Web build it is.',
  unreal: 'Unreal Engine 5 has no Web export (HTML5 was removed in 4.24), so an Unreal game cannot be published on OriginGame as it is.',
  gamemaker: 'In GameMaker, choose the HTML5 target (Target Manager > HTML5) and Build > Create Executable, then run npx origingame in the folder with its index.html.',
  renpy: "In the Ren'Py launcher, choose Web (Beta) > Build Web Application, then run npx origingame in the folder it writes (it holds index.html and game.zip).",
  electron: 'An Electron app wraps a web game: run npx origingame in the folder with the game\'s own web source (its index.html or package.json), not the packaged app.',
  nwjs: 'An NW.js app wraps a web game: run npx origingame in the folder with the game\'s index.html (for Construct, export Web (HTML5) instead of NW.js).',
  love: 'LÖVE games have no official Web export; a community port such as love.js produces a Web build that can be published.',
  defold: 'In Defold, choose Project > Bundle > HTML5 Application, then run npx origingame in the bundle folder.',
  construct: 'In Construct, choose Menu > Project > Export > Web (HTML5), then run npx origingame in the exported folder.',
  cocos: 'In Cocos Creator, choose Project > Build, platform Web Mobile (or Web Desktop), then run npx origingame in build/web-mobile (or in this folder after the build).',
  rpgmaker: 'In RPG Maker MV/MZ, choose File > Deployment > Web browsers, then run npx origingame in the deployed folder.',
  unknown: 'Export the game for the Web (HTML5/WebGL/WebAssembly) in its engine and run npx origingame in the folder with its index.html.',
}

/** One sentence: what the folder is, then how to get a Web build. */
export function nativeMessage(dir: string, native: NativeBuild, looked: string[]): string {
  const what = `${dir} holds ${PLATFORM[native.platform]}${native.engine ? ` of a ${ENGINE[native.engine]} game` : ''} (${native.evidence.join(', ')}).`
  const why = native.platform === 'project'
    ? 'OriginGame publishes Web builds, and the Wizard cannot run this engine\'s editor.'
    : `OriginGame publishes Web builds only, so ${native.platform === 'windows' ? 'an .exe' : native.platform === 'macos' ? 'an .app' : native.platform === 'android' ? 'an .apk/.aab' : native.platform === 'ios' ? 'an Xcode project' : 'a native program'} cannot be uploaded.`
  const search = looked.length ? ` No ${native.engine === 'godot' ? 'Godot' : 'Unity'} project was found near it (looked in ${looked.slice(0, 4).join(', ')}${looked.length > 4 ? ` and ${looked.length - 4} more` : ''}).` : ''
  return `${what} ${why}${search} ${EXPORT[native.engine ?? 'unknown']}`
}

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory() } catch { return false } }
const isFile = (p: string) => { try { return fs.statSync(p).isFile() } catch { return false } }

export function isUnityProject(dir: string): boolean {
  return isFile(path.join(dir, 'ProjectSettings', 'ProjectVersion.txt')) && isDir(path.join(dir, 'Assets'))
}

export function isGodotProject(dir: string): boolean {
  return isFile(path.join(dir, 'project.godot'))
}

/** The engine whose project can be built for the Web, for a native build whose engine the files do not show (an .apk, a bare .exe). */
export function apkEngine(file: string): 'unity' | 'godot' | null {
  // A zip's central directory (the file names) is at its end.
  let fd: number
  try { fd = fs.openSync(file, 'r') } catch { return null }
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, 4 * 1024 * 1024)
    const tail = Buffer.alloc(length)
    fs.readSync(fd, tail, 0, length, size - length)
    const text = tail.toString('latin1')
    if (text.includes('libunity.so') || text.includes('assets/bin/Data/')) return 'unity'
    if (text.includes('libgodot_android.so') || /assets\/[^\0]*\.pck/.test(text)) return 'godot'
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The Unity or Godot project a native build came from: the build folder
 * itself, then each parent up to four levels (stopping at the home directory
 * or the filesystem root), then the siblings at each of those levels. The
 * nearest one wins.
 */
export function findSourceProject(buildDir: string, engine: 'unity' | 'godot'): { dir: string | null; looked: string[] } {
  const test = engine === 'unity' ? isUnityProject : isGodotProject
  const looked: string[] = []
  const home = path.resolve(os.homedir())
  const levels: string[] = []
  let current = path.resolve(buildDir)
  for (let i = 0; i <= 4; i++) {
    levels.push(current)
    const parent = path.dirname(current)
    if (parent === current || current === home) break
    current = parent
  }
  for (const level of levels) {
    looked.push(level)
    if (test(level)) return { dir: level, looked }
  }
  for (const level of levels) {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(level, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').slice(0, 200)) {
      const candidate = path.join(level, entry.name)
      if (levels.includes(candidate)) continue
      if (test(candidate)) return { dir: candidate, looked }
    }
    looked.push(`${level}${path.sep}*`)
  }
  return { dir: null, looked }
}

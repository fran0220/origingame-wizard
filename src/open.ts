import { spawn } from 'node:child_process'

/** Opens a URL or file in the default browser; silently does nothing when it cannot. */
export function openInBrowser(target: string): boolean {
  if (process.env.ORIGINGAME_NO_BROWSER === '1' || process.env.CI) return false
  const [command, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]]
      : ['xdg-open', [target]]
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

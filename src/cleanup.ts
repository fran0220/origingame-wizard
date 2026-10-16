type Hook = () => Promise<unknown>

const hooks: Hook[] = []

/** Registers work that must run when the run ends, however it ends (success, failure, Ctrl-C). */
export function onCleanup(hook: Hook): () => void {
  hooks.push(hook)
  return () => {
    const at = hooks.indexOf(hook)
    if (at !== -1) hooks.splice(at, 1)
  }
}

export async function runCleanup(): Promise<void> {
  const pending = hooks.splice(0)
  await Promise.allSettled(pending.map(hook => hook()))
}

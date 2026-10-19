import { WizardError } from './errors.js'
import type { ChatMessage, ModelClient, ToolSpec } from './model.js'
import { redact } from './redact.js'
import { callTool, describeCall, Finish, type ToolHost } from './tools.js'
import type { Ui } from './ui.js'

/**
 * The publishing loop: the model is given the goal and the tools and works
 * until it calls `finish` or `give_up`. Every tool answer, including a build
 * failure or Portal refusing the upload, is an observation it acts on, never
 * the end of the run; only the session's time, its budget or `give_up` end it.
 */

/** Tool output kept whole in the conversation; older outputs are shortened once the conversation grows. */
const RESULT_MAX = 16 * 1024
const CONTEXT_MAX = 360 * 1024
const KEEP_RECENT = 14

export interface AgentOutcome { ok: boolean; text: string; turns: number; log: string[] }

function shorten(messages: ChatMessage[]): void {
  const size = () => messages.reduce((n, m) => n + (m.content?.length ?? 0) + ('tool_calls' in m && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0)
  if (size() <= CONTEXT_MAX) return
  const tools = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0)
  for (const i of tools.slice(0, Math.max(0, tools.length - KEEP_RECENT))) {
    const m = messages[i] as { content: string }
    if (m.content.length > 600) m.content = `${m.content.slice(0, 400)}\n[… older output shortened]`
    if (size() <= CONTEXT_MAX) return
  }
  for (const m of messages) {
    if (m.role === 'assistant' && m.reasoning_content) delete m.reasoning_content
  }
}

export async function runAgent(options: { client: ModelClient; model: string; system: string; goal: string; tools: ToolSpec[]; host: ToolHost; ui: Ui; maxTurns?: number }): Promise<AgentOutcome> {
  const { client, host, ui } = options
  const messages: ChatMessage[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.goal },
  ]
  const log: string[] = []
  const maxTurns = options.maxTurns ?? 150
  let nudges = 0
  for (let turn = 1; turn <= maxTurns; turn++) {
    if (Date.now() > host.deadline - 20_000) {
      return { ok: false, text: 'the Wizard session ran out of time (30 minutes)', turns: turn - 1, log }
    }
    shorten(messages)
    let reply
    try {
      reply = await client.chat(options.model, messages, options.tools)
    } catch (error) {
      if (error instanceof WizardError && error.code === 'agent_stopped') return { ok: false, text: error.message, turns: turn - 1, log }
      throw error
    }
    messages.push(reply)
    const said = reply.content.trim()
    if (said) ui.info(redact(said.length > 400 ? `${said.slice(0, 400)}…` : said))
    if (!reply.tool_calls?.length) {
      // A turn without a tool call is a question or a pause: the run only ends through finish or give_up.
      if (++nudges > 3) return { ok: false, text: said || 'the model stopped without finishing', turns: turn, log }
      messages.push({ role: 'user', content: 'Continue with the tools. Nobody can answer in chat: end with finish after a successful publish, or give_up if it truly cannot be published.' })
      continue
    }
    nudges = 0
    let finish: Finish | null = null
    for (const call of reply.tool_calls) {
      const line = describeCall(call.function.name, call.function.arguments)
      log.push(line)
      if (!['run', 'preview', 'publish', 'finish', 'give_up', 'ask'].includes(call.function.name)) ui.step(line)
      if (finish) { messages.push({ role: 'tool', tool_call_id: call.id, content: 'not run: the run already ended' }); continue }
      const result = await callTool(host, call.function.name, call.function.arguments)
      if (result instanceof Finish) {
        finish = result
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'ok' })
        continue
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.length > RESULT_MAX ? `${result.slice(0, RESULT_MAX / 4)}\n[… ${result.length - RESULT_MAX} characters omitted …]\n${result.slice(-(RESULT_MAX * 3) / 4)}` : result })
    }
    if (finish) {
      const refused = finish.ok ? host.finishRefusal?.() : null
      if (refused) {
        messages.push({ role: 'user', content: refused })
        continue
      }
      return { ok: finish.ok, text: finish.text, turns: turn, log }
    }
  }
  return { ok: false, text: `the run reached ${maxTurns} steps without finishing`, turns: maxTurns, log }
}

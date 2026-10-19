#!/usr/bin/env node
// A stand-in for Origin Engine's `og` (the engine's docs/web-export.md):
// `og build <project> --publish --out <dir>`. It records how it was run (the
// command line and what the project it was given held) to FAKE_OG_RECORD,
// cooks into the project's cooked/ as the real og does, and writes the build:
// a copy of FAKE_OG_OUTPUT (an og build --publish output) into --out.
// FAKE_OG_MODE=fail fails the way a broken game does.
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null }
const project = args[0] === 'build' ? args[1] : null
const out = arg('--out')
if (process.env.FAKE_OG_RECORD) {
  fs.appendFileSync(process.env.FAKE_OG_RECORD, `${JSON.stringify({ argv: args, cwd: process.cwd(), project, topLevel: project ? fs.readdirSync(project).sort() : null })}\n`)
}
if (!project || !out || !args.includes('--publish')) { console.error('usage: og build [project] [--publish] [--out DIR] [--json]'); process.exit(2) }
if (process.env.FAKE_OG_MODE === 'fail') { console.error('error: src/main.ts:4:3: og.game: unknown key "setupp"'); process.exit(1) }
fs.mkdirSync(path.join(project, 'cooked'), { recursive: true })
fs.writeFileSync(path.join(project, 'cooked', '.cook.ogt'), 'type cook\nversion 1\n---\n')
fs.rmSync(out, { recursive: true, force: true })
fs.cpSync(process.env.FAKE_OG_OUTPUT, out, { recursive: true })
console.log(`og build: ${out}`)

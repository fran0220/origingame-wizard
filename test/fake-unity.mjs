#!/usr/bin/env node
// A stand-in for the Unity Editor in batch mode. It records how it was run
// (the command line, the project it was given and what that project held:
// the Wizard's build script, the import cache) to FAKE_UNITY_RECORD, then acts
// like a WebGL build: it writes the build output named by -originGameOutput
// (a copy of FAKE_UNITY_OUTPUT), a log at -logFile, and a marker in the
// project's Library/ so a test can see whether the cache comes back next run.
// FAKE_UNITY_MODE=license or compile fails the way a real editor does.
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const arg = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1] ?? null }
const project = arg('-projectPath')
const output = arg('-originGameOutput')
const logFile = arg('-logFile')
const mode = process.env.FAKE_UNITY_MODE ?? 'ok'
const log = lines => { if (logFile) fs.appendFileSync(logFile, `${lines.join('\n')}\n`) }

const exists = rel => fs.existsSync(path.join(project, rel))
const record = {
  argv: args,
  editorVersion: process.env.FAKE_UNITY_VERSION ?? null,
  cwd: process.cwd(),
  project,
  buildScript: exists('Assets/OriginGameWizard/Editor/OriginGameWizardBuild.cs') ? fs.readFileSync(path.join(project, 'Assets/OriginGameWizard/Editor/OriginGameWizardBuild.cs'), 'utf8') : null,
  asmdef: exists('Assets/OriginGameWizard/Editor/OriginGameWizard.Editor.asmdef'),
  library: exists('Library') ? fs.readdirSync(path.join(project, 'Library')).sort() : null,
  libraryMarker: exists('Library/fake-unity-builds.txt') ? fs.readFileSync(path.join(project, 'Library/fake-unity-builds.txt'), 'utf8') : null,
  topLevel: fs.readdirSync(project).sort(),
  scenes: exists('ProjectSettings/EditorBuildSettings.asset'),
}
if (process.env.FAKE_UNITY_RECORD) fs.appendFileSync(process.env.FAKE_UNITY_RECORD, `${JSON.stringify(record)}\n`)

log(['Unity Editor version: 2022.3.10f1 (fake)', `Batchmode: ${args.join(' ')}`])
if (mode === 'license') {
  log(['[Licensing::Module] Error: Access token is unavailable; failed to update', 'No valid Unity Editor license found. Please activate your license.'])
  process.exit(1)
}
if (mode === 'compile') {
  log(['Assets/Scripts/PlayerController.cs(9,9): error CS0103: The name \'Jumpp\' does not exist in the current context', 'Scripts have compiler errors.'])
  process.exit(1)
}
if (!record.buildScript || !args.includes('-executeMethod') || arg('-executeMethod') !== 'OriginGameWizardBuild.BuildWebGL') {
  log(["executeMethod class 'OriginGameWizardBuild' could not be found."])
  process.exit(1)
}
fs.mkdirSync(path.join(project, 'Library'), { recursive: true })
fs.appendFileSync(path.join(project, 'Library/fake-unity-builds.txt'), 'built\n')
fs.mkdirSync(output, { recursive: true })
fs.cpSync(process.env.FAKE_UNITY_OUTPUT, output, { recursive: true })
log(['[OriginGameWizard] result Succeeded, 0 errors, 4096 bytes, scenes Assets/Scenes/Main.unity'])
process.exit(0)

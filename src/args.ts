import { parseArgs } from 'node:util'
import { WizardError } from './errors.js'

export type Command = 'deploy' | 'login' | 'logout' | 'whoami' | 'help' | 'version'

export interface Options {
  command: Command
  dir: string
  yes: boolean
  json: boolean
  /** The agent may wire scores and saves into the code on the workspace (default; `--no-integrate` turns it off). */
  integrate: boolean
  /** Commit the project source to the person's private repository (default; `--no-source` turns it off). */
  source: boolean
  game: string | undefined
  title: string | undefined
  unlisted: boolean
  host: string | undefined
  telemetry: boolean
  prebuilt: string | undefined
  credentialsFile: string | undefined
  sourceCheckpoint: string | undefined
  /** Submit the published release as the team's AIGCC finals game: true `--aigcc`, false `--no-aigcc`, undefined asks when the team is in the finals. */
  aigcc: boolean | undefined
}

const COMMANDS = new Set<Command>(['deploy', 'login', 'logout', 'whoami', 'help', 'version'])

export const USAGE = `Run \`npx origingame\` in your game folder. An AI agent publishes it to OriginGame:
it builds the game, adapts it to the platform, publishes it and fixes whatever the
build or the platform reports until the game plays. Automatic decides by itself;
Manual asks you to confirm every command and each setting.

It works on a branch origingame/publish in a separate Git worktree (or a copy when
the folder is not in Git), never in your folder; saves the source to your private
repository; writes the listing, cover and poster; and tells you how to review and
merge the branch.

Commands:
  npx origingame [deploy]     publish the game in this folder
  npx origingame login        sign in through the browser
  npx origingame logout       revoke this device's sign-in
  npx origingame whoami       show the signed-in account

Options for scripts and agents (they take the Automatic choices without asking):
  --yes                      take every default; never prompt
  --json                     print one JSON result line on stdout (implies --yes); progress goes to stderr
  --dir <path>               game folder (default: current directory)
  --no-source                do not save the source to your private repository
  --no-integrate             do not wire leaderboards and cloud saves into the code
  --game <id>                update this game instead of the one remembered for the folder
  --aigcc                    submit the release as your team's AIGCC finals game (fails early if the team is not in the finals)
  --no-aigcc                 do not submit to AIGCC (a guided run asks when your team is in the finals)
  --title <title>            game title
  --unlisted                 keep the game out of the public catalog (anyone with the link can play)
  --prebuilt <dir>           a folder that is already built: the agent publishes it as it is unless it does not work
  --host <origin>            platform origin (default: https://origingame.ai, or OG_HOST)
  --no-telemetry             disable anonymous usage events
  --credentials-file <path>  sandbox mode: run with a session handed over in this file (deleted on read)
  --source-checkpoint <id>   record the source checkpoint this build came from (sandbox mode)
  --with-source, --integrate deprecated: both are the default now
  -h, --help                 show this help
  -v, --version              show the version`

export function parseOptions(argv: string[]): Options {
  let telemetry = true
  let source = true
  let integrate = true
  let aigcc: boolean | undefined
  const rest: string[] = []
  for (const arg of argv) {
    if (arg === '--no-telemetry') telemetry = false
    else if (arg === '--aigcc') aigcc = true
    else if (arg === '--no-aigcc') aigcc = false
    else if (arg === '--no-source') source = false
    else if (arg === '--no-integrate') integrate = false
    else rest.push(arg)
  }
  let parsed
  try {
    parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: {
        dir: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        json: { type: 'boolean' },
        integrate: { type: 'boolean' },
        'with-source': { type: 'boolean' },
        game: { type: 'string' },
        title: { type: 'string' },
        unlisted: { type: 'boolean' },
        host: { type: 'string' },
        prebuilt: { type: 'string' },
        'credentials-file': { type: 'string' },
        'source-checkpoint': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (error) {
    throw new WizardError('invalid_arguments', `${(error as Error).message}\n\n${USAGE}`)
  }
  const { values, positionals } = parsed
  if (positionals.length > 1) throw new WizardError('invalid_arguments', `unexpected argument: ${positionals[1]}\n\n${USAGE}`)
  const first = positionals[0] ?? 'deploy'
  if (!COMMANDS.has(first as Command)) throw new WizardError('invalid_arguments', `unknown command: ${first}\n\n${USAGE}`)
  let command = first as Command
  if (values.help) command = 'help'
  else if (values.version) command = 'version'
  const json = values.json === true
  const options: Options = {
    command,
    dir: values.dir ?? process.cwd(),
    yes: values.yes === true || json,
    json,
    // Wiring scores and saves is the default (it lands on the workspace branch); `--integrate` (0.1.x) changes nothing.
    integrate,
    // `--with-source` (0.1.x) is accepted and changes nothing: the source is saved by default.
    // A sandbox run already has its source in Agent Service (`--source-checkpoint`).
    source: source && !values['credentials-file'] && !values['source-checkpoint'],
    game: values.game,
    title: values.title,
    unlisted: values.unlisted === true,
    host: values.host,
    telemetry: telemetry && process.env.DO_NOT_TRACK !== '1',
    prebuilt: values.prebuilt,
    credentialsFile: values['credentials-file'],
    sourceCheckpoint: values['source-checkpoint'],
    aigcc,
  }
  if (options.game !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(options.game)) {
    throw new WizardError('invalid_arguments', '--game must be a game id')
  }
  if (options.sourceCheckpoint !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.sourceCheckpoint)) {
    throw new WizardError('invalid_arguments', '--source-checkpoint must match [a-zA-Z0-9_-]{1,200}')
  }
  if (options.title !== undefined && !options.title.trim()) throw new WizardError('invalid_arguments', '--title must not be empty')
  if (options.aigcc && options.credentialsFile) {
    throw new WizardError('invalid_arguments', '--aigcc needs your own sign-in; a sandbox run cannot submit to AIGCC')
  }
  if (options.credentialsFile && !options.sourceCheckpoint) {
    throw new WizardError('invalid_arguments', '--credentials-file (sandbox mode) requires --source-checkpoint')
  }
  return options
}

export function normalizeHost(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WizardError('invalid_arguments', `--host must be an origin such as https://origingame.ai (got ${raw})`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new WizardError('invalid_arguments', '--host must use https (http is allowed only for localhost)')
  }
  return url.origin
}

import { parseArgs } from 'node:util'
import { WizardError } from './errors.js'

export type Command = 'deploy' | 'login' | 'logout' | 'whoami' | 'help' | 'version'

export interface Options {
  command: Command
  dir: string
  yes: boolean
  json: boolean
  integrate: boolean
  withSource: boolean
  game: string | undefined
  title: string | undefined
  unlisted: boolean
  host: string | undefined
  telemetry: boolean
  prebuilt: string | undefined
  credentialsFile: string | undefined
  sourceCheckpoint: string | undefined
}

const COMMANDS = new Set<Command>(['deploy', 'login', 'logout', 'whoami', 'help', 'version'])

export const USAGE = `Usage:
  npx origingame [deploy] [options]     analyze, adapt and publish the game in this directory
  npx origingame login                  sign in through the browser
  npx origingame logout                 revoke this device's sign-in
  npx origingame whoami                 show the signed-in account

Options:
  --dir <path>               project directory (default: current directory)
  --yes                      accept the defaults; never prompt
  --json                     print one JSON result line on stdout (implies --yes); progress goes to stderr
  --integrate                also wire scores and saves into your source (shows a diff first)
  --with-source              also upload your source to a private repository (not available yet)
  --game <id>                update this game instead of the one remembered for the directory
  --title <title>            game title
  --unlisted                 publish without listing the game in the catalog
  --host <origin>            platform origin (default: https://origingame.ai, or OG_HOST)
  --no-telemetry             disable anonymous usage events
  --prebuilt <dir>           skip the build and publish this directory
  --credentials-file <path>  sandbox mode: run with a session handed over in this file (deleted on read)
  --source-checkpoint <id>   record the source checkpoint this build came from
  -h, --help                 show this help
  -v, --version              show the version`

export function parseOptions(argv: string[]): Options {
  let telemetry = true
  const rest: string[] = []
  for (const arg of argv) {
    if (arg === '--no-telemetry') telemetry = false
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
    integrate: values.integrate === true,
    withSource: values['with-source'] === true,
    game: values.game,
    title: values.title,
    unlisted: values.unlisted === true,
    host: values.host,
    telemetry: telemetry && process.env.DO_NOT_TRACK !== '1',
    prebuilt: values.prebuilt,
    credentialsFile: values['credentials-file'],
    sourceCheckpoint: values['source-checkpoint'],
  }
  if (options.game !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(options.game)) {
    throw new WizardError('invalid_arguments', '--game must be a game id')
  }
  if (options.sourceCheckpoint !== undefined && !/^[a-zA-Z0-9_-]{1,200}$/.test(options.sourceCheckpoint)) {
    throw new WizardError('invalid_arguments', '--source-checkpoint must match [a-zA-Z0-9_-]{1,200}')
  }
  if (options.title !== undefined && !options.title.trim()) throw new WizardError('invalid_arguments', '--title must not be empty')
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

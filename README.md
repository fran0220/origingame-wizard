# Origin Wizard

Publish your web game to [OriginGame](https://origingame.ai) with one command.

```sh
npx origingame deploy
```

The Wizard looks at the game in the current directory, builds it if it needs
building, adapts a **copy** of the build so it runs inside the OriginGame
Player, writes the store listing, draws a cover and a poster, and publishes it.
You get a play link at the end. The model and image costs are paid by
OriginGame, not by you.

It works with:

| Project | How it is recognized | What happens |
|---|---|---|
| Plain HTML / canvas games | `index.html` (or a single page) at the root | published as is, after adaptation |
| Vite, three.js and other npm builds | `package.json` with a `build` script | built in a scratch copy (`--base ./` for Vite), then published |
| Godot Web exports | an `.html` beside a `.pck` and a `.wasm` | published, with thread builds declared cross-origin isolated |
| Godot projects | `project.godot` | exported with your local Godot editor (`GODOT=/path/to/godot`), or the existing Web export is used |
| Prebuilt output | `dist/`, `build/`, `out/` … with an `index.html`, or `--prebuilt <dir>` | published as is |

## How it works

1. **Detect** (no AI): engine, entry page, build command and output directory, from the files.
2. **Sign in** once in your browser (device authorization; the device appears on your account's Devices page and can be revoked there). The device credential is stored in `~/.origingame/credentials.json` with mode `0600`.
3. **Session**: each run gets a short platform-funded Wizard session (at most 30 minutes, a fixed model allowlist and a per-run budget). It lives only in memory and is revoked when the run ends, also when it fails or you press Ctrl-C.
4. **Consent**: the first run shows exactly what will be sent and asks you to agree (`--yes` counts as agreeing).
5. **Build** with your own build command, in a scratch copy under `~/.origingame/stage/`. Your project directory is never written.
6. **Analyze**: DeepSeek reads a bounded digest of the build and proposes an adaptation plan. Deterministic checks run first and their findings cannot be overridden by the model.
7. **Confirm** each item (or take the recommended set with `--yes`).
8. **Adapt** the staged copy only: root-absolute paths made relative, cross-origin isolation declared for threaded WebAssembly (`origingame.runtime.json`), a Godot export's service worker turned off, a stale OriginGame entry config removed, and small exact code edits you approved.
9. **Artwork**: DeepSeek writes prompts, Qwen Image Turbo draws 3 cover (16:9) and 2 poster (3:4) candidates from text only (no screenshots), each cropped and scaled locally to 1280×720 and 1080×1440. You pick in the terminal while a local preview page shows them.
10. **Publish**: files are uploaded content-addressed (an update uploads only changed files), then the game is created or updated, and the Wizard waits for the readiness check and prints the play link.

The next run in the same directory updates the same game: its id is remembered in
`~/.origingame/projects.json`, the current release revision is read, and the
update is sent with `expected_revision`, so a change made elsewhere in the
meantime is never overwritten. An update keeps the listing and artwork you have.

## What is sent to the model, and what is not

Sent, through the OriginGame AI Gateway, to DeepSeek:

- the list of file names and sizes in your build (and in your source, for projects that are built);
- your entry HTML and up to about 120 KB of source text: `package.json`, the Vite config, `project.godot`, the Web preset of `export_presets.cfg` (lines mentioning passwords, keys or keystores removed), and your main scripts;
- the deterministic findings (for example "`style.css` references `/assets/bg.png`").

For the artwork, the image model receives only the text prompts DeepSeek wrote
from the game's description. No screenshot or file of yours is sent to it.

Never sent:

- credential files: `.env*`, `*.pem`, `*.key`, `*.p12`, keystores, `id_*` SSH keys, `.npmrc`, `.netrc`, `credentials.*`, `secrets.*`, service account files. They are also never uploaded;
- any file with a line that looks like a credential (cloud and API key formats, private key blocks, `api_key = "…"` style assignments). If such a file is part of your game, it is still published (removing it could break the game) and the run warns you, because a key in a public game is public;
- your source code is not uploaded to OriginGame; only the built game is published. (`--with-source`, a private source repository, is not available yet.)

The prompts the Wizard uses are public and versioned: they are downloaded at
startup from `https://origingame.ai/wizard/v1/rules.json` (the version is shown
on screen), and their single source is the platform repository's
`packages/game-knowledge/production/wizard/`. The Wizard never ships a copy.

## Who pays, and what stops abuse

OriginGame pays for the model and image calls of a Wizard run, through a
platform channel; nothing is charged to your wallet. There is no daily quota.
Each run's session credential is limited **on the server**: it expires after at
most 30 minutes, it can call only the Wizard's model allowlist, it has a fixed
per-run budget, it is tied to your account for audit, and the platform's risk
checks run when it is issued. Portal validates every upload and every
publication as it does for any other client. This repository contains no keys,
internal addresses or limits to bypass: changing the client changes nothing the
server enforces.

## Usage

```sh
npx origingame deploy                     # the default command; `npx origingame` alone does the same
npx origingame deploy --dir ./my-game
npx origingame deploy --title "Star Catcher" --unlisted
npx origingame deploy --integrate         # also wire scores and saves into your source (diff first)
npx origingame login | logout | whoami
```

| Flag | Meaning |
|---|---|
| `--dir <path>` | project directory (default: the current directory) |
| `--yes` | accept the defaults and never prompt |
| `--json` | print exactly one JSON line on stdout; progress goes to stderr. Implies `--yes` |
| `--integrate` | wire scores and saves to the Player protocol in your source. Shows a diff and asks first; with `--yes` the git tree must be clean. HTML and JavaScript projects only |
| `--with-source` | upload your source to a private repository (not available yet; the run continues without it) |
| `--game <id>` | update this game instead of the one remembered for the directory |
| `--title <title>` | the game's title |
| `--unlisted` | publish without listing the game in the catalog |
| `--host <origin>` | platform origin (default `https://origingame.ai`, or `OG_HOST`) |
| `--prebuilt <dir>` | skip the build and publish this directory |
| `--no-telemetry` | disable usage events (see Privacy) |
| `--credentials-file <path>` | sandbox mode, for the platform's own agent threads (below) |
| `--source-checkpoint <id>` | record the source checkpoint the build came from |

Environment: `OG_HOST` (platform origin), `OG_API_KEY` (an `og-` account key used
instead of the stored sign-in, never written to disk), `GODOT` (path to the
Godot editor), `CI` (fail instead of starting a browser sign-in),
`ORIGINGAME_NO_BROWSER=1` (print the sign-in link without opening a browser),
`ORIGINGAME_READINESS_WAIT_SECONDS` (how long to wait for the readiness check,
default 60).

### In coding agents and CI

Claude Code, Codex, Cursor and other agents run the same command in their terminal:

```sh
npx origingame deploy --yes --json
```

stdout is a single JSON line:

```json
{"ok":true,"action":"created","gameId":"…","slug":"…","version":1,"releaseId":"…","playUrl":"…","portalUrl":"…",
 "readiness":{"status":"ready"},"warnings":[],"engine":"threejs","stageSha256":"…","rulesVersion":"…","adaptations":["…"],
 "usage":{"sessionId":"pak_…","quota":1000000,"promptTokens":0,"completionTokens":0,"chatCalls":3,"imageCalls":5,"models":["…"]}}
{"ok":false,"error":{"code":"build_failed","message":"…"}}
```

Error codes: `not_logged_in`, `session_refused`, `detect_failed`, `build_failed`,
`adapt_failed`, `artwork_failed`, `upload_failed`, `publish_failed`,
`readiness_failed` (with `error.readiness`), `rules_unavailable`, `aborted`,
`invalid_arguments`. Exit code `0` on success, `130` when cancelled, `1` otherwise.
`usage.quota` is the run's budget cap, not what it spent.

If the agent's machine is not signed in, the command prints a sign-in link and
code on stderr and waits for you to approve it in the browser. In CI, sign in
beforehand or set `OG_API_KEY`.

### Sandbox mode

The platform's agent threads publish through this same command inside their
sandbox: `origingame deploy --yes --json --prebuilt <dir> --credentials-file <file>
--source-checkpoint <id> [--game <id>]`. The file holds a Wizard session and a
short-lived publish delegation; the Wizard reads it, deletes it at once, never
reads or writes `~/.origingame/credentials.json`, and sends Portal the
delegation with the repository header.

## Privacy

- Credentials are never printed or logged; tokens in error messages are redacted.
- Telemetry: **this version sends no telemetry at all.** `--no-telemetry` (or
  `DO_NOT_TRACK=1`) is already honored by the no-op hook, so a future version
  that adds anonymous step outcomes (never paths, file contents, prompts or
  credentials) will respect it; such a change will be documented here first.
- Local files: `~/.origingame/credentials.json` (device credential, `0600`),
  `projects.json` (game id per project path hash), `settings.json` (consent),
  and `stage/` (the adapted copy and artwork, rebuilt on every run).
- Builds run in a scratch copy with your `node_modules` linked, not copied, so
  build tools that cache inside `node_modules/.cache` may update that cache, as
  they would in any build.

## Development

```sh
npm install
npm run build        # TypeScript → dist/
npm test             # build, then unit and end-to-end tests
node dist/cli.js deploy --dir fixtures/plain-html --host http://localhost:8080
```

The end-to-end tests run the built CLI as a subprocess against a fake platform
(`test/fake-platform.mjs`) that implements the Identity, AI Gateway and Portal
contracts, on the three fixture projects in `fixtures/`, and write
`test-artifacts/e2e-report.json` plus the chosen artwork. Set
`WIZARD_RULES_DIR=<platform>/packages/game-knowledge/production/wizard` to run
them against the real rules and prompts.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT © OriginGame

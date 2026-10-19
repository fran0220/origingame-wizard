# Origin Wizard

Publish your game to [OriginGame](https://origingame.ai). In your game's folder:

```sh
npx origingame
```

Origin Wizard is an AI agent with one goal: **your game is published on
OriginGame and plays**. It looks at the project, builds it if it needs
building, adapts it to the platform, publishes it, and when the build fails,
Portal refuses the upload or the platform's readiness check says the game does
not start, it reads what went wrong, fixes it and publishes again. It ends
when the game plays, or tells you exactly what you must do when it cannot be
published from this machine (for example a native build with no project to
build for the Web).

The first question is how to publish:

- **Automatic** (the default, press Enter): the agent decides and runs what it
  needs (installs, builds, engine exports) in its copy of your project. Only
  what nobody may skip is asked: the browser sign-in when you are not signed
  in, the data notice on your first run, and a confirmation when a file in the
  build looks like a credential.
- **Manual**: you confirm every command before it runs, choose the game to
  update, the source upload, the title, genre and description, the cover and
  poster and who can find the game, and review before the first upload; the
  agent may also ask you questions.

**Your folder is never changed**: in a Git repository the agent works in a
worktree on the branch `origingame/publish` and its changes are one commit you
review and merge when you want; outside Git it works on a copy. The model and
image costs are paid by OriginGame, not by you.

Any static Web game can be published: hand-written HTML/canvas games, npm
projects (Vite, webpack, three.js, Phaser, PixiJS, Babylon.js …), Origin
Engine projects and their `og build --publish` output, Unity WebGL builds (and
Unity projects, with your own Unity Editor), Godot Web exports (and Godot
projects, with your Godot editor and export templates), and the HTML5 exports
of Construct, GameMaker, Cocos Creator, Defold, PlayCanvas, RPG Maker, Ren'Py,
PICO-8, Twine, Emscripten or wasm-bindgen. There is no list of supported
engines in the Wizard: the agent works out what the project is from its files.

## How it works

1. **Sign in** once in your browser (device authorization; the device appears on your account's Devices page and can be revoked there). The device credential is stored in `~/.origingame/credentials.json` with mode `0600`. `OG_API_KEY` (an `og-` account key) works too.
2. **Session**: each run gets a short platform-funded Wizard session (at most 30 minutes, a fixed model allowlist and a per-run budget). It lives only in memory and is revoked when the run ends, also when it fails or you press Ctrl-C.
3. **Consent**: the first run shows exactly what will be sent and asks you to agree (`--yes` counts as agreeing).
4. **Workspace**: in a Git repository, a worktree of the repository on `origingame/publish` under `~/.origingame/worktrees/`, created from your HEAD and advanced to it on later runs. Your uncommitted changes and untracked files are copied in so the build matches what you see, but they are never committed. Outside Git, a copy under `~/.origingame/stage/`.
5. **The agent** (DeepSeek through the OriginGame AI Gateway) gets the goal, the platform's rules (served by the platform at `/wizard/v1/rules.json`, so they change without a new Wizard release) and tools: list, read, search, write, edit, move and delete files in the workspace; run commands there; preview a folder in a local headless Chrome, Chromium or Edge (served the way OriginGame serves a release, reporting exceptions, console errors, failed requests and whether anything was drawn; `CHROME_PATH` names the browser); and publish.
6. **Publish** stages the folder (credential files, `.git` and `node_modules` left out), uploads it content-addressed (an update uploads only changed files; files are streamed from disk, eight at a time by default, and an upload Portal ends partway resumes with what is still missing), creates or updates the game, and waits for the platform's readiness check (the game opened in the real Player). Whatever Portal answers goes back to the agent as it is: Portal enforces the limits and formats, the agent fixes and publishes again. A new game's listing is written by the agent from the files, and a cover and a poster are drawn from text only (no screenshots) and cropped to 1280×720 and 1080×1440.
7. **Done**: the play link, the agent's summary of what it changed and why, and how to review (`git diff HEAD...origingame/publish`) and keep (`git merge origingame/publish`) the branch.

The next run in the same directory updates the same game: its id is remembered in
`~/.origingame/projects.json`, and the update is sent with the release revision
it read, so a change made elsewhere in the meantime is never overwritten. An
update keeps the listing and artwork you have.

## What the agent sees and does, and what it does not

- It reads files of the workspace only. Credential files (`.env*`, `*.pem`, `*.key`, `*.p12`, keystores, `id_*` SSH keys, `.npmrc`, `.netrc`, `credentials.*`, `secrets.*`, service account files) are never read and never uploaded. Any line that looks like a credential (cloud and API key formats, private key blocks, `api_key = "…"` assignments) is replaced before the model sees a file, a search result or a command's output.
- Commands run in the workspace with your environment minus every variable whose name looks like a credential (`*TOKEN*`, `*SECRET*`, `*KEY*`, `OG_*` …). In Automatic they run without asking (installs and build scripts may use the network and run the project's own scripts); in Manual you confirm each one.
- If a file the game needs has a credential-like line, it is still published (removing it could break the game) after a warning, because a key in a public game is public.
- The image model receives only text prompts written from the game's listing.
- The run is bounded by the session: 30 minutes and a per-run model budget, then it stops and reports what it tried.

## Your source in a private repository

By default the run also commits your project's source to a private repository
on OriginGame owned by your account and links it to the published game, so you
can continue the game with the Origin agent. Manual asks first (the default is
yes); Automatic and `--yes` save it; `--no-source` turns it off.

- What is uploaded is the workspace: the `origingame/publish` branch's tree
  (or the copy) with the files from your checkout that the rules below allow.
- Within it, what Git would track: every `.gitignore` in the project
  applies, and `node_modules`, `.git` and engine caches are skipped. Credential
  files and files with a credential-like line are left out and listed; symbolic
  links are not followed.
- Files up to 256 KB are committed as they are; larger ones (textures, audio,
  `.pck`) are stored with Git LFS and committed as LFS pointers, with a
  generated block in `.gitattributes`.
- The repository keeps `.origin/wizard-source.json`, the list of what the
  Wizard committed; a later run commits only files that changed since and
  deletes files you removed. The same repository is reused: the one remembered
  for the directory, or the one already linked to the game you update.
- Limits: 5,000 files, 1 GiB in total, 512 MiB per file, and your account's
  2 GiB storage for large files. Over a limit, the run stops before any model
  call; if the upload fails, nothing is published. Large files are streamed
  to Git LFS four at a time; a store failure or an expired upload URL is
  retried with a new URL.
- It uses your own sign-in, not the platform-funded session, and never writes
  to your project directory.

The prompts the Wizard uses are public and versioned: they are downloaded at
startup from `https://origingame.ai/wizard/v1/rules.json` (the version is shown
on screen), and their single source is the platform repository's
`packages/game-knowledge/production/wizard/`. The Wizard never ships a copy.
The same document names Portal's upload limits and how many files to upload
at a time (`limits`); when it does not, the Wizard uses its own defaults
(512 MiB per file, 1 GiB and 20,000 files in total, 8 at a time).

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
npx origingame                            # answer the questions (Automatic or Manual)
npx origingame --dir ./my-game
npx origingame login | logout | whoami
```

Options are for scripts and agents; a person never needs them. They take the
Automatic choices without asking.

| Flag | Meaning |
|---|---|
| `--yes` | take every default and never prompt |
| `--json` | print exactly one JSON line on stdout; progress goes to stderr. Implies `--yes` |
| `--dir <path>` | game folder (default: the current directory) |
| `--no-source` | do not save the source to your private repository |
| `--no-integrate` | do not wire leaderboards and cloud saves |
| `--game <id>` | update this game instead of the one remembered for the folder |
| `--aigcc` | submit the release as your team's AIGCC finals game; fails before any model call if the team is not in the finals |
| `--no-aigcc` | do not submit to AIGCC (a guided run asks when your team is in the finals) |
| `--title <title>` | the game's title |
| `--unlisted` | keep the game out of the public catalog (anyone with the link can play) |
| `--prebuilt <dir>` | skip the build and publish this folder |
| `--host <origin>` | platform origin (default `https://origingame.ai`, or `OG_HOST`) |
| `--no-telemetry` | disable usage events (see Privacy) |
| `--credentials-file <path>` | sandbox mode, for the platform's own agent threads (below) |
| `--source-checkpoint <id>` | record the source checkpoint the build came from |
| `--with-source`, `--integrate` | accepted for 0.1 callers; both are the default now |

Environment: `OG_HOST` (platform origin), `OG_API_KEY` (an `og-` account key used
instead of the stored sign-in, never written to disk), `OG` (path to Origin
Engine's `og`), `UNITY` (path to the Unity Editor), `ORIGINGAME_UNITY_TIMEOUT_MINUTES`
(time limit of a Unity build, default 180), `CI` (fail instead of starting a browser sign-in),
`ORIGINGAME_NO_BROWSER=1` (print the sign-in link without opening a browser),
`ORIGINGAME_READINESS_WAIT_SECONDS` (how long to wait for the readiness check,
default 60), `ORIGINGAME_API_ORIGIN` (the AI Gateway relay for model calls, default
`https://api.<host>`), `ORIGINGAME_AGENT_ORIGIN` (the Agent Service origin for the source upload;
default `https://agent.<host>`).

### In coding agents and CI

Claude Code, Codex, Cursor and other agents run the same command in their terminal:

```sh
npx origingame --yes --json
```

stdout is a single JSON line:

```json
{"ok":true,"action":"created","gameId":"…","slug":"…","version":1,"releaseId":"…","title":"…","playUrl":"…","portalUrl":"…",
 "readiness":{"status":"ready"},"warnings":[],"engine":"threejs","stageSha256":"…","rulesVersion":"…",
 "steps":["list .","run: npm ci","run: npm run build","publish dist as threejs"],"summary":"…",
 "usage":{"sessionId":"pak_…","quota":1000000,"promptTokens":0,"completionTokens":0,"chatCalls":12,"imageCalls":2,"models":["…"]},
 "source":{"repositoryId":"…","checkpointId":"…"},
 "workspace":{"kind":"worktree","path":"…/.origingame/worktrees/…","branch":"origingame/publish","base":"…",
  "commits":[{"sha":"…","message":"origingame: publish to OriginGame"}],"review":"git diff HEAD...origingame/publish","merge":"git merge origingame/publish"},
 "aigcc":null}
{"ok":false,"error":{"code":"agent_stopped","message":"…"}}
```

Error codes: `not_logged_in`, `session_refused`, `agent_stopped` (the agent gave up,
or the session's time or budget ran out, before anything was published),
`publish_failed`, `upload_failed`, `rules_unavailable`, `aigcc_refused`, `aborted`,
`invalid_arguments`. Exit code `0` on success, `130` when cancelled, `1` otherwise.
`usage.quota` is the run's budget cap, not what it spent.
`engine` is the catalog engine Portal received (`html`, `origin-engine`, `threejs`, `unity`).
`steps` is what the agent did, in order; `summary` its own account of what it changed and why.
`source` is `{repositoryId, checkpointId, commit, createdRepository, files, bytes,
committed, deleted, lfsObjects, withheld}`, or `null` with `--no-source` or when it
was not saved (the publication never waits for or fails on it; a warning says why).
`workspace` is the worktree (as above) or `{"kind":"copy","path":"…"}` outside Git.

If the agent's machine is not signed in, the command prints a sign-in link and
code on stderr and waits for you to approve it in the browser. In CI, sign in
beforehand or set `OG_API_KEY`.

### AIGCC finals

Teams the organizer advanced to the AIGCC finals (八强, 决赛 or an award) publish
their finals game with the Wizard. Any confirmed team member signs in with their
own account and runs, in the game's folder:

```sh
npx origingame --aigcc
```

The Wizard checks that the team is in the finals and the window is open before
any model spend, publishes as usual (updating the team's finals game when it is
yours and the folder has no other game), then submits the exact release to AIGCC.
AIGCC verifies the team and Portal's ownership receipt and adds the game to the
AIGCC games channel. Run it again for each new version. A guided run without the
flag asks when the team is in the finals; a script never submits without
`--aigcc`. The JSON result has `aigcc`: `{submitted:true,team,version,playUrl}`,
`{submitted:false,reason}` (the game is published; the warning `aigcc.failed`
says to run again) or `null`. Error code `aigcc_refused`: not in the finals or
the window is closed. Sandbox mode cannot submit.

### Sandbox mode

The platform's agent threads publish through this same command inside their
sandbox: `origingame deploy --yes --json --prebuilt <dir> --credentials-file <file>
--source-checkpoint <id> [--game <id>]`; its source is already in Agent Service, so
nothing is uploaded from the sandbox but the build. The file holds a Wizard session and a
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
contracts, with a scripted model that answers the publishing loop with tool
calls, on the fixture projects in `fixtures/`.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT © OriginGame

# Origin Wizard

Publish your web game to [OriginGame](https://origingame.ai). In your game's folder:

```sh
npx origingame
```

and answer the questions. The first one is how to publish:

- **Automatic** (the default, press Enter): publish with the recommended
  settings. The Wizard shows the plan in one line, then asks nothing more except
  what nobody may skip: the browser sign-in when you are not signed in, the
  data notice on your first run, and a confirmation when a file in the build
  looks like a credential.
- **Manual**: choose each setting: the folder and what to publish from it, the
  account, a new game or which of your games to update, whether to save the
  source, which adaptations to apply, whether to wire leaderboards and cloud
  saves, the title, genre and description, the cover and poster, and who can
  find the game; then a review before anything is uploaded.

The Wizard finds the game, builds it if it needs building, adapts it so it runs
inside the OriginGame Player, wires leaderboards and cloud saves, saves your
source to a private repository of yours, writes the store listing, draws a
cover and a poster, and publishes it. **Your folder is never changed**: in a Git
repository every change is a commit on a branch `origingame/publish` in a
separate worktree, which you review and merge when you want; outside Git the
changes stay in a copy. The model and image costs are paid by OriginGame, not
by you.

It works with:

| Project | How it is recognized | What happens |
|---|---|---|
| Plain HTML / canvas games | `index.html` (or a single page) at the root | published as is, after adaptation |
| Vite, three.js and other npm builds | `package.json` with a `build` script | built in a scratch copy (`--base ./` for Vite), then published |
| Godot Web exports | an `.html` beside a `.pck` and a `.wasm` | published, with thread builds declared cross-origin isolated |
| Godot projects | `project.godot` | exported with your local Godot editor (`GODOT=/path/to/godot`), or the existing Web export is used |
| Unity WebGL builds | `index.html` with `Build/*.loader.js` (or a legacy `UnityLoader.js`), at the root, in a subfolder or as `--prebuilt` | published as is; a compressed build is declared precompressed, a threaded one cross-origin isolated (see [Unity](#unity)) |
| Unity projects | `Assets/` and `ProjectSettings/ProjectVersion.txt` | built for WebGL in batch mode with your local Unity Editor, or the existing WebGL build is used |
| Other engines' Web exports | the engine's own files (below) | published as is, with the engine named in the plan |
| Prebuilt output | `dist/`, `build/`, `out/` … with an `index.html`, or `--prebuilt <dir>` | published as is |
| Native builds (Windows `.exe`, macOS `.app`, Linux, Android `.apk`/`.aab`, iOS Xcode) | the executable and its data folder | never uploaded: the Wizard switches to the Unity or Godot project beside it, or says how to export for the Web |

Web exports of other engines are recognized by their files, and the catalog
engine Portal receives stays one of `html`, `threejs`, `godot`, `unity` (the
engine's name is shown in the plan and returned as `family`):

| Engine or framework | Recognized by | Catalog engine |
|---|---|---|
| Construct 3 / Construct 2 | `c3runtime.js` or `c3main.js` / `c2runtime.js` | html |
| GameMaker (HTML5) | `html5game/*.js`, or `GameMaker_Init` in the page | html |
| Cocos Creator (web-mobile, web-desktop) | `cocos2d-js*.js`, `cocos-js/cc*.js`, or `src/settings*` with the application script | html |
| Defold (HTML5 bundle) | `dmloader.js`, or `EngineLoader.load(` in the page | html |
| PlayCanvas | `__start__.js` with `config.json`, or `playcanvas*.js` | html |
| RPG Maker MZ / MV | `js/rmmz_core.js` / `js/rpg_core.js` | html |
| Ren'Py (Web) | `renpy.wasm`, `renpy.js` with `game.zip`, or `renpy-pre.js` | html |
| PICO-8 (HTML export) | `_cartdat` in the script, or the page's `pico8_buttons` | html |
| Twine | a story page with `<tw-storydata` (or TiddlyWiki's `storeArea`) | html |
| Rust + wasm-bindgen (Bevy, Leptos …) | `*_bg.wasm`, or `__wbindgen` in the JS glue | html |
| Emscripten (C/C++, raylib, SDL) | a `.wasm` with Emscripten's JS glue or page | html |
| Phaser, PixiJS, Babylon.js | the library file, or the dependency in `package.json` | html |

The markers and labels in this table are part of the platform's
Wizard rules, so new engines are added there without a new Wizard release.

## How it works

1. **Detect** (no AI): engine, entry page, build command and output directory, from the files.
2. **Sign in** once in your browser (device authorization; the device appears on your account's Devices page and can be revoked there). The device credential is stored in `~/.origingame/credentials.json` with mode `0600`.
3. **Session**: each run gets a short platform-funded Wizard session (at most 30 minutes, a fixed model allowlist and a per-run budget). It lives only in memory and is revoked when the run ends, also when it fails or you press Ctrl-C.
4. **Consent**: the first run shows exactly what will be sent and asks you to agree (`--yes` counts as agreeing).
5. **Workspace**: in a Git repository, a worktree of the repository on the branch `origingame/publish` under `~/.origingame/worktrees/`, created from your HEAD and advanced to it on later runs (if your latest commit does not merge cleanly, the branch starts again from it). Your uncommitted changes and untracked files are copied in so the build matches what you see, but they are never committed. Your checkout, index and current branch are never touched. Outside Git, a copy under `~/.origingame/stage/`.
6. **Build** with your own build command, from the workspace.
7. **Analyze**: DeepSeek reads a bounded digest of the build and proposes an adaptation plan. Deterministic checks run first and their findings cannot be overridden by the model.
8. **Adapt** (always): root-absolute paths made relative, cross-origin isolation declared for threaded WebAssembly (`origingame.runtime.json`), a Godot export's service worker turned off, a stale OriginGame entry config removed, and small exact code edits. Automatic takes the required and recommended items; Manual lets you leave out the optional ones. Where the published files are your own files (HTML games, exports in the tree) the changes are committed as `origingame: adapt for OriginGame`; for built projects they apply to the build output.
9. **Integrate** (by default; `--no-integrate` or Manual's No turns it off): DeepSeek wires leaderboards and cloud saves to the Player protocol in the workspace's source, shows the diff and commits it as `origingame: wire leaderboards and cloud saves`. If the integrated build does not become ready in the Player, the Wizard drops that commit, publishes the adaptation-only build instead and reports why; the publication never fails because of the integration.
10. **Artwork**: DeepSeek writes prompts and Qwen Image Turbo draws from text only (no screenshots), each image cropped and scaled locally to 1280×720 (cover, 16:9) and 1080×1440 (poster, 3:4). In Manual, 3 cover and 2 poster candidates to pick from in the terminal, with a local preview page; Automatic and `--yes` draw one of each.
11. **Publish**: the source goes to your private repository (below), the build is uploaded content-addressed (an update uploads only changed files; files are streamed from disk, eight at a time by default, and an upload Portal ends partway resumes with what is still missing), the game is created or updated, and the Wizard waits for the readiness check, then prints the play link and how to review (`git diff HEAD...origingame/publish`) and keep (`git merge origingame/publish`) the branch.

The next run in the same directory updates the same game: its id is remembered in
`~/.origingame/projects.json`, the current release revision is read, and the
update is sent with `expected_revision`, so a change made elsewhere in the
meantime is never overwritten. An update keeps the listing and artwork you have.

## Unity

**A WebGL build** (the folder Unity writes: `index.html`, `Build/`,
`TemplateData/`, maybe `StreamingAssets/`) is published as Unity wrote it.
Run `npx origingame` in that folder, in a folder above it, or pass
`--prebuilt <dir>`.

- Any **Compression Format** works. A Brotli (`.br`) or gzip (`.gz`) build is
  declared `"precompressed": true` in `origingame.runtime.json`, and the Player
  serves those files with their `Content-Encoding`. Turn **Decompression
  Fallback** off: the Wizard warns when a build uses it (`.unityweb`), because
  the browser then decompresses in JavaScript, which is slower.
- A build with **WebGL threads** (shared memory, found by reading the
  `.wasm` itself, compressed or not) is also declared cross-origin isolated.
  An existing `origingame.runtime.json` is merged, never replaced.
- OriginGame accepts **512 MiB per file, 1 GiB and 20,000 files in total**
  (the platform's rules name the current limits, and the Wizard's messages
  quote them). An uncompressed build over those limits is Brotli-compressed
  by the Wizard for that release (the loader references in `index.html` are
  updated and the build is declared precompressed; your folder is not
  changed). If it does not fit even compressed, the Wizard says which files
  are too large and what to change in Unity (Brotli, code stripping, texture
  compression, moving content to Addressables).
- The page template may get small edits so the canvas fills the Player's
  frame; the Unity PWA template's service worker is turned off, because the
  Player owns caching. `Build/` files are never edited.
- Leaderboards and cloud saves are not wired into Unity games (the Wizard
  cannot edit and rebuild C#); the game is published without them.

**A Unity project** (`Assets/`, `ProjectSettings/ProjectVersion.txt`) is
built for WebGL in batch mode with your own Unity Editor:

- The editor is the one set in `UNITY` (path to the Unity executable or its
  install folder), else the Unity Hub install of exactly the version in
  `ProjectVersion.txt` (default Hub locations and a custom Hub install path),
  else `Unity` on `PATH`. The **WebGL Build Support** module must be
  installed. When something is missing the Wizard prints the Unity Hub steps
  (including a `unityhub://` link for the exact version) and, if the project
  already has a WebGL build, publishes that one instead.
- The build runs in a scratch copy of the project, with a small build script
  (`Assets/OriginGameWizard/Editor/`) added only to that copy. It builds the
  scenes enabled in Build Settings. Your project is never changed.
- The first build of a project imports every asset and can take a long time.
  The time limit is 180 minutes (`ORIGINGAME_UNITY_TIMEOUT_MINUTES`). To make
  later builds fast, the Wizard keeps the copy's `Library/` import cache in
  `~/.origingame/unity/<project>/Library` (seeded from your project's own
  `Library/` on the first run). It can be large; delete
  `~/.origingame/unity/` at any time to reclaim the space.
- Unity needs an activated license in batch mode; an unlicensed editor, a
  compile error or a failed build is reported with the lines from the Unity
  log that explain it.
- Your source is saved without `Library/`, `Temp/`, `Logs/`, `obj/`, builds
  or `UserSettings/`, even when the project has no `.gitignore`.

**A native build** (for example `My Game.exe` with `My Game_Data/` and
`UnityPlayer.dll`) cannot be published, since OriginGame publishes Web builds
only. The Wizard looks for the project it came from: the folder itself, its
parents (up to four levels) and their subfolders. It builds that project
instead. When there is none, it says what it found and how to export for the
Web in that engine.

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
- the source uploaded to your private repository is not sent to any model beyond the digest above.

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
instead of the stored sign-in, never written to disk), `GODOT` (path to the
Godot editor), `UNITY` (path to the Unity Editor), `ORIGINGAME_UNITY_TIMEOUT_MINUTES`
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
{"ok":true,"action":"created","gameId":"…","slug":"…","version":1,"releaseId":"…","playUrl":"…","portalUrl":"…",
 "readiness":{"status":"ready"},"warnings":[],"engine":"threejs","family":null,"stageSha256":"…","rulesVersion":"…","adaptations":["…"],
 "usage":{"sessionId":"pak_…","quota":1000000,"promptTokens":0,"completionTokens":0,"chatCalls":3,"imageCalls":5,"models":["…"]},
 "source":{"repositoryId":"…","checkpointId":"…"},
 "workspace":{"kind":"worktree","path":"…/.origingame/worktrees/…","branch":"origingame/publish","base":"…",
  "commits":[{"sha":"…","message":"origingame: adapt for OriginGame"}],"review":"git diff HEAD...origingame/publish","merge":"git merge origingame/publish"},
 "integration":{"applied":true,"files":["game.js","og-player.js (new)"]}}
{"ok":false,"error":{"code":"build_failed","message":"…"}}
```

Error codes: `not_logged_in`, `session_refused`, `detect_failed`, `build_failed`,
`adapt_failed`, `artwork_failed`, `upload_failed`, `source_failed`, `publish_failed`,
`readiness_failed` (with `error.readiness`), `rules_unavailable`, `aigcc_refused`, `aborted`,
`invalid_arguments`. Exit code `0` on success, `130` when cancelled, `1` otherwise.
`usage.quota` is the run's budget cap, not what it spent.
`engine` is the catalog engine Portal received (`html`, `threejs`, `godot`, `unity`);
`family` is `{id, label}` for the engine or framework the files showed
(`{"id":"construct3","label":"Construct 3"}`), or `null`.
`source` is `{repositoryId, checkpointId, commit, createdRepository, files, bytes,
committed, deleted, lfsObjects, withheld}`, or `null` with `--no-source`.
`workspace` is the worktree (as above) or `{"kind":"copy","path":"…"}` outside Git.
`integration` is `{applied: false, reason}` when it was turned off, impossible
(no web source) or dropped after a failed readiness check.

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
contracts, on the fixture projects in `fixtures/` (plain pages, npm builds,
Godot, Unity and other engines' exports, native builds), with a stand-in Unity
Editor (`test/fake-unity.mjs`), and write
`test-artifacts/e2e-report.json` plus the chosen artwork. Set
`WIZARD_RULES_DIR=<platform>/packages/game-knowledge/production/wizard` to run
them against the real rules and prompts.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

MIT © OriginGame

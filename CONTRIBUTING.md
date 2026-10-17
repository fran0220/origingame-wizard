# Contributing

Thanks for helping. Bug reports with a small project that reproduces the
problem are the most useful contribution: include the command, the `--json`
output (it contains no credentials) and the project's file tree.

## Setup

```sh
npm install
npm test
```

Node 20.12 or newer. TypeScript is strict and compiled with `tsc`; there is no
bundler. Runtime dependencies are deliberately few (`@clack/prompts`,
`picocolors`, and the pure-JS `pngjs` / `jpeg-js` for artwork); a new runtime
dependency needs a reason in the pull request. No native modules, no telemetry
SDKs.

## Where things live

- `src/detect.ts`: deterministic project detection (pure function).
- `src/build.ts`, `src/stage.ts`: scratch-copy builds and the staged copy.
- `src/findings.ts`, `src/adapt.ts`: deterministic checks and adaptations.
- `src/digest.ts`, `src/secrets.ts`: what the model may see.
- `src/model.ts`, `src/tasks.ts`: model calls and their JSON contracts.
- `src/artwork.ts`, `src/image.ts`: cover and poster.
- `src/portal.ts`: uploads and publication.
- `src/deploy.ts`: the flow.

The prompts and adaptation rules are **not** in this repository. Their single
source is the OriginGame platform repository
(`packages/game-knowledge/production/wizard/`), served at
`/wizard/v1/rules.json`. Change them there; never add a bundled copy here.

## Tests

Prefer end-to-end tests: `test/e2e.test.mjs` runs the built CLI against the
fake platform in `test/fake-platform.mjs` and asserts what the CLI actually
did (its JSON result, the files and fields the platform received, the project
tree before and after). Add a unit test only for a behavior those cannot
reach (tricky detector trees, the secret scanner), and write down the ways the
unit can fail before writing it. Before trusting a new test, break the code it
covers and confirm it fails. Never read source text in a test.

## Pull requests

Keep changes small and focused, describe the user-visible effect, and run
`npm test`. The project directory must stay byte-identical after a run without
`--integrate`; the end-to-end tests check it.

## Releases

Maintainers bump `version` in `package.json` on main and push a `vX.Y.Z` tag.
`.github/workflows/release.yml` runs the tests and publishes to npm with
provenance through npm trusted publishing; no npm token is stored in the
repository. The platform pins an exact version (Agent Server's
`WIZARD_COMMAND`, the E2B templates), so a release reaches threads only when
the platform moves its pin.

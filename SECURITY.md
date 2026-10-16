# Security

## Reporting a vulnerability

Please report security issues privately with GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability). Do not open
a public issue. Include the version (`npx origingame --version`), what you did
and what you observed. We acknowledge reports within three working days.

## What this tool is trusted with

- **Device credential** (`og-…`): stored in `~/.origingame/credentials.json`
  with mode `0600`; revocable from the Devices page of your OriginGame account
  or with `npx origingame logout`.
- **Wizard session** (`ogp-…`): issued per run, held only in memory, at most
  30 minutes, restricted to the Wizard model allowlist and a per-run budget,
  revoked when the run ends.
- **Publish delegation** (`ogd-…`, sandbox mode only): read from the
  `--credentials-file`, which is deleted immediately after reading.

None of these is ever printed, logged, written into the project, sent to a
host other than the configured platform origin, or passed to your build
commands. Generated images are downloaded without credentials.

## Security model

All limits (who may publish, model allowlist, budget, expiry, upload size and
content checks, release ownership and revisions) are enforced by the
OriginGame services, not by this client. A modified client cannot raise them.
Reports about bypassing a server-side limit are in scope and welcome.

The secret scanner (`src/secrets.ts`) keeps credential files out of the
upload and out of the model context, and keeps files with credential-looking
lines out of the model context. It is a safety net, not a guarantee: keep
secrets out of game builds.

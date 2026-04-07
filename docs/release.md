# Desktop Release Runbook

This is the actual end-to-end process for shipping a new Electron desktop build of `bluedoor`.

This flow spans three repos:

1. `bluedoor-desktop`
   The Electron shell, packaging, signing, notarization, and GitHub Release assets.
2. `bluedoor`
   The CLI that the Electron app bundles and runs.
3. `bluedoor-web`
   The website download links on `https://bluedoor.sh`.

## Use This Runbook When

Follow this runbook when any of these are true:

1. the change touches `src/main.js`, `src/preload.js`, `src/index.html`, `src/cli-updater.js`, packaging, signing, or installers
2. the current desktop app cannot recover by only pulling a new npm CLI package
3. you want a new installer on `bluedoor.sh`
4. you want to bump the bundled fallback CLI version inside the app

If the change is CLI-only and the released Electron shell is already healthy, do not cut a new desktop build first. Publish the CLI to npm instead:

- `../bluedoor/docs/cli-release.md`

## Release Shape

A real desktop release currently has 10 steps:

1. decide whether this is a CLI-only release or a desktop release
2. update versions and bundled dependencies
3. run CLI preflight and desktop smoke tests
4. test the updater path from an already-installed app
5. commit and tag `bluedoor-desktop`
6. let GitHub Actions build and publish the installers
7. verify the GitHub Release assets
8. update website download links in `bluedoor-web`
9. deploy `bluedoor-web` to production
10. perform fresh-install and upgrade verification from the public website

That is the full public ship path today. macOS now has a production-wired Electron binary auto-update path through GitHub Releases, but the website update is still part of the public distribution flow and Windows is still manual.

## Files To Check Before Tagging

### In `bluedoor-desktop`

- `package.json`
  - bump the desktop app `version`
  - if needed, bump the bundled CLI dependency `"bluedoor": "^x.y.z"`
- `package-lock.json`
  - make sure it reflects the new `package.json`
- `src/cli-updater.js`
  - if the release changes cached CLI behavior, confirm the logic and log messages are current
- `.github/workflows/release.yml`
  - verify the CI release path still matches the intended platforms and secrets
- `electron-builder.config.js`
  - verify targets, publish provider, signing options, and asset expectations

### In `bluedoor`

- publish the CLI first if the desktop release depends on a new npm package
- if the installer should include a newer fallback CLI, make sure that version is already live on npm before rebuilding `bluedoor-desktop`

### In `bluedoor-web`

- `blog/src/lib/desktop-downloads.ts`
  - update the live download URLs after the new release assets exist on GitHub

## Version Audit

Before releasing, check for stale manual version strings:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-desktop
rg -n "0\\.[0-9]+\\.[0-9]+" . --glob '!node_modules/**' --glob '!dist/**'
```

Also confirm the website points at the intended versions:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-web
sed -n '1,120p' blog/src/lib/desktop-downloads.ts
```

## CI Secrets

The tag-triggered release workflow depends on these GitHub secrets.

### Required for all releases

- `GH_TOKEN`

### macOS signing and notarization

- `MAC_CERTIFICATE_P12`
- `MAC_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_PASSWORD`
- `APPLE_TEAM_ID`

### Windows signing

- `SSL_COM_MODE`
- `SSL_COM_USERNAME`
- `SSL_COM_PASSWORD`
- `SSL_COM_TOTP_SECRET`

If the Windows job fails at certificate load, the first thing to check is whether those SSL.com secrets are empty or stale.

## Preflight

### 1. Validate the CLI side first

From the CLI repo:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor
pnpm release:check
pnpm dev:desktop
```

Manual checks:

1. login works
2. home screen renders
3. chat works
4. watchlist works
5. portfolio view or banner changes render correctly
6. keyboard input, resize, scrolling, and copy behavior still work inside the Electron shell

If the desktop release depends on a new npm CLI package, publish that first and verify it:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor/packages/cli
npm publish --access public --tag latest
npm view bluedoor version
npm dist-tag ls bluedoor
```

### 2. Validate the desktop repo

From the desktop repo:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-desktop
npm install
npm start
```

Manual checks:

1. app launches cleanly
2. the correct bundled CLI version boots
3. app relaunch still works
4. desktop logs remain clean enough to diagnose failures

### 2a. Local mac binary updater smoke test

Before cutting a real mac release, you can do a disposable updater test against the current public GitHub Release.

From `bluedoor-desktop`:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-desktop
scripts/local-mac-updater-smoke.sh <older_version>
```

Example:

```bash
scripts/local-mac-updater-smoke.sh 0.1.4
```

That helper:

1. copies the repo into `/tmp/bluedoor-desktop-updater-test`
2. rewrites the app version to the older version you pass in
3. installs dependencies with Node 20
4. builds an arm64-only packaged mac app
5. opens that packaged app
6. tails `~/.bluedoor/desktop.log`

Expected evidence:

1. `Binary updater: checking for updates (app v<older_version>)`
2. `Binary updater: update available <older_version> -> <public release version>`

This helper is intentionally arm64-only to keep local disk usage reasonable. It is for updater validation, not full release artifact validation.

### 3. Test the updater path explicitly

This is required whenever the release touches CLI update behavior or depends on a newly published npm CLI.

Test with an already-installed public app:

1. install or keep the prior public desktop build
2. publish the new CLI to npm if needed
3. launch the prior desktop app and let it detect the new CLI
4. fully quit the app
5. relaunch and confirm the cached CLI boots successfully instead of falling into an exit loop or flicker

This exact path has failed before. Do not skip it.

## Build And Release

From `bluedoor-desktop`:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-desktop
git status
git add package.json package-lock.json .github/workflows/release.yml electron-builder.config.js src docs README.md
git commit -m "Release vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

Tagging `vX.Y.Z` triggers:

- `.github/workflows/release.yml`

That workflow currently:

1. builds and publishes macOS assets
2. builds and publishes Windows assets
3. uploads to GitHub Releases through `electron-builder`

Monitor the release run:

```bash
gh run list -R bluedoor-ai/bluedoor-desktop --workflow release.yml --limit 5
gh run watch -R bluedoor-ai/bluedoor-desktop
```

## Verify The GitHub Release

After CI finishes, verify the release is public and not draft:

```bash
gh release view vX.Y.Z -R bluedoor-ai/bluedoor-desktop --json isDraft,isPrerelease,publishedAt,tagName,url,assets
```

Expected macOS assets:

1. `bluedoor-X.Y.Z-arm64.dmg`
2. `bluedoor-X.Y.Z.dmg`
3. `bluedoor-X.Y.Z-arm64-mac.zip`
4. `bluedoor-X.Y.Z-mac.zip`
5. `latest-mac.yml`

Expected Windows assets, when the signing path is healthy:

1. `bluedoor-Setup-X.Y.Z.exe`
2. `bluedoor-X.Y.Z-portable.exe`
3. `latest.yml`

Confirm the direct URLs return `200`:

```bash
curl -I -L --silent https://github.com/bluedoor-ai/bluedoor-desktop/releases/download/vX.Y.Z/bluedoor-X.Y.Z-arm64.dmg | head
curl -I -L --silent https://github.com/bluedoor-ai/bluedoor-desktop/releases/download/vX.Y.Z/bluedoor-X.Y.Z.dmg | head
```

## Update The Website

The public website does not discover new desktop releases automatically yet. Update it manually after the GitHub Release assets exist.

From `bluedoor-web`:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-web
```

Update:

- `blog/src/lib/desktop-downloads.ts`

That file drives:

1. homepage download buttons
2. footer download buttons
3. `/download`

Then build and deploy:

```bash
cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-web/blog
npm run build

cd /Users/samcrombie/Documents/bluedoor-ai/bluedoor-web
vercel --prod --yes
```

Verify production HTML:

```bash
curl -L --silent https://bluedoor.sh/download | rg "bluedoor-desktop/releases/download|workers.dev|0\\.[0-9]+\\.[0-9]+"
```

Expected result:

1. new GitHub Release URLs are present
2. stale `workers.dev` links are absent
3. the intended mac and Windows versions appear

## Public Verification

The release is not done until both of these pass:

1. fresh install from `https://bluedoor.sh/download`
2. upgrade path from the previous public desktop release

Minimum post-release checks:

1. download the installer from the live website
2. install it on a clean machine or clean user account
3. launch and confirm the bundled CLI boots
4. if the app should pick up a newer npm CLI, relaunch and confirm the cached CLI boots cleanly
5. confirm there is no fast open-close flicker on launch

## Current Constraints

These are true today and should be kept in mind when releasing:

1. macOS packaged builds can now self-update from GitHub Releases through `electron-updater`
2. Windows binary auto-update is still not wired and should be treated as manual distribution for now
3. the CLI inside the app does self-update from npm through `src/cli-updater.js`
4. a broken updater or runtime path in the Electron shell cannot be repaired by npm alone
5. shipping a desktop-shell fix still requires a new desktop build, and the website should still be updated to point at the new installer

## Troubleshooting

### Fresh install or relaunch flickers and exits

Look at:

- `src/main.js`
- `src/cli-updater.js`
- `~/Desktop/bluedoor-electron.log`
- `~/.bluedoor/cli-cache`

The likely failure boundary is:

1. bundled CLI works
2. cached npm CLI is selected on relaunch
3. cached CLI exits immediately
4. app appears to flash and disappear

### Windows CI fails before packaging

Check:

1. SSL.com secrets are populated in GitHub Actions
2. `Load Windows code signing certificate` actually loads a code-signing cert
3. `WIN_CERTIFICATE_SHA1` and `WIN_PUBLISHER_NAME` are exported into the job environment

### Website still serves the old installer

Check:

1. `blog/src/lib/desktop-downloads.ts`
2. the Vercel production deploy actually completed
3. `https://bluedoor.sh/download` contains the new GitHub Release URLs

## Related Docs

- `../CLAUDE.md`
- `../../bluedoor/docs/cli-release.md`

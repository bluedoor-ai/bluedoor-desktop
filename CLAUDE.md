# Bluedoor Desktop

Electron wrapper for the bluedoor CLI. Cross-platform (macOS, Windows).

Start with:

- `docs/release.md` — end-to-end desktop release runbook across `bluedoor-desktop`, `bluedoor`, and `bluedoor-web`

## Before You Start

1. `git pull origin main`
2. `npm install` (if deps changed — triggers native module rebuild)
3. `git log --oneline -15` to see recent work

## Tech Stack

- Electron 35, vanilla JS (no framework)
- xterm.js for terminal rendering
- node-pty for PTY spawning (macOS/Linux), child_process pipes (Windows)
- electron-builder for packaging and GitHub Release publishing
- Bundles the `bluedoor` npm package, with self-updating CLI mechanism

## Structure

```
src/
├── main.js          # Main process: window management, PTY spawning
├── preload.js       # IPC bridge between main and renderer
├── cli-updater.js   # Downloads newer CLI versions from npm to ~/.bluedoor/cli-cache/
└── index.html       # Renderer: xterm.js terminal + sync bridge
```

## Commands

```bash
npm install          # also runs electron-builder install-app-deps
npm start            # launch dev mode (electron .)
npm run dist:mac     # build macOS (.dmg + .zip, arm64 + x64)
npm run dist:win     # build Windows (.exe + portable)
npm run publish:all  # build + publish macOS + Windows to GitHub Releases
```

## Key Patterns

- **Sync bridge**: Buffers output between DEC mode 2026 markers (BSU/ESU) for flicker-free rendering. Disabled on Windows (ConPTY mangles sequences).
- **Platform differences**: macOS gets custom titlebar with traffic lights; Windows uses native titlebar. macOS uses node-pty; Windows uses pipes.
- **CLI updates**: On launch, checks npm for newer `bluedoor` versions. Downloads tarball to `~/.bluedoor/cli-cache/{version}/` and hydrates a local `node_modules` tree beside the cached CLI before use.
- **Binary auto-update**: macOS packaged builds now check GitHub Releases for newer desktop versions via `electron-updater`. Windows binary auto-update is not wired yet.
- **Logging**: Dual output to console + `~/Desktop/bluedoor-electron.log`. Early crash logging before app.ready.
- **macOS signing**: Hardened runtime + notarization via `scripts/notarize.js`.

## CI/CD

`.github/workflows/release.yml` — Triggered by git tags (v*). Builds on macOS and Windows runners. Publishes to GitHub Releases. Node.js 20.

## Environment Variables

No `.env` needed for basic dev. For distribution builds:
- `GH_TOKEN` — GitHub token for publishing releases
- `APPLE_ID`, `APPLE_ID_PASSWORD`, `APPLE_TEAM_ID` — macOS notarization (CI only)
- `SSL_COM_MODE`, `SSL_COM_USERNAME`, `SSL_COM_PASSWORD`, `SSL_COM_TOTP_SECRET` — Windows code signing via SSL.com eSigner CKA (CI only)

## Before Committing

Run `npm start` to verify the app launches. No automated test suite — manual smoke test only.

## App Config

- App ID: `com.bluedoor.desktop`
- Default window: 1200x800, min 700x500
- Terminal: SF Mono font, 16px, dark theme (#0a0a0a), 5000 line scrollback
- ASAR disabled for debugging

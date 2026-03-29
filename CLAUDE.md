# Bluedoor Desktop

Electron wrapper for the bluedoor CLI. Cross-platform (macOS, Windows, Linux).

## Tech Stack

- Electron 35, vanilla JS (no framework)
- xterm.js for terminal rendering
- node-pty for PTY spawning (macOS/Linux), child_process pipes (Windows)
- electron-builder for packaging, electron-updater for auto-updates
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
npm run dist:linux   # build Linux (.AppImage + .deb)
npm run publish:all  # build + publish all platforms to GitHub Releases
```

## Key Patterns

- **Sync bridge**: Buffers output between DEC mode 2026 markers (BSU/ESU) for flicker-free rendering. Disabled on Windows (ConPTY mangles sequences).
- **Platform differences**: macOS gets custom titlebar with traffic lights; Windows/Linux use native titlebar. macOS/Linux use node-pty; Windows uses pipes.
- **CLI updates**: On launch, checks npm for newer `bluedoor` versions. Downloads tarball to `~/.bluedoor/cli-cache/{version}/`. Uses `NODE_PATH` for native deps.
- **Logging**: Dual output to console + `~/Desktop/bluedoor-electron.log`. Early crash logging before app.ready.
- **macOS signing**: Hardened runtime + notarization via `scripts/notarize.js`.

## CI/CD

`.github/workflows/release.yml` — Triggered by git tags (v*). Builds on macOS, Windows, Linux runners. Publishes to GitHub Releases. Node.js 20.

## App Config

- App ID: `com.bluedoor.desktop`
- Default window: 1200x800, min 700x500
- Terminal: SF Mono font, 16px, dark theme (#0a0a0a), 5000 line scrollback
- ASAR disabled for debugging

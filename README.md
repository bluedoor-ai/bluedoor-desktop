# bluedoor-desktop

Electron wrapper for the `bluedoor` CLI.

## Start Here

- [`docs/release.md`](./docs/release.md)
  - end-to-end desktop release flow, including CLI coordination, CI secrets, website updates, and public verification
- [`CLAUDE.md`](./CLAUDE.md)
  - repo orientation, commands, and architecture notes

## Commands

```bash
npm install
npm start
npm run dist:mac
npm run dist:win
scripts/local-mac-updater-smoke.sh 0.1.4
```

## Release Model

The desktop app bundles a fallback CLI and also checks npm for newer `bluedoor` CLI versions at runtime.

Important:

1. CLI releases usually ship through npm without a new Electron build
2. desktop-shell fixes require a new Electron release
3. the public website download links must be updated after a new desktop GitHub Release is published

const { app, BrowserWindow, ipcMain, shell, globalShortcut, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { autoUpdater } = require('electron-updater');
const { getCliEntryPoint, checkForUpdateInBackground, invalidateCachedVersion } = require('./cli-updater');

// GPU flags — must be set before app.ready
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-partial-raster');

// --- Single instance lock ---
// Prevent multiple instances from running. If a second instance launches,
// focus the existing window instead.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

const IS_DEV = !app.isPackaged;
const MAC_BINARY_AUTO_UPDATE_ENABLED = app.isPackaged && process.platform === 'darwin';
const LOG_DIR = path.join(os.homedir(), '.bluedoor');
const LOG_FILE = path.join(LOG_DIR, 'desktop.log');

let mainWindow;
let ptyProcess;
let launchAttemptId = 0;
let binaryUpdateCheckStarted = false;
let binaryUpdatePromptVisible = false;
let lastLoggedDownloadBucket = -1;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  // Resolve app icon — use .ico on Windows, .png on Linux, .icns on macOS
  let iconPath;
  if (isWin) {
    iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  } else if (isMac) {
    iconPath = path.join(__dirname, '..', 'assets', 'icon.icns');
  } else {
    iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  }

  const windowOpts = {
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0a0a0a',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  };

  if (isMac) {
    windowOpts.titleBarStyle = 'hiddenInset';
    windowOpts.trafficLightPosition = { x: 12, y: 12 };
  } else if (isWin) {
    // Custom frameless window with overlay title bar controls (Win 10+)
    windowOpts.titleBarStyle = 'hidden';
    windowOpts.titleBarOverlay = {
      color: '#0a0a0a',
      symbolColor: '#e0e0e0',
      height: 38,
    };
  }

  mainWindow = new BrowserWindow(windowOpts);

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    log('Page loaded');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    killPty();
  });
}

async function captureScreenshot(label) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const image = await mainWindow.webContents.capturePage();
  if (image.isEmpty()) return;
  const pngBuffer = image.toPNG();
  const filepath = path.join(os.homedir(), 'Desktop', `bluedoor-electron-${label}.png`);
  fs.writeFileSync(filepath, pngBuffer);
  log(`Screenshot saved: ${filepath}`);
}

function killPty() {
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch {}
    ptyProcess = null;
  }
}

async function showUpdateDialog(options) {
  if (binaryUpdatePromptVisible) {
    log(`Skipping update dialog while another prompt is visible: ${options.title}`);
    return { response: 1 };
  }

  binaryUpdatePromptVisible = true;
  try {
    return await dialog.showMessageBox(mainWindow || undefined, options);
  } finally {
    binaryUpdatePromptVisible = false;
  }
}

function setupBinaryAutoUpdater() {
  if (!MAC_BINARY_AUTO_UPDATE_ENABLED) {
    log(`Binary auto-update disabled (packaged=${app.isPackaged}, platform=${process.platform})`);
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log(`Binary updater: checking for updates (app v${app.getVersion()})`);
  });

  autoUpdater.on('update-available', async (info) => {
    log(`Binary updater: update available ${app.getVersion()} -> ${info.version}`);

    const result = await showUpdateDialog({
      type: 'info',
      buttons: ['Download Update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Available',
      message: `bluedoor ${info.version} is available.`,
      detail: 'Download the new desktop build now and install it after the app closes.',
    });

    if (result.response !== 0) {
      log(`Binary updater: user deferred download for v${info.version}`);
      return;
    }

    try {
      log(`Binary updater: downloading v${info.version}`);
      lastLoggedDownloadBucket = -1;
      await autoUpdater.downloadUpdate();
    } catch (error) {
      log(`Binary updater: download failed for v${info.version}: ${error.message}`);
      await showUpdateDialog({
        type: 'error',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Update Download Failed',
        message: `Failed to download bluedoor ${info.version}.`,
        detail: error.message,
      });
    }
  });

  autoUpdater.on('update-not-available', (info) => {
    log(`Binary updater: no update available (current=${app.getVersion()}, latest=${info?.version || 'unknown'})`);
  });

  autoUpdater.on('download-progress', (progress) => {
    const bucket = Math.floor(progress.percent / 10);
    if (bucket <= lastLoggedDownloadBucket) return;
    lastLoggedDownloadBucket = bucket;
    log(`Binary updater: download ${Math.round(progress.percent)}% (${Math.round(progress.bytesPerSecond)} B/s)`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    log(`Binary updater: update downloaded v${info.version}`);

    const result = await showUpdateDialog({
      type: 'info',
      buttons: ['Restart and Install', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: `bluedoor ${info.version} is ready to install.`,
      detail: 'Restart now to apply the desktop update. If you wait, it will install after you quit the app.',
    });

    if (result.response !== 0) {
      log(`Binary updater: user deferred install for v${info.version}`);
      return;
    }

    log(`Binary updater: restarting to install v${info.version}`);
    setImmediate(() => {
      autoUpdater.quitAndInstall(false, true);
    });
  });

  autoUpdater.on('error', (error) => {
    log(`Binary updater: ${error?.message || String(error)}`);
  });
}

function checkForBinaryUpdateInBackground() {
  if (!MAC_BINARY_AUTO_UPDATE_ENABLED) {
    return;
  }

  if (binaryUpdateCheckStarted) {
    log('Binary updater: check already started for this launch');
    return;
  }

  binaryUpdateCheckStarted = true;
  setTimeout(() => {
    log('Binary updater: starting background check');
    autoUpdater.checkForUpdates().catch((error) => {
      log(`Binary updater: check failed: ${error.message}`);
    });
  }, 10000);
}

// --- Node.js resolution (Windows) ---

function findNodeExe() {
  if (process.platform !== 'win32') return null;

  const candidates = [
    // 1. Standard Node.js installer location (preferred — native modules match)
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
    // 2. nvm-windows
    path.join(process.env.NVM_SYMLINK || '', 'node.exe'),
    // 3. Bundled Node.js (fallback for users without Node installed)
    path.join(process.resourcesPath || '', 'node', 'node.exe'),
    path.join(__dirname, '..', 'node', 'node.exe'),
  ];

  // Also check PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (dir.toLowerCase().includes('nodejs') || dir.toLowerCase().includes('node')) {
      candidates.push(path.join(dir, 'node.exe'));
    }
  }

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {}
  }

  return null;
}

// --- CLI resolution ---

function getBundledCliPath() {
  // In packaged app, asarUnpack puts modules in app.asar.unpacked/
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'bluedoor', 'dist', 'index.js'),
  ];

  // Also check the unpacked path (for packaged builds)
  const unpacked = __dirname.replace('app.asar', 'app.asar.unpacked');
  if (unpacked !== __dirname) {
    candidates.unshift(path.join(unpacked, '..', 'node_modules', 'bluedoor', 'dist', 'index.js'));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getAppNodeModules() {
  // Prefer unpacked node_modules for native module access
  const unpacked = __dirname.replace('app.asar', 'app.asar.unpacked');
  const unpackedNM = path.join(unpacked, '..', 'node_modules');
  if (unpacked !== __dirname && fs.existsSync(unpackedNM)) {
    return unpackedNM;
  }
  return path.join(__dirname, '..', 'node_modules');
}

function spawnPty(cols, rows) {
  const bundledPath = getBundledCliPath();
  const appNodeModules = getAppNodeModules();
  const cli = getCliEntryPoint(bundledPath, appNodeModules);

  if (!cli.entryPoint) {
    log('ERROR: Could not find any bluedoor CLI');
    return;
  }

  log(`Spawning bluedoor v${cli.version} (${cli.source}): ${cli.entryPoint}`);
  const startedAt = Date.now();
  const attemptId = ++launchAttemptId;

  // Build NODE_PATH so the cached CLI can find native deps from the app bundle
  const nodePath = cli.nodeModulesPath
    ? `${cli.nodeModulesPath}${path.delimiter}${process.env.NODE_PATH || ''}`
    : process.env.NODE_PATH || '';

  const isWin = process.platform === 'win32';

  const ptyOpts = {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: {
      ...process.env,
      NODE_PATH: nodePath,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      BLUEDOOR_DESKTOP: '1',
    },
  };

  // On Windows, ConPTY is used. Ensure it's enabled (default on Win10 1809+).
  if (isWin) {
    ptyOpts.useConpty = true;
  }

  // Determine the Node.js executable and args for spawning the CLI.
  // On Windows, ELECTRON_RUN_AS_NODE + ConPTY is broken — Electron's console
  // output doesn't attach to ConPTY's pseudo console, resulting in zero data.
  // Instead, use the system Node.js. On macOS/Linux, the Electron node
  // runtime works fine with PTY.
  let spawnFile, spawnArgs;

  // Dev mode: use system Node.js to avoid Electron ABI mismatch with
  // native modules (better-sqlite3, etc.) compiled for system Node.
  if (cli.source === 'dev') {
    const { execSync } = require('child_process');
    try {
      spawnFile = execSync('which node', { encoding: 'utf-8' }).trim();
    } catch {
      spawnFile = 'node';
    }
    spawnArgs = [cli.entryPoint];
    delete ptyOpts.env.ELECTRON_RUN_AS_NODE;
    log(`Dev mode: using system Node.js: ${spawnFile}`);
  } else if (isWin) {
    const nodeExe = findNodeExe();
    if (nodeExe) {
      spawnFile = nodeExe;
      spawnArgs = [cli.entryPoint];
      // When using system Node.js, don't set NODE_PATH to Electron-rebuilt
      // native modules — they have the wrong ABI. The CLI's own npm-installed
      // native deps (in node_modules) will be compatible with system Node.
      // Only set NODE_PATH if the cached CLI needs access to shared deps.
      if (cli.nodeModulesPath) {
        // Don't override — system Node will use its own module resolution
        log(`Using system Node.js: ${nodeExe} (native modules via CLI's own node_modules)`);
      } else {
        log(`Using system Node.js: ${nodeExe}`);
      }
    } else {
      spawnFile = process.execPath;
      spawnArgs = [cli.entryPoint];
      ptyOpts.env.ELECTRON_RUN_AS_NODE = '1';
      log('WARNING: No system Node.js found, falling back to Electron node (ConPTY may not work)');
    }
  } else {
    spawnFile = process.execPath;
    spawnArgs = [cli.entryPoint];
    ptyOpts.env.ELECTRON_RUN_AS_NODE = '1';
  }

  try {
    ptyProcess = pty.spawn(spawnFile, spawnArgs, ptyOpts);
  } catch (err) {
    log(`PTY spawn FAILED: ${err.message}`);
    return;
  }

  ptyProcess.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    log(`PTY exited with code ${exitCode}`);
    ptyProcess = null;

    const runtimeMs = Date.now() - startedAt;
    const shouldFallbackToBundled =
      attemptId === launchAttemptId &&
      cli.source === 'cached' &&
      exitCode !== 0 &&
      runtimeMs < 15000;

    if (shouldFallbackToBundled) {
      log(`Cached CLI v${cli.version} exited after ${runtimeMs}ms; invalidating cache and retrying bundled CLI`);
      invalidateCachedVersion(cli.version, log);
      spawnPty(cols, rows);
      return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', exitCode);
    }
  });

  // Check for CLI updates in the background (downloads for next launch)
  void checkForUpdateInBackground(cli.version, log);
}

// --- IPC handlers ---

ipcMain.on('terminal:input', (_event, data) => {
  if (ptyProcess) ptyProcess.write(data);
});

ipcMain.on('terminal:resize', (_event, { cols, rows }) => {
  if (ptyProcess) ptyProcess.resize(cols, rows);
});

ipcMain.on('terminal:ready', (_event, { cols, rows }) => {
  log(`terminal:ready received (${cols}x${rows})`);
  spawnPty(cols, rows);
});

ipcMain.on('terminal:restart', (_event, { cols, rows }) => {
  killPty();
  spawnPty(cols, rows);
});

ipcMain.handle('shell:openExternal', (_event, url) => shell.openExternal(url));

// --- App lifecycle ---

// When a second instance tries to launch, focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  log('App ready, creating window');
  setupBinaryAutoUpdater();
  createWindow();
  checkForBinaryUpdateInBackground();

  if (IS_DEV) {
    globalShortcut.register('F5', () => {
      captureScreenshot(`snap-${Date.now()}`).catch(e => log(e.message));
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killPty();
  // On macOS, apps conventionally stay open until Cmd+Q
  if (process.platform !== 'darwin') app.quit();
});

// Ensure PTY is killed on all exit paths
app.on('before-quit', () => {
  killPty();
});

app.on('will-quit', () => {
  killPty();
  globalShortcut.unregisterAll();
});

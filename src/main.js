const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// --- Early crash-proof logging (writes next to the exe) ---
const LOG_FILE = path.join(path.dirname(process.execPath), 'bluedoor-debug.log');
function earlyLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  console.log(line);
}

// On Windows with Parallels/network shares, __dirname can resolve to a UNC path
// (\\psf\Home\...) which Chromium can't load file:// URLs from. Use execPath
// (which has a drive letter) to compute paths instead. Only override for UNC paths
// — normal installs use __dirname which correctly resolves through ASAR.
const SRC_DIR = __dirname.startsWith('\\\\')
  ? path.join(path.dirname(process.execPath), 'resources', 'app', 'src')
  : __dirname;

earlyLog(`Starting bluedoor-desktop`);
earlyLog(`  platform=${process.platform} arch=${process.arch}`);
earlyLog(`  execPath=${process.execPath}`);
earlyLog(`  __dirname=${__dirname}`);
earlyLog(`  SRC_DIR=${SRC_DIR}`);
earlyLog(`  packaged=${app.isPackaged}`);

// Catch any top-level crashes
process.on('uncaughtException', (err) => {
  earlyLog(`UNCAUGHT EXCEPTION: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  earlyLog(`UNHANDLED REJECTION: ${reason}`);
});

// --- Load native module (node-pty) with error handling ---
let pty;
try {
  pty = require('node-pty');
  earlyLog('node-pty loaded OK');
} catch (err) {
  earlyLog(`node-pty FAILED TO LOAD: ${err.stack || err.message}`);
}

let cliUpdater;
try {
  cliUpdater = require('./cli-updater');
  earlyLog('cli-updater loaded OK');
} catch (err) {
  earlyLog(`cli-updater FAILED TO LOAD: ${err.stack || err.message}`);
}

// GPU flags — must be set before app.ready
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-partial-raster');

const IS_DEV = !app.isPackaged;
const IS_MAC = process.platform === 'darwin';
const SCREENSHOT_DIR = path.join(os.homedir(), 'Desktop');

let mainWindow;
let ptyProcess;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  try { fs.appendFileSync(path.join(SCREENSHOT_DIR, 'bluedoor-electron.log'), line + '\n'); } catch {}
}

function createWindow() {
  const windowOpts = {
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(SRC_DIR, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  };

  if (IS_MAC) {
    windowOpts.titleBarStyle = 'hiddenInset';
    windowOpts.trafficLightPosition = { x: 12, y: 12 };
  }

  mainWindow = new BrowserWindow(windowOpts);

  const htmlPath = path.join(SRC_DIR, 'index.html');
  log(`Loading HTML: ${htmlPath} (exists: ${fs.existsSync(htmlPath)})`);
  mainWindow.loadFile(htmlPath).catch(e => log(`loadFile FAILED: ${e.message}`));

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log(`Page load failed: ${errorCode} ${errorDescription}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('Page loaded successfully');
    if (IS_DEV) {
      setTimeout(() => {
        log('Taking 3s screenshot...');
        captureScreenshot('3s').catch(e => log(`Screenshot error: ${e.message}`));
      }, 3000);
      setTimeout(() => {
        log('Taking 10s screenshot...');
        captureScreenshot('10s').catch(e => log(`Screenshot error: ${e.message}`));
      }, 10000);
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Renderer crashed: ${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    log(`[renderer] ${message}`);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (ptyProcess) { ptyProcess.kill(); ptyProcess = null; }
  });
}

async function captureScreenshot(label) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    log('Screenshot skipped — no window');
    return;
  }
  const image = await mainWindow.webContents.capturePage();
  if (image.isEmpty()) {
    log('Screenshot captured but image is empty');
    return;
  }
  const pngBuffer = image.toPNG();
  const filepath = path.join(SCREENSHOT_DIR, `bluedoor-electron-${label}.png`);
  fs.writeFileSync(filepath, pngBuffer);
  log(`Screenshot saved: ${filepath} (${pngBuffer.length} bytes)`);
}

// --- CLI resolution ---

function getBundledCliPath() {
  const candidates = [
    path.join(SRC_DIR, '..', 'node_modules', 'bluedoor', 'dist', 'index.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getAppNodeModules() {
  return path.join(SRC_DIR, '..', 'node_modules');
}

function spawnPty(cols, rows) {
  const bundledPath = getBundledCliPath();
  const appNodeModules = getAppNodeModules();
  const cli = cliUpdater
    ? cliUpdater.getCliEntryPoint(bundledPath, appNodeModules)
    : { entryPoint: bundledPath, version: 'unknown', source: 'bundled', nodeModulesPath: null };

  if (!cli.entryPoint) {
    log('ERROR: Could not find any bluedoor CLI');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', '\r\n\x1b[31mCould not find bluedoor CLI\x1b[0m\r\n');
      mainWindow.webContents.send('terminal:exit', 1);
    }
    return;
  }

  log(`Spawning bluedoor v${cli.version} (${cli.source}): ${cli.entryPoint}`);

  // Build NODE_PATH so the cached CLI can find native deps from the app bundle
  const nodePath = cli.nodeModulesPath
    ? `${cli.nodeModulesPath}${path.delimiter}${process.env.NODE_PATH || ''}`
    : process.env.NODE_PATH || '';

  // --- Windows: use child_process.spawn with pipes (bypasses ConPTY entirely) ---
  if (process.platform === 'win32') {
    const { spawn: cpSpawn } = require('child_process');

    const child = cpSpawn(process.execPath, [cli.entryPoint], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: os.homedir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: nodePath,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '3',
        BLUEDOOR_DESKTOP: '1',
        COLUMNS: String(cols || 80),
        LINES: String(rows || 24),
      },
    });

    // Forward stdout and stderr to renderer
    let frameCount = 0;
    child.stdout.on('data', (data) => {
      const str = data.toString();
      // Log first 3 frames fully (preserving \n as LF, \r as CR) for layout debugging
      frameCount++;
      if (frameCount <= 3) {
        const escaped = str.replace(/\x1b/g, '\\e').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        log(`[FRAME-${frameCount}] len=${str.length} ${escaped.substring(0, 2000)}`);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:data', str);
      }
    });
    child.stderr.on('data', (data) => {
      const str = data.toString();
      log(`[pty-err] ${str.substring(0, 200).replace(/[\x00-\x1f]/g, '\u00b7')}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:data', str);
      }
    });

    child.on('exit', (code) => {
      log(`Child exited with code ${code}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:exit', code);
      }
    });

    child.on('error', (err) => {
      log(`Child error: ${err.message}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('terminal:data', `\r\n\x1b[31mFailed to start: ${err.message}\x1b[0m\r\n`);
        mainWindow.webContents.send('terminal:exit', 1);
      }
    });

    // Store reference for input forwarding and cleanup
    // Use a wrapper object that matches the pty interface
    ptyProcess = {
      write: (data) => { if (!child.killed) child.stdin.write(data); },
      resize: (newCols, newRows) => {
        // Send resize via IPC to child
        if (child.connected) {
          child.send({ type: 'resize', cols: newCols, rows: newRows });
        }
      },
      kill: () => { child.kill(); },
      pid: child.pid,
    };

    log(`[win-pipes] spawned pid=${child.pid}`);

    // Check for CLI updates in the background (downloads for next launch)
    if (cliUpdater) {
      void cliUpdater.checkForUpdateInBackground(cli.version, log);
    }

    return; // Skip the macOS pty.spawn path below
  }

  // --- macOS / Linux: use node-pty as before ---
  if (!pty) {
    log('ERROR: node-pty not available');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', '\r\n\x1b[31mnode-pty failed to load \u2014 see bluedoor-debug.log\x1b[0m\r\n');
      mainWindow.webContents.send('terminal:exit', 1);
    }
    return;
  }

  try {
    ptyProcess = pty.spawn(process.execPath, [cli.entryPoint], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: os.homedir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_PATH: nodePath,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        BLUEDOOR_DESKTOP: '1',
      },
    });

    log(`[pty] spawned pid=${ptyProcess.pid}`);
  } catch (err) {
    log(`PTY spawn FAILED: ${err.message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', `\r\n\x1b[31mFailed to start: ${err.message}\x1b[0m\r\n`);
      mainWindow.webContents.send('terminal:exit', 1);
    }
    return;
  }

  ptyProcess.onData((data) => {
    log(`[pty-out] ${data.substring(0, 200).replace(/[\x00-\x1f]/g, '\u00b7')}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    log(`PTY exited with code ${exitCode}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', exitCode);
    }
  });

  // Check for CLI updates in the background (downloads for next launch)
  if (cliUpdater) {
    void cliUpdater.checkForUpdateInBackground(cli.version, log);
  }
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
  if (ptyProcess) ptyProcess.kill();
  spawnPty(cols, rows);
});

ipcMain.handle('shell:openExternal', (_event, url) => shell.openExternal(url));
ipcMain.handle('debug:screenshot', async (_event, label) => captureScreenshot(label));

// --- App lifecycle ---

app.whenReady().then(() => {
  log('App ready, creating window');
  createWindow();

  if (IS_DEV) {
    globalShortcut.register('F5', () => captureScreenshot('manual').catch(e => log(e.message)));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  log('All windows closed, quitting');
  if (ptyProcess) ptyProcess.kill();
  app.quit();
});

const { app, BrowserWindow, ipcMain, shell, globalShortcut } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');

// GPU flags — must be set before app.ready
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('disable-partial-raster');

const IS_DEV = !app.isPackaged;
const SCREENSHOT_DIR = path.join(os.homedir(), 'Desktop');

let mainWindow;
let ptyProcess;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  // Also write to a log file we can read
  fs.appendFileSync(path.join(SCREENSHOT_DIR, 'bluedoor-electron.log'), line + '\n');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 12 },
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.on('did-finish-load', () => {
    log('Page loaded');
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

  mainWindow.webContents.on('console-message', (event) => {
    log(`[renderer] ${event.message}`);
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

function findBluedoorScript() {
  // Find the bundled bluedoor CLI entry point
  // In packaged app: inside app.asar or app.asar.unpacked
  // In dev mode: in node_modules
  const candidates = [
    path.join(__dirname, '..', 'node_modules', 'bluedoor', 'dist', 'index.js'),
    path.join(__dirname, '..', 'node_modules', '.bin', 'bluedoor'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function spawnPty(cols, rows) {
  // Use Electron's own Node.js to run the bundled bluedoor CLI.
  // ELECTRON_RUN_AS_NODE=1 makes the Electron binary behave as plain Node.js.
  // This means zero external dependencies — no Node.js, no npm, fully standalone.
  const bluedoorScript = findBluedoorScript();

  if (!bluedoorScript) {
    log('ERROR: Could not find bundled bluedoor CLI');
    return;
  }

  log(`Spawning bundled bluedoor: ${process.execPath} ${bluedoorScript}`);

  try {
    ptyProcess = pty.spawn(process.execPath, [bluedoorScript], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd: os.homedir(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        BLUEDOOR_DESKTOP: '1',
      },
    });
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', exitCode);
    }
  });
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
  if (ptyProcess) ptyProcess.kill();
  app.quit();
});

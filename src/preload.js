const { ipcRenderer } = require('electron');

// Expose platform so renderer can adjust UI (titlebar, etc.)
window.platform = process.platform;

// With contextIsolation off, we can attach directly to window
window.platform = process.platform;
window.terminal = {
  sendInput: (data) => ipcRenderer.send('terminal:input', data),
  ready: (cols, rows) => ipcRenderer.send('terminal:ready', { cols, rows }),
  resize: (cols, rows) => ipcRenderer.send('terminal:resize', { cols, rows }),
  restart: (cols, rows) => ipcRenderer.send('terminal:restart', { cols, rows }),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  screenshot: (label) => ipcRenderer.invoke('debug:screenshot', label),

  onData: (callback) => {
    ipcRenderer.on('terminal:data', (_event, data) => callback(data));
  },

  onExit: (callback) => {
    ipcRenderer.on('terminal:exit', (_event, exitCode) => callback(exitCode));
  },
};

/**
 * Downloads and bundles a portable Node.js for Windows distribution.
 * This is needed because ELECTRON_RUN_AS_NODE + ConPTY doesn't work,
 * so we spawn the CLI with a real node.exe instead.
 *
 * The node binary is placed in the 'node/' directory which gets included
 * in the app's resources via electron-builder extraResources.
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');

// Match the Node.js version to what the CLI expects (>=20)
const NODE_VERSION = '24.14.1';
const ARCH = process.env.npm_config_arch || 'x64';
const URL = `https://nodejs.org/dist/v${NODE_VERSION}/win-${ARCH}/node.exe`;
const DEST_DIR = path.join(__dirname, '..', 'node');
const DEST_FILE = path.join(DEST_DIR, 'node.exe');

if (fs.existsSync(DEST_FILE)) {
  console.log(`[bundle-node] node.exe already exists at ${DEST_FILE}`);
  process.exit(0);
}

console.log(`[bundle-node] Downloading Node.js v${NODE_VERSION} (${ARCH})...`);
console.log(`[bundle-node] URL: ${URL}`);

fs.mkdirSync(DEST_DIR, { recursive: true });

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const file = fs.createWriteStream(DEST_FILE);
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`[bundle-node] Saved to ${DEST_FILE}`);
        resolve();
      });
    }).on('error', reject);
  });
}

download(URL).catch(err => {
  console.error(`[bundle-node] Failed: ${err.message}`);
  process.exit(1);
});

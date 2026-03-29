/**
 * Post-build fix for Windows: rebuild native modules inside the packaged app
 * to match the bundled Node.js version (not Electron's).
 *
 * electron-builder's @electron/rebuild compiles native modules for Electron's
 * Node ABI, but on Windows the CLI runs under a real node.exe (bundled or system).
 * This script rebuilds better-sqlite3 in the unpacked output to match.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.platform !== 'win32') {
  console.log('[fix-native] Not Windows, skipping.');
  process.exit(0);
}

const distDir = path.join(__dirname, '..', 'dist', 'win-unpacked');
const unpackedNM = path.join(distDir, 'resources', 'app.asar.unpacked', 'node_modules');
const bs3Dir = path.join(unpackedNM, 'better-sqlite3');

if (!fs.existsSync(bs3Dir)) {
  console.log('[fix-native] better-sqlite3 not found in unpacked output, skipping.');
  process.exit(0);
}

// Find the bundled node.exe to determine target version
const bundledNode = path.join(distDir, 'resources', 'node', 'node.exe');
let targetVersion = process.version; // fallback to current
if (fs.existsSync(bundledNode)) {
  targetVersion = execSync(`"${bundledNode}" -e "process.stdout.write(process.version)"`, { encoding: 'utf-8' });
}

console.log(`[fix-native] Rebuilding better-sqlite3 for Node ${targetVersion}...`);

try {
  execSync('npx --yes prebuild-install || npx --yes node-gyp rebuild --release', {
    stdio: 'inherit',
    cwd: bs3Dir,
    env: {
      ...process.env,
      // Use system node-gyp with the right target
      npm_config_target: targetVersion.replace('v', ''),
      npm_config_arch: 'x64',
    },
  });
  console.log('[fix-native] better-sqlite3 rebuilt OK');
} catch (err) {
  console.error('[fix-native] WARNING: rebuild failed:', err.message);
  console.error('[fix-native] The app will still work if the user has Node.js installed.');
}

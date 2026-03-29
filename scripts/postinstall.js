/**
 * Platform-aware postinstall script for native module compilation.
 *
 * macOS/Linux: Rebuild ALL native modules for Electron (ELECTRON_RUN_AS_NODE works).
 * Windows:     Only rebuild node-pty for Electron. Other native modules (better-sqlite3,
 *              sharp, etc.) stay built for system Node.js because the CLI subprocess
 *              runs under system node.exe (Electron + ConPTY doesn't work together).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';

if (!isWin) {
  // macOS/Linux: standard Electron rebuild for all native modules
  console.log('[postinstall] Rebuilding all native modules for Electron...');
  execSync('npx electron-builder install-app-deps', { stdio: 'inherit' });
  process.exit(0);
}

// --- Windows-specific build ---
console.log('[postinstall] Windows detected — building native modules...');

// 1. Patch node-pty's binding.gyp to skip winpty (ConPTY-only, Windows 10+)
//    and disable Spectre mitigation (requires extra VS components).
const bindingGyp = path.join(__dirname, '..', 'node_modules', 'node-pty', 'binding.gyp');
if (fs.existsSync(bindingGyp)) {
  let content = fs.readFileSync(bindingGyp, 'utf-8');
  const originalContent = content;

  // Remove Spectre mitigation requirement
  content = content.replace("'SpectreMitigation': 'Spectre'", "'SpectreMitigation': 'false'");

  // Remove winpty target (broken GetCommitHash.bat + unnecessary on Win10+)
  content = content.replace(
    /\{\s*'target_name':\s*'pty',[\s\S]*?'libraries':\s*\[\s*'-lshlwapi'\s*\],?\s*\}/,
    "# winpty target removed — ConPTY-only build for Windows 10+"
  );

  if (content !== originalContent) {
    fs.writeFileSync(bindingGyp, content);
    console.log('[postinstall] Patched node-pty binding.gyp (ConPTY-only, no Spectre)');
  }
}

// 2. Rebuild node-pty for Electron.
//    Paths with spaces break node-gyp, so we rebuild in a temp directory if needed.
const projectRoot = path.join(__dirname, '..');
const hasSpaces = projectRoot.includes(' ');

if (hasSpaces) {
  // Copy node-pty + deps to a space-free temp path, rebuild there, copy back
  const tempDir = path.join('C:\\dev', '_bluedoor-rebuild-' + Date.now());
  const tempNM = path.join(tempDir, 'node_modules');

  console.log(`[postinstall] Path has spaces, using temp dir: ${tempDir}`);
  fs.mkdirSync(tempNM, { recursive: true });

  // Copy package.json and required modules
  fs.copyFileSync(path.join(projectRoot, 'package.json'), path.join(tempDir, 'package.json'));

  const modulesToCopy = ['node-pty', 'node-addon-api', 'node-gyp', '@electron/rebuild', 'electron'];
  for (const mod of modulesToCopy) {
    const src = path.join(projectRoot, 'node_modules', mod);
    if (fs.existsSync(src)) {
      execSync(`xcopy "${src}" "${path.join(tempNM, mod)}" /E /I /Q /Y`, { stdio: 'pipe' });
    }
  }

  // Also copy .bin for npx
  const binSrc = path.join(projectRoot, 'node_modules', '.bin');
  if (fs.existsSync(binSrc)) {
    execSync(`xcopy "${binSrc}" "${path.join(tempNM, '.bin')}" /E /I /Q /Y`, { stdio: 'pipe' });
  }

  try {
    execSync('npx @electron/rebuild -w node-pty', {
      stdio: 'inherit',
      cwd: tempDir,
    });

    // Copy rebuilt binaries back
    const buildDir = path.join(tempNM, 'node-pty', 'build');
    const destBuildDir = path.join(projectRoot, 'node_modules', 'node-pty', 'build');
    if (fs.existsSync(buildDir)) {
      execSync(`xcopy "${buildDir}" "${destBuildDir}" /E /I /Q /Y`, { stdio: 'pipe' });
      console.log('[postinstall] node-pty rebuilt for Electron (via temp dir)');
    }
  } finally {
    // Clean up temp dir
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
} else {
  // No spaces — rebuild directly
  try {
    execSync('npx @electron/rebuild -w node-pty', {
      stdio: 'inherit',
      cwd: projectRoot,
    });
    console.log('[postinstall] node-pty rebuilt for Electron');
  } catch (err) {
    console.error('[postinstall] WARNING: node-pty rebuild failed:', err.message);
    console.error('[postinstall] The prebuilt binaries may still work.');
  }
}

// 3. Build better-sqlite3 for system Node.js (not Electron).
//    This runs in the module's own directory to trigger its normal build.
const bs3Dir = path.join(projectRoot, 'node_modules', 'better-sqlite3');
if (fs.existsSync(bs3Dir)) {
  console.log('[postinstall] Building better-sqlite3 for system Node.js...');
  try {
    execSync('npx prebuild-install || npx node-gyp rebuild --release', {
      stdio: 'inherit',
      cwd: bs3Dir,
    });
    console.log('[postinstall] better-sqlite3 built OK');
  } catch (err) {
    console.error('[postinstall] WARNING: better-sqlite3 build failed:', err.message);
  }
}

console.log('[postinstall] Done!');

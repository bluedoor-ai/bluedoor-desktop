/**
 * Self-updating CLI manager.
 *
 * The Electron app bundles a CLI version as a fallback, but on each launch
 * checks npm for a newer version. If found, it downloads the tarball and
 * extracts it to ~/.bluedoor/cli-cache/{version}/. Before a cached version
 * is used, the app hydrates a local node_modules tree beside it from the
 * bundled app dependencies so ESM bare imports resolve correctly.
 *
 * This means CLI updates are automatic — no Electron rebuild needed.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { createGunzip } = require('zlib');
const tar = require('tar');

const CLI_CACHE_DIR = path.join(os.homedir(), '.bluedoor', 'cli-cache');
const STATE_FILE = path.join(CLI_CACHE_DIR, 'state.json');
const NPM_REGISTRY = 'https://registry.npmjs.org/bluedoor';
const CACHE_READY_MARKER = '.bluedoor-cache-ready';

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(CLI_CACHE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function getBundledNodeModuleRoots() {
  const roots = [];
  const packagedNodeModules = path.join(__dirname, '..', 'node_modules');
  if (fs.existsSync(packagedNodeModules)) {
    roots.push({ path: packagedNodeModules, overwrite: false });
  }

  const unpacked = __dirname.replace('app.asar', 'app.asar.unpacked');
  const unpackedNodeModules = path.join(unpacked, '..', 'node_modules');
  if (unpacked !== __dirname && fs.existsSync(unpackedNodeModules)) {
    roots.push({ path: unpackedNodeModules, overwrite: true });
  }

  return roots;
}

function hydrateCachedNodeModules(versionDir, log = () => {}) {
  const destRoot = path.join(versionDir, 'node_modules');
  const markerPath = path.join(destRoot, CACHE_READY_MARKER);
  if (fs.existsSync(markerPath)) {
    return true;
  }

  const roots = getBundledNodeModuleRoots();
  if (roots.length === 0) {
    throw new Error('No bundled node_modules roots found');
  }

  log(`Hydrating cached CLI dependencies for ${versionDir}...`);
  fs.mkdirSync(destRoot, { recursive: true });

  for (const root of roots) {
    for (const entry of fs.readdirSync(root.path)) {
      if (entry === '.bin') continue;
      const src = path.join(root.path, entry);
      const dest = path.join(destRoot, entry);
      if (!root.overwrite && fs.existsSync(dest)) continue;
      if (root.overwrite) {
        fs.rmSync(dest, { recursive: true, force: true });
      }
      copyRecursive(src, dest);
    }
  }

  fs.writeFileSync(markerPath, JSON.stringify({
    hydratedAt: new Date().toISOString(),
  }, null, 2));
  log('Cached CLI dependencies ready');
  return true;
}

/**
 * Returns the path to the best available CLI entry point.
 * Prefers: dev override → cached (latest) → bundled.
 *
 * Set BLUEDOOR_DEV_CLI to a path (e.g. ../bluedoor/packages/cli/dist/index.js)
 * to use a local dev build instead of the npm package.
 */
function getCliEntryPoint(bundledPath, appNodeModules) {
  // Dev override: point at local CLI build
  const devCli = process.env.BLUEDOOR_DEV_CLI;
  if (devCli) {
    const devPath = path.resolve(devCli);
    if (fs.existsSync(devPath)) {
      return {
        entryPoint: devPath,
        version: 'dev',
        source: 'dev',
        nodeModulesPath: path.resolve(path.dirname(devPath), '..', '..', '..', 'node_modules'),
      };
    }
    console.warn(`BLUEDOOR_DEV_CLI path not found: ${devPath}, falling back to normal resolution`);
  }

  const state = readState();

  if (state.currentVersion && state.currentPath) {
    const entryPoint = path.join(state.currentPath, 'dist', 'index.js');
    if (fs.existsSync(entryPoint)) {
      try {
        hydrateCachedNodeModules(state.currentPath);
      } catch (error) {
        console.warn(`Cached CLI hydration failed for v${state.currentVersion}: ${error.message}`);
        try { invalidateCachedVersion(state.currentVersion, console.warn); } catch {}
        return {
          entryPoint: bundledPath,
          version: getBundledVersion(bundledPath),
          source: 'bundled',
          nodeModulesPath: null,
        };
      }
      return {
        entryPoint,
        version: state.currentVersion,
        source: 'cached',
        nodeModulesPath: appNodeModules,
      };
    }
  }

  // Fallback to bundled
  return {
    entryPoint: bundledPath,
    version: getBundledVersion(bundledPath),
    source: 'bundled',
    nodeModulesPath: null, // bundled doesn't need NODE_PATH
  };
}

function getBundledVersion(bundledPath) {
  try {
    const pkgPath = path.join(path.dirname(bundledPath), '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

/**
 * Check npm for the latest version. Returns null if check fails.
 */
async function checkLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(NPM_REGISTRY + '/latest', {
      headers: { 'Accept': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const pkg = JSON.parse(data);
          resolve({
            version: pkg.version,
            tarball: pkg.dist?.tarball,
          });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Download and extract a CLI version tarball to the cache.
 */
async function downloadVersion(version, tarballUrl, log) {
  const versionDir = path.join(CLI_CACHE_DIR, version);

  // Already downloaded
  if (fs.existsSync(path.join(versionDir, 'dist', 'index.js'))) {
    log(`CLI v${version} already cached`);
    try {
      hydrateCachedNodeModules(versionDir, log);
    } catch (error) {
      log(`Dependency hydration failed: ${error.message}`);
      try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
      return false;
    }
    writeState({ currentVersion: version, currentPath: versionDir });
    return true;
  }

  log(`Downloading CLI v${version}...`);
  fs.mkdirSync(versionDir, { recursive: true });

  return new Promise((resolve) => {
    const follow = (url) => {
      https.get(url, { timeout: 30000 }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }

        if (res.statusCode !== 200) {
          log(`Download failed: HTTP ${res.statusCode}`);
          resolve(false);
          return;
        }

        // npm tarballs have a 'package/' prefix inside
        res
          .pipe(createGunzip())
          .pipe(tar.extract({
            cwd: versionDir,
            strip: 1, // strip 'package/' prefix
          }))
          .on('finish', () => {
            try {
              hydrateCachedNodeModules(versionDir, log);
            } catch (err) {
              log(`Dependency hydration failed: ${err.message}`);
              try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
              resolve(false);
              return;
            }
            log(`CLI v${version} downloaded and extracted`);
            writeState({ currentVersion: version, currentPath: versionDir });

            // Clean old cached versions (keep current + 1 previous)
            cleanOldVersions(version, log);
            resolve(true);
          })
          .on('error', (err) => {
            log(`Extract failed: ${err.message}`);
            // Clean up partial download
            try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
            resolve(false);
          });
      }).on('error', (err) => {
        log(`Download failed: ${err.message}`);
        resolve(false);
      }).on('timeout', function() {
        this.destroy();
        log('Download timed out');
        resolve(false);
      });
    };

    follow(tarballUrl);
  });
}

function cleanOldVersions(currentVersion, log) {
  try {
    const entries = fs.readdirSync(CLI_CACHE_DIR);
    const versions = entries.filter(e => {
      // Only directories that look like semver
      return /^\d+\.\d+\.\d+/.test(e) && e !== currentVersion;
    });

    // Sort descending, keep the most recent one as fallback
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (let i = 1; i < versions.length; i++) {
      const dir = path.join(CLI_CACHE_DIR, versions[i]);
      log(`Cleaning old CLI cache: v${versions[i]}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch {}
}

function invalidateCachedVersion(version, log = () => {}) {
  const state = readState();
  const versionDir = path.join(CLI_CACHE_DIR, version);
  if (state.currentVersion === version) {
    writeState({});
  }
  try {
    fs.rmSync(versionDir, { recursive: true, force: true });
    log(`Invalidated cached CLI v${version}`);
  } catch (error) {
    log(`Failed to invalidate cached CLI v${version}: ${error.message}`);
  }
}

/**
 * Background update check. Non-blocking, fire-and-forget.
 * Downloads the new version for next launch.
 */
async function checkForUpdateInBackground(currentVersion, log) {
  const latest = await checkLatestVersion();
  if (!latest || !latest.version || !latest.tarball) {
    return;
  }

  if (latest.version === currentVersion) {
    log(`CLI is up to date (v${currentVersion})`);
    return;
  }

  // Simple semver comparison — latest should be newer
  const current = currentVersion.split('.').map(Number);
  const next = latest.version.split('.').map(Number);
  const isNewer = next[0] > current[0] ||
    (next[0] === current[0] && next[1] > current[1]) ||
    (next[0] === current[0] && next[1] === current[1] && next[2] > current[2]);

  if (!isNewer) {
    return;
  }

  log(`CLI update available: v${currentVersion} → v${latest.version}`);
  await downloadVersion(latest.version, latest.tarball, log);
}

module.exports = {
  getCliEntryPoint,
  checkForUpdateInBackground,
  getBundledVersion,
  invalidateCachedVersion,
};

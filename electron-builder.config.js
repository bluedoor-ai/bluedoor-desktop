const winSigningEnabled = Boolean(
  process.env.WIN_CERTIFICATE_SHA1 && process.env.WIN_PUBLISHER_NAME
);

module.exports = {
  appId: 'com.bluedoor.desktop',
  productName: 'bluedoor',
  files: [
    'src/**/*',
    'node_modules/**/*'
  ],
  npmRebuild: false,
  asarUnpack: [
    'node_modules/**'
  ],
  mac: {
    target: [
      {
        target: 'dmg',
        arch: ['arm64', 'x64']
      },
      {
        target: 'zip',
        arch: ['arm64', 'x64']
      }
    ],
    category: 'public.app-category.finance',
    icon: 'assets/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'entitlements.mac.plist',
    entitlementsInherit: 'entitlements.mac.plist'
  },
  afterSign: 'scripts/notarize.js',
  win: {
    target: [
      'nsis',
      'portable'
    ],
    icon: 'assets/icon.ico',
    extraResources: [
      {
        from: 'node/',
        to: 'node/',
        filter: ['node.exe']
      }
    ],
    requestedExecutionLevel: 'asInvoker',
    ...(winSigningEnabled
      ? {
          signtoolOptions: {
            certificateSha1: process.env.WIN_CERTIFICATE_SHA1,
            publisherName: process.env.WIN_PUBLISHER_NAME,
            signingHashAlgorithms: ['sha256'],
            rfc3161TimeStampServer: 'http://ts.ssl.com'
          }
        }
      : {})
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    deleteAppDataOnUninstall: false,
    installerIcon: 'assets/icon.ico',
    uninstallerIcon: 'assets/icon.ico',
    installerHeaderIcon: 'assets/icon.ico'
  },
  publish: {
    provider: 'github',
    owner: 'bluedoor-ai',
    repo: 'bluedoor-desktop'
  }
};

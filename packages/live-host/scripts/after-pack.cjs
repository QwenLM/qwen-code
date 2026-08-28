const { spawnSync } = require('node:child_process');
const path = require('node:path');

const UNUSED_PERMISSION_KEYS = [
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
];

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productName}.app`;
  const infoPlist = path.join(
    context.appOutDir,
    appName,
    'Contents',
    'Info.plist',
  );

  for (const key of UNUSED_PERMISSION_KEYS) {
    const result = spawnSync('/usr/libexec/PlistBuddy', [
      '-c',
      `Delete :${key}`,
      infoPlist,
    ]);
    if (
      result.status !== 0 &&
      !result.stderr.toString().includes('Does Not Exist')
    ) {
      throw new Error(`Failed to remove unused permission declaration ${key}`);
    }
  }
};

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const UNUSED_DEVICE_PERMISSIONS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
];

module.exports = function removeUnusedDevicePermissions(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const infoPlist = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
    'Contents',
    'Info.plist',
  );
  for (const key of UNUSED_DEVICE_PERMISSIONS) {
    spawnSync('/usr/bin/plutil', ['-remove', key, infoPlist]);
  }
  const packedInfo = execFileSync('/usr/bin/plutil', ['-p', infoPlist], {
    encoding: 'utf8',
  });
  for (const key of UNUSED_DEVICE_PERMISSIONS) {
    if (packedInfo.includes(key)) {
      throw new Error(
        `Unused device permission remained in Info.plist: ${key}`,
      );
    }
  }
};

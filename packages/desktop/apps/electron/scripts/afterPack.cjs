/**
 * electron-builder afterPack hook
 *
 * Copies the optional pre-compiled macOS 26+ Liquid Glass icon (Assets.car)
 * into the app bundle when present. Without it, macOS falls back to icon.icns.
 *
 * If a future Icon Composer workflow produces Assets.car for the current app
 * icon, place it at resources/brands/<brand>/Assets.car and this hook will
 * bundle it.
 *
 * For older macOS versions, or builds without Assets.car, the app falls back
 * to icon.icns which is included separately by electron-builder.
 */

const path = require('path');
const fs = require('fs');

module.exports = async function afterPack(context) {
  // Only process macOS builds
  if (context.electronPlatformName !== 'darwin') {
    console.log('Skipping Liquid Glass icon (not macOS)');
    return;
  }

  const appPath = context.appOutDir;
  const productName = context.packager.appInfo.productName;
  const resourcesDir = path.join(appPath, `${productName}.app`, 'Contents', 'Resources');
  const brandId = process.env.CRAFT_BRAND || 'qwen-code';
  const precompiledAssets = path.join(
    context.packager.projectDir,
    'resources',
    'brands',
    brandId,
    'Assets.car',
  );

  console.log(`afterPack: projectDir=${context.packager.projectDir}`);
  console.log(`afterPack: looking for Assets.car at ${precompiledAssets}`);

  // Check if pre-compiled Assets.car exists
  if (!fs.existsSync(precompiledAssets)) {
    console.log(`Warning: Pre-compiled Assets.car not found for brand ${brandId}`);
    console.log('The app will use the fallback icon.icns on all macOS versions');
    return;
  }

  // Copy pre-compiled Assets.car to the app bundle
  const destAssetsCar = path.join(resourcesDir, 'Assets.car');
  try {
    fs.copyFileSync(precompiledAssets, destAssetsCar);
    console.log(`Liquid Glass icon copied: ${destAssetsCar}`);
  } catch (err) {
    // Don't fail the build if Assets.car can't be copied - app will use fallback icon.icns
    console.log(`Warning: Could not copy Assets.car: ${err.message}`);
    console.log('The app will use the fallback icon.icns on all macOS versions');
  }
};

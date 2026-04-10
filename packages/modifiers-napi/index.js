const path = require('path');

let binding;

function loadBinding() {
  if (binding) return binding;

  if (process.platform !== 'darwin') {
    binding = {
      isModifierPressed: () => false,
      prewarm: () => {},
    };
    return binding;
  }

  try {
    // Try node-gyp-build first (prebuilt binaries)
    const nodeGypBuild = require('node-gyp-build');
    binding = nodeGypBuild(path.join(__dirname));
  } catch (e1) {
    try {
      // Fallback to build directory
      binding = require(
        path.join(__dirname, 'build', 'Release', 'modifiers_napi.node'),
      );
    } catch (e2) {
      // If native module unavailable, provide no-op fallback
      console.warn(
        '@qwen-code/modifiers-napi: native module not available, ' +
          'Shift+Enter detection in Apple Terminal will be disabled. ' +
          'Run "npm run build" in packages/modifiers-napi to compile.',
        e1.message,
      );
      binding = {
        isModifierPressed: () => false,
        prewarm: () => {},
      };
    }
  }

  return binding;
}

function isModifierPressed(modifier) {
  return loadBinding().isModifierPressed(modifier);
}

function prewarm() {
  loadBinding().prewarm();
}

module.exports = { isModifierPressed, prewarm };

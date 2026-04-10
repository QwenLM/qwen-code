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
  } catch {
    try {
      // Fallback to build directory
      binding = require(
        path.join(__dirname, 'build', 'Release', 'modifiers_napi.node'),
      );
    } catch {
      // If native module unavailable, provide no-op fallback
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

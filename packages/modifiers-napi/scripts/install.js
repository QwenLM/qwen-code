// Only attempt to load/build native module on macOS
if (process.platform !== 'darwin') {
  process.exit(0);
}

try {
  require('node-gyp-build')(__dirname + '/..');
} catch {
  // Prebuilt binary not found, will be built on demand via node-gyp rebuild
  // during development. In production, prebuildify should be used.
  console.log(
    '@qwen-code/modifiers-napi: no prebuilt binary found. ' +
      'Run "npm run build" in packages/modifiers-napi to compile.',
  );
}

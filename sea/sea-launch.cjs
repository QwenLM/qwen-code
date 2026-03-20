/**
 * SEA (Single Executable Application) launcher for qwen-code.
 *
 * Extracts the embedded ESM bundle to a versioned temp directory and
 * dynamically imports it.  Based on the gemini-cli launcher but
 * simplified for qwen-code's single-file bundle (no code-splitting).
 */
const { getAsset } = require('node:sea');
const process = require('node:process');
const nodeModule = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

function sanitizeArgv(argv, execPath, resolveFn = path.resolve) {
  if (argv.length > 2) {
    const arg2Abs = resolveFn(argv[2]);
    if (execPath === arg2Abs) {
      argv.splice(2, 1);
      return true;
    }
  }
  return false;
}

function getSafeName(name) {
  return (name || 'unknown').toString().replace(/[^a-zA-Z0-9.-]/g, '_');
}

function verifyIntegrity(dir, manifest, fsMod = fs, cryptoMod = crypto) {
  try {
    const calculateHash = (filePath) => {
      const hash = cryptoMod.createHash('sha256');
      const fd = fsMod.openSync(filePath, 'r');
      const buffer = new Uint8Array(65536);
      try {
        let bytesRead = 0;
        while (
          (bytesRead = fsMod.readSync(fd, buffer, 0, buffer.length, null)) !== 0
        ) {
          hash.update(buffer.subarray(0, bytesRead));
        }
      } finally {
        fsMod.closeSync(fd);
      }
      return hash.digest('hex');
    };

    if (calculateHash(path.join(dir, 'cli.mjs')) !== manifest.mainHash)
      return false;
    if (manifest.files) {
      for (const file of manifest.files) {
        if (calculateHash(path.join(dir, file.path)) !== file.hash)
          return false;
      }
    }
    return true;
  } catch (_e) {
    return false;
  }
}

function prepareRuntime(manifest, getAssetFn, deps = {}) {
  const fsMod = deps.fs || fs;
  const osMod = deps.os || os;
  const pathMod = deps.path || path;
  const processEnv = deps.processEnv || process.env;
  const processPid = deps.processPid || process.pid;
  const processUid =
    deps.processUid || (process.getuid ? process.getuid() : 'unknown');

  const version = manifest.version || '0.0.0';
  const safeVersion = getSafeName(version);
  const userInfo = osMod.userInfo();
  const username =
    userInfo.username || processEnv.USER || processUid || 'unknown';
  const safeUsername = getSafeName(username);

  const tempBase = osMod.tmpdir();
  const finalRuntimeDir = pathMod.join(
    tempBase,
    `qwen-runtime-${safeVersion}-${safeUsername}`,
  );

  let runtimeDir;
  let useExisting = false;

  const isSecure = (dir) => {
    try {
      const stat = fsMod.lstatSync(dir);
      if (!stat.isDirectory()) return false;
      if (processUid !== 'unknown' && stat.uid !== processUid) return false;
      if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)
        return false;
      return true;
    } catch (_) {
      return false;
    }
  };

  if (fsMod.existsSync(finalRuntimeDir)) {
    if (isSecure(finalRuntimeDir)) {
      if (
        verifyIntegrity(finalRuntimeDir, manifest, fsMod, deps.crypto || crypto)
      ) {
        runtimeDir = finalRuntimeDir;
        useExisting = true;
      } else {
        try {
          fsMod.rmSync(finalRuntimeDir, { recursive: true, force: true });
        } catch (_) {}
      }
    } else {
      try {
        fsMod.rmSync(finalRuntimeDir, { recursive: true, force: true });
      } catch (_) {}
    }
  }

  if (!useExisting) {
    const setupDir = pathMod.join(
      tempBase,
      `qwen-setup-${processPid}-${Date.now()}`,
    );

    try {
      fsMod.mkdirSync(setupDir, { recursive: true, mode: 0o700 });
      const writeToSetup = (assetKey, relPath) => {
        const content = getAssetFn(assetKey);
        if (!content) return;
        const destPath = pathMod.join(setupDir, relPath);
        const destDir = pathMod.dirname(destPath);
        if (!fsMod.existsSync(destDir))
          fsMod.mkdirSync(destDir, { recursive: true, mode: 0o700 });
        fsMod.writeFileSync(destPath, new Uint8Array(content), {
          mode: 0o755,
        });
      };
      writeToSetup('cli.mjs', 'cli.mjs');
      if (manifest.files) {
        for (const file of manifest.files) {
          writeToSetup(file.key, file.path);
        }
      }
      try {
        fsMod.renameSync(setupDir, finalRuntimeDir);
        runtimeDir = finalRuntimeDir;
      } catch (renameErr) {
        if (
          fsMod.existsSync(finalRuntimeDir) &&
          isSecure(finalRuntimeDir) &&
          verifyIntegrity(
            finalRuntimeDir,
            manifest,
            fsMod,
            deps.crypto || crypto,
          )
        ) {
          runtimeDir = finalRuntimeDir;
          try {
            fsMod.rmSync(setupDir, { recursive: true, force: true });
          } catch (_) {}
        } else {
          throw renameErr;
        }
      }
    } catch (e) {
      console.error(
        'Fatal Error: Failed to setup secure runtime. Please try running again and if error persists please reinstall.',
        e,
      );
      try {
        fsMod.rmSync(setupDir, { recursive: true, force: true });
      } catch (_) {}
      process.exit(1);
    }
  }

  return runtimeDir;
}

async function main(getAssetFn = getAsset) {
  process.env.IS_BINARY = 'true';

  if (nodeModule.enableCompileCache) {
    nodeModule.enableCompileCache();
  }

  process.noDeprecation = true;

  sanitizeArgv(process.argv, process.execPath);

  const manifestJson = getAssetFn('manifest.json', 'utf8');
  if (!manifestJson) {
    console.error('Fatal Error: Corrupted binary. Please reinstall.');
    process.exit(1);
  }

  const manifest = JSON.parse(manifestJson);

  const runtimeDir = prepareRuntime(manifest, getAssetFn, {
    fs,
    os,
    path,
    processEnv: process.env,
    crypto,
  });

  const mainPath = path.join(runtimeDir, 'cli.mjs');

  await import(pathToFileURL(mainPath).href).catch((err) => {
    console.error('Fatal Error: Failed to launch. Please reinstall.', err);
    console.error(err);
    process.exit(1);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Unhandled error in sea-launch:', err);
    process.exit(1);
  });
}

module.exports = {
  sanitizeArgv,
  getSafeName,
  verifyIntegrity,
  prepareRuntime,
  main,
};

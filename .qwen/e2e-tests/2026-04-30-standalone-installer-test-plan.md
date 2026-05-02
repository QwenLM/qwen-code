# Standalone Installer Test Plan

## Scope

This plan verifies the one-line installer after standalone archive support is
added. It covers installer behavior, artifact packaging, and fallback behavior
without requiring real global npm writes.

## Local Smoke Matrix

Run from the repository root after `npm run bundle && npm run prepare:package`.

### Unix Standalone Archive

1. Build a standalone archive for the current target with a local Node.js
   archive.
2. Keep the generated `SHA256SUMS` next to the archive.
3. Create a temporary `HOME`.
4. Run:

   ```bash
   HOME="$tmp_home" bash scripts/installation/install-qwen-with-source.sh \
     --method standalone \
     --archive dist/standalone/qwen-code-<target>.tar.gz \
     --source github
   ```

5. Expected:
   - `$tmp_home/.local/lib/qwen-code` exists.
   - `$tmp_home/.local/bin/qwen` exists and is executable.
   - `$tmp_home/.qwen/source.json` contains `{"source":"github"}`.
   - Installer does not write `.bashrc`, `.zshrc`, `.npmrc`, or npm prefix.
   - Installer rejects the same archive after tampering with its contents.
   - Installer rejects the archive if `SHA256SUMS` is missing.

### Unix npm Fallback

1. Put fake `node`, `npm`, and `qwen` commands in a temporary PATH.
2. Run detect mode with a fake base URL whose archive does not exist.
3. Expected:
   - npm is invoked with `install -g @qwen-code/qwen-code@latest`.
   - `qwen` is not executed interactively.

### Unix Standalone Failure

1. Run `--method standalone` with a fake base URL whose archive does not exist.
2. Expected:
   - installer exits non-zero.
   - npm is not invoked.

### Windows Standalone Archive

Run on `windows-latest` or a Windows VM:

```cmd
set USERPROFILE=%TEMP%\qwen-user
set LOCALAPPDATA=%TEMP%\qwen-local
scripts\installation\install-qwen-with-source.bat --method standalone --archive dist\standalone\qwen-code-win-x64.zip --source github
```

Expected:

- `%LOCALAPPDATA%\qwen-code\qwen-code` exists.
- `%LOCALAPPDATA%\qwen-code\bin\qwen.cmd` exists.
- `%USERPROFILE%\.qwen\source.json` exists.
- The script does not require Administrator.

## CI Matrix

- `ubuntu-latest`: package + install Linux x64 archive.
- `macos-latest`: package + install Darwin arm64/x64 depending on runner.
- `windows-latest`: package + install Windows x64 archive.

## Manual Release Verification

For a release candidate:

1. Download `SHA256SUMS` and all archives from GitHub Release.
2. Verify checksums locally.
3. Sync the same files to OSS/CDN under both `vX.Y.Z/` and `latest/`.
4. Download one archive from GitHub and one from OSS/CDN.
5. Confirm byte-identical checksums.
6. Run installer with:

   ```bash
   --mirror github --method standalone
   --mirror aliyun --method standalone
   --method npm
   --archive /path/to/archive
   ```

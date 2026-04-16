## Summary

Fixes #3287

On macOS, Zed editor is typically installed via Homebrew or direct download, but the CLI command `zed` is not automatically added to PATH. This causes the `/editor` command to show "Zed (Not installed)" even when Zed is already installed.

## Changes

- Added detection for Zed.app bundle at `/Applications/Zed.app` and `~/Applications/Zed.app`
- Falls back to using the CLI inside the app bundle when CLI is not in PATH
- Added comprehensive tests for the new detection logic

## How to verify

1. On macOS, install Zed via Homebrew: `brew install --cask zed`
2. Run `qwen /editor`
3. Zed should now be detected and selectable

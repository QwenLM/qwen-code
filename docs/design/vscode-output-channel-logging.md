# VS Code Output Channel Logging

## Problem

Runtime diagnostics currently use `console.*`. Extension Host logs require
Developer Tools, while Webview logs require the separate Webview Developer
Tools, so users cannot easily collect a complete report.

## Design

Reuse the existing `Qwen Code Companion` `OutputChannel` during extension
activation and configure the logger to write in both development and production
modes.

Extension Host runtime code uses the shared logger instead of `console.*`. The
logger preserves log levels, formats objects and errors, redacts sensitive
object fields, and applies the existing log-credential redactor before writing.

The Webview bundle redirects its global `console.*` methods so logs from the
shared Web UI are included. It sends formatted log messages through the existing
Webview-to-Extension Host message bridge. The host validates each message and
escapes line breaks before writing it to the same `Qwen Code Companion`
channel.

Build scripts and tests keep using `console.*` because they do not run inside the
extension.

## Verification

- Production activation writes to the `Qwen Code Companion` channel.
- Multi-argument, object, circular, and `Error` values remain readable.
- Sensitive object fields and common credentials are redacted.
- Webview log messages reach the Extension Host logger.
- The focused unit tests, package build, and package typecheck pass.

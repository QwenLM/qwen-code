# Load the Web Shell terminal on demand

[English](2026-11-19-web-shell-lazy-terminal.md) | [简体中文](2026-11-19-web-shell-lazy-terminal.zh-CN.md)

## Problem

The workspace and managed-session terminal panels both import xterm, FitAddon,
and their stylesheet. Their static imports put these dependencies on the
startup path even for users who only open a conversation.

## Design

Load a shared terminal runtime when a workspace terminal is enabled or a
managed terminal surface mounts. A restored, inactive workspace tab can
register its PTY release callback without loading the runtime. The managed
dialog opens immediately. Both surfaces show loading status while the runtime
downloads and start their existing connection logic once it is ready.

Keep the stylesheet in the same lazy chunk. In the library build, scope it
like the existing component CSS and render it alongside the terminal so that
it also applies inside a shadow root.

## Verification

- Open a chat with a cold cache and verify that the browser downloads neither
  the xterm runtime nor its stylesheet. Verify the standalone and embedded
  build output for static imports.
- Open the workspace and managed terminals and verify that the runtime loads
  and the terminal can connect. Verify that closing a tab during loading
  prevents a late connection and still releases an existing workspace PTY.
- Restore an inactive workspace terminal tab and verify that it loads the
  runtime only after activation.

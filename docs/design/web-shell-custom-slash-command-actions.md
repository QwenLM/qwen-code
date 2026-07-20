# Web Shell Custom Slash Command Actions

## Problem

Web Shell handles built-in slash commands locally and forwards other slash
commands to the daemon. Embedders cannot observe a command before that default
behavior or replace it with an application-specific action.

## Design

Add an optional `onSlashCommand` prop. It runs before hidden-command,
built-in-command, and daemon-forwarding behavior and receives:

- `command`: the slash command name, normalized to lower case;
- `args`: the trimmed text after the command name;
- `input`: the original submitted text.

Returning `true` marks the command as handled and skips Web Shell's default
behavior. Returning `false` or nothing lets the existing command pipeline
continue unchanged. The callback is synchronous so composer acceptance keeps
the existing synchronous submit contract; embedders may start asynchronous
work inside the callback.

## Compatibility

The prop is optional, so existing embedders and all current command behavior
remain unchanged. The callback also observes unknown commands, allowing an
embedder to implement a command without daemon support.

## Test Plan

- Verify an unknown slash command invokes the callback with parsed fields and
  still reaches the daemon when the callback does not handle it.
- Verify returning `true` prevents the command from reaching the daemon.
- Verify returning `true` prevents a built-in command's local behavior.

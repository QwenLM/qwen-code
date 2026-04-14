## Problem

Fix issue #3224 so startup keystrokes survive the real CLI startup path,
including:

- parent -> child relaunch
- parent -> sandbox handoff
- child process startup before the interactive UI mounts

## Local candidates

- `packages/cli/index.ts`
  - earliest point where interactive input capture can start
- `packages/cli/src/gemini.tsx`
  - owns relaunch, sandbox hop, kitty detection, and UI startup sequencing
- `packages/cli/src/utils/relaunch.ts`
  - already supports env additions for parent -> child relaunch
- `packages/cli/src/utils/sandbox.ts`
  - owns parent -> sandbox process launch, but had no early-input env handoff
- `packages/cli/src/gemini.test.tsx`
  - closest place to cover the failing production startup path

## Decision

- `adapt`

Reuse the existing early-input buffering and relaunch env transport, but fix
the sequencing in `gemini.tsx` and add equivalent env transport for
`start_sandbox()`.

## Why

- The buffering utility itself is fine.
- The bug is in when the buffer is drained and whether it is forwarded to the
  next process.
- The missing coverage is in end-to-end startup orchestration, not in the
  isolated buffer/replay helpers.

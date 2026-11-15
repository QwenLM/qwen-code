# Session relink verification follow-up

## Goal

Verify that explicit session recovery after a project move still preserves the complete session and that a relocation refusal is shown as a normal CLI error instead of an unexpected fatal stack trace.

## Scenarios

1. Create a session in an isolated `QWEN_RUNTIME_DIR`, exit Qwen Code, rename the project directory, then run `qwen --resume <uuid>` from the new directory. Confirm the prompt shows both paths and defaults to No. Accept it and verify the original history opens under the same UUID.
2. Pre-create one target sidecar for the UUID, repeat the recovery, and accept the prompt. Verify the CLI prints one safe refusal message without a stack trace and that source and target bytes are unchanged.
3. Decline the prompt and verify no files move.
4. Run the explicit resume non-interactively and verify it explains that interactive confirmation is required without moving files.
5. Create duplicate UUIDs, a live runtime writer, an invalid transcript, a hard-linked transcript, and a transcript stored under a directory inconsistent with its recorded `cwd`. Verify each case refuses without mutation.

## Acceptance criteria

- Successful recovery preserves the UUID, complete transcript, unknown transcript fields, and all supported sidecars while rewriting only paths rooted in the old project.
- Refusal paths never overwrite existing artifacts and do not expose an unexpected fatal stack trace.
- Current-project resume, `--continue`, picker, title lookup, archived sessions, and headless behavior remain unchanged.

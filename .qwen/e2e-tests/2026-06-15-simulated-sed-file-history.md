# Simulated `sed -i` File-History E2E Test Plan

## Goal

Verify that a simple `sed -i` shell edit is previewed as a file edit, tracked in file history, and reversible through `/rewind`.

## Manual Flow

1. Create a temporary project with `file.txt` containing `foo foo`.
2. Start qwen-code in that project.
3. Ask the agent to run `sed -i 's/foo/bar/g' file.txt`.
4. Confirm that the permission UI shows a file diff from `foo foo` to `bar bar` instead of only a shell command confirmation.
5. Approve the edit.
6. Confirm `file.txt` contains `bar bar`.
7. Run `/rewind` to the turn before the sed edit.
8. Confirm `file.txt` is restored to `foo foo`.

## Fallback Flow

1. In the same project, ask the agent to run `sed -i 's/foo/bar/g' *.txt`.
2. Confirm the command uses the normal shell confirmation path, because globbed multi-file edits are intentionally not simulated.
3. Cancel the command.

## Expected Result

Simple single-file substitutions are tracked like Edit/WriteFile changes and can be rewound. Unsupported sed forms preserve the previous shell behavior.

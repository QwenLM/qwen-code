# Simulated `sed -i` File-History Tracking

## Summary

Support the remaining issue #4204 item B1 by treating a narrow class of `sed -i 's/pattern/replacement/flags' file` shell commands as file edits instead of opaque shell executions.

The simulated path previews the exact text change in the normal edit confirmation UI, records the target file with `FileHistoryService.trackEdit()`, writes through `FileSystemService.writeTextFile()`, and avoids spawning a shell. This lets `/rewind` capture shell-driven in-place edits that are common in agent workflows.

## Scope

Only simple in-place substitutions are simulated:

- `sed -i 's/foo/bar/' file`
- `sed -i '' -E 's/foo|bar/baz/g' file`
- `sed -i -e 's/foo/bar/' file`

Commands are not simulated when they include compound shell operators, globs, multiple files, command substitutions, shell variable references inside the sed expression, variable-expanded file paths, backup suffixes such as `-i.bak`, unsupported sed flags, unsupported sed expressions, or background execution. Those cases keep the existing shell execution behavior.

The supported substitution flags are intentionally limited to `g` and numeric occurrences. Flags that can affect stdout or have platform-specific sed behavior, such as `p`, `I`, and `M`, fall back to the shell path. Environment-prefixed shell wrappers also fall back so locale or environment changes cannot be silently ignored by the simulator.

## Behavior

Confirmation reads the target file, applies the parsed substitution in memory, and returns `ToolEditConfirmationDetails` with a normal file diff.

Execution re-reads the file before writing. If the file content differs from the content used for confirmation, execution rejects with `FILE_CHANGED_SINCE_READ` instead of writing a change the user did not approve.

If previewing the file fails, the command is confirmed and executed through the existing shell path instead of being simulated.

The confirmation hides external-editor modify actions because ShellTool is not a general modifiable file-edit tool. If an IDE or host returns an inline `newContent` payload while approving the diff, the simulated sed path writes that approved content after the same stale-content guard.

Before writing, execution calls `FileHistoryService.trackEdit(filePath)` so the current turn's file-history snapshot captures a pre-edit backup. The file-history call is best-effort and never blocks the edit. The write itself uses `FileSystemService.writeTextFile()` with the read metadata so encoding, BOM, and line-ending behavior stays aligned with the Edit and WriteFile tools.

## Compatibility

No persisted schema changes are needed. This is just another source of tracked file edits inside an existing snapshot. Unsupported shell commands continue through the existing shell path, so this does not change generic shell semantics.

## Out of Scope

Generic shell mutation tracking remains deferred. Commands like `perl -pi`, `python -c`, `awk`, `cat > file`, `mv`, arbitrary scripts, and multi-file `sed` invocations are not simulated. They require broader shell-effect analysis that claude-code does not support today and is outside B1.

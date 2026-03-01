## Problem

Models often use common shell command aliases like `bash` or `sh` instead of the registered tool name `run_shell_command`, causing "Tool not found in registry" errors.

Example error from #2012:

```
Tool "bash" not found in registry. Tools must use the exact names that are registered. Did you mean one of: "task", "glob", "edit"?
```

## Changes

- Add `bash` and `sh` to `ToolNamesMigration` as aliases for `run_shell_command`
- Migrate legacy tool names in `CoreToolScheduler._schedule()` before registry lookup
- This allows models to use common shell aliases while maintaining backward compatibility
- Add test case for tool name migration

## Testing

- Added test case verifying that `bash` tool calls are correctly mapped to `run_shell_command`
- All 37 tests pass

Fixes #2012

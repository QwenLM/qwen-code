# TODO: Qwen Compatibility for Claude Protocol Client

Based on analysis of the sample/automation/hooks.py code (client for Claude), here are the changes needed to make Qwen Code compatible with the sample code client:

## CLI Argument Mapping Adapter

### Current Implementation:

- Qwen CLI has its own argument structure
- Claude CLI has different argument structure
- The claude-adapter.js exists to map between Claude and Qwen arguments

### Required Changes:

- [x] **Create argument mapping configuration**: Define config file format that maps Claude arguments to Qwen arguments (e.g., --print -> -p, --allowed-tools -> --allowed-tools, --permission-mode -> --approval-mode, --model -> -m)
- [x] **Implement argument translation layer**: Create a CLI adapter that accepts Claude arguments and translates them to Qwen equivalents
- [x] **Handle semantic differences**: Map arguments with similar concepts but different names/functionality (e.g., Claude's --permission-mode vs Qwen's --approval-mode)
- [ ] **Support command forwarding**: Handle Claude commands like `claude mcp` that should translate to `qwen mcp`
- [x] **Create default mapping file**: Provide default config file with common Claude-to-Qwen argument mappings
- [x] **Support custom mapping overrides**: Allow users to customize mappings in a config file

## Qwen Hook Input/Output Compatibility

### Current Implementation:

- Qwen HookService passes structured HookPayload to handlers
- Sample code expects JSON input via stdin to external commands

### Required Changes:

- [ ] **Send JSON input to external hooks**: When Qwen executes external commands (via command field in ClaudeHookConfig), it must serialize hook payload to JSON and pipe to stdin
- [ ] **Support Claude-format hook input fields**: Hook payloads sent via stdin to external commands must include Claude-compatible fields: session_id, hook_event_name, tool_name, tool_input, transcript_path
- [ ] **Match Claude input structure**: tool_input format must match Claude's expectations per tool type

## Qwen Hook Output Format Compatibility

### Current Implementation:

- Qwen HookManager handles execution without specific output formatting
- External hooks should return specific JSON output formats expected by Qwen

### Required Changes:

- [ ] **Handle PreToolUse response format**: External hooks should return Claude-compatible JSON: { "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow|deny|block", "permissionDecisionReason"?: "string" }, "systemMessage"?: "string" }
- [ ] **Handle Stop hook response format**: External hooks should return Claude-compatible JSON: { "decision": "approve|block", "reason"?: "string", "systemMessage"?: "string" }
- [ ] **Process exit codes from external hooks**: Handle exit code 0 (success), 2 (blocking error), other codes (non-blocking errors)

## Qwen Tool Input Format Compatibility

### Current Implementation:

- Qwen may use different tool input structures

### Required Changes:

- [ ] **Format Write tool_input as Claude expects**: { "file_path": "string", "content": "string" }
- [ ] **Format Edit tool_input as Claude expects**: { "file_path": "string", "old_string": "string", "new_string": "string" }
- [ ] **Format Bash tool_input as Claude expects**: { "command": "string", "description"?: "string" }
- [x] **Format TodoWrite tool_input as Claude expects**: { "todos": array of todo objects with id, content, status, created_at, and completed_at fields }

## Todo List Format Compatibility

### Current Implementation:

- Qwen has TodoWriteTool with its own format that now includes Claude-compatible timestamps

### Required Changes:

- [x] **Store todo files in Claude-compatible format**: Todo files should be stored in Claude-compatible JSON format
- [x] **Support Claude todo structure**: Ensure todo objects have id, content, status (pending/in_progress/completed), created_at, and completed_at fields
- [ ] **Use Claude-compatible todo file locations**: Todos should be stored at Claude-compatible paths (not required - Qwen paths are fine)
- [x] **Maintain session ID compatibility for todos**: Ensure session IDs work with Claude todo structure

## Hook Event Mapping

### Current Implementation:

- Qwen has HookType enum with various lifecycle events
- Claude events may need to map to Qwen equivalents

### Required Changes:

- [ ] **Support Claude event names**: External hooks should receive proper Claude event names in hook_event_name field
- [ ] **Ensure Claude events map correctly**: Verify Claude events like PreToolUse, Stop, SubagentStop, etc. map to correct Qwen hook types

## CLI Argument Adapter

### Current Implementation:

- Qwen and Claude have different CLI argument structures
- The claude-adapter.js exists to map between Claude and Qwen arguments

### Required Changes:

- [x] **Create argument mapping configuration**: Define mappings between Claude and Qwen CLI arguments (e.g., --print, --allowed-tools, --model, etc.)
- [x] **Implement argument translation**: Create an adapter that receives Claude CLI arguments and translates them to equivalent Qwen arguments
- [x] **Handle semantic differences**: Map arguments with different names but similar functionality (e.g. Claude --permission-mode to Qwen --approval-mode)
- [ ] **Support command forwarding**: Handle command-specific mappings (e.g. claude mcp -> qwen mcp)
- [x] **Create mapping configuration file**: Define a config file format that specifies argument mappings and transformations

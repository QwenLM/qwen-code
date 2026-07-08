# chat-delete.md — Remove a Session Name from Index

**Note**: Direct invocation (`/chat-delete name`) bypasses the router's argument parsing, locale detection, and name validation. Use `/chat -d name` instead.

1. **Validate `{{name}}`**: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. **Read index**: Read `.qwen/chat-index.json` (project root, NOT runtime base). **JSON parse error → output `"chat-index.json is malformed. Fix it manually before deleting."` and stop. Do NOT proceed.**
3. If `{{name}}` NOT found: show list + "Session not in index", stop.
4. **Confirmation**: If user provided `-y` or `--force` flag, SKIP confirmation and delete immediately. Otherwise:
   - **STOP and output this exact question:**
     ```
     ⚠️ Delete session "{{name}}"?
     Type "yes" to confirm, or anything else to cancel:
     ```
   - **WAIT for user's response.** DO NOT proceed until user responds.
   - If response = `"yes"` → Continue to delete
   - If response ≠ `"yes"` → Output `"Delete cancelled."` and STOP immediately
5. **Delete**: Remove `{{name}}` from index, write back.
6. **Confirm result**: Output: `Session "{{name}}" removed from index.` + note: "Session file NOT deleted."

**Why file NOT deleted?**

- **Safety**: Deletion is irreversible; removing a name reference is low-risk.
- **Shared reference**: Multiple names can point to the same session. Deleting one name should not destroy data others reference.

**Important**: The index is stored in the **current project's root directory**, NOT the user's home directory or runtime base.

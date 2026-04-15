# chat-delete.md — Remove a Session Name from Index

## Step 0: MUST Ask for Confirmation (DO NOT SKIP)

**⚠️ CRITICAL: Before ANY deletion, you MUST:**

1. **STOP and output this exact question:**
   ```
   ⚠️ Delete session "{{name}}"?
   Type "yes" to confirm, or anything else to cancel:
   ```
2. **WAIT for user's response.** DO NOT proceed until user responds.
3. **Check the response:**
   - If response = `"yes"` → Continue to Step 1
   - If response ≠ `"yes"` → Output `"Delete cancelled."` and STOP immediately

**DO NOT skip this step. DO NOT proceed with deletion until the user explicitly types "yes".**

---

## Step 1: Validate name

Validate `{{name}}` (Common rules): `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`.

## Step 2: Look up and delete

1. Read `.qwen/chat-index.json` (project root, NOT `~/.qwen/`).
2. If `{{name}}` not found → show list + "Session not in index", STOP.
3. Remove `{{name}}` from index, write back.

## Step 3: Confirm result

Output: `Session "{{name}}" removed from index.` + note: "Session file NOT deleted."

**Why file NOT deleted?**

- **Safety**: Deletion is irreversible; removing a name reference is low-risk.
- **Shared reference**: Multiple names can point to the same session. Deleting one name should not destroy data others reference.

**Important**: The index is stored in the **current project's root directory**, NOT the user's home directory.

# PR 创建指南

## 步骤 1: Fork 仓库

在浏览器中打开 https://github.com/QwenLM/qwen-code，点击右上角的 "Fork" 按钮创建你自己的 fork。

## 步骤 2: 添加你的 fork 为远程仓库

在你的 fork 创建完成后，运行：

```bash
cd D:\code\qwen-code
git remote add fork https://github.com/lnxsun/qwen-code.git
git push -u fork feat/chat-session-command
```

## 步骤 3: 创建 PR

使用以下链接创建 PR（替换为你的 fork URL）：

```
https://github.com/QwenLM/qwen-code/compare/main...lnxsun:qwen-code:feat/chat-session-command?expand=1
```

或者在 GitHub 页面上：
1. 进入 https://github.com/QwenLM/qwen-code
2. 点击 "Pull requests" 标签
3. 点击 "New pull request"
4. 选择你的分支 `feat/chat-session-command`
5. 使用下面的 PR 描述

---

## PR 标题

```
feat: add /chat command for saving, listing, resuming, and deleting named sessions
```

## PR 描述

```markdown
## Summary

This PR implements a new `/chat` slash command for managing named chat sessions, inspired by the iflow CLI's session management features (related to #3025).

## Features

The `/chat` command provides four subcommands:

- **`/chat save <name>`** - Save the current session with a custom name
- **`/chat list`** - List all saved session names with their shortened IDs
- **`/chat resume <name>`** - Look up a session ID by name for easy restoration
- **`/chat delete <name>`** - Remove a saved session from the index

## Implementation Details

### New Files

1. **`packages/core/src/services/chatIndex.ts`**
   - Session index management module
   - Stores name-to-sessionID mappings in `~/.qwen/chat-index.json`
   - Provides CRUD operations for the session index

2. **`packages/cli/src/ui/commands/chatCommand.ts`**
   - Implementation of the `/chat` slash command with all subcommands
   - Follows existing command patterns (similar to `/memory`, `/btw`)

3. **`packages/core/src/services/chatIndex.test.ts`**
   - Comprehensive unit tests for the chat index module
   - 11 tests all passing

### Modified Files

- `packages/core/src/index.ts` - Export the new chatIndex module
- `packages/cli/src/services/BuiltinCommandLoader.ts` - Register the chatCommand

## Usage Examples

```bash
# Save current session as "my-feature-work"
/chat save my-feature-work

# List all saved sessions
/chat list
# Output:
# Saved sessions:
# • my-feature-work (ID: abc12345...)
# • debugging-session (ID: def67890...)

# Find session ID for restoration
/chat resume my-feature-work
# Output: Found session "my-feature-work" with ID: abc12345-...
# Use /resume to select it, or restart with: qwen --session-id abc12345-...

# Delete a saved session
/chat delete my-feature-work
```

## Design Decisions

1. **Separate index file**: Uses `~/.qwen/chat-index.json` instead of modifying the existing auto-save mechanism in `~/.qwen/projects/<cwd>/chats/`
2. **Simple mapping**: Maintains a straightforward name → sessionId mapping
3. **Non-intrusive**: Complements rather than replaces existing session management
4. **Error handling**: Graceful handling of missing/corrupted index files

## Testing

- Unit tests: 11/11 passing in `chatIndex.test.ts`
- Manual testing recommended for all subcommands

## Related Issues

- Related to #3025 (adopting good features from iflow cli)
```

---

## 步骤 4: 关联 Issue

在 PR 描述中添加：

```markdown
Closes #3025
```

或者在 PR 创建后，在 issue #3025 中评论：

```markdown
PR created: #<PR_NUMBER>
```

---

## 备选方案：使用 gh CLI 创建 PR

如果你可以安装 GitHub CLI (`gh`)，可以直接运行：

```bash
# 安装 gh (Windows)
winget install GitHub.cli

# 然后运行
cd D:\code\qwen-code
gh pr create --title "feat: add /chat command for saving, listing, resuming, and deleting named sessions" --body "相关描述见上面" --head lnxsun:feat/chat-session-command --base main
```

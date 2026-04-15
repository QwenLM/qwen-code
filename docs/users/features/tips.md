# Contextual Tips

Qwen Code includes a contextual tips system that helps you discover features and stay aware of session state.

## Startup Tips

Each time you launch Qwen Code, a tip is shown in the header area. Tips are selected by priority first, then rotated across sessions using LRU (least-recently-used) scheduling among tips of the same priority, so you see a different tip each time.

New users see onboarding-focused tips during their first sessions:

| Sessions | Example tips                                         |
| -------- | ---------------------------------------------------- |
| < 5      | Slash commands (`/`), Tab autocomplete               |
| < 10     | `QWEN.md` project context, `--continue` / `--resume` |
| < 15     | Shell commands with `!` prefix                       |

After that, tips rotate through general features like `/compress`, `/approval-mode`, `/insight`, `/btw`, and more.

## Post-Response Tips

During a conversation, Qwen Code monitors your context window usage and shows tips when action may be needed:

| Context usage | Condition                      | Tip                                               |
| ------------- | ------------------------------ | ------------------------------------------------- |
| 50-80%        | After a few prompts in session | Suggests `/compress` to free up context           |
| 80-95%        | —                              | Warns context is getting full                     |
| >= 95%        | —                              | Urgent: run `/compress` now or `/new` to continue |

Post-response tips have per-tip cooldowns to avoid being repetitive.

## Tip History

Tip display history is persisted at `~/.qwen/tip_history.json`. This file tracks:

- Session count (used for new-user tip selection)
- Which tips have been shown and when (used for LRU rotation and cooldown)

You can safely delete this file to reset tip history.

## Disabling Tips

To hide all tips (both startup and post-response), set `ui.hideTips` to `true` in `~/.qwen/settings.json`:

```json
{
  "ui": {
    "hideTips": true
  }
}
```

You can also toggle this in the settings dialog via the `/settings` command.

Tips are also automatically hidden when screen reader mode is enabled.

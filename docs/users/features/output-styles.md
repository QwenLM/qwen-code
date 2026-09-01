# Output Styles

Output styles change how Qwen Code writes its responses — the tone, the amount of narration, how much it explains — without changing what it can do. A style is a named block of instructions layered onto the built-in system prompt, and the model is reminded of the active style on every turn so it holds up over long sessions.

## Built-in styles

| Style           | What it does                                                                                                                                                                                  |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **default**     | No extra style — the standard prompt.                                                                                                                                                         |
| **Concise**     | Answers first, with no preamble, narration, or closing recap. The work stays as thorough as ever; error reports and safety confirmations keep their full content.                             |
| **Proactive**   | Starts work immediately and prefers a stated assumption over a question on low-risk decisions. Does not change what is allowed: the approval mode and confirmation rules still apply in full. |
| **Explanatory** | Adds short educational "Insight" notes about the codebase and the implementation choices alongside the work.                                                                                  |
| **Learning**    | Collaborative learn-by-doing: hands you small, meaningful pieces of code to write (marked `TODO(human)`), then waits. Skipped in headless runs, which cannot wait for you.                    |

## Choosing a style

Run `/output-style` to open a picker, or set one directly:

```
/output-style Concise
/output-style default   # back to no style
```

The change applies to the running session immediately — the system prompt is rebuilt in place, so the next turn already answers in the new style — and it is persisted for future sessions. If a trusted project setting currently owns `general.outputStyle`, the command updates that project setting; otherwise it updates your user setting. Style names are case-insensitive.

You can also set the style without the command:

- **Settings**: `"general": { "outputStyle": "Concise" }` in `settings.json` (user or project scope). A hand edit takes effect on the next start.
- **One run**: `qwen -p "..." --output-style Concise` overrides the setting for that run. See [Headless Mode](./headless).

## Scope and interactions

- A style layers onto the built-in prompt. When `--system-prompt` or `QWEN_SYSTEM_MD` replaces the prompt entirely, the style (and its per-turn reminder) is not applied.
- Styles apply to the main conversation only; subagents run their own system prompts.
- `--bare` and `--safe-mode` ignore the setting and do not allow `/output-style` changes.
- Changing the style mid-session invalidates the cached prompt prefix once; after that, caching works as usual.

Styles adjust tone and workflow, not knowledge or permissions. For project conventions the model should always know, use context files (`QWEN.md`); for a one-off addition to the prompt, use `--append-system-prompt`.

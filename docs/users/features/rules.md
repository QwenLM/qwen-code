# Rules

A rule is a Markdown file that reaches the model either at the start of a session or the moment the work touches a file it applies to. Rules live in `.qwen/rules/`, and the `paths:` field is what makes the second kind possible: guidance about your React components does not have to be in the prompt while you are editing a Makefile.

They are the cheap counterpart to a context file (`QWEN.md`), which is carried on **every** request of every session — see [Resident Context Cost](context-cost.md).

## Where rules live

| Location                                  | Loaded                                     |
| ----------------------------------------- | ------------------------------------------ |
| `~/.qwen/rules/` (or `$QWEN_HOME/rules/`) | always                                     |
| `<project>/.qwen/rules/`                  | when the workspace is trusted              |
| an active extension's `rules/`            | always, conditional rules only — see below |

Every `.md` file under those directories is discovered, including in subdirectories, in a deterministic order.

## Baseline and conditional rules

```markdown
---
description: How we write React components
paths:
  - 'src/**/*.tsx'
  - 'src/**/*.jsx'
---

Components are function components. Co-locate the test beside the component.
Never reach for a global store for state one screen owns.
```

- **With `paths:`** — a _conditional_ rule. It stays out of the prompt until a tool call reads or edits a file matching one of its globs, and is then injected once for the rest of the session.
- **Without `paths:`** — a _baseline_ rule. It is part of the system prompt from the first request, exactly like a context file, and costs the same on every turn.

Both fields are optional, and a rule with no frontmatter at all is a baseline rule.

Details worth knowing:

- Globs are matched against the path **relative to the project root**, with forward slashes on every platform, and they match dotfiles.
- Symlinks are resolved, so a rule matches whether the tool call used the link or the real path.
- A conditional rule is injected **once per session** — the second matching file does not repeat it.
- HTML comments are stripped from a rule's body before it is sent.

## Rules from extensions

An extension can ship a `rules/` directory, and **its rules must be conditional**: a rule with no `paths:` is skipped, with a startup warning naming it. That restriction is the entire point. An extension's context file (`contextFileName`) is concatenated into every request of every session the extension is active in, with no relevance gating — in one measured session, nine extensions' context files came to 9,989 tokens, 65% of all the always-on context that session carried. A baseline extension rule would recreate exactly that, one mechanism over.

Extension rules are labelled by their owner in the prompt — `charts:rules/charting.md`, not a path climbing out of the project — so a transcript shows whose rule fired.

They are not gated on workspace trust, unlike project rules: installing an extension is already an explicit act, and the same extension can contribute MCP servers, commands, skills and an ungated context file. Requiring trust for the one mechanism that is narrower and cheaper than a context file would only push authors back to the expensive option.

**If you author an extension**, this is the migration to make:

| Content                                                                           | Put it in                                      |
| --------------------------------------------------------------------------------- | ---------------------------------------------- |
| Always-true facts — the extension's identity, its vocabulary, one hard constraint | the context file                               |
| "When working on X, do Y"                                                         | a `paths:`-gated rule, or a [skill](skills.md) |
| A procedure the model runs on request                                             | a [skill](skills.md)                           |

## Rules, skills and context files

|                             | In the prompt from the start | Loaded on demand                |
| --------------------------- | ---------------------------- | ------------------------------- |
| Context file (`QWEN.md`)    | always, in full              | —                               |
| Baseline rule               | always, in full              | —                               |
| Conditional rule (`paths:`) | nothing                      | when a matching file is touched |
| Skill                       | name + description only      | body, when the model invokes it |

A skill is the right home for a procedure the model chooses to follow; a conditional rule is the right home for a constraint that applies to a region of the codebase whether or not the model thought to look for it. Skills can also be [gated on `paths:`](skills.md#optional-gate-a-skill-on-file-paths-paths), which keeps even their listing entry out of the prompt until it is relevant.

## See also

- [Resident Context Cost](context-cost.md) — how to measure what your prefix costs, and the other levers.
- [Skills](skills.md)
- [Memory](memory.md)

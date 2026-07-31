# Desktop Harness Principles

Use this reference when designing desktop development workflows, debugging
loops, observability, or agent-facing docs.

## Source

OpenAI, "Engineering: Harnessing Codex in an agent-first world"
https://openai.com/zh-Hans-CN/index/harness-engineering/

## Principles

- Give the agent a map, not a giant manual. Keep `AGENTS.md` and skills concise
  entry points that route to focused docs, tests, and logs.
- Make the application readable to agents. UI snapshots, logs, metrics, traces,
  and runtime state should be directly inspectable without asking a human to
  copy/paste observations.
- Treat the repo as the system of record. If a fix depends on tribal knowledge,
  encode that knowledge as versioned docs, tests, lint rules, or structured
  logging.
- Build feedback loops, not one-off heroics. Reproduce, observe, patch,
  restart, and verify through the same harness until the evidence changes.
- Prefer enforceable constraints over vague preference. If a pattern matters
  repeatedly, turn it into a test, linter, helper, or review checklist.
- Use human attention for judgment. Let agents collect evidence, run tools,
  draft fixes, and verify; ask humans when product intent or risk cannot be
  inferred locally.

## Desktop Application Pattern

For qwen-code desktop work, the harness is:

1. Desktop runtime logs under `~/Library/Logs/@craft-agent/electron/`.
2. Domain-specific logs such as `~/.craft-agent/logs/messaging-gateway.log`.
3. Chrome DevTools MCP snapshots, console messages, network details, and heap
   snapshots.
4. Focused package tests and typechecks under `packages/desktop`.
5. Small repo artifacts under `.qwen/` for investigations, E2E notes, and skill
   improvements.

When one of these is missing or hard to read, consider improving the harness as
part of the development task.

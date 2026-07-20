# Agentix integration for Qwen Code

This fork adds a Qwen-side adapter for the external Agentix memory service. It
does not contain, import, or inspect the private memory sidecar implementation.

## Changes from upstream

- Adds an optional recalled-memory snapshot to outbound model context.
- Preserves complete curated Qwen history when a conversation has no snapshot.
- Keeps only the active turn after a valid snapshot assumes cross-turn context.
- Supports an opt-in external training and snapshot refresh during compression.
- Coalesces concurrent training requests and fails back to retained history.
- Adds tests for zero-state behavior, snapshot isolation, failure handling, and
  standard Qwen compression.

## Safe defaults

The unified launcher in
[`ahsan3274/agentix-qwen-cli`](https://github.com/ahsan3274/agentix-qwen-cli)
uses an isolated short-term directory and disables automatic training:

```bash
export QWEN_AGENTIX_AUTO_TRAIN=0
export QWEN_MEMORY_SNAPSHOT_DIR="$HOME/.agentix-coder/short-term"
```

This leaves normal same-conversation history and standard compression
authoritative. Long-term memory remains explicitly available through the
published `qwen-agentix` interface.

Automatic memory refresh is opt-in with `QWEN_AGENTIX_AUTO_TRAIN=1`. Qwen then
invokes only the configured external commands and reads their published
snapshot; it does not access sidecar internals.

## Validation

From `packages/core`:

```bash
npx vitest run \
  src/services/agentixMemoryContext.test.ts \
  src/services/agentixMemoryTrainer.test.ts \
  src/services/chatCompressionService.test.ts \
  src/core/geminiChat.test.ts
```

The integration passes 99 targeted tests and the complete Qwen monorepo build.

The public memory policy and Explorer live in
[`ahsan3274/agentix`](https://github.com/ahsan3274/agentix).

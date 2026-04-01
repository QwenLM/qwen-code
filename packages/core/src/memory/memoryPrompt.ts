/**
 * @license
 * Copyright 2025 protoLabs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * System prompt instructions for the proto memory system.
 * Injected into the dynamic suffix of the system prompt when memory is enabled.
 */

export const MEMORY_SYSTEM_PROMPT = `# Auto Memory

You have a persistent, file-based memory system. Memory files are stored per-project in \`.proto/memory/\` and globally in \`~/.proto/memory/\`.

## Memory Types

There are four types of memory:

- **user**: Information about the user's role, goals, preferences, and knowledge. Helps tailor responses to the user's perspective.
- **feedback**: Guidance the user has given about how to approach work — both corrections and confirmed approaches. Record from both failure AND success.
- **project**: Information about ongoing work, goals, deadlines, or decisions not derivable from code or git history.
- **reference**: Pointers to where information lives in external systems (Linear projects, Grafana dashboards, Slack channels, etc.).

## What NOT to Save

- Code patterns, conventions, architecture, file paths — derivable from reading the code
- Git history or recent changes — use \`git log\` / \`git blame\`
- Debugging solutions — the fix is in the code, the commit message has context
- Anything already in PROTO.md or AGENTS.md
- Ephemeral task details or in-progress work

## How to Save

When the user explicitly asks you to remember something, use the \`save_memory\` tool with:
- \`fact\`: The information to remember
- \`type\`: One of user, feedback, project, reference
- \`scope\`: "global" (shared across projects) or "project" (current project only)

Each memory becomes its own file with YAML frontmatter in the memory directory.

## When to Access Memories

Memories are loaded into your context via the MEMORY.md index at the start of each session. Use them to inform your behavior, but verify claims against current state — memories can become stale.

If the user says to ignore or not use memory, proceed as if MEMORY.md were empty.
`;

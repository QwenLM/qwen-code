# Swarm Tool (`swarm`)

Use `swarm` to run many independent, simple tasks through ephemeral worker
agents and return a structured aggregate result to the parent agent.

Swarm is intended for map-reduce style work:

- analyzing many files independently
- processing chunks of a large data file
- running independent searches where the first successful result is enough
- collecting per-item summaries, counts, or validation results

For a few complex role-based tasks, use the [`task`](./task.md) tool instead.
For model comparison on the same task, use Agent Arena.

## Arguments

- `description` (string, required): Short description of the overall swarm job.
- `tasks` (array, required): Independent tasks. Each task becomes one worker.
  - `id` (string, optional): Stable identifier returned in results.
  - `description` (string, required): Short per-worker description.
  - `prompt` (string, required): Complete instructions for the worker.
- `mode` (`wait_all` or `first_success`, optional): Defaults to `wait_all`.
- `max_concurrency` (number, optional): Maximum workers to run at once.
- `max_turns` (number, optional): Maximum model/tool turns per worker.
  Defaults to `8`.
- `timeout_seconds` (number, optional): Per-worker wall-clock timeout.
- `worker_system_prompt` (string, optional): Shared worker system prompt.
- `allowed_tools` (string array, optional): Tool allowlist for workers.
- `disallowed_tools` (string array, optional): Tools removed from workers.

If `max_concurrency` is omitted, Qwen Code uses
`QWEN_CODE_MAX_SWARM_CONCURRENCY`, then `QWEN_CODE_MAX_TOOL_CONCURRENCY`, then
`10`.

## Result

The tool returns JSON to the parent agent with:

- `summary.total`
- `summary.completed`
- `summary.failed`
- `summary.cancelled`
- `summary.notStarted`
- `results[]` with one entry per task, including `taskId`, `status`, `output`
  or `error`, duration, and execution stats when available

Individual worker failures do not abort the whole swarm. The parent agent is
responsible for reading the aggregate result and presenting the final answer.

## Examples

Analyze files in parallel:

```text
swarm(
  description="Extract function names",
  tasks=[
    {
      id="src/a.ts",
      description="Analyze src/a.ts",
      prompt="Read /repo/src/a.ts and return the exported function names."
    },
    {
      id="src/b.ts",
      description="Analyze src/b.ts",
      prompt="Read /repo/src/b.ts and return the exported function names."
    }
  ],
  max_concurrency=10
)
```

Use first successful result:

```text
swarm(
  description="Find API route definition",
  mode="first_success",
  tasks=[
    {
      description="Search routes directory",
      prompt="Search /repo/src/routes for the user creation route."
    },
    {
      description="Search controllers directory",
      prompt="Search /repo/src/controllers for the user creation route."
    }
  ]
)
```

## Notes

Workers are lightweight and ephemeral: they are spawned, execute one task,
return a result, and are cleaned up. Workers cannot spawn further subagents or
cron jobs.

Swarm workers run concurrently, so interactive permission prompts are avoided.
Permission hooks can still approve actions, and permissive approval modes still
apply where configured. Prefer read-only or disjoint file scopes for swarm
tasks.

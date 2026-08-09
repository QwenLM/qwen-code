# Multi-Agent Coordination

Qwen Code can coordinate several same-model teammates with the experimental Agent Team runtime. Teammates receive separate tasks, share a task list, exchange messages, and appear in the existing Agent View tabs.

## Enable Agent Team

Set `experimental.agentTeam` to `true` in Qwen Code settings and restart, or start Qwen Code with `QWEN_CODE_ENABLE_AGENT_TEAM=1`.

## Run a coordinated task

Use the bundled skill with a goal:

```text
/coordinate investigate the authentication regression and propose the smallest fix
```

The leader creates a team, assigns up to three independent workstreams, and uses the existing team tools for messages and task state. Teammate conversations and approvals remain visible through the existing Agent View UI. The leader reconciles the evidence and remains the only writer in the shared checkout.

If Agent Team is disabled, `/coordinate` can still use ordinary foreground agents for read-only parallel investigation. That fallback is delegation, not a collaborating team: the workers report only to the leader.

## Choosing the right multi-agent mode

| Mode                          | Use it for                                                      | Communication                      | Workspace behavior                         |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| `/coordinate` with Agent Team | Different workstreams contributing to one result                | Shared tasks and teammate messages | Leader-only writes in the shared checkout  |
| Subagents                     | Small delegated tasks                                           | Worker reports to parent           | Depends on the selected agent              |
| Arena                         | Several models competing on the same task                       | Agents do not collaborate          | Isolated worktrees; one winner is selected |
| Herdr                         | Coordinating different CLI products or remote terminal sessions | External terminal-level control    | Managed outside Qwen Code                  |

The current workflow deliberately reuses the in-process Agent Team runtime and Agent View UI. Persistent independent PTY sessions, cross-vendor workers, and remote attach are separate product concerns and are not implemented by `/coordinate`.

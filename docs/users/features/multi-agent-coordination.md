# Multi-Agent Coordination

Qwen Code can coordinate several teammates with the experimental Agent Team runtime. Teammates receive separate tasks, share a task list, exchange messages, and appear in the existing Agent View tabs. `/coordinate` defaults investigation workers to an enforced read-only tool set and can place one writer in a leader-owned Git worktree.

## Enable Agent Team

Set `experimental.agentTeam` to `true` in Qwen Code settings and restart, or start Qwen Code with `QWEN_CODE_ENABLE_AGENT_TEAM=1`.

## Run a coordinated task

Use the bundled skill with a goal:

```text
/coordinate investigate the authentication regression and propose the smallest fix
```

The leader creates a team, assigns up to three independent workstreams, and uses the existing team tools for messages and task state. Teammate conversations and approvals remain visible through the existing Agent View UI. Read-only teammates cannot execute shell commands or write files. If implementation is needed, the leader can create one Git worktree and pin one writer teammate to it; the leader remains the only merge authority for the current branch.

If Agent Team is disabled, `/coordinate` can still use ordinary foreground agents for read-only parallel investigation. That fallback is delegation, not a collaborating team: the workers report only to the leader.

## See who is working

While a team is active, its teammates appear in the roster the CLI already shows below the composer, alongside ordinary background subagents. Each row carries the teammate's name in its assigned color, the shared task it currently owns, its state, and elapsed time. Pressing Enter on a teammate row opens that teammate's existing Agent View tab rather than the background-task detail view.

Idle is reported as its own state, distinct from completed: an idle teammate has finished its current task and is waiting for the next one, so it can still be given work. A completed, failed, or cancelled teammate stays visible briefly so a terminal outcome is not missed.

The same team state reaches Web Shell when the session runs under `qwen serve`: teammates appear in the environment sidebar and the session workflow view with their current shared task and state. Web Shell shows team rows as status only — teammate conversations stay in the CLI's Agent View tabs. Teammate tool approvals do surface in Web Shell, labelled with the teammate that asked, and answering one there releases or rejects that teammate's tool call.

## Choosing the right multi-agent mode

| Mode                          | Use it for                                                      | Communication                      | Workspace behavior                                          |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------- |
| `/coordinate` with Agent Team | Different workstreams contributing to one result                | Shared tasks and teammate messages | Enforced read-only workers; optional single worktree writer |
| Subagents                     | Small delegated tasks                                           | Worker reports to parent           | Depends on the selected agent                               |
| Arena                         | Several models competing on the same task                       | Agents do not collaborate          | Isolated worktrees; one winner is selected                  |
| Herdr                         | Coordinating different CLI products or remote terminal sessions | External terminal-level control    | Managed outside Qwen Code                                   |

The current workflow deliberately reuses the in-process Agent Team runtime and Agent View UI. Teammates normally inherit the session model, although an agent definition can override it. Persistent independent PTY sessions, cross-vendor workers, and remote attach are separate product concerns and are not implemented by `/coordinate`.

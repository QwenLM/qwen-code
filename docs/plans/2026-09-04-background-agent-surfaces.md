# Where a background agent shows up

> Status: decision recorded, one surface unbuilt
> Baseline: `678ac2e1ec` (`origin/main`, 2026-09-03)
> Implements the CLI half in #10942, #10943, #10949. The Web Shell half is the open part.

## 0. The decision, first

**The Agent View roster is the authority on background agents. Every other surface reads it.**

The alternative — letting the daemon keep its own idea of what is running in the background — is what produced the situation in §1, and adding a Web Shell panel on top of the daemon's model would make it permanent.

One consequence to state plainly, because it is the part that costs work: the daemon does not read the roster today and will need to. That is a reader, not a new model.

## 1. Three things already answer "what is running"

Measured at `678ac2e1ec`.

| Model                     | Written by                                                                | Stored at                                                                   | Read by                                                                |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **Live-process registry** | every interactive session, unconditionally (`startInteractiveUI.tsx:421`) | `~/.qwen/sessions/<pid>.json`                                               | `qwen sessions ps`, peer messaging discovery (`ipc/peer-directory.ts`) |
| **Agent View roster**     | the supervisor (`supervisor-store.ts`)                                    | `~/.qwen/daemon/roster.json` + `~/.qwen/jobs/`                              | `qwen sessions ps` (#10942), `peek`/`answer`/`stop` (#10949)           |
| **Daemon sessions**       | `qwen serve`                                                              | daemon process memory (`serve/conversations/standalone-session-service.ts`) | Web Shell                                                              |

The third does not know about the first two: `rg 'listLiveSessions|session-registry' packages/cli/src/serve` returns nothing across 94,136 lines.

Only the roster carries a background agent's _semantic_ state — `needs_input`, `working`, `failed` — because only the supervisor is told by the worker. The registry knows a process is alive. The daemon's model knows a conversation exists. Neither can answer "is it stuck waiting for me", which is the only question a background agent surface exists to answer.

That is the whole argument for the decision in §0.

## 2. What the CLI half already does

- `qwen --bg "<prompt>"` records a session and a supervisor spawns it (#10943).
- `qwen sessions ps` lists managed sessions beside interactive ones, deduplicated by session id, each with its real state (#10942).
- `qwen sessions peek | answer | stop <id>` reads the question, answers it, ends the session (#10949).

**A background session is peer-addressable for free.** The worker is launched as `qwen --session-id <id> --prompt-interactive=<prompt>` (`supervisor-dispatch.ts:196`), which is a full interactive session, so it registers in the live-process registry and — when `agents.crossSessionMessaging` is on — binds a peer inbox. It therefore appears in another session's `list_agents` and can be addressed with `send_message`, with no code that makes it so.

This is worth naming because it decides what the Web Shell should _not_ build: a background agent is already reachable by the messaging tier. The Web Shell needs to show it, not to invent a second way to talk to it.

## 3. The unbuilt surface

A Web Shell panel that lists background agents and lets one be answered. Concretely:

1. A daemon route that reads the roster — `listAgentViewSessionSnapshots()` plus `deriveAgentViewPresentation`, which is exactly what `managed-rows.ts` does for the CLI. Same source, same labels, no third vocabulary.
2. A panel that renders the rows and posts an answer back through the supervisor's existing `answer` operation.

Two rules for whoever builds it:

- **Do not add a fourth model.** If the daemon needs to remember something about a background agent, it belongs in the roster.
- **Label by task state, not by display group.** The roster's group folds `ready`, `stopped` and `failed` into `completed`; the roster UI can afford that because it also paints an icon tone. Any surface without a second channel must not print "completed" beside a session that failed — see `managed-rows.ts`.

## 4. Left to a human

**Should daemon-owned sessions adopt into the roster?** `qwen serve` starts sessions of its own (scheduled tasks, channel workers). They are background agents by any user's definition, and under §0 they would be visible in `qwen sessions ps` too. The supervisor already has an `adopt` operation for exactly this shape. Doing it means the daemon writes to the roster as well as reads it, which is a larger change than the panel and should be decided on its own.

Not proposed here: moving the live-process registry or the daemon's session model under the roster. They answer different questions and both have consumers.

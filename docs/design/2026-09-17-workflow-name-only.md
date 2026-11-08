# Named-workflows-only lock

[中文](./2026-09-17-workflow-name-only.zh-CN.md)

Tracking issue: #11013, item 12 (remaining part).

Status: implemented in #12078.

## Problem

A deployment can let the model start the workflows an extension ships (`whenToUse`, #11957) and can scope approvals to a workflow by name or path (#11943). It had no way to stop the same model from writing an inline script of up to 1,000 agents and running it. An inline script has no name or path to write a permission rule against, so once a deployment relaxed approvals for its named workflows, inline scripts went through as well.

## Decisions

### The switch

`tools.workflowNameOnly` (default `false`) or `QWEN_CODE_WORKFLOW_NAME_ONLY=1` turns the lock on. `Config.isWorkflowNameOnly()` decides it once, when the session starts: the Workflow tool builds its description and parameter schema at startup, and a lock that changed under them would leave the model holding a contract the tool no longer honours.

A workspace may turn the lock on but not off. The key is a tighten-only setting: a workspace `true` is honoured, and a workspace `false` under an operator's `true` is dropped with a warning. The environment variable is excluded from project `.env` files, so repository content cannot unset an operator's exported value.

### What is locked

| Source                                                       | Locked session | Why                                                                                                                                      |
| ------------------------------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `script`                                                     | refused        | Code the model writes in the session has no identity a rule can match.                                                                   |
| `scriptPath`                                                 | refused        | Every saved workflow is reachable by name; a path adds nothing a name cannot say, and the generated-scripts root is a runtime directory. |
| `name`, and `name` with `resumeFromRunId`                    | allowed        | A `Workflow(name:…[,sha256:…])` rule matches it.                                                                                         |
| `workflow({ scriptPath })` inside a script the model started | refused        | The same rule, one level down. `workflow('<name>')` still works.                                                                         |

A source counts the way parameter validation counts it: an empty `script` or `scriptPath` beside a `name` does not refuse a call that runs by name.

### The lock constrains the model, not the host

The refusal sits in the tool's `build`, the entry every model and client call takes, including the interactive slash command's `schedule_tool`. Runs a host starts over ACP — `run-saved`, `run-script`, retry and rerun — go through `buildSessionOwnedBackground`, which shares parameter validation but not `build`, and are not restricted. The nested refusal follows the same line: the tool asks the runner for it only on a call it built for the model or a client, so a host script may still nest by path.

### What the model is told

A locked session tells the model the rule instead of letting it find the rule by failing:

- The parameter schema omits `script` and `scriptPath`. `name` is not made `required`, because the host's runs validate against the same schema and start from a script.
- The description replaces the authoring pointer with a "Named workflows only" section, and its shared decision and runtime text lose the sentences that send the model to `scriptPath` or to editing a persisted script. A test holds that no such advice survives outside the section.
- The `workflow` keyword reminder steers toward `{ name, args }` instead of authoring a script. The lock is read before anything else in that path can fail.
- The interactive `/<name>` command dispatches by name.

### Resuming by name

Outside the lock, resume calls keep naming the script path, so existing `Workflow(scriptPath:…)` grants keep matching. In a locked session a path is refused, so the resume call names the workflow — but only a name that leads back to the script the run executed. A workflow name can be recorded from a path in a subdirectory, from a user workflow a same-named project workflow shadows, or carried over by a retry that fell back to the run's inline copy; resuming by such a name would run a different script, or none. The runner therefore resolves the name once, as the run starts, and records it as the run's `resumeName` only when it resolves to the same file. A run without one gets no resume call; its failure notice says that only whoever started it can retry it.

The lock itself lives in one place, the Config. The Config hands it to the workflow run registry it owns, which reads it when a notification offers a resume call; the tool and the keyword reminder read the Config.

### Hosts

`workflowToolFeatures.nameOnly` in `GET /session/:id/supported-commands` reports the lock, so a host knows the model is restricted while its own `run-script` still starts runs.

## Differences from Claude Code

Claude Code's `CLAUDE_WORKFLOW_NAME_ONLY` refuses `script`, `scriptPath` and `resumeFromRunId`, limits resolution to built-in workflows, and refuses a nested `workflow({ scriptPath })` for every run. Qwen Code has no built-in workflows, and the lock serves deployments that start named runs and resume them, so it keeps every name tier (project, user, extension), allows a named resume, and leaves host-started runs unrestricted.

## Related fix

The tighten-only merge compared a workspace value against the stricter of User and SystemDefaults, while the merge lets User override SystemDefaults. With SystemDefaults stricter and User looser, a workspace value equal to SystemDefaults was dropped as "no change" although the value in force was User's. The baseline is now the value in force without the workspace: User's when User sets the key, otherwise SystemDefaults', otherwise the default. This also affects `agents.crossSessionMessaging` and `agents.crossSessionInbound`.

## Limits and risks

- The lock makes every run the model starts addressable by a name rule; it does not approve or block anything by itself. The model can still save a new workflow file and run it by name, which an approval rule scoped to specific names or script digests will ask about.
- In a locked session the `/review` workflow fan-out is unavailable, because it runs a generated script by path. The review skill already reports an unavailable tool and stops.
- The resume name is checked when a run starts. A workflow file added or removed afterwards is not reflected.

## Not in scope

- A bundled `deep-research` workflow (the other remaining part of item 12).
- An allowlist of name sources.
- Changing the lock during a session.

## Verification

- Unit tests cover each refused and accepted source, the host runs (script, script path, nested path), the schema and description shapes, the resume name when it matches and when it does not, the notices, the keyword reminder when the registry throws, the slash command, the Config's start-time decision, the tighten-only baseline for this key and for `crossSessionInbound`, and the ACP flag.
- Hand-made mutations of each new branch fail at least one test.

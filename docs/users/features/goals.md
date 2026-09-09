# Goals

A Goal keeps Qwen Code working across turns until a stated condition is met. Set one with `/goal <objective>`, and the session keeps going on its own. Each turn is recorded as evidence; when the model proposes that the objective is complete or blocked, an independent verifier judges that proposal from the evidence alone. The session stops when the verifier accepts, or when the Goal is paused, cleared, or stopped by a limit.

## Commands

| Command                  | Behavior                                                      |
| ------------------------ | ------------------------------------------------------------- |
| `/goal`                  | Show the current Goal and its status.                         |
| `/goal <objective>`      | Create a Goal, or replace the active one.                     |
| `/goal set <objective>`  | Same as above, explicit form.                                 |
| `/goal edit <objective>` | Revise the active Goal's wording without starting over.       |
| `/goal pause` / `resume` | Stop or continue the loop without losing the Goal.            |
| `/goal clear`            | Remove the Goal.                                              |
| `/goal-draft <intent>`   | Have the objective written for you before you set it (below). |

Creating, editing, or resuming a Goal requires a trusted workspace (`/trust`). Headless usage is covered in [Headless Mode](./headless.md#run-a-persistent-goal).

Once a Goal has billed a turn, the footer pill and every status card show what it has spent against the window it is allowed, as `1.2k/30.0m`. The figure counts the model calls the Goal makes in its own turns; subagents and the verifier's own checks are not included. The window is set by [`model.goalTokenBudget`](../configuration/settings.md); resuming a Goal that has spent its window grants another one on top of what it has already spent, so the figure reads `30.0m/60.0m` rather than starting over. A Goal with no budget shows only what it has spent. A Goal that has not billed a turn yet shows no figures at all.

Each turn the session takes on its own reports what the Goal has spent so far, how many turns are behind it, and — unless the Goal runs unbounded — the window it is allowed. Every such turn except the final wind-down hand-off also carries standing instructions to re-check the workspace rather than trust earlier turns' reports, to work toward the end state the objective asks for, to do something different when the previous turn changed nothing (from the second turn on, once there is a previous turn to judge), and to check every requirement against citable evidence before proposing that the Goal is done.

A long Goal periodically compresses the evidence it has recorded into checkpoint claims with a side model check, so later turns and the verifier still have it to cite. The check is bounded by [`model.goalCheckpointTimeoutSeconds`](../configuration/settings.md), 180 seconds by default. If its claims overrun the aggregate byte budget, or include a claim over the per-claim character limit, it makes one corrective model call and both calls share that ceiling. A check that does not finish in time is abandoned as inconclusive; it counts toward the checkpoint stall limit only when the evidence window has overflowed, while a non-overflowing check preserves the streak and retries on a later turn. The calls are streamed, so the per-request transport timeout bounds only connect and first response, and the ceiling itself stops at the stream guards' 15-minute lifetime cap because past that the guard, not the setting, ends the check. That 15-minute limit on the setting is fixed, and raising the stream guard's own cap does not lift it.

## Interrupting a Goal

Cancelling a Goal turn pauses the Goal. Press Esc while the model is answering or while its tools are still running, and the turn stops, the Goal moves to `paused`, and the card and `/goal` both say why it stopped. Nothing continues until you run `/goal resume`.

Typing a message while a Goal is active does not pause it. Your message runs as the next Goal turn, so use it to steer the work; use `/goal pause` or `/goal clear` to stop it.

Every pause states its reason: that you interrupted it, that you ran `/goal pause`, that the session token limit blocked the next model request, that the turn failed, or that three turns in a row recorded nothing the verifier could judge and no proposal — Goal bookkeeping reads (`get_goal`, `update_goal`) do not count as progress. A Goal stopped by a limit keeps the reason for that limit instead.

## How a Goal is judged

The verifier never runs commands or reads files on its own. It only sees what is already in the transcript:

- Visible assistant output and tool results count as evidence. The objective text, your prompts, and the model's hidden reasoning do not.
- Printed text proves only that text was printed. A claim that tests pass, a file changed, or a remote is updated needs the corresponding tool result in the transcript.
- A claim that you confirmed, chose, or approved something needs a real message from you; the verifier rejects proposals that assume it.
- When evidence is missing the verdict is "not yet", not "done". A condition nobody can evidence keeps the loop running until a limit stops it.

So the objective has to make the agent produce evidence: run the named check and show the decisive output.

## Writing a good objective

Put these into the objective, in this order:

| Part         | What to write                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `Outcome:`   | One sentence: what is true when this is done.                                                                                         |
| `Done when:` | Numbered, binary checks. At least one names a command and its expected exit code or output line, and asks for that line to be pasted. |
| `Must not:`  | Files not to touch, tests or thresholds not to weaken, irreversible actions (push, delete, publish) not to take.                      |
| `Budget:`    | When to give up: "stop as blocked after 20 turns" or a time limit.                                                                    |
| `On block:`  | What to report when stuck, and which decision a human must make.                                                                      |
| `Context:`   | Only facts the agent cannot find in the workspace: branch, environment, earlier decisions.                                            |

Keep it to one objective. `/goal set` and `/goal edit` accept any length, but stay roughly under 1,200 characters: the objective is re-sent on every Goal turn. An objective the model proposes through `propose_goal` is capped at 1,500 characters. Both commands collapse newlines to spaces, so number the items rather than relying on line breaks.

`Budget` is an instruction to the model about when to stop and report a blocker. Writing a turn count or time limit in the objective does not configure a runtime timer or change the Goal's token budget.

| Weak                       | Why it fails                                                | Stronger                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| make checkout faster       | No threshold, no check.                                     | `Outcome: checkout p95 is below 250 ms. Done when: 1) npm run bench:checkout exits 0 and prints p95 < 250 (paste the line); 2) npm test exits 0. Must not: change the benchmark or skip tests. Budget: stop as blocked after 20 turns.` |
| clean up the auth module   | "Clean" has no evidence.                                    | Ask what would be observable: zero lint warnings in `src/auth`, a coverage threshold, a file count.                                                                                                                                     |
| ship the release           | Irreversible, and needs a human decision.                   | Narrow to a checkable pre-release state (tag exists, `npm run release:dry-run` exits 0) and put "do not publish" in `Must not`.                                                                                                         |
| after I confirm the design | The verifier cannot see a confirmation that never happened. | Move it to `On block:` as the decision a human must make.                                                                                                                                                                               |

## Let `/goal-draft` write it

`/goal-draft <what you want done>` is a bundled skill that does the above for you. It reads only enough of the workspace to establish the scope and real verification commands, without running tests, building, installing dependencies, or starting services. It asks at most one round of questions when essential choices are unclear, then writes a compact objective, usually with 3–5 completion checks (fewer when enough). Explicit requirements are preserved; it does not add checks just to reach a count.

For an audit, completion means covering the agreed scenarios and reporting evidence, including reproduction steps for confirmed defects. Finding no defects is a valid result. The draft should not invent a minimum number of scenarios, evidence files, exploration rounds, or defects.

If a success criterion, command, input path, or essential decision cannot be established, the skill returns a draft marked "Needs clarification" with `<TODO: …>` items. It does not offer that draft for approval or print a runnable `/goal set` or `/goal edit` command. Nonessential defaults are marked `[ASSUMPTION]`; they do not stand in for missing success criteria.

Once the objective is ready, an interactive terminal session can show the `propose_goal` approval dialog described below. Web Shell and other ACP clients, headless runs, sessions with the tool disabled, and sessions with an active Goal receive a command to run manually instead. The hand-off says that the draft has not been applied. The skill never starts the work itself, and nothing is set without your approval.

Pass an existing objective to tighten it: `/goal-draft all tests pass and the lint is clean`. For an active Goal, an explicit request to tighten it produces `/goal edit`; a replacement uses `/goal set`. If the intended operation is unclear, the skill includes that choice in its single round of questions.

### Approve a Goal the model proposes

In an interactive terminal session the model has a `propose_goal` tool. When `/goal-draft` finishes, or when you ask for an outcome that spans several turns, it can propose the objective instead of printing a `/goal set …` line for you to copy. The proposal appears as an approval dialog showing the full objective. Approving it sets the Goal exactly as `/goal set` would, the moment the current turn ends (the model acknowledges and stops; the first Goal turn then starts on its own), and declining sets nothing — the model sees only that the tool call was not allowed, and its instructions tell it not to ask why and not to propose the same objective again. The approval is bound to the turn that asked for it: if that turn is cancelled or otherwise never reaches its end, the approval is dropped rather than applied under a later message or an automated turn. No permission rule or approval mode (including YOLO) skips this dialog, and the tool refuses while another Goal is active, in plan mode, and in untrusted folders; subagents are never offered it. It is not available in headless runs, nor yet in Web Shell or other ACP-driven sessions (they do not pass through the turn boundary that applies the approval); there the printed `/goal set` line remains the hand-off.

Turn it off with `goals.modelProposed: "disabled"` in your user settings. Because the setting decides whether the model may ask you to start an autonomous loop, it is honored only from user and system scope; a workspace `.qwen/settings.json` value is ignored with a warning.

The skill is instructed to be read-only, and only its non-mutating tools are auto-approved (`get_goal`, `read_file`, `glob`, `grep_search`). `ask_user_question` is deliberately not auto-approved, so its question dialog is shown before the skill drafts from your answers. Like other bundled skills, a project or personal skill named `goal-draft` overrides it, and `skills.disabled` can turn it off. See [Skills](./skills.md) for how bundled skills are discovered.

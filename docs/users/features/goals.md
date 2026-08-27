# Goals

A Goal keeps Qwen Code working across turns until a stated condition is met. Set one with `/goal <objective>`; after each turn an independent verifier checks the transcript, and the session keeps going until the objective is verified complete, verified blocked, paused, or cleared.

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

Keep it to one objective and roughly under 1,200 characters. `/goal set` and `/goal edit` collapse newlines to spaces, so number the items rather than relying on line breaks.

| Weak                       | Why it fails                                                | Stronger                                                                                                                                                                                                                                |
| -------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| make checkout faster       | No threshold, no check.                                     | `Outcome: checkout p95 is below 250 ms. Done when: 1) npm run bench:checkout exits 0 and prints p95 < 250 (paste the line); 2) npm test exits 0. Must not: change the benchmark or skip tests. Budget: stop as blocked after 20 turns.` |
| clean up the auth module   | "Clean" has no evidence.                                    | Ask what would be observable: zero lint warnings in `src/auth`, a coverage threshold, a file count.                                                                                                                                     |
| ship the release           | Irreversible, and needs a human decision.                   | Narrow to a checkable pre-release state (tag exists, `npm run release:dry-run` exits 0) and put "do not publish" in `Must not`.                                                                                                         |
| after I confirm the design | The verifier cannot see a confirmation that never happened. | Move it to `On block:` as the decision a human must make.                                                                                                                                                                               |

## Let `/goal-draft` write it

`/goal-draft <what you want done>` is a bundled skill that does the above for you. It checks whether the request is a Goal at all, reads the workspace for the real test and lint commands instead of guessing, asks at most one round of multiple-choice questions when the answer changes the check or the scope, drafts the objective in the format above, runs the self-check, and hands it over: in an interactive session it proposes the objective through the `propose_goal` approval dialog described below, otherwise it prints a `/goal set …` line you can run as-is. It never starts the work itself, and nothing is set without your approval.

Pass an existing objective to tighten it: `/goal-draft all tests pass and the lint is clean`.

### Approve a Goal the model proposes

In an interactive TUI or Web Shell session the model has a `propose_goal` tool. When `/goal-draft` finishes, or when you ask for an outcome that spans several turns, it can propose the objective instead of printing a `/goal set …` line for you to copy. The proposal appears as an approval dialog showing the full objective. Approving it sets the Goal exactly as `/goal set` would, the moment the current turn ends (the model acknowledges and stops; the first Goal turn then starts on its own), and declining sets nothing — the model is told only that the Goal was not set, and must not propose it again. If you cancel the turn after approving, the approval is dropped rather than applied under your next message. No permission rule or approval mode (including YOLO) skips this dialog, and the tool refuses while another Goal is active, in plan mode, in subagents, and in untrusted folders. It is not available in ACP or headless runs, where the printed `/goal set` line remains the hand-off.

Turn it off with `goals.modelProposed: "disabled"` in your user settings. Because the setting decides whether the model may ask you to start an autonomous loop, it is honored only from user and system scope; a workspace `.qwen/settings.json` value is ignored with a warning.

The skill is instructed to be read-only, and only its non-mutating tools are auto-approved (`get_goal`, `read_file`, `glob`, `grep_search`). `ask_user_question` is deliberately not auto-approved, so its question dialog is shown before the skill drafts from your answers. Like other bundled skills, a project or personal skill named `goal-draft` overrides it, and `skills.disabled` can turn it off. See [Skills](./skills.md) for how bundled skills are discovered.

# Workflow authoring reference as a bundled skill

[中文](./2026-09-10-workflow-authoring-skill.zh-CN.md)

Tracking issue: #11013, item 4.

## Problem

The Workflow tool's description carried the whole authoring contract: the
orchestration policy, every `agent()` option with the error strings a script
compares against, and the fan-out patterns. It was about 17,000 characters
between the description and the `script` parameter, sent in the tool
definition of every turn. Only the turn that writes a script needs it.

## Decision

The authoring contract moves into a bundled skill, `workflow-authoring`
(`packages/core/src/skills/bundled/workflow-authoring/SKILL.md`). The tool
surface keeps what a model needs to decide whether to call the tool and to read
back a result it did not author: the opt-in rule, the limits, the
`null`-versus-throw contract, and the run handle.

`SKILL.md` is the only source of the reference. Its numbers are literals, and
its test pins each one that has an exported runtime constant against that
constant. The wall-clock cap and the concurrency formula have no exported
constant and stay literals on both sides.

## How the reference reaches the model

`resolveWorkflowAuthoringRoute` decides one of four routes when the Workflow
tool is constructed. The order matters: a user opt-out wins over the lack of a
Skill tool.

| Route                   | When                                                                                    | Description shape                                                     |
| ----------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `withheld`              | The skill is disabled by name, or the bundled level is disabled                         | Decision and runtime, nothing about the reference                     |
| `inline`                | No SkillManager, the Skill tool is not registered, or it is deferred with no ToolSearch | Decision and the full reference                                       |
| `skill-via-tool-search` | The Skill tool is deferred by a `tools.eager` allowlist and ToolSearch is registered    | Decision, runtime, pointer, and a note to reveal the Skill tool first |
| `skill`                 | Otherwise, including when the config cannot answer                                      | Decision, runtime, and a pointer                                      |

An `inline` route with an unreadable `SKILL.md` falls back to the pointer, the
only remaining text that names the reference.

Withholding instead of inlining matters for users who disable the skill. They
asked for this text to go away, and inlining would put it back into every
request at a higher cost.

The inline shape leaves out the runtime paragraph because the reference states
all of it. Two copies of each number in one string is how they drift apart.

## One decision, recorded

The Workflow tool records the result as `authoringSurface`. Every other surface
that talks about the reference reads that record instead of re-deriving it:

- the `script` parameter's closing sentence;
- the failure hint in the run trailer, in a compile failure, and in a failed
  background run's completion notification;
- the `workflow` keyword reminder in the CLI.

The description is built once, so a `/skills` toggle mid-session takes effect
on restart. Reading the record keeps the other surfaces consistent with the
description the model already holds.

## Failure hint

A script the model authored gets a hint line when it fails, when it fails to
compile, and when it fails in the background. The wording follows the recorded
shape: load the skill, or see the description. There is no hint when the
reference is withheld, when the run was cancelled, or when the script is a
saved workflow. A saved workflow is the user's file, and the resume advice
already says to copy it first.

## Keyword reminder

The `workflow` keyword reminder names the skill when the description points at
it. It does not carry the reference. The reminder is part of the user's message
text: it is rendered in the transcript, restored into the input buffer when a
queued turn is cancelled, and kept in history. A skill body travelling that way
would miss what a real Skill load gets: dedup on resume, `/context`
attribution, microcompaction, and the skill's declared side effects.

The reminder is skipped for shell-mode submissions and when the Workflow tool
is not registered.

## Not in scope

- An `ultracode` keyword, a session standing mode, or a dismiss key (item 5).
- A size guideline (item 7).
- Keyword triggers on non-TUI entry points.
- Auto-loading the reference on the keyword turn. That needs a hidden,
  history-aware message channel that does not exist today.

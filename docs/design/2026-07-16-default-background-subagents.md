# Default Background Subagents

## Summary

Top-level one-shot subagents should run in the background by default. Callers
that require an inline result can opt out with `run_in_background: false`.
Nested subagent launches and launches pinned to a caller-owned `working_dir`
remain foreground operations because the current background lifecycle cannot
safely return results to those callers. Forks and named Agent Teams teammates
keep their existing behavior.

## Motivation

The Agent tool already supports background execution across interactive,
headless, and SDK consumers, but callers must currently request it with
`run_in_background: true` or select an agent declared with `background: true`.
This makes ordinary delegation block the parent by default even when the parent
could continue independent work. Making background execution the top-level
default better matches the tool's parallel delegation guidance while retaining
an explicit foreground escape hatch for result-dependent work.

## Goals

- Run top-level one-shot subagents in the background when
  `run_in_background` is omitted.
- Preserve `run_in_background: false` as an explicit foreground opt-out.
- Preserve the existing completion notification, cancellation, concurrency,
  permission, transcript, and headless hold-back paths.
- Keep unsafe or unsupported launch shapes on their existing foreground path.
- Document the compatibility impact for skills and callers that require an
  inline result.

## Non-goals

- Background execution for nested subagent launches.
- Background execution in a caller-owned `working_dir`.
- Changes to fork context inheritance or fork lifecycle.
- Changes to named Agent Teams teammate behavior.
- A new global setting for the default.
- Redesigning background notification routing or task ownership.

## Behavior

The runtime resolves one-shot subagent execution in this order:

1. A named Agent Teams teammate uses the existing teammate path.
2. A valid top-level fork uses the existing detached fork path.
3. A nested ordinary subagent runs in the foreground, even when background was
   requested, so its result returns to the nested caller.
4. An ordinary subagent with `working_dir` runs in the foreground because the
   caller owns that worktree's lifecycle.
5. For any other top-level ordinary subagent:
   - `run_in_background: false` runs in the foreground.
   - `run_in_background: true` runs in the background.
   - an omitted `run_in_background` runs in the background.

The existing agent-level `background: true` frontmatter remains accepted for
compatibility. It is no longer necessary to obtain the new top-level default.
An explicit tool-call value of `run_in_background: false` takes precedence and
selects the foreground path.

## Implementation

The dispatch decision remains in the Agent tool so every consumer receives the
same behavior. The background decision should distinguish three concepts:

- whether the caller explicitly opted out;
- whether the launch is top-level;
- whether the launch shape can safely detach.

The implementation should reuse the existing background branch rather than add
a second launch path. Tool schema text and model-facing usage guidance should
describe background as the default and tell callers to pass
`run_in_background: false` when they need the result inline.

The `working_dir` exception must be resolved before the existing incompatibility
guard. An omitted background parameter must not turn previously valid pinned
review launches into errors. An explicit `run_in_background: true` with
`working_dir` remains invalid, preserving the existing safety check.

## Result Flow

A default-background launch returns the existing background-launch response to
the parent immediately. The detached task remains registered with the existing
background task registry. When it terminates, the registry emits the existing
completion, failure, or cancellation notification and the parent processes the
result in a later turn. No new message format or SDK event is introduced.

Foreground opt-outs continue through the existing synchronous branch and return
the sanitized subagent result inline.

## Documentation

The subagent user guide should state that named one-shot subagents run in the
background by default at the top level and explain
`run_in_background: false`. The fork comparison should focus on context
inheritance and result semantics rather than claiming that all named subagents
block the parent.

## Testing

Unit coverage should verify:

- an ordinary top-level subagent with an omitted flag launches in the
  background;
- `run_in_background: false` returns the result inline;
- `run_in_background: true` retains the existing background behavior;
- a nested launch with an omitted or true flag remains foreground;
- a `working_dir` launch with an omitted flag remains foreground;
- an explicit background request with `working_dir` remains rejected;
- fork and named teammate behavior remain unchanged;
- the tool schema and usage guidance advertise the new default and opt-out.

Existing tests that intentionally exercise the foreground branch should pass
`run_in_background: false` so their expectation is explicit. The focused Agent
tool test file, build, and typecheck are required before submission. A manual
interactive E2E check should confirm that a normal delegation returns control
immediately and later delivers a completion notification, while an explicit
foreground delegation blocks and returns its result inline.

## Risks and Compatibility

The change is behaviorally breaking for prompts, skills, and programmatic
callers that omit the flag and assume the Agent tool response contains the
subagent result. Those callers must pass `run_in_background: false`.

Default background execution can also increase concurrent work. Existing global
concurrency limits and queueing remain the controlling safeguards. Permission
handling, shutdown, and headless waiting already use the established background
task lifecycle and are not changed by this design.

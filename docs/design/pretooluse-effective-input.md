# PreToolUse effective input

[English](pretooluse-effective-input.md) | [简体中文](pretooluse-effective-input.zh-CN.md)

## Problem

The documented `hookSpecificOutput.updatedInput` was ignored. Applying it during execution would reuse permission decisions, confirmations and prepared resources belonging to the original request. ACP tools can cache a remote invocation during their default permission check; interactive tools retain answers and approval state on the invocation.

## Lifecycle

Resolve the final tool and validate the original request. Run PreToolUse once, before argument-dependent permission evaluation and preparation. An object replacement replaces the whole input, passes the media-policy gate and the tool's canonical builder, and releases the superseded invocation. Preserve call identity and invocation context. Permission rules, plan-mode shell snapshots, protected-write checks, worktree restrictions, subagent tracking, confirmation and execution use the effective request. Post-tool hooks receive that request too.

An explicit deny or stop blocks execution. Allow continues the existing permission flow. Core hook asks use one confirmation, combined with ordinary approval where needed; mandatory interaction remains on the effective invocation. ACP retains its existing ask-as-denial behavior. Cancelling during hooks or permissions prevents execution and drops additional context. Successful and failed calls retain their existing context delivery.

Sequential hooks pass the previous replacement to the following hook without merging removed fields. Parallel aggregation remains last replacement in configuration order. The undocumented sequential `tool_input` output is superseded by `updatedInput`.

Stored request arguments remain raw through confirmation and any inline edit rebuild. Hooks receive a separate normalized path view; retained paths are mapped back to their raw spelling before rebuilding, and execution keeps the existing post-hook normalization. ACP hook input contains caller arguments, not operator-injected policy fields, so an echo cannot accidentally resubmit protected configuration as caller input. Headless execution serializes argument-sensitive shell calls when PreToolUse hooks are enabled, and final structured output uses the completed effective request. Combined confirmations retain the hook's reason in the existing visible fields.

## Boundaries

The tool identity cannot be rewritten. Managed invocations are already prepared and digest-pinned before their preflight hook, and fixed-policy calls carry authorization for a specific request. Changed replacements are refused on those paths; identical input remains valid. General hook transport failure behavior is unchanged.

## Validation

Retained tests cover effective execution and post-hook input, schema rejection, deny rules, plan-mode writes, cached preparation, approval state, once-only confirmation, cancellation and pinned-input refusal. Integration tests use command-hook subprocesses and an echo MCP server on CLI and ACP surfaces. Platform and running-application evidence is reported separately; unit tests alone do not establish a desktop UI result.

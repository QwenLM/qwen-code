# Make `todo_write` opt-in

## Summary

Disable the built-in `todo_write` tool by default in every interaction mode and
allow users to restore it with `tools.todoWrite.enabled`. The default system
prompt and Agent tool description must not advertise Todo-only behavior when
the tool is unavailable.

## Motivation

`todo_write` rewrites a session checklist in a separate model turn. In
headless mode that bookkeeping is not rendered as a dedicated progress view:
text output hides the call, while JSON formats expose it only as a generic tool
event. The extra tool round therefore adds latency and tokens without providing
the interactive progress experience that originally justified the tool.

Newer models can maintain and revise a working approach without a mandatory
checklist. Qwen Code also has shared task tools for the separate agent-team use
case. Removing Todo from the default tool surface avoids steering ordinary
sessions toward bookkeeping while preserving it for users and integrations
that deliberately depend on it.

## Design

Add `tools.todoWrite.enabled`, a restart-required boolean setting whose default
is `false`. The CLI passes the resolved value into `Config`; SDK callers can use
the corresponding configuration parameter. Only this flag enables the tool.
Tool allowlists, eager-tool selection, and permission rules continue to control
registered tools but do not opt a disabled tool into existence.

When disabled:

- the tool registry does not register `todo_write`, eagerly or as a deferred
  tool;
- an attempted call returns an actionable error naming the opt-in setting;
- the default system prompt omits the Todo task-management section and all
  `todo_write` guidance while retaining adaptive planning guidance;
- the Agent tool omits `todo_id` from its model-facing schema and usage notes;
- the bundled new-application workflow does not require an unavailable tool.

When enabled, the existing Todo implementation remains unchanged. Persistence,
hooks, active-Todo reminders, ACP rendering, and the daemon Todo Stop Guard
remain downstream consumers of successful Todo calls. The Stop Guard is
therefore effective only when both it and `tools.todoWrite.enabled` are on.

Custom system prompts remain user-owned and are not rewritten. Existing
sessions may still contain historical Todo calls, but disabling the tool only
changes future tool declarations and guidance; history loading and rendering
continue to accept those records.

## Compatibility and rollout

This intentionally changes the default tool surface. Users who rely on Todo
must add:

```json
{
  "tools": {
    "todoWrite": {
      "enabled": true
    }
  }
}
```

No Todo data is deleted. Removing the setting restores the new default.

## Verification

Unit tests cover CLI setting propagation, registry behavior with the flag off
and on, prompt guidance with the flag off and on, Agent schema guidance, and
eager/deferred registration. Headless integration coverage verifies that the
default tool declaration excludes `todo_write` and that explicitly enabling
the setting restores a successful call.

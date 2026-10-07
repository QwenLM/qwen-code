# Chinese Goal Command Alias

[English](chinese-goal-alias.md) | [简体中文](chinese-goal-alias.zh-CN.md)

## Problem and scope

Issue #13317 requests `/目标` as another spelling of `/goal`. The command registry supports aliases, but Goal parsing and queue priority also recognize the literal English prefix. The alias must share dispatch, discovery, arguments, trust checks and Goal state transitions in interactive, non-interactive and ACP modes. Translating subcommands or other command names is outside this change.

## Design

Add `目标` to the existing always-on `altNames` of the Goal command. Recognize both names when parsing a full command line and when deciding whether a queued message is Goal control. The streaming consumer continues to use the existing queue predicate. Both browser composers recognize the same alias and dispatch through the existing Goal control route; the browser argument and clear-command parser shares one prefix predicate. Existing registry, restriction, completion, ACP metadata and channel consumers use the registered alias without a new locale table or runtime setting.

Both names accept the existing English `pause`, `resume`, `clear`, `set` and `edit` arguments. Prefix matching requires whitespace or the end of the command, so `/目标x` remains a different command. A queued `/目标 clear` must bypass the same Goal hold as `/goal clear`. Existing trust and disabled-command checks apply to both spellings.

## Validation and acceptance

Verify the global CLI baseline before implementation, then run command dispatch/completion, full-line parser, command restriction and held-queue tests. Verify the built CLI through its user interface with `/目标`, `/目标 pause`, `/目标 resume` and `/目标 clear`, including an unrelated command and ordinary queued message as controls. Verify the browser composers with an active Goal: `/目标 clear` must reach Goal control while an ordinary slash command remains held. Build, typecheck, formatting and relevant lint must pass. This is an alias proposal; it makes no claim that the historical downstream deployment has been retested.

## Risks and decisions

The alias is visible to all locales, like other built-in aliases. This intentionally implements the single spelling requested by #13317 and does not choose a general command-localization policy. No protocol field or configuration format changes. There are no open implementation questions within that scope.

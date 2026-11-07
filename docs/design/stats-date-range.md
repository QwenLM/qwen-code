# Custom date ranges for token usage

[English](stats-date-range.md) | [简体中文](stats-date-range.zh-CN.md)

## Problem and scope

`/stats daily` and `/stats monthly` query one calendar bucket. The dashboard offers preset periods. None accepts a user-selected start and end date, for example September 9, 2025 through July 11, 2026.

Add `/stats range <YYYY-MM-DD> <YYYY-MM-DD>` in interactive, headless, and ACP modes. Both endpoints are inclusive. This command reports persisted token usage, not historical tool calls, generation timing, or session durations. No dashboard date picker or range export syntax is included.

## Design

Add `queryTokenUsageRange(startDate, endDate)` to the existing token usage service. Validate both dates with the existing calendar validator and reject reversed ranges before reading files. List the usage directory and read only existing monthly token files intersecting the range, sequentially, to avoid work proportional to missing calendar months or unbounded concurrent reads. Filter records by their stored `localDate`, preserving the writing process's original local timezone buckets, and reuse the existing aggregation and group ordering.

The returned summary keeps the existing shape, with `period: 'range'` and `value: 'YYYY-MM-DD..YYYY-MM-DD'`. Daily/monthly query and export inputs remain unchanged. The CLI displays the existing totals and model/auth/source breakdowns under a range-specific, inclusive heading. Missing arguments, extra arguments, impossible dates and reversed dates produce errors; missing history produces zero totals. Non-ENOENT read errors propagate instead of appearing as zero usage.

## Affected files and consumers

- Core token usage service and its collocated tests: range query, shared summary period type, calendar and I/O regressions.
- CLI stats command and its tests: subcommand registration, validation, shared output and all execution modes.
- CLI locale dictionaries and user command documentation: localized labels and usage.

Existing summary consumers are the daily/monthly command formatter, CSV/JSON formatters and service tests. Only the command formatter needs a third heading; export formatters already serialize the summary's period and value without calendar interpretation. No public configuration, daemon route, persistence schema, or provider change is required.

## Validation and acceptance

Verify inclusive endpoints across months and years, same-day ranges, leap days, preserved local-date buckets, excluded adjacent days, missing months, empty history, unreadable files, invalid/reversed dates and argument arity. Exercise the real command in isolated runtime storage without model requests, and retain daily/monthly regressions. Run focused package tests, build, typecheck, bundle, formatting and lint. Record baseline and post-change results in `.qwen/e2e-tests/stats-date-range.md`.

## Risks and open questions

Only already-recorded local token history can be counted; this does not reconstruct usage predating persistence. Very large stored histories still require scanning the selected monthly files, as existing daily/monthly queries do. There are no unresolved behavior questions.

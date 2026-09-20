# Message timestamp dates

[English](web-shell-message-dates.md) | [简体中文](web-shell-message-dates.zh-CN.md)

## Problem and scope

Message timestamps already distinguish today from other dates, but monitor details show only time and scheduled task messages use a different localized format. All message-area wall-clock timestamps should use the local calendar date: `HH:mm:ss` for today and `YYYY-MM-DD HH:mm:ss` for other days, so dates remain unambiguous across days and years. Durations and sidebar session labels remain unchanged.

## Implementation

Reuse `formatTimestamp` in MessageTimestamp, preserving its local-calendar same-day comparison. Existing assistant, tool, subagent, todo, and workflow consumers inherit the format; the workflow runs page also shares this formatter. Route monitor last-event times in TasksStatusMessage and scheduled trigger times in UserMessage through it. Preserve the scheduled trigger's invalid-date fallback and existing visibility, copy actions, and timezone behavior. No new dependencies or CSS changes are needed.

## Validation and acceptance

Check current-day, past-day, cross-year, and midnight timestamps with fixed local dates. Verify normal hover and chat timestamps show only time today and include date and seconds on other days, scheduled trigger and monitor details use the same format, and missing timestamps remain hidden. Run focused component tests, build, typecheck, and browser checks using fixture data; fixture checks do not validate daemon persistence. There are no open design questions.

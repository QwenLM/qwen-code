# Managed model API failure messages

[English](2026-10-22-managed-model-api-errors.md) | [简体中文](2026-10-22-managed-model-api-errors.zh-CN.md)

## Problem and scope

A model API response such as HTTP 402 is formatted for the private Harness log, but its structured status is lost when the model stream throws a plain Error. The terminal journal records only a generic failure, and the Java projector intentionally discards arbitrary error messages. The Web Shell consequently cannot explain the failure or suggest an action.

## Change

Keep a typed model API error at the model stream boundary. Map its structured HTTP status to a fixed failure code for payment, authentication, access, timeout, rate limit, rejected requests, unavailable services, or otherwise unclassified model API failures. Only model API errors receive these codes; cancellation, deadlines, storage failures, and other existing classifications retain their current precedence.

Persist the classification through the existing terminal stopReason and turn_error code fields on both initial and recovered execution paths. Project a fixed, actionable English message in the CLI and Java; never publish the provider response body, headers, credentials, paths, or arbitrary exception text. The Web Shell translates known failure codes for its summary banner and retains the existing fallback for unknown codes. Page-only translations stay with the page so transcript exports do not bundle these UI hints. No public schema or storage migration is required.

## Constraints and validation

This change does not alter billing, credentials, model selection, automatic retry, or terminal-state semantics. Existing generic failure events are not rewritten or retroactively classified; the private log remains the diagnostic source for those events. Verify HTTP status classifications, durable failure replay, safe messages despite malicious diagnostics, English/Chinese summary rendering, unknown-code fallback, and unchanged cancellation/deadline behavior. Run the affected TypeScript and Java checks and verify a built local deployment with a deterministic model endpoint, preserving the user's live sessions.

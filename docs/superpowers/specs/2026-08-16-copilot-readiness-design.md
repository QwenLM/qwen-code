# Copilot Readiness — Design Decision

**Date:** 2026-08-16
**Status:** Approved

## Goal

Make the shipped GitHub Copilot authentication path correct, cancellable, and honest about its supported surface before preparing an upstream pull request.

## Decisions

- Device-flow cancellation is a correctness requirement. `/auth` owns an `AbortController` for its fallback Copilot device flow, aborts it on cancellation, and prevents a cancelled flow from persisting credentials or installing a provider. Core forwards the signal to both device-flow requests and checks cancellation after awaited responses.
- A token manager consumes a validated fresh disk snapshot before token discovery. On a miss it acquires the existing cross-process lock, rechecks the cache, then discovers/exchanges/writes while holding that lock. Force refresh uses the same locked path.
- Remove the unimplemented `security.auth.copilot` schema settings rather than exposing settings that do nothing.
- Remove unreachable live catalog and policy-enablement code. Copilot supports its static provider model list and existing model-family routing only.
- `QWEN_DEFAULT_AUTH_TYPE=copilot` is valid wherever other supported auth types are validated.
- When a user selects a Copilot model without credentials, the existing auth dialog opens with Copilot preselected rather than returning the user to the generic chooser.

## Constraints

- Preserve the existing static Copilot model preset and `claude-*`/`gpt-5*` routing.
- Preserve current lock retry and stale-lock behavior; do not add a dependency.
- Preserve the atomic bearer/endpoints snapshot invariant and existing redaction behavior.
- Do not claim or add GitHub Enterprise configuration without verified support.
- Every behavior change uses a true RED-before-GREEN test with at least one control assertion that stays green.

## Verification

Run targeted core and CLI Vitest suites first, then repository typecheck, lint, and build. A fresh generalist reviewer validates the final commit against this document and the implementation plan before PR preparation.

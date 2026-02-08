# ADR 0003: Tool naming scheme

**Date**: 2026-02-01
**Status**: Accepted

## Context

Legacy docs used `browser_*` tools while the current native server defines `chrome_*` tools.

## Decision

- `chrome_*` is the **canonical tool namespace**.
- `browser_*` is treated as **legacy** and only supported via explicit compatibility layers if required.

## Consequences

- Design and guides should refer to `chrome_*` tools.
- Migration documentation must map `browser_*` → `chrome_*`.

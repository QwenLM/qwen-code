---
name: coding-agent-standards
description: Implementation quality checklist for coding agents - ensures code changes meet production standards before completion
agentOnly: true
---

# Coding Agent Standards

## Purpose

Quality gate for coding agents. Load this skill before finalizing any implementation to verify the work meets production standards.

## Pre-Completion Checklist

### 1. Code Correctness

- [ ] All modified files compile without errors
- [ ] No unresolved type errors or missing imports
- [ ] No hardcoded values that should be configurable
- [ ] Error paths handled — no bare throws, no swallowed exceptions without logging
- [ ] Async operations have proper error handling (no unhandled Promise rejections)

### 2. Integration Completeness

- [ ] Every new file has at least one non-test importer
- [ ] Every new service/class is wired to the runtime (not just passing tests in isolation)
- [ ] Every new export is reachable from the package entry point
- [ ] If types were changed, all consumers updated (no backward-compat shims)

### 3. Side Effect Awareness

- [ ] File operations use correct paths (absolute, not relative)
- [ ] No accidental writes to directories outside the working tree
- [ ] Git operations target the correct branch
- [ ] Shell commands are safe (no unquoted variables, no glob expansion risks)

### 4. Test Coverage

- [ ] Modified logic has corresponding test updates
- [ ] Edge cases tested: empty input, null, boundary values
- [ ] Tests actually assert the behavior (not just "no error thrown")

### 5. Cleanup

- [ ] No debug console.log statements left in
- [ ] No commented-out code blocks
- [ ] No TODO/FIXME without a corresponding task
- [ ] No placeholder implementations or stub functions

## How to Use

When loaded as a skill, review your changes against each section. Report any violations before marking the task complete. If a violation is found:

1. Fix it immediately if possible
2. If not fixable in scope, create a task describing the issue
3. Never silently skip a check — always report the outcome

## Verdict Format

```
STANDARDS CHECK: [PASS | FAIL | PARTIAL]
- Correctness: [pass/fail] — [details if fail]
- Integration: [pass/fail] — [details if fail]
- Side Effects: [pass/fail] — [details if fail]
- Tests: [pass/fail/skipped] — [reason if skipped]
- Cleanup: [pass/fail] — [details if fail]
```

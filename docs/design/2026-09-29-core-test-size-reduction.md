---
title: 'Core test size reduction'
date: '2026-09-29'
status: 'implemented'
---

# Core test size reduction

[English](2026-09-29-core-test-size-reduction.md) | [简体中文](2026-09-29-core-test-size-reduction.zh-CN.md)

## Problem

Core carries about 1.7 lines of test code per production line, and the gap
keeps widening: from 2026-09-26 to 2026-09-29, Core gained about 31,600 test
lines against 20,200 production lines. Much of that is repeated mock setup and
near-identical cases, which cost review and maintenance time without catching
more bugs.

## Goal

Shrink Core's test code substantially, with production code unchanged and any
loss of regression detection held to an explicit budget. Other packages, and a
guard against future test growth, are separate work.

## Approach

| Method                    | Change                                                          | Must keep                                                  |
| ------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- |
| Shared fixtures           | Small factories for repeated config, requests, responses, mocks | Fresh state per case, omitted keys, ordering, async timing |
| Parameterized scenarios   | One table replaces cases with the same shape                    | Each row's input, expected result and a useful label       |
| Whole-result expectations | One hand-written expected value replaces scattered assertions   | Expected values independent of the implementation          |
| Behavioral contracts      | One lifecycle test checks several related outcomes              | Error paths, option propagation, caller wiring             |

Helpers, fixtures and snapshots count toward the size. Merged cases lose
independent failure labels, so one failed assertion can hide later ones; that
diagnostic cost is accepted. No test file is removed.

## Guardrails

A reduction is kept only if all of these hold:

- Production code is untouched; build, typecheck and lint pass; the suite has
  no new failures.
- **Coverage:** at most 0.5 percentage points of previously covered production
  lines are lost, counted against main's instrumented lines. New coverage does
  not offset losses, and large per-file losses are reviewed.
- **Historical faults:** past production bugs, re-applied by reverting their
  fixes, are still caught wherever main's suite caught them.
- **Mutation:** in sampled modules, at most 1% of the mutants main kills
  survive.

## Result

All measurements run on Linux arm64 against main at `e767e223c5`.

| Core                       |    Main | This change |            Change |
| -------------------------- | ------: | ----------: | ----------------: |
| Test and support lines     | 714,123 |     535,949 | −178,174 (−25.0%) |
| Test and support bytes     | 24.9 MB |     19.3 MB |            −22.6% |
| Test files                 |     861 |         861 |                 0 |
| Test cases                 |  33,691 |      33,608 |               −83 |
| Production line coverage   |  91.00% |      90.98% |                   |
| Production branch coverage |  88.65% |      88.65% |                   |

- **Coverage:** 41 previously covered lines lose coverage (0.015 points). 30
  are in tool-result cleanup, which the client starts without awaiting and
  which scans the machine's real temp directory; 10 are an Arena fallback that
  only other tests' timing reaches. Each module's own tests cover the same
  lines on both sides.
- **Historical faults:** of 106 past bugs, 91 still re-apply to this main; both
  sides catch the same 80.
- **Mutation:** thirteen whole modules, every operator. Of 4,583 mutants,
  main's tests kill 3,286; this change loses none of those kills and adds 20.
  The modules are Anthropic usage accounting, workflow budget, XML tool-call
  fallback, file read cache, model registry, streaming tool-call parsing, retry
  error classification, microcompaction, memory discovery, hook system, schema
  validation, session hooks and hook planning.
- **Cases:** 203 test names in 24 files, mostly hook and schema-validation
  tests, are merged into fewer tests or removed as exact duplicates.
- The suite has no new failures.

## Costs and limits

- Merged cases carry fewer labels, so some failures are harder to localize.
- An earlier stage also deleted or cut 179 test files where coverage suggested
  overlap. Sandboxed verification showed it lost real checks (7 of 23 sampled
  mutants survived), so it was reverted: those files are as on main.
- Measured on Linux arm64; tests skipped there are outside the measurement.

## Follow-up

- The 179 restored files can be compressed the same way.
- Compression alone levels off near 30%. Keeping Core lean needs a check on
  how much test code each change adds.

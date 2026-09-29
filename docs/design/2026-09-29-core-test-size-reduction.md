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
| Measured deletion         | Remove cases whose checks retained tests already make           | Security, permission and data-integrity checks; negatives  |

Helpers, fixtures and snapshots count toward the size. Merged cases lose
independent failure labels, so one failed assertion can hide later ones; that
diagnostic cost is accepted.

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

Coverage and mutation data only suggested what to delete; the replays decided.

## Result

Full Core suite with coverage on both sides, Linux arm64, against main at
`81582ca19d`:

| Core                       |    Main | This change |            Change |
| -------------------------- | ------: | ----------: | ----------------: |
| Test and support lines     | 710,076 |     488,045 | −222,031 (−31.3%) |
| Test and support bytes     | 24.8 MB |     17.6 MB |            −28.9% |
| Test files                 |     855 |         715 |              −140 |
| Test cases                 |  33,494 |      30,566 |    −2,928 (−8.7%) |
| Production line coverage   |  90.97% |      90.71% |                   |
| Production branch coverage |  88.65% |      88.13% |                   |

727 previously covered lines lose coverage: 0.27 points, within the 0.5 budget.
The largest per-file losses are microcompaction (48 of 760 covered lines),
memory discovery (43 of 428) and streaming tool-call parsing (34 of 339). The
suite has no new failures.

## Costs and limits

- Fewer cases and labels make some failures harder to localize.
- Some formatting, diagnostic, invalid-input and evaluation-style checks were
  removed.
- Fault and mutation replays ran stage by stage during the work, not against
  the latest main. The last deletion stage still caught all 95 historical
  faults it was measured on and kept all 385 killed mutants in four sampled
  modules.
- Measured on Linux arm64; tests skipped there are outside the measurement.

## Follow-up

Compression alone levels off near 30%. Keeping Core lean needs a check on how
much test code each change adds.

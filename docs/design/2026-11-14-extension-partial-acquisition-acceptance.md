# Partial extension acquisition acceptance

[English](2026-11-14-extension-partial-acquisition-acceptance.md) | [简体中文](2026-11-14-extension-partial-acquisition-acceptance.zh-CN.md)

## Status and problem

This Draft provides a reproducible acceptance experiment for maintainers. It is not Ready: the Bun and platform gaps listed below remain open.
Initial test preparation and the first matrix used historical main
`6f754be6548903e545e6ff0ed43a34927fe3bfb9`; those results retain their own scope.
PR15950's width correction remains a separate unmerged dependency, never an
implicit main pass.

Discover and Sources are already implemented. The existing public acquisition
case covers one local plugin, denial, approval and cold reload. It does not
prove partial success with two remotely acquired plugins and fresh consent for
the failed selection. The historical original-folder mutation decision remains
pending; a remote command-only fixture cannot settle it.

## Test design

Add one public interactive case and one small HTTP Git fixture. The fixture
creates two command-only plugins in a new owned Git repository, commits it
under fixed fixture identity, creates a bare publisher and makes the publisher
read-only. An owned loopback server serves an HTTP JSON catalog plus read-only
smart Git requests through the actual `git http-backend`. The application must
perform its own clone and conversion; no private installer API is called.

The catalog resolves each plugin through the existing structured URL source
contract. A declared owned Git launcher records actual arguments, cwd, parent
PID and the real child's outcome; clone destinations must be inside the
session's explicit owned `TMPDIR`/`TMP`/`TEMP`. This is bounded process evidence,
not independent process-birth or lossless transient tracing. Git fixture
preparation uses an explicit isolated environment and does not inherit a caller's
`GIT_INDEX_FILE`.

The extensionless launcher has its own CommonJS package boundary. Resolve the
actual clone destination relative to its recorded canonical cwd (the current
installer uses `./`), require strict confinement below owned temp, and verify
removal after resolution. After closing both servers, recheck modelHTTP0,
fixture errors and final protected maps before recording the durable result;
late failures retain the first error and cannot produce a pass.

The same original public UI runs on Node+Ink, Bun+Ink and strict Bun+OpenTUI:
select A+B, choose user scope, approve A and deny B; require partial1/failed1,
exact A bytes/policy and cleared selection; explicitly reselect only B and
approve it; verify both distinct URL/plugin identities and command bytes; quit
naturally, cold launch, verify both command completions and quit naturally.
Publisher and unrelated workspace/settings maps must remain exact at every
captured stage. Model HTTP stays0; catalog/Git HTTP is recorded separately.

## Boundaries and validation

The submitted case has a120s timeout, conditionLocal15s/conditionCI45s and
zero retries. The recorded experiments additionally used a180s outer controller
cap; that controller is not part of the submitted case. The existing wait helper triples only when `CI=true`; record that
actual environment before execution rather than claiming CI has a15s limit.
The fixture starts only when the case runs. Preserve the first actual
failure and its outputs; do not add Enter/Escape retries, policy overrides,
private imports or timing extensions to get green. A real policy rejection of
loopback HTTP is an unqualified route, not permission to change Core policy.

No CLI/Core production change, user/global install, hook-sensitive behavior,
original-folder semantics, desktop acceptance or final migration completion is
claimed. The new files are the public case, its fixture, and this linked design
pair; the E2E plan is ignored. CI routing is unchanged in this increment.

Before reproducing, build and typecheck the candidate and record the actual
runtime, Git client/backend and bundle identities.
Run the global Ink baseline first when available, retaining its version scope,
then each final candidate renderer sequentially. Verify source/publisher maps,
two real natural exits, exact promoted contents/policies and0 model HTTP. Run
the separate width geometry contract on a candidate containing its correction.
The recorded observations below do not qualify all renderers or platforms. No local diagnostic production changes are included in this four-file Draft.

## Recorded snapshot results

Both matrices below use the frozen main snapshot `8646b0a70552af5297b433fbbdb4c2b73b63bc32`, not the latest or final main. The public case is unchanged at SHA256 `0cae8e5657ae279ba771d0511d329c911e8ad27242bf3f16a1d894a1d7d591e8`. The second candidate contains only the four test/design files on that snapshot and no CLI/Core diagnostic instrumentation.

| Recorded candidate                                           | Node/Ink                          | Bun/Ink                                  | Strict Bun/OpenTUI                                                    |
| ------------------------------------------------------------ | --------------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| Original fixture `a574bfeb`, bundle `75d72f97`               | Full case PASS, two natural exits | First `deny-b`15s FAIL, no natural exits | First `deny-b`15s FAIL, no natural exits                              |
| Cleanup-corrected fixture `a8beb92c`, pure bundle `ef6030a6` | Full case PASS, two natural exits | Full case PASS, two natural exits        | First `deny-b`15s FAIL, inner PTY close-grace error, no natural exits |

The passing cases reached A approval/B denial, exact partial1/failed1 with cleared selection, explicit B-only re-selection and fresh consent, exact installed identities/policies/command bytes, hot and cold command completion, and two natural exit0/signal0. The pure Native failure displayed Installing before B consent, with only A committed; later partial/reselection/cold stages were not reached. The pure matrix had modelHTTP0, no fixture errors, unchanged publisher maps and unchanged source pins; all three outer controllers finished without timeout, forced cleanup or remaining owned group. Outer cleanup does not erase the Native inner close-grace error.

The new Bun/Ink pass is an observation, not evidence that fixture cleanup fixed the earlier Bun business failure. The original matrix remains1P/2F and the pure matrix2P/1F; neither is overall acceptance. The global v0.22 baseline reached the business flow but failed to observe cold natural exit. Historical `6f754be6` observations retain their own candidate scope.

Linux is NOT_RUN. Windows is SETUP_NQ because this Git HTTP fixture is not qualified there; no skip, flag or timing extension is added to get green. These are local Darwin observations, not installed-package, latest/final-main or cross-platform qualification. Other merged features do not change these scopes. This contribution remains Draft, not Ready, with no production fix claim.

## Fixture error-path cleanup

The corrected fixture has SHA256 `a8beb92c168c9f1d72c03f31f03058aba3aa97c2c2883d6ecac4b5be5d542a97`. It retains a CGI child after spawn or stdin errors until its real close event. A separate owned-backend fault probe observed the original early return with the child still alive, and the corrected helper waiting until the child was gone. That probe qualifies fixture cleanup ownership only, not transport, application root cause or a Bun fix. The pure matrix above is its actual application observation; it is no longer listed as pending validation.

All exploratory CLI/Core logging, wrapper experiments and native samples are excluded. There is no Core or CLI production change in this test/design contribution.

## Readiness and cold-start evidence follow-up

The later production candidate `b6ec1bb9` completed the Native hot partial/retry/command flow and one natural exit, but its cold startup did not reach the prompt. Its Bun+Ink case failed before source detail; saved frames showed that an Added status could coexist with the still-busy add form. Node+Ink completed the whole case. These observations do not close the Source gate or replace the earlier candidate results.

The next driver strengthens the existing source-added condition: one viewport must contain the success status, Sources list, focused Add marketplace action and registered URL row, without Adding. It sends the same original keys under the same deadlines and retry policy.

Optional test-helper lifecycle observations record PTY PID, observer PID, raw bytes, readiness, exit status and cleanup attempts/results. Monotonic timestamps belong to the observer process; a PTY PID is not proof of a leaf or GC-owner process. Callback errors cannot replace the original startup/cleanup outcome, and emitted status values are copied rather than exposing internal mutable state. The existing startup-failure callback remains once and preserves raw ANSI before cleanup. The session start method retains ownership of failed startup cleanup, including the original 30-second local readiness and 10+5-second cleanup bounds.

The Source fixture captures the attempt index before each start, keeping hot and cold evidence separate. Observation may affect scheduling; missing records remain unknown, and forced exits are never natural exits. Helper tests use controlled PTY events and the real terminal parser, not an actual application or native process. Any OS sample must independently qualify its process identity and pending startup window. Functional acceptance and final migration still require their original evidence.

## Full composer-prefix admission

The new driver-only candidate keeps the original completion-name assertion and also requires the complete requested prefix inside the real composer in the same fresh viewport. It reads the single `>` input row between the last two complete horizontal rules; history text and dropdown names do not establish that input arrived. The case remains fixed at 120×42 with short ASCII prefixes that fit one row. Multiline composers, other layouts and platforms are outside this recognizer's demonstrated scope; a missing or nonconforming region rejects admission.

Seven unchanged saved frames lacked the full prefix requested at that point even though the old name-only predicate could pass. This is saved evidence of premature observer admission, not proof of persistent input loss or a Core/renderer defect. The earlier 83221 clear failure and original matrix remain unchanged. The candidate waits for the same business condition to become demonstrable without extra input, retries, keys, sleep or changes to case120s/local15s/CI45s budgets. Type/normal checks and actual new-driver acceptance are required before freezing a publication tree; this candidate has not run.

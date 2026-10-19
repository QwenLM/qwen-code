# K2 physical retirement coordination and retained progress

[English](2026-10-20-k2-physical-retirement-progress.md) | [简体中文](2026-10-20-k2-physical-retirement-progress.zh-CN.md)

## Problem and current state

Slice 2 (#14698) implements original-owner application DRAINED. Slice 3 (#14758) supplies strict node-source evidence and controlled creation, but deliberately refuses source-associated application retirement. Slice 4 supplies installation and cold-bootstrap software. This fifth slice extracts durable physical coordination from cumulative #13526 without claiming native installation or safe volume reuse.

## Scope and dependencies

Build on slice 3 commit `1656cf02fd8419ce7baf608adcfb21a2d28a3dfc` and preserve its strict installation/birth/journal readers. Keep slice-4 generators, packaging and cold-init changes outside this PR. Support only settled original generation-1/epoch-1 owners. Source evidence, installation qualification and final physical release remain distinct.

Add durable plan, stop intent, original UID/resourceVersion-qualified normal Pod deletion, bounded reply recording, source-prefix observation and retained status/retries. Stop at PLANNED, INTENT, STOPPED and UNPUBLISHED. Never release the binding, slot or physical holder; no RELEASED, public selector, released-history support or later-cycle reuse.

## Application evidence compatibility

Preserve every published migration and all existing inventory/2 bytes. Add a separate versioned inventory for source-associated retirement that pins the entire typed original source row; old owners continue using inventory/2. Validate the original PUBLISHED source against the reservation, registration and saved worker handle, refusing missing, partial or changed evidence. Unsupported historical source-owner reads remain closed. A verified DRAINED result is created only by the original application store on the physical operation's same transactional Connection.

## Coordination and persistence

Append the physical-progress companion migration after slice 3. Keep it outside application snapshots so progress updates cannot invalidate the immutable application baseline. Validate its complete schema and refuse unexpected rows before application DRAINED. Pin the exact plan bytes and hashes, original source incarnation, publication prefix, Pod identity and protection facts. Keep external RPCs outside SQL locks; acquire and revalidate original ownership for each durable write.

Persist an immutable deletion attempt before transmission. Send precisely the saved bytes with UID and resourceVersion preconditions, gracePeriodSeconds=30 and Background propagation. Preserve unknown outcomes, actual bounded status/body, exact retry identity and monotonic counters. HTTP acceptance, 404 and Pod absence never prove physical stop or unpublish. Only continuous original-source evidence advances observations; UNPUBLISHED confers no release authority.

Each resourceVersion is attempted at most once, including after restart. A crash or failed preflight between persistence and transmission leaves that attempt unknown; the coordinator only appends another attempt after observing a different resourceVersion, with an eight-attempt limit. Status requires an already saved plan and refuses an unplanned owner.

Private status and plan inspect SQL without loading network credentials. Network actions corroborate the pinned node UID/boot/Ready and protected volume. Foreign owner, changed plan, gap, replacement source, transaction misuse and malformed evidence fail closed.

## Affected components

Java application inventory/store, physical coordinator/store/progress/source/private entry, exact Kubernetes deletion client and tests; append-only managed-schema metadata. No TypeScript behavior, public HTTP route or native host installation changes are intended.

## Validation and acceptance

Run the global qwen baseline first and document why private Java commands require component testing. Verify original application DRAINED to physical plan/status/restart, exact deletion retries and unknown outcomes, source-prefix stop/unpublish and unchanged DRAINING ownership. Verify legacy snapshot bytes, old retained reads, wrong source/UID/plan, malformed companion schema, foreign transaction and all-or-nothing refusal. Run affected Java tests, complete Java verify including static gates, and disposable MySQL 8.4 coverage; build/typecheck for shared contracts. Bind results to this candidate and disclose fixtures. Native Linux/CSI, installed confinement, actual cold boot, release and reuse require separate acceptance.

## Risks and open questions

This PR stacks on [slice 3](https://github.com/QwenLM/qwen-code/pull/14758) and can be developed and reviewed alongside slice 4. Merge after slice 3, then rebase onto main; migration numbering follows actual landing order. Source-associated inventory is a new format; it must never reinterpret or rewrite inventory/2. Real node qualification and release authority remain unfinished and cannot be granted by protocol fixtures or artifact hashes.

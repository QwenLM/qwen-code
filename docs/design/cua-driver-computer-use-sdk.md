# CUA Driver Computer Use SDK

## Goal

Upgrade the vendored CUA Driver 0.20.0 implementation with a native, versioned accessibility observation revision protocol, then expose the resulting capability through its typed SDKs and a small JavaScript wrapper.

The finished SDK must be directly importable from an ordinary Node.js program and independently testable without Qwen Code, Node REPL, a Skill, or any Qwen host integration. Stage 3 will teach Qwen Code to call this SDK from the Node REPL delivered by #9333.

## Stage boundary

This stage includes only:

- cua-driver core and native platform changes;
- Rust, Python, and TypeScript SDK contract and generated bindings;
- a thin JavaScript Computer Use wrapper over the TypeScript cua-driver SDK;
- independent unit, compatibility, platform E2E, packaging, and release validation.

This stage does not:

- modify Qwen Code core, CLI, ACP, TUI, tool registry, scheduler, or permission manager;
- register any SDK or capability in the Node REPL;
- add a hidden Qwen bridge or Qwen-specific runtime session;
- track which observation reached a model;
- add a Computer Use Skill, prompt, default migration, or direct-tool replacement.

## Runtime topology

```text
ordinary Node.js program
  -> @qwen-code/cua-sdk/computer-use
  -> @qwen-code/cua-sdk typed driver API
  -> cua-driver runtime
  -> AX / UIA / AT-SPI platform implementation
```

The wrapper calls the typed SDK directly. It does not route calls through Qwen Code or a second tool protocol. It preserves cua-driver's existing runtime, permission, transport, and lifecycle behavior.

The TypeScript SDK and Computer Use wrapper are distributed together as the
single `@qwen-code/cua-sdk` npm package. The package root exposes the generated
typed driver API and the `/computer-use` subpath exposes the high-level wrapper.
There is no driver npm package and there are no platform npm packages.

The matching `qwen-cua-driver` GitHub Release remains the only native artifact
channel. During npm installation, `@qwen-code/cua-sdk` downloads the exact
same-version binary archive, verifies it against that release's
`checksums.txt`, and caches only the SDK library plus Node runtime. An explicit
native-directory override supports source builds and release dry-runs without
changing the production resolution path. The synchronized TryCua release is
source provenance only; no published Qwen artifact imports or resolves the
upstream npm package.

## Release contract

One version identifies both release surfaces:

1. `cua-driver-rs-v<version>` publishes the driver, SDK library, Node runtime,
   installers, and checksums to the Qwen GitHub Release.
2. `@qwen-code/cua-sdk@<version>` publishes the platform-neutral JavaScript,
   generated bindings, declarations, downloader, and Computer Use wrapper.

Production publication is ordered. The GitHub Release must be complete before
the packed npm artifact is installed without overrides against the public
release. Only after that real installation and native-load smoke test succeeds
may npm publication run. A retry accepts an already-published npm version only
when its registry integrity matches the packed artifact.

The workflow dry-run builds every native target, verifies the release archive
contract, packs exactly one npm tarball, installs it into a clean consumer
project using the just-built native payload, and runs the native-load smoke
test. It creates no tag, GitHub Release, npm version, installer-version PR, or
machine-wide driver installation.

## Observation revision contract

CUA Driver adds the opt-in `accessibility.observation_revision.v1` capability. Existing callers that do not opt in continue receiving the current full snapshot and snapshot-token behavior.

A revision request explicitly supplies:

- protocol version;
- exact target;
- optional base revision ID;
- optional force-full flag;
- serializer/projection version.

A response reports:

- `full | diff | no_change` mode;
- current and actual base revision IDs;
- lineage, serializer, and projection versions;
- stable-element support;
- a closed resynchronization reason when full output is required.

The caller, not cua-driver, selects the base revision. Missing, expired, foreign, or incompatible bases produce a full response. The driver never guesses whether a revision reached a model.

## Stable identity and diff correctness

Within one trusted driver session, runtime generation, exact target, and serializer lineage:

- the same native element keeps its stable ID;
- rename, value change, reorder, and reparent retain the ID;
- inserted elements receive new IDs;
- removed IDs retire;
- destroyed and recreated look-alikes receive new IDs.

Every candidate diff must replay from the requested base to the canonical current full rendering. Incomplete capture, unavailable identity, incompatible lineage, failed replay, or a diff not smaller than the full rendering returns full output with an explicit reason.

Stable action tokens resolve through the current revision. An unchanged element remains actionable after compatible diffs; removed, recreated, foreign-session, or stale-generation tokens fail before native dispatch.

## Platform identity

| Platform path      | Identity rule                                                     | Revision v1 behavior                            |
| ------------------ | ----------------------------------------------------------------- | ----------------------------------------------- |
| macOS AX           | retained `AXUIElementRef`, compared with Core Foundation equality | diff when capture and identity are complete     |
| Windows UIA        | RuntimeId candidate confirmed by `IUIAutomation::CompareElements` | diff when identity is confirmed                 |
| Windows MSAA       | no approved stable identity                                       | explicit full-only fallback                     |
| Linux AT-SPI       | unique D-Bus owner plus object path                               | diff while the owner remains live and unchanged |
| Linux X11 fallback | no approved stable identity                                       | explicit full-only fallback                     |

Provider invalidation, truncation, subtree read failure, target ambiguity, or fallback capture forces full output.

## SDK wrapper

The JavaScript wrapper exposes a small Computer Use API while directly using the generated TypeScript cua-driver SDK. It hides raw low-level constructors and arbitrary tool dispatch from its public surface, but it does not depend on Qwen Code.

The observation API returns the revision ID and accepts an explicit base revision ID on the next call. The caller owns that state. Actions consume opaque element tokens returned by the driver. The wrapper does not compute a second semantic diff or invent element identity.

The wrapper must run in a standalone Node.js integration test before Stage 3 begins.

## Validation

Completion requires:

- deterministic core tests for full, diff, no-change, replay, eviction, isolation, and forced-full reasons;
- unchanged compatibility fixtures for existing Rust, Python, and TypeScript applications;
- generated SDK drift checks;
- real signed macOS, Windows UIA, and Linux AT-SPI E2E evidence;
- explicit MSAA and X11 full-only evidence;
- stable-token action tests after rename, insertion, reparent, removal, and recreation;
- a standalone Node.js test importing and using the JavaScript wrapper directly;
- at least 30 deterministic real transitions and a median accessibility-text reduction of at least 40% for small UI changes;
- clean build, typecheck, packaging, and release artifacts.

No Qwen Code or model-in-the-loop result is part of this stage's completion claim.

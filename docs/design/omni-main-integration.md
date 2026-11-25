# Integrating the Omni experiment into main

[简体中文](./omni-main-integration.zh-CN.md)

## Scope

Integrate the completed `omni-experiment` feature into the current main branch
through `lazzy/omni-main-integration`. The source experiment is
`a7ab939cc3624c1dfc1629015e0af50ec77ab4b5`; the initial main baseline is
`eb3bcc62f1afd3438f42d1d05679d6f5084720f4`.

The feature includes media recognition and upload delivery, processing
policies and tools, media memory and recall, storage governance, and separate
upload/inference configuration. Existing experiment designs define these
behaviors; this change adapts their implementation to main's current entry
points without redesigning them.

## Integration decisions

- Create the integration branch from the experiment and merge main into it.
  Keep main's package versions, dependencies, runtime ownership, and public
  compatibility exports while carrying forward the experiment's additions.
- Move media overflow recovery into the active `LlmChat` implementation.
  Keep `geminiChat.ts` as main's compatibility export, not a second runtime.
- Apply query-preparation and cancellation state to `use-llm-stream.ts`, and
  retain main's current ACP, tool scheduling, recording, and UI contracts.
- Defer processing-policy normalization until tools are warmed, including
  provisional workspace activation. Load the media reader through Config so
  the utility layer keeps its dependency boundary.
- Apply media-policy visibility and execution provenance to CodeModeOnly.
  Preserve uploaded media, annotations, and tool output in the outer exec
  response, including hook context and later script failures. Export nested
  tool-result execution IDs from the active transcript branch without
  fabricating model-authored calls. Recognize the Omni recall record subtype.
- Keep `omni.enabled` false by default. Preserve the existing environment
  opt-in and bare-mode override.
- Retain the accepted global 250-image request cap and audio wire-format
  extensions. Existing users have no Omni-enabled historical sessions;
  expired Omni media retry behavior is outside this integration's scope.
- Update both lockfiles for the experiment's additional test dependency and
  preserve the package exports and source aliases required by every consumer.

## Validation

The assessment already exercised the global CLI and exact experiment with
isolated loopback controls. Extend that plan against the integrated bundle:
ordinary text, file reads/writes, tool continuation, normal session resume,
and the Omni-enabled delivery path. Use local protocol doubles for
deterministic upload/inference and credential separation checks; report them
separately from real-provider validation.

Build, typecheck, bundle, check both lockfiles and startup imports, and run
focused core/CLI/media tests. Verify the conflict adaptations on main's
actual entry points. Complete two clean self-audit passes and code review
before submitting the single main-targeted PR.

## Boundaries

No default enablement, new provider policy, storage redesign, or additional
feature PR is part of this integration. The PR does not authorize merging
itself or enabling auto-merge. No design decisions remain open.

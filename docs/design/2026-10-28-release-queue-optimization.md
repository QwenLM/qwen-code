# Release runner slots

[English](2026-10-28-release-queue-optimization.md) | [简体中文](2026-10-28-release-queue-optimization.zh-CN.md)

## Goal

Remove GitHub-hosted queue waits from release work that can run on existing ECS capacity. This change targets main independently of #15854; audio caching is not required.

## Routing

Use `ecs-qwen-release-host` on three existing runner processes: hz1-17 and hz1-18 (ARM64), and hk4-31 (x64). Remove ordinary CI labels from those processes only. Other processes and machine uses remain unchanged; no reinstall or exclusive machine is needed.

Linux audio builds select the matching architecture and build in `node:22-bookworm` so a newer host glibc does not raise the binary's compatibility floor. macOS and Windows audio builds keep their existing runners. Audio collection uses any release slot and always consumes artifacts from the current run, for the selected release commit.

CLI builds prepare the version commit and bundle/workspace/standalone outputs on ECS, then transfer the exact commit and outputs to a hosted npm publisher. The SDK similarly hands off its tested package. Preserve executable modes and verify the imported commit; failed or unexpectedly skipped builds must block publication.

Eligible VSCode universal/prepare/publish, Desktop publish, Chrome extension, finalization and GHCR jobs use the same slots. Final npm publication remains hosted for trusted publishing/provenance. Native VSCode/Desktop, OSS mirrors, managed-runtime and other SDK/Live Host publishers keep existing routes in this change. Failure reporting remains hosted so an ECS outage can still be reported.

## Persistent runner preparation

A workflow-pinned preflight clears the contained workspace before checkout, checks Node 22 and disk space, and isolates Git/npm/Docker/gh state and npm's installation prefix. Labels reserve scheduling capacity; they do not isolate sibling processes on the shared host. This deployment accepts that existing shared-host trust boundary and preserves environment protections.

## Activation and verification

Keep `ECS_RELEASE_HOST_RUNNER_ENABLED` unset until this build/publish split reaches main. Enabling the old whole-publisher route would also move npm publication to ECS. Once merged, enable the variable; unsetting it restores hosted routes.

Verify on/off routing, both Linux audio architectures and native addon loading, same-run Git/artifact handoffs, SDK package identity, failure propagation and workflow syntax. Then run non-publishing Actions acceptance on the reserved runners and retain runner names and queue/start times. Main release dry-run does not emit a release event; downstream routes need separate acceptance. Observe the first real release before calling activation complete. No UI or tmux evidence applies to these workflow changes.

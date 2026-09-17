# Live camera capture and provider quota failures

[English](live-camera-quota-fixes.md) | [简体中文](live-camera-quota-fixes.zh-CN.md)

## Problem

After switching an active call from screen to camera, Appshot failed with
`camera_snapshot_resolution_unavailable`. A local Electron reproduction showed
photo capabilities of 1280×720 but a decoded photo of 1552×1552. Exact equality
discarded that valid larger image. The video fallback requested independently
reported width/height maxima of 1920×1920 and negotiated 1552×1552, which also
failed the native-size check.

Separately, Realtime closed with code 1007 and `Allocated quota exceeded,
please increase your quota limit.` The client classified this as a generic
protocol failure. If speech was pending, it could instead report lost input,
hiding the quota reason. A later connection-only check succeeded; the evidence
does not establish a permanent exhausted balance or identify the quota type.

## Changes

Native camera snapshots accept decoded dimensions at least as large as the
reported dimensions, including a 90-degree rotation. Larger photos retain
their actual dimensions in the local asset. Truly undersized images still
take the existing fallback or fail; preview pixels are not silently relabeled
as a native photo. Explicit snapshot bounds and transport limits are unchanged.

Realtime gives explicit quota failures their own internal `quota` error kind.
Ordinary HTTP 429/rate limits remain transient without an explicit quota code
or message. Quota close reasons survive pending-speech handling. Startup and
active-call errors receive localized guidance to check service quota and
concurrency, then retry when available. Quota failure does not persist a
configuration blocker, change credentials, increase account limits, or trigger
automatic retries.

## Scope and validation

There are no new dependencies, processes, permissions, provider requests in
normal operation, or Host protocol fields. The existing `native` configuration
remains valid. Regression tests cover the observed larger-photo case, existing
undersized failures, quota close/error events, ordinary rate limits, and
localized startup/active-call guidance. Local Electron verification uses the
physical camera without persisting or transmitting images; reports contain
only dimensions and error metadata. Provider validation uses a connection-only
check without audio, images, or a response request.

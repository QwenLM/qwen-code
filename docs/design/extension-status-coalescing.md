# Coalescing extension status reads

[English](extension-status-coalescing.md) | [简体中文](extension-status-coalescing.zh-CN.md)

## Problem

The legacy-primary `GET /workspace/extensions` controller caches completed
responses for two seconds, but concurrent cache misses each create a manager
and fully load extensions. The store lock serializes these redundant scans.

## Design

Keep one in-flight status load per controller, keyed by resolved locale and
workspace trust. Matching requests share its promise. Keep the existing full
response and the two-second TTL measured from successful completion.

All three existing invalidation sites clear both the completed cache and the
in-flight reference: manual refresh, completed mutation, and committed mutation
whose post-commit work fails. Only the current in-flight entry may publish a
cache result or clear the pending reference. Object identity provides the
invalidation token without an extra counter. Old callers may finish with their
original snapshot, but newer callers never join an invalidated load. Failure is
shared by current waiters and the next request retries.

Resolve trust before locale so cache identity and manager settings agree.
Different controllers, languages, and trust states do not share loads. Retain
per-request HTTP lifecycle checks before and after the await.

## Scope

Change only the status controller and its tests. No long-lived manager, new
API, stale-while-revalidate, TTL increase, global cache, loader optimization,
or stronger mutation/read ordering is introduced. Documentation and an isolated
benchmark record the behavior and measured benefit.

## Validation

Unit tests cover cold/expired coalescing, hits, failure/retry, locale/trust and
controller isolation, and stale completion after each invalidation path.
Build, typecheck, and run the controller and workspace-extension route suites.
Use real filesystem fixtures and the same loader for base and candidate;
measure 1/2/5/10 simultaneous requests, cache hits, and expiry. Validate every
response and count full refreshes. Exclude setup/startup from timings and label
warm filesystem-cache measurements. Single requests are not expected to improve.

## Acceptance

A concurrent batch with one cache identity performs one full refresh. Old
completions cannot overwrite newer cached data or clear a newer pending read.
Results must report baseline SHA, fixture size, samples, timings, and limits.

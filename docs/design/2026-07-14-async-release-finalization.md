# Asynchronous Stable Release Finalization

## Problem

Stable publishing currently waits for AI release notes, changelog regeneration, and release pull request automation. The v0.19.10 AI step exceeded its five-minute timeout, so the release fell back to GitHub-generated notes while keeping the publish job occupied.

## Design

The main release workflow stops after package publication and GitHub Release creation. It still creates and pushes the versioned release branch before publishing because package contents and the release tag depend on that version bump.

A separate workflow listens for the resulting `release.published` event. Stable tags run AI release note generation with a 15-minute timeout, update the GitHub Release when generation succeeds, regenerate the changelog from the final Release body, and then create, approve, and auto-merge the existing release branch pull request. A manual tag input supports retrying the finalization workflow without rerunning package publication.

Aliyun OSS synchronization remains independent. It listens to the same release event but has separate credentials, failure handling, and retry behavior.

## Failure Behavior

AI generation and changelog regeneration remain best-effort. Missing AI output preserves GitHub-generated notes, and changelog failures do not prevent the version bump pull request from being opened. Package publication is never retried by the finalization workflow. If that pull request has already merged, a manual retry skips PR creation, approval, and auto-merge so a stale release branch cannot be merged again.

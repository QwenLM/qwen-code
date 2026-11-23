# Hangzhou ARM64 runner validation

[English](hangzhou-arm64-runner-smoke.md) | [简体中文](hangzhou-arm64-runner-smoke.zh-CN.md)

## Goal

Validate checkout and the host toolchain on each of the five new Hangzhou ECS hosts before using them for production CI. Runner online status only confirms that the listener can connect to GitHub.

## Design

A matrix targets one validation label per host. Each job verifies the ARM64 architecture and service account, checks out the triggering commit with read-only permissions, and checks Git, Node 22, npm, pnpm, and the shared Qwen Code installation. Jobs report independently so a failed host does not cancel the remaining checks.

The workflow supports manual dispatch. A push that changes the workflow on the dedicated smoke branch starts the first validation run. Production runner labels and workflow routing stay as configured.

## Acceptance

GitHub schedules one job on each of the five hosts. Each job reports the selected runner and the checkout and toolchain results. Either of the two registered listeners on a host can take that host's job.

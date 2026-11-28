# Managed control-plane attachment recovery

[English](2026-11-26-managed-control-plane-attachments.md) | [简体中文](2026-11-26-managed-control-plane-attachments.zh-CN.md)

## Problem

Multiple Java control-plane instances can share a database and address one
Hosted Harness. Each instance still has its own Harness attachment cache. A
management request can open the Harness Session before the first Turn records
the Harness boot ID. A different instance then attempts to create the same
Session, and its ordinary load can be refused by the resident Harness.

## Design

When the managed Harness replies `hosted_session_already_attached`, the
connector can passively load the matching Session. It still checks the original
Session identity, store descriptor, tool profile and approval configuration.
The normal dispatcher continues to own Turn admission. A create reply lost in
transit first uses the existing load path. An explicit resident conflict on
that path allows a passive retry.

An approval response can passively attach to the original managed Session
before delivering its decision. Runtime Skill candidates, snapshots and
archives use the management-only attachment on a cache miss. That load checks
for a compatible resident Session and keeps the original placement and
Runtime binding checks.

Active Turn recovery views use the stored Turn and journal evidence. Explicit
recovery operations keep the checks against the original Harness and prompt.
Pending cleanup and missing settlement proof continue to gate new work.

## Scope and validation

Use two independent Java connectors or instances sharing one Session store and
the same Harness. Exercise management before the first Turn, cancellation and
approval from a node with an empty attachment cache, and recovery queries on
both nodes. Verify the request reaches the original Session, any native
operation targets the original Turn or Action, and no new Turn is admitted
while the SQL state still blocks it. SSE delivery and Runtime Broker
failover are separate increments. The recovery-blocked dispatch scanner still
requires a ref to the original Harness stream. Removing that dependency
requires a read-only attachment for all Hosted profiles.

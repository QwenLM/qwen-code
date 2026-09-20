# Managed Runtime Broker State Foundation

[English](managed-runtime-broker-state.md) | [简体中文](managed-runtime-broker-state.zh-CN.md)

Status: Implemented foundation

## Problem

A Managed Agent control plane may start, reuse, drain, and replace tool Runtime
instances while multiple service instances handle requests concurrently. Process
memory alone cannot provide stable Runtime generations or Session bindings
across retries and ownership changes.

## Current state

The main branch has no Managed Runtime Broker module. Runtime placement,
transport, Hosted Harness integration, and production persistence remain future
work. This change adds only the state boundary needed by those later layers.

These records are private Java control-plane placement and ownership state.
They are distinct from both the Harness Session Authority journal and the
public Agent Event/Item/Snapshot store; a durable adapter may share a database
deployment with those stores, but it must keep separate schemas and ownership
contracts.

## Goals

- Define immutable identities for Runtime scope, placement, lease, and Session.
- Define repository contracts with compare-and-set versioning and expiring
  operation ownership.
- Preserve one active Runtime generation for each compatible provision request.
- Provide thread-safe in-memory implementations for unit tests and
  single-process prototypes.

## Non-goals

- Starting or stopping Runtime processes.
- Exposing an HTTP service.
- Calling a Hosted Harness or a model.
- Authenticating tenant identities inside the Runtime Broker.
- Tracking tool execution or resolving ambiguous dispatch outcomes.
- Providing a MySQL implementation.
- Claiming restart recovery from the in-memory implementations.

## State model

### Runtime binding

A **RuntimeProvisionRequest** combines a control-plane-supplied
**RuntimeScope** with its isolation key. A **RuntimeBindingRecord** assigns
that request a monotonically increasing generation and follows:

    PROVISIONING -> READY -> DRAINING -> RELEASED

**FAILED** and **RELEASED** are terminal. A later allocation creates a new
generation. Mutations use an optimistic version and an expiring operation
owner so only one service instance performs a placement action at a time.
This foundation enumerates states but leaves transition-policy enforcement to
the later lifecycle service.

### Runtime Session

A **RuntimeSessionRecord** binds one logical Runtime Session to a binding
generation. Its lifecycle is:

    ACQUIRING -> READY -> RELEASING -> RELEASED

**FAILED** and **RELEASED** are terminal. Repository queries derive the number
of active Sessions for a binding generation so a later lifecycle layer can
make drain and idle-reclaim decisions. Session transition-policy enforcement
also belongs to that lifecycle layer. Repository identity combines the Runtime
scope with `runtimeSessionId`; a same-scope identifier collision with different
immutable Session fields fails instead of returning the existing record.

## Repository semantics

- **findOrCreate** is atomic for the repository identity.
- Runtime binding **compareAndSet** succeeds only for the current version,
  immutable identity, and a live operation claim that the replacement
  preserves. Runtime Session **compareAndSet** requires the current version and
  immutable identity.
- Operation claims use an owner, expiry, and monotonic generation.
- In-memory implementations synchronize compound operations but are not a
  substitute for shared durable storage.

## Security and tenancy

**RuntimeScope** carries tenant, workspace, workspace generation, canonical
working directory, capability digest, and isolation class. The standalone
Broker does not authenticate these values: its Java caller supplies them and
remains responsible for any upstream authentication. The Broker includes the
values in placement and Session identity, and the Runtime or Harness must not
be allowed to replace them.

## Validation plan

- Compile the module with Java 11.
- Run repository unit tests covering concurrent create, generation rollover,
  version-only stale compare-and-set rejection, successful operation renewal,
  operation takeover after expiry, and Session accounting, including
  cross-tenant identity collisions and cross-scope replacement rejection.
- Run Checkstyle against the repository Java conventions.
- Verify hosted and self-hosted Java CI both execute the Runtime Broker module.

## Acceptance criteria

- The module has no dependency on Spring, CLI internals, or a scheduler.
- Concurrent creation returns one active binding generation for each provision
  request.
- Tenant scope participates in placement and Session identity and cannot be
  overwritten by a colliding Runtime Session identifier.
- Terminal binding and Session records cannot be reactivated through the
  repository compare-and-set operation.
- Stale versions and stale ownership generations cannot mutate current state.
- The public records validate required identities and immutable relationships.
- Documentation does not claim that Runtime lifecycle or durable persistence is
  already implemented.

## Follow-up work

Later PRs may add tool execution identity, provisioning seeds, durable
repository adapters, Runtime transport and provisioning, Hosted Harness
integration, Spring wiring, and end-to-end tests. Each follow-up must depend
on this state boundary instead of adding an alternative in-memory source of
truth.

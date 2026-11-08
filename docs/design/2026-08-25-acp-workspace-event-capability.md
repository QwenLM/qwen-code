# ACP workspace event capability

## Problem

Several serve-layer services accept the full ACP session bridge even though they only publish workspace events, or publish events plus validate an originating client id. This couples small services and their tests to a bridge interface with more than one hundred members.

## Design

Define a workspace event publisher capability and a two-method workspace event bridge capability. The full session bridge continues to implement both through interface extension, so runtime behavior and construction stay unchanged. Narrow the git-status watcher, device-flow fan-out, memory mutation routes, and GitHub setup route to the smallest applicable capability.

## Non-goals

- Split the bridge implementation or factory.
- Change event delivery, client validation, or bridge construction.
- Migrate session lifecycle, artifacts, permissions, or command invocation in this change.

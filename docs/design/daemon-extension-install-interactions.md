# Daemon Extension Install Interactions

## Context

The daemon installs extensions as asynchronous workspace operations. Some
extensions require the user to select a Claude marketplace plugin or provide
configuration values while installation is in progress.

## Design

An extension operation can enter `waiting_for_input`. Its status exposes one
non-sensitive interaction at a time:

- `marketplace_plugin` includes the marketplace name and selectable plugins.
- `setting` includes a setting's name, description, environment variable, and
  whether the value is sensitive.

The client polls the existing operation status endpoint, then submits the
answer to `POST /workspace/extensions/operations/:operationId/interactions/:interactionId`.
The operation's in-memory callback resumes after the answer is validated.

Setting values are never included in operation status, results, or logs. The
existing extension settings mechanism remains responsible for storing them.

## Lifetime

Install and update operations have a shared twenty-minute lifetime. Each
interaction may use up to ten minutes of the operation's remaining lifetime.
Other extension mutations keep their existing timeout. A waiting operation
remains in the existing serialized mutation queue, so no other extension
mutation can observe partially installed state.

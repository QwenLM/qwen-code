# Reduce unnecessary Computer Use model round trips

[English](cua-skill-round-trips.md) | [简体中文](cua-skill-round-trips.zh-CN.md)

## Problem and scope

The platform-routed skill currently illustrates initialization, platform lookup,
reference reading and cleanup as separate calls. A recorded successful macOS
task used separate model responses for those steps and also split a known edit
from saving. The native tool calls occupied only a small part of elapsed time.
This change improves the general skill workflow; it adds no application-specific
instructions and changes no SDK, native API, task prompt or authorization policy.

## Proposed behavior

Initialize the connection, query its platform and read exactly one local skill
reference in the same REPL call. The skill's actual directory is supplied from
the loader or the file just read. A filesystem-import failure retains the
existing `read_file` fallback. Platform-specific UI work begins only after the
selected reference has been returned and read; unknown platforms still fail.

For macOS, batch known actions that retain their target, including saving, until
a new decision is needed. New dialogs, menus, target changes and uncertain
results still require observation. Prefer AX text when sufficient, and use
screenshots for missing context, coordinates or visual properties. Close the
connection after final verification in the same call when the task is complete.

## Risks and validation

Batching must not guess future dialog controls or repeat unconfirmed actions.
The resource path belongs to the skill host, even when the connected desktop
is remote. Preserve the existing platform, observation and text-operation tests;
build and typecheck the packaged SDK and ensure staged skill resources match.
Run the unchanged task in a fresh VM clone, with the same model and pristine
input. Accept the change only with a correct saved output and observed reduction
in unnecessary response boundaries; record time and tokens including regressions.
Additional apps assess whether the guidance generalizes. Live results belong to
the experiment report; a single run does not establish a stable average speedup.

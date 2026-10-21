# Extension list and detail loading

[English](extension-list-details.md) | [简体中文](extension-list-details.zh-CN.md)

## Problem and scope

The extension manager loads every installed extension's skills, commands, agents,
context, and settings before displaying its list. The list needs only manifest
metadata and activation; resource details are needed for the selected extension.

This change is independent of the workspace activation projection optimization
(#12541) and in-flight full-status request coalescing (#12638). It uses the
existing catalog reader and does not change the full-status cache. Shared files
may require ordinary conflict resolution when merging #12638.

## API and ownership

The additive `extension_list_details` capability advertises two legacy-primary
workspace routes:

- `GET /workspace/extensions/summary`: the existing status envelope with extension
  metadata and activation, omitting `capabilities` and `details` entirely.
- `GET /workspace/extensions/:name/details`: one complete extension entry, or
  HTTP 404 with `extension_not_found` when the extension is absent.

The existing full-status API and workspace-qualified activation projection retain
their contracts. Both new routes use the resolved controller's workspace, trust,
locale, and lifecycle generation checks. They do not select a different runtime
or fall back after a resolution failure.

## Loading and consistency

The list reads a consistent catalog snapshot without loading subresources. The
single-detail reader loads all manifest identities under the same store read
boundary, but loads subresources only for the requested name. This preserves
identity validation and snapshot activation semantics without walking the
resources of preceding extensions. Neither reader populates the manager cache or
creates plugin data directories. Existing manifest and subresource error behavior
is preserved. Shared response mapping keeps source redaction and metadata
identical to the full-status response.

## Client behavior and compatibility

The SDK adds separate list and detail methods. The extension manager uses them
only when the daemon advertises the capability, otherwise it retains full-status
loading. Selecting an extension loads its details separately with loading, error,
and retry states. Changing the selection or refreshing the summary invalidates
older responses; resource fields are combined with current list metadata so
stale details cannot overwrite activation changes. Other status consumers remain
unchanged.

## Validation and acceptance

- The list omits resource fields, and its metadata agrees with full status.
- A selected extension's details agree with full status; missing names return 404.
- Only selected subresources load; cache state and plugin directories stay intact.
- Tests cover selection races, refresh, errors, and old-daemon compatibility.
- Build, typecheck, focused tests, and real HTTP smoke checks pass.
- Alternating real-filesystem measurements compare full status, summary, detail,
  and summary plus detail for 20 and 100 extensions. Report warm-cache local
  controller latency separately from browser and network performance.

## Risks and limits

A detail request still reads all manifests to preserve store identity consistency.
List and detail are separate snapshots, so an uninstall between them can return
404 and is shown as a detail error. This change adds no persistent detail cache or
in-flight coalescing. End-to-end browser latency and cold-disk behavior need
separate measurements; they cannot be inferred from controller benchmarks.

# Responses stable prefix caching

[English](responses-stable-prefix-cache.md) | [简体中文](responses-stable-prefix-cache.zh-CN.md)

## Problem and scope

Auto-memory catalogs and reattached images are request-only trailing content.
They carry `REATTACH_BOUNDARY_METADATA` and are absent from stored history.
Responses currently ignores that boundary. For GPT-5.6 and later, an implicit
write through the temporary tail does not write a separately reusable endpoint
at the unchanged conversation prefix. A stable session cache key alone cannot
fix this. Preserve the catalog, instructions, tool results, reasoning, images,
and their existing order.

## Implementation

The converter reports the last stable input item and, when necessary, the last
stable content block within that item. This metadata stays local. After merging
caller request options, the pipeline adds explicit breakpoints to at most three
recent stable user-text or group-ending function-output boundaries. The implicit
tail remains enabled, keeping the total within four write slots. Apply this
before orphan cleanup so conversion indices still identify the intended items.

Normalize all historical user strings and function outputs to text-block arrays
when applying this policy, including outputs whose markers rotate out. Marker
rotation must not change the representation of earlier text. Custom tool outputs
retain their existing representation; a function output followed by another
function or custom output is not a group endpoint. No text is removed or changed.

## Compatibility and cost

Reuse the existing GPT-5.6+ capability check. The official Responses endpoint,
including its default URL, enables the policy automatically. Compatible proxies
opt in through existing `enableCacheControl: true` or
`extra_body.prompt_cache_options` with implicit mode. `enableCacheControl: false`
disables automatic additions. Explicit-only mode or existing caller breakpoints
retain caller ownership. Requests without a volatile boundary remain unchanged.

Preserve `prompt_cache_key` and caller TTL settings. Do not select a longer TTL;
omitting it retains the server's default 30-minute lifetime. New stable endpoints
can incur writes, with later reads dependent on prefix identity, routing, expiry,
and compaction. No cache-hit percentage is guaranteed. See the
[official prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching).

## Validation and acceptance

The latest-main pipeline regression must fail before the fix and pass afterward.
Cover user text before a catalog, grouped tool outputs, six-turn marker rotation,
image reattachment, tool-returned media, caller settings, older models, and proxy
opt-in. Verify unchanged source history, payload text, order, cache key and TTL,
at most three explicit markers, and matching previous endpoints after rotation.
Run relevant tests, build, typecheck, lint, and a built-runtime loopback transport
check. These local checks establish request correctness; prior controlled live
experiments support the mechanism but are not production acceptance of this
revision or a measurement of long-history cache-hit rates.

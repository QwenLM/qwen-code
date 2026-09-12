# Avoid AX ancestry cycles

[English](osworld-pivot-ax-cycles.md) | [简体中文](osworld-pivot-ax-cycles.zh-CN.md)

## Evidence and scope

Case50R2 repeats Create PivotTable controls until max_depth, then discards every facade token as incomplete. Independent traversal of a separate workbook proves two AXTextField nodes each return themselves as AXChildren[0] by CFEqual, not just matching labels. The unique tree has21 nodes. AXPress also returns -25204 while opening the dialog; that separate error is not explained or fixed here.

## Candidate and verification

Maintain one visited identity set for the entire walk using retained AXIdentity with CFHash/CFEqual. Preserve the first DFS occurrence of each identity and skip subsequent edges to it, including cycles and cross-branch aliases. The revision store requires unique identities; retaining both appearances of a shared control makes the whole facade observation unstable. Unseen siblings and descendants are still traversed, and identity storage remains bounded by the walk limits. It does not turn attribute failures, noncyclic depth truncation or real missing nodes into complete captures. Retained identities are released on scope exit.

Status: verified on the same real dialog, with frozen old/new native libraries and identical JS. Native tests/build, full facade tokens, preservation of nonrepeated controls, an actual dialog token action and normal NameBox observations passed. A complete cycle-filtered observation is not evidence of full-task efficiency success.

Ancestor-only candidate aee52939 reduced the same dialog from10343 to1900 bytes but still returned no facade tokens: two Collapse Dialog controls also have cross-branch CFEqual identities. This failed candidate is retained as evidence. Candidate b47e0102 applies whole-walk identity uniqueness;357 native tests and release build passed. Independent verification passed23 checks:89 rendered rows become17, all17 unique semantic rows and9 actionable controls survive, both observations are complete with stable tokens, and the first Cancel token actually closes the dialog. NameBox focus and B2 selection also pass. First observation445.420→284.413ms is a local control, not a full-task speedup. Independent code review reports no findings. Evidence: `.qwen/issues/osworld-pivot-ax-cycle.md`.

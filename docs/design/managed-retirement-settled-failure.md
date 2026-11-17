# Retire external Workspaces after settled failures

[English](managed-retirement-settled-failure.md) | [简体中文](managed-retirement-settled-failure.zh-CN.md)

## Problem and proposal

FAILED and CANCELLED operations can deliberately retain a BLOCKED delivery marker so the relay does not dispatch them again. Treating that marker as an unfinished effect permanently fences retirement of an otherwise terminated external Worker.

Retirement now fences nonterminal operation states while accepting COMPLETED, FAILED and CANCELLED operations. Existing checks for pending approvals, active work, ownership, Session membership and original runtime termination remain in place. This changes retirement eligibility, not relay delivery or Worker creation.

## Compatibility and validation

This update extends resident external Workspace retirement and makes no schema change. A terminated Workspace with a terminal failed operation and BLOCKED delivery should retire; an otherwise identical nonterminal operation must still refuse retirement. Existing approval and unfinished-work fencing must remain effective. Regression source is included, but fresh public-head CI and real lifecycle acceptance are pending; no local test pass is claimed.

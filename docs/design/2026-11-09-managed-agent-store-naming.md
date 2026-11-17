# Managed Agent store implementation naming

[English](2026-11-09-managed-agent-store-naming.md) | [简体中文](2026-11-09-managed-agent-store-naming.zh-CN.md)

## Status and scope

- Status: implemented in the change that adds this document.
- Date: 2026-11-09
- Scope: `packages/managed-agent-server` — production sources and the verification fixtures that name production classes.
- Baseline: `origin/main` `e5eb6a1775`.

## Problem

Twenty-four repository interfaces in `com.alibaba.qwen.code.managedagent.repository` (module `contracts`) have implementations with the same simple name in `com.alibaba.qwen.code.managedagent.persistence` (module `persistence`), for example `ManagedSessionStore` and `WorkspaceExecutionStore`. The child-worktree Git port `contracts.workspace.ChildWorktreeGit` likewise shares its name with its adapter `adapters.workspace.ChildWorktreeGit`.

A Java file can import only one of two types with the same simple name. Every implementation, and every persistence class that also uses its interface's nested records or static helpers, must therefore spell the interface fully qualified. At the baseline, production sources had 1,347 lines with an inline fully qualified class name; 662 of them name one of these colliding types. For example, `com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable()` alone appears on more than 200 lines. In such files a bare simple name can mean either type, depending on the file's package and imports.

## Design

Rename the implementation, or the port when the implementation already has the more specific name. Interfaces that consumers inject keep their names.

- The 23 implementations whose own code runs JDBC take the `Jdbc` prefix, following the existing `JdbcRuntimeBindingRepository` and `JdbcChannelRouteRepository`: `JdbcAutomationLedgerStore`, `JdbcChannelInstanceStore`, `JdbcChildResultRelayStore`, `JdbcChildWorkspaceStore`, `JdbcHarnessPlacementStore`, `JdbcHostedCleanupDebtStore`, `JdbcManagedActionStore`, `JdbcManagedAgentDefinitionStore`, `JdbcManagedExtensionRecordStore`, `JdbcManagedSessionSkills`, `JdbcManagedSessionStore`, `JdbcManagedTaskEventStore`, `JdbcManagedToolDetailsStore`, `JdbcManagedToolResultStore`, `JdbcManagedUserMessageStore`, `JdbcManagedWorkspaceRegistry`, `JdbcSessionMessageRelayStore`, `JdbcSessionWorktreeStore`, `JdbcSshWorkspaceStore`, `JdbcTransportConsumerStore`, `JdbcWakeRecoveryStore`, `JdbcWorkspaceExecutionStore` and `JdbcWorkspaceLifecycleStore`.
- The `ManagedArtifactReader` implementation does not query the database itself; it reads through the tool-publication data store. It becomes `ToolPublicationArtifactReader`.
- The child-worktree port becomes `ChildWorktreeOperations`, matching the existing `SessionWorktreeOperations` port and its `SessionWorktreeGit` adapter. The adapter keeps the name `ChildWorktreeGit`.
- With the collisions gone, inline fully qualified references to these types become imports. Afterwards, 685 production lines still use inline fully qualified names, and none of them names a renamed pair.
- Static helpers and error factories stay on their interfaces, for example `WorkspaceExecutionStore.unavailable()`. They need no move once the simple name is unambiguous.

Convention for new code: a `persistence` implementation does not reuse the simple name of the `repository` interface it implements. A JDBC implementation is named `Jdbc<Interface>`.

## Constraints

- No runtime behavior changes. SQL, transaction boundaries and attributes, locking order, wire and JSON names, configuration keys, database bytes and digests stay unchanged. Each renamed class keeps its annotations, qualifiers and constructors.
- Spring injects these components by type. The existing qualifiers name infrastructure beans, such as the data source, JDBC template, transaction manager, object mapper, clock and executors, and never a renamed component. The default bean names derived from the renamed classes change (for example `managedSessionStore` becomes `jdbcManagedSessionStore`), but nothing in the repository refers to a bean by those names.
- `JdbcHostedCleanupDebtStore` and `JdbcManagedExtensionRecordStore` declare class-based loggers, so their log categories change with their class names. The repository configures no logging level for those categories.
- The rename is mechanical. Each simple name is resolved with Java's lookup order: the file's own type, single-type imports, the same package, then on-demand imports. Only references bound to a renamed type change. Imports are kept in Checkstyle's order.
- The verification fixtures that spell production class names are updated: the lock-contract signature entries, the SQL-owner source paths (kept sorted, as the test requires) and the class-size pin keys.

## Class-size ratchet exception

The [class-size ratchet](2026-11-04-managed-agent-class-size-ratchet.md) counts every line, including imports. Fourteen pinned classes grow by one to three import lines, and no other line in them changes. Their ceilings rise by exactly that amount, and each raised entry is marked `imports +N` in the pin. The global ceiling and every other ceiling stay unchanged. This is a deliberate, reviewed exception to the "ceilings only go down" rule: the growth consists of import declarations, not code.

## Out of scope

- Inline fully qualified names that do not come from these collisions, for example the schema row and key helpers.
- The two unrelated `WorkspaceSelection` value classes.
- Test class names such as `ManagedSessionStoreTest`, and historical design documents that mention the earlier class names.

## Validation and acceptance

- A normalization check confirms that every changed Java file differs from the baseline only by the rename and its imports.
- Acceptance: all production modules and verification sources compile; Checkstyle, SpotBugs and the complete unit/H2 suite pass in CI, including `ModuleArchitectureTest`, `ClassSizeRatchetTest` and `SessionRowLockOrderTest`. The MySQL, Hosted and fault profiles pass with their existing selectors.

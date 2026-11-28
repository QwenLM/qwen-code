# Managed Agent Server Java import cleanup

[English](2026-11-25-managed-agent-java-imports.md) | [简体中文](2026-11-25-managed-agent-java-imports.zh-CN.md)

## Scope

Fully qualified type names in annotations, method signatures, and expressions make
the Managed Agent Server production code harder to read. The cleanup covers Java
files under `packages/managed-agent-server/*/src/main/java`.

## Approach

Use the short name for each type when it resolves to the original class. Add an
explicit import where Java requires one. For types in the current package and
`java.lang`, use the implicit import. Keep qualified names where a short name
would refer to a different class. In the Harness SDK adapter, both the SDK and
the service contract define `HarnessRuntimeRecovery`, so the SDK parameter
keeps its qualified name.

The Java compiler identifies type references in source. This leaves package
declarations, comments, and string literals such as Spring scan targets and
class names for reflection intact.

## Verification

Build the production reactor with JDK 21 before and after the cleanup with
debug information disabled (`-g:none`). Compare the class files byte for byte to
verify that the compiler resolved the same classes, methods, and annotations.
Run both Checkstyle configurations and focused tests for module boundaries,
Spring wiring, API contracts, persistence, and the runtime broker.

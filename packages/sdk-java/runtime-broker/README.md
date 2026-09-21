# Qwen Managed Runtime Broker State

This Java 21 module defines the durable state boundary for a future Managed
Agent Runtime Broker. It contains Runtime binding, Runtime Session, and Tool
execution records; repository contracts; and thread-safe in-memory
implementations for tests and single-process prototypes.

This foundation intentionally does not provision Runtime processes, expose an
HTTP API, or call the Hosted Harness. Those integrations belong to later PRs
that depend on this module.

Building and running this module requires JDK 21 or later. Its Maven release
target is 21; services embedding the resulting JAR must also use JDK 21 or later.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

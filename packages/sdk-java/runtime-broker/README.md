# Qwen Managed Runtime Broker State

This Java 25 module defines the durable state boundary for a future Managed
Agent Runtime Broker. It contains Runtime binding and Runtime Session records,
repository contracts, and thread-safe in-memory implementations for tests and
single-process prototypes.

This foundation intentionally does not provision Runtime processes, expose an
HTTP API, call the Hosted Harness, or track tool execution. Those integrations
belong to later PRs that depend on this module.

Building and running this module requires JDK 25 or later. Its Maven release
target is 25; services embedding the resulting JAR must also use JDK 25 or later.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

# Qwen Managed Runtime Broker State

This Java 11 module defines the durable state boundary for a future Managed
Agent Runtime Broker. It contains Runtime binding and Runtime Session records,
repository contracts, and thread-safe in-memory implementations for tests and
single-process prototypes.

This foundation intentionally does not provision Runtime processes, expose an
HTTP API, call the Hosted Harness, or track tool execution. Those integrations
belong to later PRs that depend on this module.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

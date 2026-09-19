# Qwen Managed Runtime Broker State

Keep this module independent of Spring, Qwen Code CLI internals, and any
specific Runtime scheduler. Repository contracts define the persistence
boundary; in-memory implementations are reference implementations for tests
and single-process prototypes only.

Build and test with:

```bash
mvn test
mvn checkstyle:check
```

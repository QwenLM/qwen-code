# Qwen Code Java SDK

This package publishes `com.alibaba:qwencode-sdk:0.1.0-alpha` and requires
Java 11 or newer. Java 8 users must remain on `0.0.3-alpha`.

The recommended API is the Java 11 daemon transport in
`com.alibaba.qwen.code.daemon`. It talks to `qwen serve` through REST and SSE,
creates thread-scoped sessions by default, fails closed without a reliable
prompt terminal, and uses periodic heartbeats when the daemon advertises them.

The experimental stdio API remains in `com.alibaba.qwen.code.cli` for source
compatibility. The daemon package is intentionally independent of its process
transport, DTOs, sessions, and global executor.

Build and test with Maven:

```bash
mvn test
mvn checkstyle:check
mvn package
```

Use the package `README.md` for API examples, compatibility notes, reliability
semantics, and known alpha limitations. The implementation design is tracked
in `docs/design/java-daemon-sdk-alpha.md` at the repository root.

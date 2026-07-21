# Release Notes

## Changes in 0.1.0-alpha

### Summary

This release adds the Java 11 daemon transport to the existing `com.alibaba:qwencode-sdk` artifact. The new `com.alibaba.qwen.code.daemon` API uses `POST` admission watermarks and resumable SSE to avoid returning truncated prompt output as success. The legacy stdio API remains available.

### Compatibility

- Minimum Java version: 11
- Java 8 users must remain on `0.0.3-alpha`
- Applications now select their own SLF4J provider; Logback is test-only
- Fastjson2 and Jackson Core remain implementation dependencies and are absent from daemon public API signatures
- Use the qwen-code build released from the same source revision as the SDK; the daemon must contain [#7386](https://github.com/QwenLM/qwen-code/pull/7386), [#7400](https://github.com/QwenLM/qwen-code/pull/7400), and this release's acknowledged admission cancellation plus FIFO cancel-drain fence

### Reliability contract

- Prompt, create, permission, cancel, heartbeat, detach, and delete mutations are not retried automatically
- HTTP 408 and 5xx responses to those mutations remain outcome-unknown
- SSE uses identity encoding, replay cursors, ordered callbacks, duplicate suppression, gap detection, and bounded reconnect
- JSON decoding rejects non-standard syntax and duplicate object keys
- Finite HTTP response bodies and SSE observation are independently deadline-bound
- Session creation fails before mutation unless REST and `session_scope_override` are advertised
- A requested daemon prompt deadline fails before mutation unless `prompt_absolute_deadline` is advertised
- When the daemon advertises `client_heartbeat`, open sessions send periodic
  heartbeat mutations until detach or destroy
- Only a matching `turn_complete` or `turn_error` is terminal
- A cooperative cancellation is `turn_complete` with `stopReason=cancelled`; an agent or provider failure during cancellation can instead produce `turn_error`, so callers wait for and inspect the formal terminal
- When cancellation, deadline, teardown, and agent settlement race, the daemon's first formal terminal wins; callers must not infer the outcome from the last control mutation they sent
- Missing terminal, resync, session death, observer failure, timeout, and reconnect exhaustion fail closed
- `close()` attempts detach at most once; only `destroySession()` sends DELETE

### Known alpha limits

The SDK does not promise exactly-once prompt execution across daemon restarts, automatic epoch recovery, snapshot/resync, persisted cursors, or true prompt-ID-targeted cancellation. Creation-time model selection is omitted because the current daemon reports rejection only through an SSE event emitted before the create response. An ambiguous create may leave an unidentified session until the daemon reaps it.

### Maven configuration

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>qwencode-sdk</artifactId>
    <version>0.1.0-alpha</version>
</dependency>
```

## Changes in 0.0.2-alpha

### Summary

This release includes a fix for modifying some fields as referenced in issue #1459.

#### Fix

- Issue: modify some fields #1459

### Release Date

January 14, 2026

### Maven Configuration

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>qwencode-sdk</artifactId>
    <version>0.0.2-alpha</version>
</dependency>
```

## Changes in 0.0.1-alpha

### Summary

This release includes updates to the Qwen Code Java SDK with improved session management, enhanced transport options, and better error handling capabilities.

### Maven Configuration

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>qwencode-sdk</artifactId>
    <version>0.0.1-alpha</version>
</dependency>
```

#### Gradle Configuration

```gradle
implementation 'com.alibaba:qwencode-sdk:0.0.1-alpha'
```

### Release Date

January 5, 2026

#### New Features

- Enhanced session management with dynamic model switching
- Improved permission mode controls with multiple options (default, plan, auto-edit, yolo)
- Support for streaming content handling with custom content consumers
- Thread pool configuration for managing concurrent operations
- Session resumption capabilities using resumeSessionId
- Dynamic permission mode switching during active sessions

#### Improvements

- Better timeout handling with configurable session and message timeouts
- Enhanced error handling with specific exception types
- Improved transport options configuration
- More flexible environment variable passing to CLI process
- Better support for partial message streaming

#### Bug Fixes

- Fixed session interruption handling
- Resolved issues with tool execution permissions
- Improved stability of process transport communication
- Fixed potential resource leaks in session cleanup

### Known Issues

1. **Memory Management**: Long-running sessions with extensive streaming content may consume significant memory. Proper session cleanup using `session.close()` is essential.

2. **Thread Pool Configuration**: The legacy stdio API's default thread pool configuration (30 core, 100 max threads) may need adjustment based on application load and concurrent session requirements.

3. **Timeout Configuration**: Legacy stdio users experiencing timeout issues should adjust the `turnTimeout` and `messageTimeout` values in `TransportOptions` based on their specific use cases.

4. **Permission Mode Confusion**: The different legacy stdio permission modes (default, plan, auto-edit, yolo) may cause confusion for new users. Clear documentation and examples are needed to guide users in selecting appropriate permission modes.

5. **Environment Variable Limitations**: Environment variables passed to the legacy stdio CLI process may have platform-specific limitations on length and character sets.

### Maven Build Configuration

The project uses Maven for build management with the following key plugins and configurations:

#### Compiler Plugin

- Compiler release: Java 11
- Encoding: UTF-8

#### Dependencies

- Logging API: org.slf4j:slf4j-api
- Utilities: org.apache.commons:commons-lang3
- JSON Processing: Fastjson2 for encoding and Jackson Core for strict decoding
- Testing: JUnit 5 (org.junit.jupiter:junit-jupiter)

#### Build Plugins

- **Checkstyle Plugin**: Enforces code style consistency using checkstyle.xml configuration
- **JaCoCo Plugin**: Provides code coverage reports during testing
- **Central Publishing Plugin**: Enables publishing to Maven Central
- **Source Plugin**: Generates and attaches source JARs
- **Javadoc Plugin**: Generates and attaches Javadoc JARs
- **GPG Plugin**: Signs artifacts for secure publishing to Maven Central

#### Publishing

- Releases: Sonatype Central Publisher Portal through the official Maven plugin

### Deployment Instructions

To release this version of the SDK:

1. Merge the version and release notes to protected `main`.
2. Run the `Release Java SDK` workflow in dry-run mode.
3. Approve the protected production environment and rerun with dry-run disabled.
4. The workflow first pins the verified source with an immutable tag, then signs and publishes the artifacts, waits for Maven Central availability, and creates the GitHub Release. A failed publish can safely resume from the matching tag commit even if `main` has advanced.

### Future Enhancements

Planned improvements for upcoming releases:

1. **Enhanced Security**: Additional authentication mechanisms and secure credential handling
2. **Performance Optimization**: Improved memory usage and faster response times
3. **Extended API Coverage**: More comprehensive coverage of Qwen Code CLI features
4. **Better Documentation**: Expanded examples and API reference materials
5. **Improved Error Recovery**: More robust handling of connection failures and retries

### Support and Contributions

For support, bug reports, or contributions:

- Issue Tracker: https://github.com/QwenLM/qwen-code/issues
- Documentation: Refer to README.md and Javadoc
- Contributions: Pull requests are welcome following the project's contribution guidelines

### License

This project is licensed under the Apache 2.0 License - see the [LICENSE](./LICENSE) file for details.

# Release Notes

### Changes in 0.0.2-alpha

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

### Changes in 0.0.1-alpha

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

1. **CLI Bundling**: From v0.1.1, the CLI is bundled with the SDK, eliminating the need for separate CLI installation. However, users upgrading from earlier versions should remove any standalone CLI installations to avoid conflicts.

2. **Memory Management**: Long-running sessions with extensive streaming content may consume significant memory. Proper session cleanup using `session.close()` is essential.

3. **Thread Pool Configuration**: The default thread pool configuration (30 core, 100 max threads) may need adjustment based on application load and concurrent session requirements.

4. **Timeout Configuration**: Users experiencing timeout issues should adjust the `turnTimeout` and `messageTimeout` values in `TransportOptions` based on their specific use cases.

5. **Permission Mode Confusion**: The different permission modes (default, plan, auto-edit, yolo) may cause confusion for new users. Clear documentation and examples are needed to guide users in selecting appropriate permission modes.

6. **Environment Variable Limitations**: Environment variables passed to the CLI process may have platform-specific limitations on length and character sets.

### Maven Build Configuration

The project uses Maven for build management with the following key plugins and configurations:

#### Compiler Plugin

- Source and Target: Java 1.8
- Encoding: UTF-8

#### Dependencies

- Logging: ch.qos.logback:logback-classic
- Utilities: org.apache.commons:commons-lang3
- JSON Processing: com.alibaba.fastjson2:fastjson2
- Testing: JUnit 5 (org.junit.jupiter:junit-jupiter)

#### Build Plugins

- **Checkstyle Plugin**: Enforces code style consistency using checkstyle.xml configuration
- **JaCoCo Plugin**: Provides code coverage reports during testing
- **Central Publishing Plugin**: Enables publishing to Maven Central
- **Source Plugin**: Generates and attaches source JARs
- **Javadoc Plugin**: Generates and attaches Javadoc JARs
- **GPG Plugin**: Signs artifacts for secure publishing to Maven Central

#### Distribution Management

- Snapshot Repository: https://central.sonatype.com/repository/maven-snapshots/
- Release Repository: https://central.sonatype.org/service/local/staging/deploy/maven2/

### Deployment Instructions

To deploy a new version of the SDK:

1. Update the version in `pom.xml`
2. Run `mvn clean deploy` to build and deploy to Maven Central
3. Ensure GPG signing keys are properly configured
4. Verify the deployment in the Sonatype staging repository

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

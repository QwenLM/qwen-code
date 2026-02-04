# Qwen Code Java SDK

Qwen Code Java SDK 是一个最小化实验性 SDK，用于以编程方式访问 Qwen Code 功能。它提供了一个 Java 接口来与 Qwen Code CLI 交互，允许开发者将 Qwen Code 能力集成到他们的 Java 应用程序中。

## 系统要求

- Java >= 1.8
- Maven >= 3.6.0（用于从源码构建）
- qwen-code >= 0.5.0

### 依赖项

- **日志**: ch.qos.logback:logback-classic
- **工具类**: org.apache.commons:commons-lang3
- **JSON 处理**: com.alibaba.fastjson2:fastjson2
- **测试**: JUnit 5 (org.junit.jupiter:junit-jupiter)

## 安装

在你的 Maven `pom.xml` 中添加以下依赖：

```xml
<dependency>
    <groupId>com.alibaba</groupId>
    <artifactId>qwencode-sdk</artifactId>
    <version>{$version}</version>
</dependency>
```

或者如果使用 Gradle，在你的 `build.gradle` 中添加：

```gradle
implementation 'com.alibaba:qwencode-sdk:{$version}'
```

## 构建和运行

### 构建命令

```bash
# 编译项目
mvn compile

# 运行测试
mvn test

# 打包 JAR
mvn package

# 安装到本地仓库
mvn install
```

## 快速入门

使用 SDK 最简单的方式是通过 `QwenCodeCli.simpleQuery()` 方法：

```java
public static void runSimpleExample() {
    List<String> result = QwenCodeCli.simpleQuery("hello world");
    result.forEach(logger::info);
}
```

使用自定义传输选项的高级用法：

```java
public static void runTransportOptionsExample() {
    TransportOptions options = new TransportOptions()
            .setModel("qwen3-coder-flash")
            .setPermissionMode(PermissionMode.AUTO_EDIT)
            .setCwd("./")
            .setEnv(new HashMap<String, String>() {{put("CUSTOM_VAR", "value");}})
            .setIncludePartialMessages(true)
            .setTurnTimeout(new Timeout(120L, TimeUnit.SECONDS))
            .setMessageTimeout(new Timeout(90L, TimeUnit.SECONDS))
            .setAllowedTools(Arrays.asList("read_file", "write_file", "list_directory"));

    List<String> result = QwenCodeCli.simpleQuery("who are you, what are your capabilities?", options);
    result.forEach(logger::info);
}
```

使用自定义内容消费者进行流式内容处理：

```java
public static void runStreamingExample() {
    QwenCodeCli.simpleQuery("who are you, what are your capabilities?",
            new TransportOptions().setMessageTimeout(new Timeout(10L, TimeUnit.SECONDS)), new AssistantContentSimpleConsumers() {

                @Override
                public void onText(Session session, TextAssistantContent textAssistantContent) {
                    logger.info("接收到文本内容: {}", textAssistantContent.getText());
                }

                @Override
                public void onThinking(Session session, ThingkingAssistantContent thingkingAssistantContent) {
                    logger.info("接收到思考内容: {}", thingkingAssistantContent.getThinking());
                }

                @Override
                public void onToolUse(Session session, ToolUseAssistantContent toolUseContent) {
                    logger.info("接收到工具使用内容: {} 参数: {}",
                            toolUseContent, toolUseContent.getInput());
                }

                @Override
                public void onToolResult(Session session, ToolResultAssistantContent toolResultContent) {
                    logger.info("接收到工具结果内容: {}", toolResultContent.getContent());
                }

                @Override
                public void onOtherContent(Session session, AssistantContent<?> other) {
                    logger.info("接收到其他内容: {}", other);
                }

                @Override
                public void onUsage(Session session, AssistantUsage assistantUsage) {
                    logger.info("接收到使用信息: 输入 tokens: {}, 输出 tokens: {}",
                            assistantUsage.getUsage().getInputTokens(), assistantUsage.getUsage().getOutputTokens());
                }
            }.setDefaultPermissionOperation(Operation.allow));
    logger.info("流式示例完成。");
}
```

其他示例请参见 src/test/java/com/alibaba/qwen/code/cli/example

## 架构

SDK 遵循分层架构：

- **API 层**：通过 `QwenCodeCli` 类提供主要入口点，包含简单的静态方法用于基本使用
- **会话层**：通过 `Session` 类管理与 Qwen Code CLI 的通信会话
- **传输层**：处理 SDK 和 CLI 进程之间的通信机制（目前使用通过 `ProcessTransport` 的进程传输）
- **协议层**：基于 CLI 协议定义通信的数据结构
- **工具类**：用于并发执行、超时处理和错误管理的通用工具

## 功能特性

### 权限模式

SDK 支持不同的权限模式来控制工具执行：

- **`default`**：写入工具被拒绝，除非通过 `canUseTool` 回调批准或在 `allowedTools` 中。只读工具无需确认即可执行。
- **`plan`**：阻止所有写入工具，指示 AI 首先提出计划。
- **`auto-edit`**：自动批准编辑工具（edit、write_file），其他工具需要确认。
- **`yolo`**：所有工具自动执行，无需确认。

### 会话事件消费者和助手内容消费者

SDK 提供两个关键接口来处理来自 CLI 的事件和内容：

#### SessionEventConsumers 接口

`SessionEventConsumers` 接口为会话期间的不同类型消息提供回调：

- `onSystemMessage`：处理来自 CLI 的系统消息（接收 Session 和 SDKSystemMessage）
- `onResultMessage`：处理来自 CLI 的结果消息（接收 Session 和 SDKResultMessage）
- `onAssistantMessage`：处理助手消息（AI 响应）（接收 Session 和 SDKAssistantMessage）
- `onPartialAssistantMessage`：在流式传输期间处理部分助手消息（接收 Session 和 SDKPartialAssistantMessage）
- `onUserMessage`：处理用户消息（接收 Session 和 SDKUserMessage）
- `onOtherMessage`：处理其他类型的消息（接收 Session 和 String 消息）
- `onControlResponse`：处理控制响应（接收 Session 和 CLIControlResponse）
- `onControlRequest`：处理控制请求（接收 Session 和 CLIControlRequest，返回 CLIControlResponse）
- `onPermissionRequest`：处理权限请求（接收 Session 和 CLIControlRequest<CLIControlPermissionRequest>，返回 Behavior）

#### AssistantContentConsumers 接口

`AssistantContentConsumers` 接口处理助手消息中的不同类型内容：

- `onText`：处理文本内容（接收 Session 和 TextAssistantContent）
- `onThinking`：处理思考内容（接收 Session 和 ThingkingAssistantContent）
- `onToolUse`：处理工具使用内容（接收 Session 和 ToolUseAssistantContent）
- `onToolResult`：处理工具结果内容（接收 Session 和 ToolResultAssistantContent）
- `onOtherContent`：处理其他内容类型（接收 Session 和 AssistantContent）
- `onUsage`：处理使用信息（接收 Session 和 AssistantUsage）
- `onPermissionRequest`：处理权限请求（接收 Session 和 CLIControlPermissionRequest，返回 Behavior）
- `onOtherControlRequest`：处理其他控制请求（接收 Session 和 ControlRequestPayload，返回 ControlResponsePayload）

#### 接口之间的关系

**事件层次结构重要说明：**

- `SessionEventConsumers` 是**高级**事件处理器，处理不同的消息类型（系统、助手、用户等）
- `AssistantContentConsumers` 是**低级**内容处理器，处理助手消息中的不同类型内容（文本、工具、思考等）

**处理器关系：**

- `SessionEventConsumers` → `AssistantContentConsumers`（SessionEventConsumers 使用 AssistantContentConsumers 处理助手消息中的内容）

**事件派生关系：**

- `onAssistantMessage` → `onText`、`onThinking`、`onToolUse`、`onToolResult`、`onOtherContent`、`onUsage`
- `onPartialAssistantMessage` → `onText`、`onThinking`、`onToolUse`、`onToolResult`、`onOtherContent`
- `onControlRequest` → `onPermissionRequest`、`onOtherControlRequest`

**事件超时关系：**

每个事件处理方法都有一个相应的超时方法，允许为该特定事件自定义超时行为：

- `onSystemMessage` ↔ `onSystemMessageTimeout`
- `onResultMessage` ↔ `onResultMessageTimeout`
- `onAssistantMessage` ↔ `onAssistantMessageTimeout`
- `onPartialAssistantMessage` ↔ `onPartialAssistantMessageTimeout`
- `onUserMessage` ↔ `onUserMessageTimeout`
- `onOtherMessage` ↔ `onOtherMessageTimeout`
- `onControlResponse` ↔ `onControlResponseTimeout`
- `onControlRequest` ↔ `onControlRequestTimeout`

AssistantContentConsumers 超时方法：

- `onText` ↔ `onTextTimeout`
- `onThinking` ↔ `onThinkingTimeout`
- `onToolUse` ↔ `onToolUseTimeout`
- `onToolResult` ↔ `onToolResultTimeout`
- `onOtherContent` ↔ `onOtherContentTimeout`
- `onPermissionRequest` ↔ `onPermissionRequestTimeout`
- `onOtherControlRequest` ↔ `onOtherControlRequestTimeout`

**默认超时值：**

- `SessionEventSimpleConsumers` 默认超时：180 秒（Timeout.TIMEOUT_180_SECONDS）
- `AssistantContentSimpleConsumers` 默认超时：60 秒（Timeout.TIMEOUT_60_SECONDS）

**超时层次要求：**

为了正常运行，应保持以下超时关系：

- `onAssistantMessageTimeout` 返回值应大于 `onTextTimeout`、`onThinkingTimeout`、`onToolUseTimeout`、`onToolResultTimeout` 和 `onOtherContentTimeout` 返回值
- `onControlRequestTimeout` 返回值应大于 `onPermissionRequestTimeout` 和 `onOtherControlRequestTimeout` 返回值

### 传输选项

`TransportOptions` 类允许配置 SDK 如何与 Qwen Code CLI 通信：

- `pathToQwenExecutable`：Qwen Code CLI 可执行文件的路径
- `cwd`：CLI 进程的工作目录
- `model`：用于会话的 AI 模型
- `permissionMode`：控制工具执行的权限模式
- `env`：传递给 CLI 进程的环境变量
- `maxSessionTurns`：限制会话中的对话轮次数
- `coreTools`：应该对 AI 可用的核心工具列表
- `excludeTools`：排除对 AI 可用的工具列表
- `allowedTools`：预先批准使用的工具列表，无需额外确认
- `authType`：用于会话的身份验证类型
- `includePartialMessages`：启用在流式响应期间接收部分消息
- `skillsEnable`：启用或禁用会话的技能功能
- `turnTimeout`：完整对话轮次的超时时间
- `messageTimeout`：轮次内单个消息的超时时间
- `resumeSessionId`：要恢复的先前会话的 ID
- `otherOptions`：传递给 CLI 的其他命令行选项

### 会话控制功能

- **会话创建**：使用 `QwenCodeCli.newSession()` 创建带有自定义选项的新会话
- **会话管理**：`Session` 类提供发送提示、处理响应和管理会话状态的方法
- **会话清理**：始终使用 `session.close()` 关闭会话以正确终止 CLI 进程
- **会话恢复**：在 `TransportOptions` 中使用 `setResumeSessionId()` 恢复先前的会话
- **会话中断**：使用 `session.interrupt()` 中断当前运行的提示
- **动态模型切换**：使用 `session.setModel()` 在会话期间更改模型
- **动态权限模式切换**：使用 `session.setPermissionMode()` 在会话期间更改权限模式

### 线程池配置

SDK 使用线程池管理并发操作，默认配置如下：

- **核心池大小**：30 个线程
- **最大池大小**：100 个线程
- **保持活动时间**：60 秒
- **队列容量**：300 个任务（使用 LinkedBlockingQueue）
- **线程命名**："qwen_code_cli-pool-{number}"
- **守护线程**：false
- **拒绝执行处理器**：CallerRunsPolicy

## 优点和缺点

### 优点

#### 1. **易于集成**
- 简单的 API 设计，使用 `QwenCodeCli.simpleQuery()` 快速入门
- 所需设置最少 - 只需添加 SDK 作为 Maven/Gradle 依赖
- 无需复杂配置即可与现有 Java 应用程序无缝集成

#### 2. **灵活的权限控制**
- 针对不同安全要求的多种权限模式（`default`、`plan`、`auto-edit`、`yolo`）
- 通过 `allowedTools` 和 `excludeTools` 对工具执行进行细粒度控制
- 基于回调的权限系统用于自定义批准逻辑

#### 3. **全面的事件处理**
- 丰富的事件系统，包括 `SessionEventConsumers` 和 `AssistantContentConsumers` 接口
- 支持带有部分消息处理的流式响应
- 针对不同内容类型（文本、思考、工具使用、工具结果）的独立处理器

#### 4. **生产就绪功能**
- 内置线程池用于并发操作，具有可配置参数
- 多级（轮次、消息、事件）的强大超时处理
- 具有特定异常类型的适当错误处理
- 长时间运行工作流的会话恢复能力

#### 5. **会话管理**
- 完整的会话生命周期控制（创建、管理、中断、关闭）
- 会话期间动态模型和权限模式切换
- 支持自定义环境变量和工作目录
- 并行处理的多个并发会话

#### 6. **Java 生态系统兼容性**
- 支持 Java 1.8+ 以实现广泛的兼容性
- 使用成熟、维护良好的依赖项（fastjson2、logback、commons-lang3）
- 标准的 Maven/Gradle 构建集成
- 遵循 Java 最佳实践和约定

### 缺点

#### 1. **CLI 依赖**
- 需要单独安装 Qwen Code CLI（qwen-code >= 0.5.0）
- 与直接库集成相比，基于进程的通信增加了开销
- CLI 的更新可能需要 SDK 更新以保持兼容性

#### 2. **仅限进程传输**
- 目前仅支持基于进程的传输机制
- 不支持远程 API 调用或基于网络的通信
- 所有通信都通过本地进程生成进行

#### 3. **实验性状态**
- 标记为"最小化实验性 SDK"表示 API 不稳定
- API 可能在未来版本中更改而不保持向后兼容性
- 有限的生产部署示例和最佳实践

#### 4. **学习曲线**
- 复杂的事件层次结构（`SessionEventConsumers` → `AssistantContentConsumers`）
- 多个超时配置点需要了解系统
- 权限模式需要仔细考虑以平衡安全性和可用性

#### 5. **资源消耗**
- 线程池开销（30 个核心线程，最多 100 个最大线程）
- 每个会话生成一个单独的 CLI 进程
- 内存使用量随并发会话数量而扩展

#### 6. **文档有限**
- 没有详细的 API 参考文档（JavaDoc）
- 高级用例的示例有限
- 错误处理模式没有全面记录
- 故障排除指南比较基础

#### 7. **平台依赖**
- 需要 Node.js 环境来运行 CLI（用 TypeScript 编写）
- 跨平台兼容性取决于 CLI 支持
- 在进程生成受限的受限环境中可能会出现问题

### 使用建议

**适合使用 Java SDK 的场景：**
- 构建需要 AI 编码辅助的基于 Java/JVM 的应用程序
- 需要对工具执行和权限进行细粒度控制
- 需要会话管理和长时间运行的工作流
- 想要将 Qwen Code 能力集成到现有 Java 基础设施中

**考虑替代方案的场景：**
- 需要具有保证向后兼容性的生产稳定 API
- 需要远程 API 访问或基于云的部署
- 您的环境不支持进程生成（例如某些容器、无服务器）
- 需要全面的 API 文档和大量示例

## 错误处理

SDK 为不同的错误场景提供特定的异常类型：

- `SessionControlException`：会话控制（创建、初始化等）出现问题时抛出
- `SessionSendPromptException`：发送提示或接收响应出现问题时抛出
- `SessionClosedException`：尝试使用已关闭的会话时抛出

## 常见问题 / 故障排除

### 问：我需要单独安装 Qwen CLI 吗？

答：是的，需要 Qwen CLI 0.5.5 或更高版本。

### 问：支持哪些 Java 版本？

答：SDK 需要 Java 1.8 或更高版本。

### 问：如何处理长时间运行的请求？

答：SDK 包含超时工具。您可以使用 `TransportOptions` 中的 `Timeout` 类配置超时。

### 问：为什么某些工具没有执行？

答：这可能是由于权限模式。检查您的权限模式设置，并考虑使用 `allowedTools` 预先批准某些工具。

### 问：如何恢复以前的会话？

答：在 `TransportOptions` 中使用 `setResumeSessionId()` 方法恢复以前的会话。

### 问：我可以为 CLI 进程自定义环境吗？

答：可以，使用 `TransportOptions` 中的 `setEnv()` 方法将环境变量传递给 CLI 进程。

## 许可证

Apache-2.0 - 详见 [LICENSE](./LICENSE)。

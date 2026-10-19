# DOCX 生成实现计划

[English](docx-generation.md) | [简体中文](docx-generation.zh-CN.md)

交付本地 DOCX MCP 扩展和配套发布 skill。
私有 workspace 包将 MCP SDK 和文档库打包为一个 Node.js 服务器。
Qwen 通过现有扩展清单发现工具，skill 单独发布已完成的文件。
参见[文档生成设计](../design/native-document-generation.zh-CN.md)。

## 约束

- Node.js >=22、ESM、严格 TypeScript，以及仓库固定的 pnpm。
- 仅支持一种格式、标题和段落，不修改原生 core 工具。
- 工作区在启动时固定，禁止覆盖，本地生成，不记录正文。
- 文档和 PR 描述均提供完整的英文及中文版本。

## 评审重点

- 打包后的服务器不能依赖仓库的依赖目录。
- 发布失败时不能重新生成文件或声称下载已存在。
- 并发调用和已有符号链接不能导致覆盖其他文件。
- 非法 XML 字符不能生成需要 Word 修复的文档。
- 工作区绑定必须来自启动配置，而非模型参数。

## 生成器与文件系统契约

文件：`packages/document-generation/src/generate-docx.ts` 及其同目录测试。
接口：`createDocxGenerator(workspacePath)` 返回异步生成函数，接收未知输入
和可选的取消信号，并返回 `resolvedPath`、`mimeType` 和 `sizeBytes`。

- [x] 编写并运行失败测试，覆盖 OOXML 文本与 Unicode、非法输入、目录穿越、
      符号链接父目录、禁止覆盖的并发行为和取消。
- [x] 使用 `docx` 实现有界 schema 和渲染。
- [x] 私下暂存完整字节，通过硬链接创建最终文件名，禁止替换已有目录项。
- [x] 运行生成器测试，并独立检查生成的文档。

## MCP 传输、打包和 skill

文件：`src/mcp-server.ts`、`src/server.ts`、同目录协议测试、扩展清单、skill、
包元数据和构建配置。接口：唯一工具 `generate_docx` 返回结构化输出和文本，
预期执行失败返回 `isError: true`。

- [x] 使用 SDK 客户端编写失败测试，覆盖真实工具发现、生成、验证错误、协议输出和进程退出。
- [x] 实现 stdio 启动，要求绝对路径 `--workspace` 参数。
- [x] 打包运行时依赖，并加入精确的 workspace 依赖锁定。
- [x] 封装 skill，先调用发现的生成工具，再调用 `record_artifact`。
- [x] 打包并运行解压后的服务器，使其无法通过仓库解析模块。

## 仓库集成与证据

文件：pnpm workspace 名称 hook、Vitest 配置登记、两种语言的设计文档、
两种语言的包 README，以及 PR 描述。

- [x] 运行包测试、构建、类型检查、lint 和 workspace 元测试。
- [x] 构建仓库、检查类型，并打包 CLI。
- [x] 执行 `.qwen/e2e-tests/docx-generation.md` 中的 E2E 计划，
      包括独立文档打开以及 Qwen 生成与发布链路。
- [x] 完成两轮无问题自查和独立代码评审。
- [x] 准备英文及中文 PR 描述和 E2E 报告。

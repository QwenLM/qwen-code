# 通过本地 MCP 扩展生成 DOCX

[English](native-document-generation.md) | [简体中文](native-document-generation.zh-CN.md)

实现：[草稿 PR #14665](https://github.com/QwenLM/qwen-code/pull/14665)。
关联 issue：[#14616](https://github.com/QwenLM/qwen-code/issues/14616)。

## 问题说明

用户请求 Word 合同时，需要能够下载并打开的文件。
Qwen 可以运行文档生成脚本，但用户原本需要自行组合文档库、工具说明和产物发布步骤。

文档生成扩展为 DOCX 提供这一工作流。
本地 MCP 工具根据标题和段落写入文档，配套 skill 再通过 Qwen 现有产物工具发布文件。

## 当前状态与集成

- [write_file](../../packages/core/src/tools/write-file.ts)接收字符串内容，并识别 Office 扩展名以生成产物元数据，
  但不提供二进制缓冲区输入或 base64 解码选项。
- 普通 [MCP 结果适配器](../../packages/core/src/tools/mcp-tool.ts)返回模型内容和显示数据，
  不填充 `ToolResult.artifacts`。
- [record_artifact](../../packages/core/src/tools/record-artifact.ts)验证工作区文件，
  并返回用于发布的元数据。
- [扩展变量](../../packages/core/src/extension/variableSchema.ts)分别提供安装目录和工作区路径。
- [Web Shell](../../packages/web-shell/package.json)已依赖 `exceljs` 进行
  [电子表格预览](../../packages/web-shell/client/components/artifacts/excel-preview-parser.ts)。
  该依赖既不提供 DOCX 生成器，也不提供独立 XLSX 服务器。

新增的 [workspace 包](../../packages/document-generation/README.zh-CN.md)实现生成器，
无需修改这些 core 契约。

## 目标与范围

- 生成包含标题和原样文本段落的 DOCX。
- 返回准确文件位置，并将其发布为会话产物。
- 打包运行时，使生成仅依赖 Node.js >=22。
- 本地生成文档，不依赖转换器二进制，也不记录正文。
- 保留已有目标，包括并发调用时。

扩展需要显式安装，不会在每个 Qwen 安装中默认启用。
其他格式、转换、模板、表格、图片、编辑和原生 core 集成不属于本次改动。

## 设计决定

| 决定                    | 原因                                                         |
| ----------------------- | ------------------------------------------------------------ |
| 私有 workspace 扩展     | 使用正常构建、测试、类型检查和依赖锁定，不加入自动注册表发布 |
| 单个打包的 stdio 服务器 | 安装后的副本不需要仓库依赖或单独安装文档库                   |
| 首先支持 DOCX           | 对应合同示例，并控制首个工作流的范围                         |
| 标题和段落              | 避免引入文档布局语言                                         |
| 单独调用发布工具        | 复用现有产物工具，无需修改 MCP 结果接收                      |
| 禁止覆盖输出            | 重试或并发生成不能替换其他文档                               |

## 工具契约

唯一 MCP 工具为 `generate_docx`。
[输入 schema 和渲染器](../../packages/document-generation/src/generate-docx.ts)接收以下结构：

```json
{
  "outputPath": "reports/nda.docx",
  "title": "NDA",
  "paragraphs": ["First agreement paragraph.", "Second agreement paragraph."]
}
```

结果在结构化输出和文本中包含绝对路径 `resolvedPath`、固定 DOCX `mimeType` 和 `sizeBytes`。
预期失败返回 MCP 工具错误，不附带成功元数据。

限制为 200 个标题字符、1000 个段落、合计 1 MiB UTF-8 文本，
以及 500 个字符的相对输出路径。非法 XML 字符、绝对路径、父目录穿越、
不安全的显示或文件名字符和未知输入键均被拒绝。
标题使用文档标题样式，段落按原样文本处理。

## 运行时与工作区绑定

[清单](../../packages/document-generation/qwen-extension.json)从 `${extensionPath}` 启动打包后的服务器，
并通过必填的 `--workspace` 参数及工作目录传递 `${workspacePath}`。
服务器在启动时解析工作区，工具输入不能替换它。

运行时依赖为 `docx` 9.12.0、MCP SDK 1.30.0 和 Zod 3.25.76，
workspace 锁文件记录完整性信息。SDK 支持协议 `2025-11-25`；
包版本固定了其[源码版本](https://github.com/modelcontextprotocol/typescript-sdk/tree/2d889f2b329e46680ec9bdd565de4616c497825a)。
构建将依赖打包为面向 Node.js 22 的 ESM，并保留生成的许可证声明。

服务器使用本地 stdio，与 Qwen 工作区共享文件系统视图。
远程文件系统映射不属于本次实现。

## 生成与发布

1. [skill](../../packages/document-generation/skills/generate-document/SKILL.md)准备标题、段落和相对目标路径。
2. 它按实际注册名称调用发现的 MCP `generate_docx` 工具。
3. 服务器验证输入、渲染 OOXML 并发布完整文件字节。
4. skill 将返回的绝对路径作为 `workspacePath`，并使用显式 `kind: "document"`、
   MIME 类型和大小调用 `record_artifact`。它使用 `"Generated Word document"`
   作为有界的备用标题；符合标题规则时由 Qwen 派生文件名。
5. 登记成功后，助手才报告可下载产物。

生成失败时，skill 报告错误。登记失败或不可用时，说明文件已生成但未发布，
保留文件以便重试登记。不得重新生成文件或重复登记已经成功的输出。

skill 通过模型协调这些调用。自动接收 MCP 产物元数据属于独立功能，
该工作流不依赖它。

## 写入安全与失败行为

生成器在规范化的工作区内解析输出目录，并拒绝已有的符号链接或 junction 父目录。
它在目标旁的私有临时目录中暂存字节，刷新并关闭文件，再通过硬链接创建最终文件名。
已有目标会使链接操作失败，因此检查与发布之间不存在覆盖窗口。

生成器在发布前检查取消信号，在成功或失败后清理临时文件。
不支持硬链接或没有写入权限时返回工具错误，已有输出保持不变。
清理失败会报告到 stderr，不会将已经创建成功的文档改为生成失败结果。

外部 MCP 进程使用当前用户的文件系统权限。输入和重定向检查并不是操作系统沙箱，
无法防御另一个进程并发替换目录。工作区必须可信。
生成后的产物验证不能保护之前的文件系统写入。

## 仓库集成与打包

现有 `packages/*` workspace glob 自动包含扩展。
pnpm workspace 名称 hook 和 Vitest 配置登记均包含该包。
它提供正常的构建、测试、CI 测试和类型检查脚本。

扩展归档包含清单、skill、双语 README、打包后的服务器和生成的许可证声明，
不包含源码测试或 `node_modules`。
包标记为私有，不会进入自动公开发布脚本。
包 README 的两个语言版本提供本地链接和解压安装说明。

## 验证

| 边界       | 实现测试检查的证据                                               |
| ---------- | ---------------------------------------------------------------- |
| 文档内容   | 独立 ZIP/XML 读取器验证标题、Unicode、原样 XML 字符和段落顺序    |
| 文件系统   | 目录穿越、已有符号链接父目录和目标、已有文件、并发写入及临时清理 |
| 取消       | 生成前和异步渲染中的取消不会留下已发布文件                       |
| MCP        | 真实 SDK 发现与调用、结构化和文本输出、验证失败及覆盖错误        |
| 打包运行时 | 解压归档后使用 Node 限制文件读取范围，禁止读取仓库依赖           |
| 启动       | 缺失或相对工作区参数会失败，且不会向 stdout 写入协议外输出       |

`.qwen/e2e-tests/docx-generation.md` 中的 E2E 计划单独记录运行时证据，
包括独立应用打开和 Qwen 发布链路。
仅有 ZIP 签名或产物记录不能证明文档可用。
PR 测试报告说明实际使用的平台和模型配置。

## 验收标准与后续工作

- 安装后的扩展根据请求内容生成有效 DOCX。
- 打包后的生成不依赖系统转换器或全局文档库。
- 拒绝不安全输出路径和已有重定向；并发调用不替换已有目标。
- 工作流发布实际生成的文件，并准确报告失败。
- 测试覆盖生成器、协议和隔离的打包运行时。
- 英文和中文文档描述相同的行为与限制。

注册表发布由维护者单独决定。未来 XLSX 工作应首先评估 `exceljs`。
其他格式、更丰富的文档布局和 core 集成都需要各自的范围及证据。

# Word 文档扩展

[English](README.md) | [简体中文](README.zh-CN.md)

根据标题和段落生成 Word 文档，再将其发布为可下载的 Qwen 会话产物。
扩展在本地通过 MCP stdio 运行。构建后的服务器包含文档库，要求 Node.js >=22。
生成不需要 Word、LibreOffice、Pandoc 或网络连接。

## 构建与安装

在仓库根目录执行：

```sh
corepack pnpm install --frozen-lockfile
npm run build --workspace=@qwen-code/document-generation
qwen extensions link ./packages/document-generation
```

在需要生成文档的工作区重新启动 Qwen。
扩展通过 `${workspacePath}` 将服务器绑定到该工作区，不会将文档写入安装目录。

请 Qwen 创建 Word 文档，或调用 `/document-generation:generate-document`。例如：

```text
Create reports/nda.docx with the title "NDA" and the agreement paragraphs
we just drafted. Publish the Word document as a session artifact.
```

skill 调用发现的 `generate_docx` 工具，再使用实际返回的绝对路径调用 `record_artifact`。
发布失败时保留文件以便重试登记，skill 不得重新生成文件。

## 工具契约

`generate_docx` 接收：

```json
{
  "outputPath": "reports/nda.docx",
  "title": "NDA",
  "paragraphs": ["First agreement paragraph.", "Second agreement paragraph."]
}
```

结果在结构化输出和文本中包含 `resolvedPath`、`mimeType` 和 `sizeBytes`。
工具负责写入文件，skill 单独发布。标题作为文档标题，每个段落按原样文本处理。

限制为 200 个标题字符、1000 个段落、合计 1 MiB UTF-8 文本，
以及 500 个字符的相对输出路径。非法 XML 字符、父目录穿越、绝对路径、
不安全的显示或文件名字符和符号链接父目录均被拒绝。
已有目标（包括符号链接）不会被替换。创建修订版文档时请选择新文件名。

生成器支持包含标题和段落的 DOCX，不支持文件转换、电子表格、幻灯片、
PDF、表格、图片或模板。

## 写入行为与信任

服务器在目标目录旁的私有临时目录中暂存完整字节，再通过硬链接创建最终文件名。
并发调用不能替换已有目标。不支持硬链接的文件系统会返回工具错误。
服务器在完成或失败后清理自身临时文件，并在发布输出前检查取消信号。

服务器使用当前用户的文件系统权限。路径检查会拒绝不安全的工具输入和已有重定向，
但不能作为操作系统沙箱来防御另一个进程在写入期间修改目录。
请在可信工作区使用扩展。服务器不记录文档正文。

## 测试与打包

在本包目录执行：

```sh
npm test
npm run typecheck
```

测试通过独立 ZIP/XML 读取器检查 OOXML 内容，并覆盖文件系统失败、取消、
MCP 调用和打包后的服务器。打包服务器测试禁止读取解压后的包及测试目录以外的文件。

在仓库根目录创建扩展归档：

```sh
mkdir -p .qwen/releases
npm pack --workspace=@qwen-code/document-generation --pack-destination .qwen/releases
```

归档包含清单、skill、打包后的服务器和生成的许可证声明。
解压后，将生成的 `package` 目录链接到 Qwen。
本 workspace 标记为私有，不会加入 CLI 的注册表发布流程。
扩展需要显式安装，不会在每个 Qwen 会话中默认启用。

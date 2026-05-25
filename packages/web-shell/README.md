# @alife/dataworks-qwen-code-web-shell

Qwen Code Web Shell 是面向浏览器的 daemon 会话 UI，可以打包成 React
组件给其他项目集成。

## React 组件接入

### 环境要求

- React：`^18.0.0 || ^19.0.0`
- React DOM：`^18.0.0 || ^19.0.0`
- 浏览器环境需要能访问 Qwen Code daemon serve 的 HTTP 接口。

组件包会自动注入自身样式，样式已通过 CSS Modules 和组件作用域隔离；
接入方不需要额外引入全局 CSS。

### 安装

```bash
npm install @alife/dataworks-qwen-code-web-shell
```

### 基本用法

```tsx
import { WebShell } from '@alife/dataworks-qwen-code-web-shell';

export function QwenCodePanel() {
  return (
    <WebShell
      baseUrl="http://127.0.0.1:4170"
      token="qwen-local-4170-abc123"
      initialSessionId="838e1811-9f84-4848-9915-d9a7f01ff5c6"
      onSessionIdChange={(sessionId) => {
        console.log('current session:', sessionId);
      }}
      theme="dark"
      language="zh-CN"
      onLanguageChange={(language) => {
        console.log('current language:', language);
      }}
    />
  );
}
```

### Props

| 属性                | 类型                                   | 说明                                                                                               |
| ------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `baseUrl`           | `string`                               | daemon API 地址。组件化接入时建议显式传入，例如 `http://127.0.0.1:4170`。未传时使用同源 API 路径。 |
| `token`             | `string`                               | daemon API Bearer token。未传时会从当前 URL 的 `?token=` 中读取。                                  |
| `initialSessionId`  | `string`                               | 初始要连接的 daemon session id。未传时，独立应用会尝试从 `/session/:id` 路径中读取。               |
| `onSessionIdChange` | `(sessionId: string) => void`          | 当前 session id 变化时触发。组件化接入建议用它同步外层路由或状态。                                 |
| `theme`             | `'dark' \| 'light'`                    | UI 主题，默认 `dark`。也可以通过 `/theme` 命令在组件内部切换。                                     |
| `language`          | `'en' \| 'zh-CN' \| 'zh' \| 'zh-cn'`   | UI 语言。未传时独立应用会读取 URL、localStorage 或浏览器语言。                                     |
| `onLanguageChange`  | `(language: WebShellLanguage) => void` | `/language ui` 切换 UI 语言后触发。组件化接入方可在这里持久化语言设置。                            |

## 已支持的斜杠命令

下面列出当前 web-shell 已支持的命令。支持方式分为两类：

- **本地实现**：web-shell 前端直接打开弹窗、调用 daemon REST API，或切换本地状态。
- **ACP 透传**：web-shell 将命令发送给 daemon，由 daemon/ACP 执行。

| 命令             | 支持方式            | 说明                                                                                                                    |
| ---------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `/help`          | 本地实现            | 打开帮助弹窗，支持键盘浏览命令和快捷键。                                                                                |
| `/theme`         | 本地实现            | 打开主题选择弹窗；支持 `/theme light`、`/theme dark`。                                                                  |
| `/language`      | 本地实现 + ACP 透传 | `/language ui <lang>` 会切换 web-shell UI 语言并同步给 daemon；其他语言能力由 daemon 执行。包含 `ui`、`output` 子命令。 |
| `/model`         | 本地实现 + 部分透传 | 无参数打开模型弹窗；普通参数直接切换模型；`/model --fast <model>` 透传给 daemon。                                       |
| `/plan`          | 本地实现            | 切换到 `plan` approval mode，并可继续发送后续 prompt。                                                                  |
| `/approval-mode` | 本地实现            | 打开审批模式弹窗或直接切换审批模式。                                                                                    |
| `/mode`          | 本地实现            | web-shell 本地别名，用于切换审批模式。                                                                                  |
| `/mcp`           | 本地实现            | 打开 MCP 管理弹窗。                                                                                                     |
| `/skills`        | 本地实现 + ACP 透传 | 无参数打开 skills 弹窗；带参数时透传给 daemon 执行。                                                                    |
| `/tools`         | 本地实现            | 打开 tools 弹窗，列表展示工具名称、启用状态和 `description`。                                                           |
| `/memory`        | 本地实现            | 打开 memory 弹窗，支持 `show`、`refresh`、`add user`、`add project` 等分支。                                            |
| `/agents`        | 本地实现            | 打开 agents 弹窗，支持 `manage`、`create user`、`create project` 等分支。                                               |
| `/copy`          | 本地实现            | 复制最后一条 assistant 输出；支持 `code`、语言名、LaTeX、inline LaTeX 等选择器。                                        |
| `/release`       | 本地实现            | 释放 live session 连接，不删除历史会话记录。                                                                            |
| `/clear`         | 本地实现            | 清空当前 web-shell transcript store。                                                                                   |
| `/new`           | 本地实现            | 创建新的 daemon session。                                                                                               |
| `/reset`         | 本地实现            | 与 `/new` 一样创建新的 daemon session。                                                                                 |
| `/rename <name>` | 本地实现            | 修改当前 daemon session 的展示名称。                                                                                    |
| `/resume`        | 本地实现            | 无参数打开恢复会话弹窗；带 session id 时直接加载。                                                                      |
| `/status`        | ACP 透传            | daemon 支持，包含 `paths` 子命令。                                                                                      |
| `/auth`          | ACP 透传            | 连接 LLM provider。                                                                                                     |
| `/bug`           | ACP 透传            | 提交错误报告。                                                                                                          |
| `/compress`      | ACP 透传            | 通过摘要替换来压缩上下文。                                                                                              |
| `/context`       | ACP 透传            | 显示上下文窗口使用情况，包含 `detail` 子命令。                                                                          |
| `/diff`          | ACP 透传            | 显示工作区相对 `HEAD` 的变更统计。                                                                                      |
| `/docs`          | ACP 透传            | 打开 Qwen Code 文档。                                                                                                   |
| `/doctor`        | ACP 透传            | 执行安装与环境诊断，包含 `memory` 子命令。                                                                              |
| `/export`        | ACP 透传            | 导出当前会话记录，包含 `html`、`md`、`json`、`jsonl` 子命令。                                                           |
| `/goal`          | ACP 透传            | 设置目标，并持续工作直到条件满足。                                                                                      |
| `/init`          | ACP 透传            | 分析项目并创建定制的 `QWEN.md`。                                                                                        |
| `/stats`         | ACP 透传            | 显示统计信息，包含 `model`、`tools` 子命令。                                                                            |
| `/summary`       | ACP 透传            | 生成当前会话摘要。                                                                                                      |
| `/tasks`         | ACP 透传            | 列出后台任务。                                                                                                          |
| `/insight`       | ACP 透传            | 查看 insight 相关信息。                                                                                                 |

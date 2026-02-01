# 浏览器 MCP 能力与写操作现状

> ⚠️ 备注：本文档描述的是旧版 `browser_*` 工具与 HTTP/SSE 路径。统一设计以 `chrome_*` 工具集为主，后续需把映射与能力矩阵更新到这里。

> Canonical 工具定义：`app/native-server/src/shared/tools.ts`

## 现有 MCP 工具

由 `src/browser-mcp-server.js` 暴露（工具列表在 `src/shared/tools.js`）：

- `browser_read_page`：读取当前标签页（需扩展提供页面内容）。
- `browser_capture_screenshot`：当前标签页截图（扩展 `chrome.tabs.captureVisibleTab`）。
- `browser_get_network_logs`：当前标签网络请求日志（扩展 webRequest + debugger）。
- `browser_get_console_logs`：当前标签 console 日志（content-script 拦截）。
- `browser_fill_form`：按 selector/label 批量填充输入。
- `browser_input_text`：按 selector 填充单个输入。

所有写操作（fill/click）依赖扩展的 content-script 注入，当前支持：

- 填充：`FILL_INPUT`/`FILL_INPUTS`，覆盖 input/textarea/contentEditable，支持 label 解析、append/replace、事件触发。
- 点击：`CLICK_ELEMENT`，按 CSS selector 触发 pointerdown/mousedown/mouseup/click。
- 执行 JS：`EXECUTE_CODE`（任意表达式注入页面上下文，有限时）。

## 流程

- MCP → host → HTTP `/api` → background → content-script；事件用 `/events` SSE 推送（原长轮询已改为 SSE）。
- MCP 工具调用（fill_form/input_text/click/run_js/fill_form_auto）通过 HTTP 方法触发上述 content-script 路径。

## 待完善方向

- 追加工具映射：将 `CLICK_ELEMENT` / `EXECUTE_CODE` 透出为 MCP 工具（例如 `browser_click`, `browser_run_js`），目前未暴露。
- 增加更丰富的写操作：选择下拉、多步点击、上传文件等。
- 更好的错误与状态回传：目前填充返回简单 success/message，可扩展为详细目标描述。

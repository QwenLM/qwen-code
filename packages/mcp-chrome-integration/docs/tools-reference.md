# Chrome MCP 工具目录

> **最后更新**: 2026-02-08
> **工具定义源文件**: `app/native-server/src/shared/tools.ts`
> **当前版本**: 2.0.0 (基于 Native Messaging 架构)

本文档列出所有可用的 Chrome MCP 工具及其功能说明。

## 工具总览

当前共有 **27 个活跃工具**，分为以下类别：

| 类别         | 工具数量 | 说明                                 |
| ------------ | -------- | ------------------------------------ |
| 浏览器管理   | 6        | 窗口/标签管理、页面导航、DOM访问     |
| 页面交互     | 5        | 点击、填充、键盘输入、JavaScript执行 |
| 网络监控     | 2        | 网络请求捕获、HTTP请求发送           |
| 内容分析     | 2        | 页面内容提取、控制台日志捕获         |
| 数据管理     | 4        | 历史记录、书签管理                   |
| 截图与录制   | 2        | 页面截图、GIF录制                    |
| 性能分析     | 3        | 性能追踪、分析                       |
| 文件与对话框 | 3        | 文件上传、对话框处理、下载管理       |

---

## 1. 浏览器管理工具（6个）

### 1.1 `get_windows_and_tabs`

**功能**: 获取所有打开的浏览器窗口和标签页
**参数**: 无
**返回**: 窗口和标签页列表，包含 ID、标题、URL 等信息

**使用场景**:

- 列出所有打开的标签页
- 查找特定 URL 的标签
- 获取标签 ID 用于后续操作

---

### 1.2 `chrome_navigate`

**功能**: 导航到指定 URL、刷新页面或浏览器历史导航
**参数**:

- `url` (string): 目标 URL，或特殊值 "back"/"forward" 进行历史导航
- `refresh` (boolean): 是否刷新当前页面
- `tabId` (number): 目标标签 ID（可选，默认当前标签）
- `windowId` (number): 目标窗口 ID（可选）
- `newWindow` (boolean): 是否在新窗口打开
- `background` (boolean): 后台执行，不激活窗口
- `width` / `height` (number): 新窗口尺寸

**使用场景**:

- 打开新网页
- 刷新页面
- 浏览器前进/后退
- 在新窗口打开链接

---

### 1.3 `chrome_switch_tab`

**功能**: 切换到指定标签页
**参数**:

- `tabId` (number, 必需): 要切换到的标签 ID
- `windowId` (number): 标签所在窗口 ID

**使用场景**: 在多个标签页之间切换

---

### 1.4 `chrome_close_tabs`

**功能**: 关闭一个或多个标签页
**参数**:

- `tabIds` (array): 要关闭的标签 ID 列表
- `url` (string): 根据 URL 匹配关闭标签

**使用场景**:

- 批量关闭标签
- 关闭匹配特定 URL 的标签

---

### 1.5 `chrome_read_page`

**功能**: 获取页面的可访问性树（Accessibility Tree）表示
**参数**:

- `filter` (string): 过滤条件，"interactive" 只返回可交互元素
- `depth` (number): DOM 遍历深度
- `refId` (string): 聚焦到特定元素子树
- `tabId` (number): 目标标签 ID
- `windowId` (number): 目标窗口 ID

**返回**: 页面元素结构，每个元素包含 ref（引用 ID）、角色、文本等

**使用场景**:

- 分析页面结构
- 查找可交互元素
- 获取元素 ref 用于后续操作

---

### 1.6 `chrome_computer`

**功能**: 统一的浏览器交互工具（鼠标、键盘、截图等）
**参数**:

- `action` (string, 必需): 操作类型
  - 点击: `left_click`, `right_click`, `double_click`, `triple_click`
  - 拖拽: `left_click_drag`
  - 滚动: `scroll`, `scroll_to`
  - 输入: `type`, `key`, `fill`, `fill_form`
  - 其他: `hover`, `wait`, `resize_page`, `zoom`, `screenshot`
- `ref` (string): chrome_read_page 返回的元素引用
- `coordinates` (object): 坐标 {x, y}
- `text` (string): 输入的文本或按键
- `tabId` (number): 目标标签 ID

**使用场景**:

- 复杂的页面交互
- 坐标级精确操作
- 综合性自动化任务

---

## 2. 页面交互工具（5个）

### 2.1 `chrome_click_element`

**功能**: 点击页面元素
**参数**:

- `selector` (string): CSS 选择器或 XPath
- `selectorType` (string): "css" 或 "xpath"
- `ref` (string): chrome_read_page 返回的元素引用（优先级最高）
- `coordinates` (object): 视口坐标 {x, y}
- `double` (boolean): 是否双击
- `button` (string): 鼠标按钮 "left"/"right"/"middle"
- `modifiers` (object): 修饰键 {altKey, ctrlKey, metaKey, shiftKey}
- `waitForNavigation` (boolean): 等待页面导航完成
- `tabId` (number): 目标标签 ID
- `frameId` (number): iframe 内的操作

**使用场景**: 点击按钮、链接等元素

---

### 2.2 `chrome_fill_or_select`

**功能**: 填充或选择表单元素
**参数**:

- `selector` (string): CSS 选择器或 XPath
- `selectorType` (string): "css" 或 "xpath"
- `ref` (string): chrome_read_page 返回的元素引用
- `value` (string|number|boolean, 必需): 要填充的值
- `tabId` (number): 目标标签 ID
- `frameId` (number): iframe 支持

**支持元素类型**: input、textarea、select、checkbox、radio

**使用场景**: 表单自动填充、选择下拉选项

---

### 2.3 `chrome_keyboard`

**功能**: 模拟键盘输入
**参数**:

- `keys` (string, 必需): 按键或组合键，如 "Enter"、"Ctrl+C"、"Hello World"
- `selector` (string): 目标元素选择器
- `delay` (number): 按键间延迟（毫秒，默认50）
- `tabId` (number): 目标标签 ID
- `frameId` (number): iframe 支持

**使用场景**:

- 发送快捷键
- 模拟打字
- 触发键盘事件

---

### 2.4 `chrome_request_element_selection`

**功能**: 请求用户手动选择页面元素（人在回路）
**参数**:

- `requests` (array, 必需): 选择请求列表，每个包含:
  - `id` (string): 请求 ID
  - `name` (string): 显示给用户的标签
  - `description` (string): 详细说明
- `timeoutMs` (number): 超时时间（默认180000，最大600000）
- `tabId` (number): 目标标签 ID

**返回**: 用户选择的元素 ref 列表

**使用场景**: 当自动定位失败约3次后，请求用户协助选择元素

---

### 2.5 `chrome_javascript`

**功能**: 在标签页中执行 JavaScript 代码
**参数**:

- `code` (string, 必需): 要执行的 JavaScript 代码（支持 async/await 和 return）
- `tabId` (number): 目标标签 ID
- `timeoutMs` (number): 执行超时（默认15000）
- `maxOutputBytes` (number): 最大输出字节数（默认51200）

**返回**: 代码执行结果（自动清理敏感数据）

**使用场景**:

- 提取页面数据
- 执行自定义逻辑
- 调试页面状态

---

## 3. 网络监控工具（2个）

### 3.1 `chrome_network_capture`

**功能**: 统一的网络请求捕获工具
**参数**:

- `action` (string, 必需): "start" 开始捕获，"stop" 停止并返回结果
- `needResponseBody` (boolean): 是否捕获响应体（使用 Debugger API）
- `needDocumentBody` (boolean): 是否捕获 Document 响应体
- `captureWebSocket` (boolean): 是否捕获 WebSocket 流量
- `url` (string): 捕获时导航到的 URL
- `maxCaptureTime` (number): 最大捕获时间（默认180000）
- `inactivityTimeout` (number): 无活动超时（默认60000）
- `includeStatic` (boolean): 是否包含静态资源
- `maxBodyChars` (number): 响应体最大字符数（默认10000）
- `maxEntries` (number): 最大请求数（默认100）

**使用场景**:

- 分析网络请求
- 捕获 API 响应
- 调试 WebSocket 通信

---

### 3.2 `chrome_network_request`

**功能**: 发送带浏览器上下文的 HTTP 请求（携带 cookies）
**参数**:

- `url` (string, 必需): 请求 URL
- `method` (string): HTTP 方法（默认 GET）
- `headers` (object): 请求头
- `body` (string): 请求体
- `timeout` (number): 超时时间（默认30000）
- `formData` (object): multipart/form-data 配置

**使用场景**:

- 发送已认证的 API 请求
- 上传文件（multipart）
- 模拟表单提交

---

## 4. 内容分析工具（2个）

### 4.1 `chrome_get_web_content`

**功能**: 提取页面内容
**参数**:

- `url` (string): 要提取的 URL（可选，默认当前标签）
- `tabId` (number): 目标标签 ID
- `background` (boolean): 后台执行
- `htmlContent` (boolean): 获取 HTML 内容
- `textContent` (boolean): 获取文本内容（默认 true）
- `selector` (string): 只提取特定元素的内容

**返回**: 页面的 HTML 或文本内容，包含元数据

**使用场景**:

- 提取文章内容
- 获取页面结构
- 抓取特定元素数据

---

### 4.2 `chrome_console`

**功能**: 捕获浏览器控制台输出
**参数**:

- `url` (string): 导航并捕获的 URL
- `tabId` (number): 目标标签 ID
- `background` (boolean): 后台执行
- `mode` (string): "snapshot"（快照模式，等待~2s）或 "buffer"（缓冲模式，即时读取）
- `includeExceptions` (boolean): 包含异常（默认 true）
- `maxMessages` (number): 最大消息数（默认100）
- `clear` (boolean): 缓冲模式：读取前清空
- `clearAfterRead` (boolean): 缓冲模式：读取后清空
- `pattern` (string): 正则过滤
- `onlyErrors` (boolean): 只返回错误

**使用场景**:

- 调试页面错误
- 监控日志输出
- 捕获异常信息

---

## 5. 数据管理工具（4个）

### 5.1 `chrome_history`

**功能**: 搜索浏览历史
**参数**:

- `text` (string): 搜索关键词（URL 或标题）
- `startTime` (string): 开始时间（支持 ISO、相对时间、关键词）
- `endTime` (string): 结束时间
- `maxResults` (number): 最大结果数（默认100）
- `excludeCurrentTabs` (boolean): 排除当前打开的标签

**使用场景**: 查找历史访问记录

---

### 5.2 `chrome_bookmark_search`

**功能**: 搜索书签
**参数**:

- `query` (string): 搜索关键词
- `maxResults` (number): 最大结果数（默认50）
- `folderPath` (string): 限制在特定文件夹

**使用场景**: 查找已保存的书签

---

### 5.3 `chrome_bookmark_add`

**功能**: 添加书签
**参数**:

- `url` (string): 书签 URL（可选，默认当前标签）
- `title` (string): 书签标题
- `parentId` (string): 父文件夹路径或 ID
- `createFolder` (boolean): 自动创建文件夹

**使用场景**: 保存网页为书签

---

### 5.4 `chrome_bookmark_delete`

**功能**: 删除书签
**参数**:

- `bookmarkId` (string): 书签 ID
- `url` (string): 或通过 URL 删除
- `title` (string): 辅助匹配标题

**使用场景**: 移除不需要的书签

---

## 6. 截图与录制工具（2个）

### 6.1 `chrome_screenshot`

**功能**: 页面截图（推荐优先使用 chrome_computer 的 screenshot 操作）
**参数**:

- `name` (string): 截图文件名
- `selector` (string): 截取特定元素
- `tabId` (number): 目标标签 ID
- `background` (boolean): 后台执行
- `width` / `height` (number): 截图尺寸
- `storeBase64` (boolean): 返回 base64 格式
- `fullPage` (boolean): 全页截图（默认 true）
- `savePng` (boolean): 保存为 PNG 文件（默认 true）

**使用场景**: 页面截图、元素截图

---

### 6.2 `chrome_gif_recorder`

**功能**: 录制浏览器活动为 GIF 动画
**参数**:

- `action` (string, 必需):
  - `start`: 固定 FPS 模式录制
  - `auto_start`: 自动捕获模式（在 chrome_computer 等操作时自动截帧）
  - `stop`: 停止并保存 GIF
  - `capture`: 手动触发一帧
  - `status`: 查询状态
  - `clear`: 清空录制
  - `export`: 导出 GIF
- `tabId` (number): 目标标签 ID
- `fps` (number): 帧率（1-30，默认5）
- `durationMs` (number): 最大录制时长
- `maxFrames` (number): 最大帧数
- `width` / `height` (number): 输出尺寸
- `enhancedRendering` (object): 增强渲染配置（点击指示、拖拽路径、标签）

**使用场景**:

- 录制操作演示
- 制作教程 GIF
- 记录自动化过程

---

## 7. 性能分析工具（3个）

### 7.1 `performance_start_trace`

**功能**: 开始性能追踪
**参数**:

- `reload` (boolean): 追踪开始后自动刷新页面
- `autoStop` (boolean): 自动停止追踪
- `durationMs` (number): 自动停止时长（默认5000）

**使用场景**: 性能分析、页面加载分析

---

### 7.2 `performance_stop_trace`

**功能**: 停止性能追踪
**参数**:

- `saveToDownloads` (boolean): 保存为 JSON 文件（默认 true）
- `filenamePrefix` (string): 文件名前缀

**使用场景**: 保存追踪数据用于分析

---

### 7.3 `performance_analyze_insight`

**功能**: 分析性能追踪结果
**参数**:

- `insightName` (string): 分析类型（如 "DocumentLatency"）
- `timeoutMs` (number): 分析超时（默认60000）

**返回**: 性能摘要信息

**使用场景**: 快速获取性能指标

---

## 8. 文件与对话框工具（3个）

### 8.1 `chrome_upload_file`

**功能**: 上传文件到表单
**参数**:

- `selector` (string, 必需): 文件输入框选择器
- `filePath` (string): 本地文件路径
- `fileUrl` (string): 从 URL 下载文件
- `base64Data` (string): Base64 编码的文件数据
- `fileName` (string): 文件名
- `multiple` (boolean): 多文件上传
- `tabId` (number): 目标标签 ID

**使用场景**: 自动化文件上传

---

### 8.2 `chrome_handle_dialog`

**功能**: 处理 JavaScript 对话框（alert/confirm/prompt）
**参数**:

- `action` (string, 必需): "accept" 或 "dismiss"
- `promptText` (string): prompt 对话框的输入文本

**使用场景**: 处理页面弹窗

---

### 8.3 `chrome_handle_download`

**功能**: 等待并处理下载
**参数**:

- `filenameContains` (string): 文件名过滤
- `timeoutMs` (number): 超时时间（默认60000，最大300000）
- `waitForComplete` (boolean): 等待下载完成（默认 true）

**返回**: 下载信息（ID、文件名、URL、状态、大小）

**使用场景**: 等待文件下载完成

---

## 工具使用最佳实践

### 1. 元素定位优先级

推荐的元素定位方法优先级：

1. **chrome_read_page** → 获取元素 `ref` → 使用 `ref` 操作（最可靠）
2. **CSS 选择器** → 使用 `selector`
3. **坐标** → 使用 `coordinates`（最不稳定）

### 2. 人在回路模式

当自动定位失败约 3 次后，使用 `chrome_request_element_selection` 请求用户协助。

### 3. 网络捕获注意事项

- 默认使用 webRequest API（轻量级，无冲突）
- 需要响应体时才启用 `needResponseBody`（会使用 Debugger API，可能与 DevTools 冲突）

### 4. 性能考虑

- `chrome_read_page` 的 `depth` 参数控制遍历深度，降低可减少输出
- `chrome_screenshot` 的 `fullPage=false` 可加快截图速度
- `chrome_console` 的 buffer 模式比 snapshot 模式更快

---

## 已注释的工具（可选启用）

以下工具在源码中被注释，需要时可以启用：

- `search_tabs_content` - AI 语义搜索标签内容
- `chrome_inject_script` - 注入持久化脚本
- `chrome_send_command_to_inject_script` - 向注入脚本发送命令
- `chrome_userscript` - 统一的用户脚本管理工具
- `record_replay_flow_run` - 运行录制的流程
- `record_replay_list_published` - 列出已发布的流程

---

## 旧版工具映射表

| 旧版工具 (browser\_\*)       | 新版工具 (chrome\_\*)    | 说明                   |
| ---------------------------- | ------------------------ | ---------------------- |
| `browser_read_page`          | `chrome_read_page`       | API 相同               |
| `browser_capture_screenshot` | `chrome_screenshot`      | 功能增强               |
| `browser_get_network_logs`   | `chrome_network_capture` | 统一为 start/stop 模式 |
| `browser_get_console_logs`   | `chrome_console`         | 新增 buffer 模式       |
| `browser_click`              | `chrome_click_element`   | 支持更多定位方式       |
| `browser_fill_form`          | `chrome_fill_or_select`  | API 相同               |
| `browser_input_text`         | `chrome_fill_or_select`  | 合并到 fill 工具       |
| `browser_run_js`             | `chrome_javascript`      | 增强安全性             |

---

**文档版本**: 2.0.0
**最后更新**: 2026-02-08
**维护者**: Qwen Code Team

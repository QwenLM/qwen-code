# Chrome MCP Integration 测试场景

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

本文档定义 Chrome MCP Integration 的端到端测试场景，覆盖所有 27 个工具和典型工作流。

---

## 测试环境要求

### 必需环境

- **Chrome 浏览器**: 120+ (支持 Manifest V3)
- **Node.js**: 22+
- **Qwen CLI**: 最新版本
- **操作系统**: macOS / Linux / Windows

### 测试数据准备

- 测试网页：准备包含表单、表格、按钮的静态页面
- 测试 API：准备返回 JSON 的测试端点
- 测试文件：准备用于上传测试的图片和文档

---

## 测试场景分类

### 🔧 基础集成测试

#### Scenario 1.1: 组件启动和连接

**目标**: 验证所有组件正常启动并建立连接

**前置条件**:

- Chrome Extension 已加载
- Native Messaging Host 已注册
- Qwen CLI 已配置 MCP Server

**测试步骤**:

1. 启动 Chrome 浏览器
2. 打开 Extension Side Panel
3. 观察连接状态
4. 在 Qwen CLI 中执行 `list tools`

**验收标准**:

- ✅ Extension Side Panel 显示"已连接"
- ✅ Qwen CLI 列出所有 27 个 chrome\_\* 工具
- ✅ Native Host 进程正常运行
- ✅ 无错误日志

---

#### Scenario 1.2: 基础工具调用

**目标**: 验证最简单的工具调用链路

**测试步骤**:

1. 打开一个网页（如 https://example.com）
2. 在 Qwen CLI 中执行：
   ```
   使用 get_windows_and_tabs 工具列出所有标签页
   ```

**验收标准**:

- ✅ 返回当前所有窗口和标签页信息
- ✅ 包含标签 ID、标题、URL
- ✅ 响应时间 < 2 秒

---

### 📑 浏览器管理工具测试（6个）

#### Scenario 2.1: get_windows_and_tabs

**工具**: `get_windows_and_tabs`

**测试步骤**:

1. 打开 3 个不同的标签页
2. 调用工具
3. 验证返回数据

**验收标准**:

- ✅ 返回所有 3 个标签页
- ✅ 每个标签包含 id, title, url, active 字段
- ✅ 正确标识当前活跃标签

---

#### Scenario 2.2: chrome_navigate - 基础导航

**工具**: `chrome_navigate`

**测试步骤**:

1. 调用工具导航到 https://example.com
2. 等待页面加载
3. 验证当前 URL

**验收标准**:

- ✅ 页面成功加载
- ✅ URL 匹配目标地址
- ✅ 响应时间 < 5 秒

---

#### Scenario 2.3: chrome_navigate - 历史导航

**工具**: `chrome_navigate`

**测试步骤**:

1. 依次访问 3 个页面
2. 调用 `chrome_navigate` 参数 `url: "back"`
3. 再次调用 `url: "forward"`

**验收标准**:

- ✅ 后退到上一页
- ✅ 前进到下一页
- ✅ URL 变化正确

---

#### Scenario 2.4: chrome_navigate - 刷新页面

**工具**: `chrome_navigate`

**测试步骤**:

1. 打开包含时间戳的页面
2. 调用工具参数 `refresh: true`
3. 比较刷新前后的时间戳

**验收标准**:

- ✅ 页面重新加载
- ✅ 时间戳更新

---

#### Scenario 2.5: chrome_switch_tab

**工具**: `chrome_switch_tab`

**测试步骤**:

1. 打开 3 个标签页
2. 使用 get_windows_and_tabs 获取标签 ID
3. 调用工具切换到第 2 个标签
4. 验证当前活跃标签

**验收标准**:

- ✅ 成功切换到目标标签
- ✅ 该标签变为 active
- ✅ 浏览器视觉上切换正确

---

#### Scenario 2.6: chrome_close_tabs

**工具**: `chrome_close_tabs`

**测试步骤**:

1. 打开 5 个标签页
2. 获取第 2、3 个标签的 ID
3. 调用工具关闭这两个标签
4. 验证剩余标签数量

**验收标准**:

- ✅ 只剩下 3 个标签
- ✅ 正确的标签被关闭
- ✅ 其他标签不受影响

---

#### Scenario 2.7: chrome_read_page

**工具**: `chrome_read_page`

**测试步骤**:

1. 打开包含表单的页面
2. 调用工具获取页面可访问性树
3. 检查返回的元素结构

**验收标准**:

- ✅ 返回页面元素树
- ✅ 每个元素包含 ref、role、text
- ✅ 可交互元素被正确标识

---

#### Scenario 2.8: chrome_computer - 截图

**工具**: `chrome_computer`

**测试步骤**:

1. 打开测试页面
2. 调用工具参数 `action: "screenshot"`
3. 检查返回的截图数据

**验收标准**:

- ✅ 返回 base64 编码的图片
- ✅ 图片尺寸正确
- ✅ 内容清晰可见

---

### 🖱️ 页面交互工具测试（5个）

#### Scenario 3.1: chrome_click_element - CSS 选择器

**工具**: `chrome_click_element`

**测试步骤**:

1. 打开包含按钮的页面（如 `<button id="testBtn">Click Me</button>`）
2. 调用工具参数 `selector: "#testBtn"`
3. 验证点击事件触发

**验收标准**:

- ✅ 按钮被成功点击
- ✅ 点击事件处理函数执行
- ✅ 页面状态改变（如显示消息）

---

#### Scenario 3.2: chrome_click_element - 使用 ref

**工具**: `chrome_click_element` + `chrome_read_page`

**测试步骤**:

1. 先调用 chrome_read_page 获取页面元素
2. 从返回结果中找到按钮的 ref
3. 调用 chrome_click_element 使用该 ref 点击

**验收标准**:

- ✅ 通过 ref 成功定位元素
- ✅ 点击事件正确触发
- ✅ 比直接使用选择器更可靠

---

#### Scenario 3.3: chrome_fill_or_select - 文本输入

**工具**: `chrome_fill_or_select`

**测试步骤**:

1. 打开包含输入框的表单
2. 调用工具填充文本：
   ```
   selector: "#username"
   value: "testuser"
   ```
3. 验证输入框值

**验收标准**:

- ✅ 输入框值正确填充
- ✅ 触发 input 和 change 事件
- ✅ 表单验证正常工作

---

#### Scenario 3.4: chrome_fill_or_select - 下拉选择

**工具**: `chrome_fill_or_select`

**测试步骤**:

1. 打开包含 select 元素的表单
2. 调用工具选择选项：
   ```
   selector: "#country"
   value: "China"
   ```

**验收标准**:

- ✅ 选项被正确选中
- ✅ 选择框显示值更新
- ✅ change 事件触发

---

#### Scenario 3.5: chrome_fill_or_select - 复选框

**工具**: `chrome_fill_or_select`

**测试步骤**:

1. 打开包含 checkbox 的表单
2. 调用工具：
   ```
   selector: "#agree"
   value: true
   ```

**验收标准**:

- ✅ 复选框被选中
- ✅ checked 属性为 true

---

#### Scenario 3.6: chrome_keyboard

**工具**: `chrome_keyboard`

**测试步骤**:

1. 聚焦到输入框
2. 调用工具模拟键盘输入：
   ```
   keys: "Hello World"
   ```
3. 然后发送回车：
   ```
   keys: "Enter"
   ```

**验收标准**:

- ✅ 文本逐字符输入
- ✅ Enter 键触发表单提交
- ✅ 键盘事件正确触发

---

#### Scenario 3.7: chrome_request_element_selection

**工具**: `chrome_request_element_selection`

**测试步骤**:

1. 调用工具请求用户选择元素：
   ```json
   {
     "requests": [
       {
         "name": "登录按钮",
         "description": "请点击页面上的登录按钮"
       }
     ]
   }
   ```
2. 手动在页面上点击目标元素
3. 验证返回的 ref

**验收标准**:

- ✅ Extension 显示选择提示面板
- ✅ 用户点击后返回正确的 ref
- ✅ ref 可用于后续操作

---

#### Scenario 3.8: chrome_javascript

**工具**: `chrome_javascript`

**测试步骤**:

1. 打开测试页面
2. 调用工具执行 JavaScript：
   ```javascript
   return document.title;
   ```

**验收标准**:

- ✅ 返回页面标题
- ✅ 支持 async/await
- ✅ 输出被正确序列化

---

### 🌐 网络监控工具测试（2个）

#### Scenario 4.1: chrome_network_capture - 基础捕获

**工具**: `chrome_network_capture`

**测试步骤**:

1. 调用工具开始捕获：`action: "start"`
2. 访问一个页面（发起多个请求）
3. 调用工具停止捕获：`action: "stop"`
4. 检查返回的网络日志

**验收标准**:

- ✅ 捕获到所有 HTTP 请求
- ✅ 包含 URL、方法、状态码
- ✅ 请求/响应时间戳正确

---

#### Scenario 4.2: chrome_network_capture - 捕获响应体

**工具**: `chrome_network_capture`

**测试步骤**:

1. 调用工具参数 `needResponseBody: true, action: "start"`
2. 访问返回 JSON 的 API
3. 停止捕获
4. 验证响应体

**验收标准**:

- ✅ 响应体被完整捕获
- ✅ JSON 内容正确
- ✅ Content-Type 正确

---

#### Scenario 4.3: chrome_network_capture - WebSocket

**工具**: `chrome_network_capture`

**测试步骤**:

1. 调用工具参数 `captureWebSocket: true, action: "start"`
2. 建立 WebSocket 连接并发送消息
3. 停止捕获

**验收标准**:

- ✅ 捕获 WebSocket 握手
- ✅ 捕获发送/接收的帧
- ✅ 消息内容正确

---

#### Scenario 4.4: chrome_network_request

**工具**: `chrome_network_request`

**测试步骤**:

1. 先登录网站（设置 cookies）
2. 调用工具发送带认证的请求：
   ```json
   {
     "url": "https://example.com/api/user",
     "method": "GET"
   }
   ```

**验收标准**:

- ✅ 请求携带浏览器 cookies
- ✅ 返回正确的用户数据
- ✅ 认证成功

---

### 📄 内容分析工具测试（2个）

#### Scenario 5.1: chrome_get_web_content - 文本内容

**工具**: `chrome_get_web_content`

**测试步骤**:

1. 打开文章页面
2. 调用工具参数 `textContent: true`
3. 检查返回内容

**验收标准**:

- ✅ 返回页面可见文本
- ✅ 包含元数据（标题、URL）
- ✅ 过滤掉脚本和样式

---

#### Scenario 5.2: chrome_get_web_content - HTML 内容

**工具**: `chrome_get_web_content`

**测试步骤**:

1. 打开测试页面
2. 调用工具参数 `htmlContent: true`
3. 验证 HTML 结构

**验收标准**:

- ✅ 返回页面 HTML
- ✅ 结构完整
- ✅ 可用于解析

---

#### Scenario 5.3: chrome_get_web_content - 选择器提取

**工具**: `chrome_get_web_content`

**测试步骤**:

1. 打开包含文章的页面
2. 调用工具参数 `selector: "article"`
3. 只返回 article 元素内容

**验收标准**:

- ✅ 只返回指定元素内容
- ✅ 其他内容被过滤

---

#### Scenario 5.4: chrome_console - 快照模式

**工具**: `chrome_console`

**测试步骤**:

1. 打开包含 console.log 的页面
2. 调用工具参数 `mode: "snapshot"`
3. 检查返回的日志

**验收标准**:

- ✅ 捕获 console.log 消息
- ✅ 包含时间戳和日志级别
- ✅ 捕获异常信息

---

#### Scenario 5.5: chrome_console - 缓冲模式

**工具**: `chrome_console`

**测试步骤**:

1. 调用工具参数 `mode: "buffer"` 读取日志
2. 触发一些控制台输出
3. 再次调用读取新日志

**验收标准**:

- ✅ 即时返回（无等待）
- ✅ 按顺序返回日志
- ✅ clearAfterRead 正常工作

---

### 💾 数据管理工具测试（4个）

#### Scenario 6.1: chrome_history

**工具**: `chrome_history`

**测试步骤**:

1. 访问几个页面
2. 调用工具搜索历史：
   ```json
   {
     "text": "example",
     "maxResults": 10
   }
   ```

**验收标准**:

- ✅ 返回匹配的历史记录
- ✅ 包含标题、URL、访问时间
- ✅ 按时间排序

---

#### Scenario 6.2: chrome_bookmark_search

**工具**: `chrome_bookmark_search`

**测试步骤**:

1. 提前创建几个测试书签
2. 调用工具搜索：
   ```json
   {
     "query": "test"
   }
   ```

**验收标准**:

- ✅ 返回匹配的书签
- ✅ 包含标题、URL、文件夹路径

---

#### Scenario 6.3: chrome_bookmark_add

**工具**: `chrome_bookmark_add`

**测试步骤**:

1. 打开测试页面
2. 调用工具添加书签：
   ```json
   {
     "title": "测试书签",
     "url": "https://example.com"
   }
   ```
3. 在 Chrome 书签栏验证

**验收标准**:

- ✅ 书签成功创建
- ✅ 出现在书签栏
- ✅ 标题和 URL 正确

---

#### Scenario 6.4: chrome_bookmark_delete

**工具**: `chrome_bookmark_delete`

**测试步骤**:

1. 先创建一个测试书签
2. 调用工具删除：
   ```json
   {
     "url": "https://example.com"
   }
   ```
3. 验证书签已删除

**验收标准**:

- ✅ 书签被成功删除
- ✅ 书签栏中不再显示

---

### 📸 截图与录制工具测试（2个）

#### Scenario 7.1: chrome_screenshot - 全页截图

**工具**: `chrome_screenshot`

**测试步骤**:

1. 打开长页面
2. 调用工具参数：
   ```json
   {
     "fullPage": true,
     "storeBase64": true
   }
   ```

**验收标准**:

- ✅ 返回完整页面截图
- ✅ base64 数据有效
- ✅ 包含页面底部内容

---

#### Scenario 7.2: chrome_screenshot - 元素截图

**工具**: `chrome_screenshot`

**测试步骤**:

1. 打开测试页面
2. 调用工具参数：
   ```json
   {
     "selector": "#header",
     "storeBase64": true
   }
   ```

**验收标准**:

- ✅ 只截取指定元素
- ✅ 尺寸匹配元素大小

---

#### Scenario 7.3: chrome_gif_recorder - 固定 FPS 模式

**工具**: `chrome_gif_recorder`

**测试步骤**:

1. 调用工具开始录制：
   ```json
   {
     "action": "start",
     "fps": 5,
     "durationMs": 3000
   }
   ```
2. 等待 3 秒
3. 调用工具停止：`action: "stop"`

**验收标准**:

- ✅ 生成 GIF 文件
- ✅ 帧率正确（约 15 帧）
- ✅ 文件大小合理

---

#### Scenario 7.4: chrome_gif_recorder - 自动捕获模式

**工具**: `chrome_gif_recorder` + `chrome_computer`

**测试步骤**:

1. 调用 chrome_gif_recorder 参数 `action: "auto_start"`
2. 使用 chrome_computer 执行一系列操作
3. 停止录制

**验收标准**:

- ✅ 自动捕获每次操作的截图
- ✅ GIF 显示操作过程
- ✅ 增强渲染（点击指示、拖拽路径）生效

---

### ⚡ 性能分析工具测试（3个）

#### Scenario 8.1: performance_start_trace + stop_trace

**工具**: `performance_start_trace`, `performance_stop_trace`

**测试步骤**:

1. 调用 performance_start_trace 参数 `reload: true`
2. 等待页面加载完成
3. 调用 performance_stop_trace

**验收标准**:

- ✅ 性能追踪文件保存成功
- ✅ JSON 格式有效
- ✅ 可在 Chrome DevTools 中打开

---

#### Scenario 8.2: performance_analyze_insight

**工具**: `performance_analyze_insight`

**测试步骤**:

1. 先执行完整的追踪流程
2. 调用工具分析：
   ```json
   {
     "insightName": "DocumentLatency"
   }
   ```

**验收标准**:

- ✅ 返回性能摘要
- ✅ 包含关键指标（FCP、LCP 等）

---

### 📁 文件与对话框工具测试（3个）

#### Scenario 9.1: chrome_upload_file

**工具**: `chrome_upload_file`

**测试步骤**:

1. 打开包含文件上传的表单
2. 调用工具：
   ```json
   {
     "selector": "input[type='file']",
     "filePath": "/path/to/test.png"
   }
   ```
3. 提交表单验证上传

**验收标准**:

- ✅ 文件成功选中
- ✅ 表单提交包含文件
- ✅ 服务器接收到文件

---

#### Scenario 9.2: chrome_handle_dialog

**工具**: `chrome_handle_dialog`

**测试步骤**:

1. 触发页面 alert 对话框
2. 调用工具：
   ```json
   {
     "action": "accept"
   }
   ```

**验收标准**:

- ✅ 对话框被接受
- ✅ 页面继续执行

---

#### Scenario 9.3: chrome_handle_download

**工具**: `chrome_handle_download`

**测试步骤**:

1. 点击下载链接
2. 调用工具等待下载：
   ```json
   {
     "timeoutMs": 30000,
     "waitForComplete": true
   }
   ```

**验收标准**:

- ✅ 捕获下载事件
- ✅ 返回文件名、大小、状态
- ✅ 下载完成

---

## 🔄 典型工作流测试

### Workflow 1: 智能表单填充

**场景**: AI 自动分析表单并填充

**涉及工具**:

1. `chrome_navigate` - 打开表单页面
2. `chrome_read_page` - 读取表单结构
3. `chrome_fill_or_select` - 填充各个字段
4. `chrome_click_element` - 点击提交按钮

**验收标准**:

- ✅ 完整流程自动完成
- ✅ 所有字段正确填充
- ✅ 表单成功提交
- ✅ 总耗时 < 10 秒

---

### Workflow 2: 网页数据提取和分析

**场景**: 提取网页内容并分析

**涉及工具**:

1. `chrome_navigate` - 打开目标页面
2. `chrome_get_web_content` - 提取内容
3. `chrome_network_capture` - 捕获 API 请求
4. `chrome_console` - 检查错误

**验收标准**:

- ✅ 内容完整提取
- ✅ API 请求被记录
- ✅ 无错误日志

---

### Workflow 3: 自动化测试录制

**场景**: 录制自动化测试过程为 GIF

**涉及工具**:

1. `chrome_gif_recorder` - 开始录制
2. `chrome_navigate` - 访问页面
3. `chrome_click_element` - 执行操作
4. `chrome_fill_or_select` - 填写表单
5. `chrome_gif_recorder` - 停止并导出

**验收标准**:

- ✅ GIF 显示完整流程
- ✅ 操作清晰可见
- ✅ 文件大小 < 5MB

---

### Workflow 4: 性能分析完整流程

**场景**: 分析页面性能并生成报告

**涉及工具**:

1. `performance_start_trace` - 开始追踪
2. `chrome_navigate` - 加载页面
3. `performance_stop_trace` - 停止并保存
4. `performance_analyze_insight` - 分析结果

**验收标准**:

- ✅ 性能数据完整
- ✅ 关键指标正确
- ✅ 可生成优化建议

---

## 🚨 错误处理测试

### Error Scenario 1: 工具超时

**测试**:

1. 调用 chrome_navigate 访问超慢的页面
2. 设置短超时时间

**验收标准**:

- ✅ 超时后返回错误
- ✅ 错误信息清晰
- ✅ 不影响后续操作

---

### Error Scenario 2: 元素未找到

**测试**:

1. 调用 chrome_click_element 使用不存在的选择器

**验收标准**:

- ✅ 返回"元素未找到"错误
- ✅ 建议使用 chrome_read_page
- ✅ 不崩溃

---

### Error Scenario 3: 权限拒绝

**测试**:

1. 调用需要特殊权限的操作（如访问 chrome:// 页面）

**验收标准**:

- ✅ 返回权限错误
- ✅ 说明所需权限

---

## 📊 性能基准测试

### Performance Benchmark 1: 工具响应时间

**测试所有 27 个工具的响应时间**

**目标**:

- 简单查询工具（如 get_windows_and_tabs）: < 1 秒
- 页面操作工具（如 chrome_click_element）: < 2 秒
- 复杂工具（如 chrome_network_capture）: < 5 秒

---

### Performance Benchmark 2: 并发处理

**测试**:

1. 同时发起 5 个不同的工具调用
2. 测量总完成时间

**目标**:

- 所有工具正确完成
- 无相互干扰
- 总时间 < 单独执行时间之和

---

## ✅ 测试覆盖率目标

- **工具覆盖率**: 27/27 工具 = 100%
- **场景覆盖率**: 至少每个工具 2 个场景
- **工作流覆盖率**: 4 个典型工作流
- **错误处理**: 至少 3 种错误场景
- **性能测试**: 所有工具响应时间

---

**文档版本**: 2.0.0
**最后更新**: 2026-02-08
**维护者**: Qwen Code Team

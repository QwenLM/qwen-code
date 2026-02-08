# Chrome MCP Integration - 测试用例

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

本文档提供完整的测试场景和用例，覆盖所有 27 个工具和典型工作流。

---

## 📋 测试环境准备

### 必需环境

- **Chrome 浏览器**: 120+ (支持 Manifest V3)
- **Node.js**: 22+
- **Qwen CLI**: 最新版本
- **操作系统**: macOS / Linux

### 测试数据准备

创建测试网页 `test.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <title>MCP Chrome Test Page</title>
  </head>
  <body>
    <h1>测试页面</h1>

    <!-- 表单测试 -->
    <form id="testForm">
      <input type="text" id="username" placeholder="用户名" />
      <input type="password" id="password" placeholder="密码" />
      <select id="country">
        <option value="cn">中国</option>
        <option value="us">美国</option>
      </select>
      <input type="checkbox" id="agree" /> 同意协议
      <button type="submit" id="submitBtn">提交</button>
    </form>

    <!-- 测试按钮 -->
    <button id="testBtn" onclick="alert('Clicked!')">测试按钮</button>

    <!-- 文件上传 -->
    <input type="file" id="fileInput" />

    <script>
      // 生成一些控制台日志
      console.log('页面加载完成');
      console.error('这是一个测试错误');

      // 发送测试请求
      fetch('/api/test').catch((e) => console.error(e));
    </script>
  </body>
</html>
```

---

## 🧪 基础集成测试

### Test Case 1.1: 组件启动和连接

**目标**: 验证所有组件正常启动

**步骤**:

1. 打开 Chrome，加载 Extension
2. 在 `chrome://extensions/` 检查扩展状态
3. 点击 "Inspect views: service worker"
4. 在 Qwen CLI 中执行 `qwen mcp list`

**预期结果**:

```
✅ Service Worker 显示: [NativeMessaging] Connected successfully
✅ qwen mcp list 显示: chrome: ... (27 tools)
✅ 无错误日志
```

**调用工具**: 无

---

### Test Case 1.2: 基础工具调用

**目标**: 验证最简单的工具链路

**步骤**:

```bash
qwen
> 使用 get_windows_and_tabs 工具列出所有标签页
```

**预期结果**:

```json
{
  "windows": [
    {
      "id": 1,
      "tabs": [
        {
          "id": 123,
          "title": "Test Page",
          "url": "http://localhost/test.html",
          "active": true
        }
      ]
    }
  ]
}
```

**调用工具**: `get_windows_and_tabs`

---

## 🖥️ 浏览器管理工具测试（6个）

### Test Case 2.1: 页面导航

**步骤**:

```bash
qwen
> 使用 chrome_navigate 打开 https://example.com
```

**预期结果**:

- ✅ 页面成功加载
- ✅ URL 变为 https://example.com
- ✅ 响应时间 < 5 秒

**调用工具**: `chrome_navigate`

---

### Test Case 2.2: 历史导航

**步骤**:

```bash
> 先打开 https://google.com
> 再打开 https://github.com
> 使用 chrome_navigate 参数 url="back" 返回上一页
```

**预期结果**:

- ✅ 返回到 google.com
- ✅ URL 正确

**调用工具**: `chrome_navigate`

---

### Test Case 2.3: 切换标签页

**前置**: 打开 3 个标签页

**步骤**:

```bash
> 使用 get_windows_and_tabs 获取所有标签
> 使用 chrome_switch_tab 切换到第 2 个标签
```

**预期结果**:

- ✅ 浏览器视觉上切换到第 2 个标签
- ✅ 该标签变为 active

**调用工具**: `get_windows_and_tabs`, `chrome_switch_tab`

---

### Test Case 2.4: 关闭标签页

**前置**: 打开 5 个标签页

**步骤**:

```bash
> 获取所有标签的 ID
> 使用 chrome_close_tabs 关闭第 2、3 个标签
> 再次获取标签列表验证
```

**预期结果**:

- ✅ 只剩 3 个标签
- ✅ 正确的标签被关闭

**调用工具**: `get_windows_and_tabs`, `chrome_close_tabs`

---

### Test Case 2.5: 读取页面结构

**前置**: 打开 test.html

**步骤**:

```bash
> 使用 chrome_read_page 获取页面可访问性树
```

**预期结果**:

```json
{
  "elements": [
    {
      "ref": "ref-001",
      "role": "button",
      "text": "提交",
      "selector": "#submitBtn"
    },
    {
      "ref": "ref-002",
      "role": "textbox",
      "text": "",
      "selector": "#username"
    }
  ]
}
```

**验证**:

- ✅ 返回所有可交互元素
- ✅ 每个元素包含 ref、role、text
- ✅ ref 可用于后续操作

**调用工具**: `chrome_read_page`

---

### Test Case 2.6: 页面截图

**步骤**:

```bash
> 使用 chrome_computer action="screenshot" 截图当前页面
```

**预期结果**:

- ✅ 返回 base64 编码的图片
- ✅ 图片清晰可见
- ✅ 尺寸正确

**调用工具**: `chrome_computer`

---

## 🖱️ 页面交互工具测试（5个）

### Test Case 3.1: CSS 选择器点击

**前置**: 打开 test.html

**步骤**:

```bash
> 使用 chrome_click_element 参数 selector="#testBtn" 点击按钮
```

**预期结果**:

- ✅ 按钮被点击
- ✅ alert 对话框弹出
- ✅ 对话框文本为 "Clicked!"

**调用工具**: `chrome_click_element`

**注意**: 需要用 `chrome_handle_dialog` 关闭 alert

---

### Test Case 3.2: 使用 ref 点击（推荐方式）

**步骤**:

```bash
> 1. 使用 chrome_read_page 获取页面元素
> 2. 找到按钮的 ref（如 "ref-001"）
> 3. 使用 chrome_click_element ref="ref-001" 点击
```

**预期结果**:

- ✅ 通过 ref 成功定位
- ✅ 点击成功

**调用工具**: `chrome_read_page`, `chrome_click_element`

---

### Test Case 3.3: 表单填充 - 文本输入

**步骤**:

```bash
> 使用 chrome_fill_or_select 填充:
>   selector="#username"
>   value="testuser"
>
> 再填充密码:
>   selector="#password"
>   value="password123"
```

**预期结果**:

- ✅ 输入框值正确填充
- ✅ 触发 input 事件
- ✅ 表单验证生效

**调用工具**: `chrome_fill_or_select` (2次)

---

### Test Case 3.4: 表单填充 - 下拉选择

**步骤**:

```bash
> 使用 chrome_fill_or_select:
>   selector="#country"
>   value="us"
```

**预期结果**:

- ✅ 下拉框选中 "美国"
- ✅ change 事件触发

**调用工具**: `chrome_fill_or_select`

---

### Test Case 3.5: 表单填充 - 复选框

**步骤**:

```bash
> 使用 chrome_fill_or_select:
>   selector="#agree"
>   value=true
```

**预期结果**:

- ✅ 复选框被选中
- ✅ checked 属性为 true

**调用工具**: `chrome_fill_or_select`

---

### Test Case 3.6: 键盘输入

**步骤**:

```bash
> 先点击用户名输入框
> 使用 chrome_keyboard:
>   keys="Hello World"
>   selector="#username"
>
> 然后按 Enter:
>   keys="Enter"
```

**预期结果**:

- ✅ 文本逐字符输入
- ✅ Enter 触发表单提交

**调用工具**: `chrome_click_element`, `chrome_keyboard` (2次)

---

### Test Case 3.7: JavaScript 执行

**步骤**:

```bash
> 使用 chrome_javascript 执行:
>   code="return document.title"
```

**预期结果**:

```json
{
  "result": "MCP Chrome Test Page"
}
```

**调用工具**: `chrome_javascript`

---

### Test Case 3.8: 人在回路 - 元素选择

**场景**: 自动定位失败，请求用户协助

**步骤**:

```bash
> 使用 chrome_request_element_selection:
>   requests=[{
>     "name": "登录按钮",
>     "description": "请点击页面上的登录按钮"
>   }]
```

**用户操作**: 手动在页面上点击目标元素

**预期结果**:

- ✅ Extension 显示选择提示
- ✅ 用户点击后返回 ref
- ✅ ref 可用于后续操作

**调用工具**: `chrome_request_element_selection`

---

## 🌐 网络监控工具测试（2个）

### Test Case 4.1: 基础网络捕获

**步骤**:

```bash
> 使用 chrome_network_capture action="start" 开始捕获
> 访问 https://jsonplaceholder.typicode.com/posts
> 使用 chrome_network_capture action="stop" 停止
```

**预期结果**:

```json
{
  "requests": [
    {
      "url": "https://jsonplaceholder.typicode.com/posts",
      "method": "GET",
      "statusCode": 200,
      "timing": {
        "start": 1234567890,
        "end": 1234567900
      }
    }
  ]
}
```

**调用工具**: `chrome_network_capture` (2次)

---

### Test Case 4.2: 捕获响应体

**步骤**:

```bash
> 使用 chrome_network_capture:
>   action="start"
>   needResponseBody=true
>
> 访问 JSON API
> 停止捕获
```

**预期结果**:

- ✅ 响应体被捕获
- ✅ JSON 内容完整
- ✅ Content-Type 正确

**调用工具**: `chrome_network_capture` (2次)

---

### Test Case 4.3: 带认证的请求

**前置**: 先登录网站

**步骤**:

```bash
> 使用 chrome_network_request:
>   url="https://example.com/api/user"
>   method="GET"
```

**预期结果**:

- ✅ 请求携带 cookies
- ✅ 返回用户数据
- ✅ 认证成功

**调用工具**: `chrome_network_request`

---

## 📄 内容分析工具测试（2个）

### Test Case 5.1: 提取页面文本

**步骤**:

```bash
> 打开文章页面
> 使用 chrome_get_web_content textContent=true
```

**预期结果**:

```json
{
  "text": "测试页面\n\n用户名\n密码\n...",
  "metadata": {
    "title": "MCP Chrome Test Page",
    "url": "http://localhost/test.html"
  }
}
```

**调用工具**: `chrome_get_web_content`

---

### Test Case 5.2: 提取 HTML

**步骤**:

```bash
> 使用 chrome_get_web_content htmlContent=true
```

**预期结果**:

- ✅ 返回完整 HTML
- ✅ 结构正确

**调用工具**: `chrome_get_web_content`

---

### Test Case 5.3: 捕获控制台日志

**步骤**:

```bash
> 打开 test.html
> 使用 chrome_console mode="snapshot"
```

**预期结果**:

```json
{
  "logs": [
    {
      "level": "log",
      "text": "页面加载完成",
      "timestamp": 1234567890
    },
    {
      "level": "error",
      "text": "这是一个测试错误",
      "timestamp": 1234567891
    }
  ]
}
```

**调用工具**: `chrome_console`

---

## 💾 数据管理工具测试（4个）

### Test Case 6.1: 搜索历史记录

**前置**: 访问几个页面

**步骤**:

```bash
> 使用 chrome_history:
>   text="example"
>   maxResults=10
```

**预期结果**:

- ✅ 返回匹配的历史记录
- ✅ 包含标题、URL、访问时间
- ✅ 按时间排序

**调用工具**: `chrome_history`

---

### Test Case 6.2: 添加书签

**步骤**:

```bash
> 打开 https://github.com
> 使用 chrome_bookmark_add:
>   title="GitHub"
>   url="https://github.com"
```

**预期结果**:

- ✅ 书签创建成功
- ✅ 出现在书签栏

**调用工具**: `chrome_bookmark_add`

---

### Test Case 6.3: 搜索书签

**前置**: 已有测试书签

**步骤**:

```bash
> 使用 chrome_bookmark_search query="GitHub"
```

**预期结果**:

- ✅ 返回匹配书签
- ✅ 包含标题、URL

**调用工具**: `chrome_bookmark_search`

---

### Test Case 6.4: 删除书签

**步骤**:

```bash
> 使用 chrome_bookmark_delete:
>   url="https://github.com"
```

**预期结果**:

- ✅ 书签被删除
- ✅ 书签栏中消失

**调用工具**: `chrome_bookmark_delete`

---

## 📸 截图与录制工具测试（2个）

### Test Case 7.1: 全页截图

**步骤**:

```bash
> 打开长页面
> 使用 chrome_screenshot:
>   fullPage=true
>   storeBase64=true
```

**预期结果**:

- ✅ 返回完整页面截图
- ✅ base64 数据有效
- ✅ 包含页面底部

**调用工具**: `chrome_screenshot`

---

### Test Case 7.2: GIF 录制

**步骤**:

```bash
> 使用 chrome_gif_recorder action="start" fps=5
> 执行一些操作（点击、填充）
> 使用 chrome_gif_recorder action="stop"
```

**预期结果**:

- ✅ 生成 GIF 文件
- ✅ 显示操作过程
- ✅ 文件大小合理

**调用工具**: `chrome_gif_recorder` (2次)

---

## ⚡ 性能分析工具测试（3个）

### Test Case 8.1: 性能追踪

**步骤**:

```bash
> 使用 performance_start_trace reload=true
> 等待页面加载
> 使用 performance_stop_trace
```

**预期结果**:

- ✅ 性能数据保存为 JSON
- ✅ 可在 DevTools 中打开

**调用工具**: `performance_start_trace`, `performance_stop_trace`

---

### Test Case 8.2: 性能分析

**步骤**:

```bash
> 先执行完整追踪
> 使用 performance_analyze_insight insightName="DocumentLatency"
```

**预期结果**:

- ✅ 返回性能摘要
- ✅ 包含 FCP、LCP 等指标

**调用工具**: `performance_start_trace`, `performance_stop_trace`, `performance_analyze_insight`

---

## 📁 文件与对话框工具测试（3个）

### Test Case 9.1: 文件上传

**步骤**:

```bash
> 使用 chrome_upload_file:
>   selector="#fileInput"
>   filePath="/path/to/test.png"
```

**预期结果**:

- ✅ 文件被选中
- ✅ 文件名显示正确

**调用工具**: `chrome_upload_file`

---

### Test Case 9.2: 处理对话框

**步骤**:

```bash
> 点击触发 alert 的按钮
> 使用 chrome_handle_dialog action="accept"
```

**预期结果**:

- ✅ 对话框被接受
- ✅ 页面继续执行

**调用工具**: `chrome_click_element`, `chrome_handle_dialog`

---

### Test Case 9.3: 等待下载

**步骤**:

```bash
> 点击下载链接
> 使用 chrome_handle_download:
>   timeoutMs=30000
>   waitForComplete=true
```

**预期结果**:

- ✅ 捕获下载事件
- ✅ 返回文件信息
- ✅ 下载完成

**调用工具**: `chrome_handle_download`

---

## 🔄 典型工作流测试

### Workflow 1: 智能表单填充

**场景**: AI 自动分析并填充登录表单

**完整步骤**:

```bash
qwen
> 帮我登录这个网站，用户名是 admin，密码是 password123

# AI 自动执行以下步骤：
```

**AI 执行的工具调用序列**:

1. `chrome_read_page` - 分析表单结构
2. `chrome_fill_or_select` selector="#username" value="admin"
3. `chrome_fill_or_select` selector="#password" value="password123"
4. `chrome_click_element` selector="#submitBtn"

**预期结果**:

- ✅ 表单自动填充
- ✅ 成功提交
- ✅ 总耗时 < 10 秒

**调用工具**: 4 个

---

### Workflow 2: 网页数据提取和分析

**场景**: 提取文章内容并分析

**步骤**:

```bash
> 帮我分析这篇文章的主要内容
```

**AI 执行的工具调用**:

1. `chrome_get_web_content` textContent=true
2. `chrome_network_capture` - 检查 API 请求
3. `chrome_console` - 检查是否有错误

**预期结果**:

- ✅ 内容完整提取
- ✅ API 请求被记录
- ✅ 无错误日志

**调用工具**: 3 个

---

### Workflow 3: 自动化测试录制

**场景**: 录制测试流程为 GIF

**步骤**:

```bash
> 帮我录制一个登录流程的 GIF
```

**AI 执行的工具调用**:

1. `chrome_gif_recorder` action="auto_start"
2. `chrome_navigate` url="https://example.com/login"
3. `chrome_fill_or_select` - 填充用户名
4. `chrome_fill_or_select` - 填充密码
5. `chrome_click_element` - 点击登录
6. `chrome_gif_recorder` action="stop"

**预期结果**:

- ✅ GIF 显示完整流程
- ✅ 操作清晰可见
- ✅ 文件大小 < 5MB

**调用工具**: 6 个

---

### Workflow 4: 性能分析

**场景**: 分析页面性能

**步骤**:

```bash
> 帮我分析这个页面的加载性能
```

**AI 执行的工具调用**:

1. `performance_start_trace` reload=true
2. 等待页面加载
3. `performance_stop_trace`
4. `performance_analyze_insight` insightName="DocumentLatency"

**预期结果**:

- ✅ 性能数据完整
- ✅ 关键指标正确
- ✅ 生成优化建议

**调用工具**: 3 个

---

## 📊 测试覆盖率总结

| 类别       | 工具数量 | 测试用例数 | 覆盖率   |
| ---------- | -------- | ---------- | -------- |
| 浏览器管理 | 6        | 6          | 100%     |
| 页面交互   | 5        | 8          | 100%     |
| 网络监控   | 2        | 3          | 100%     |
| 内容分析   | 2        | 3          | 100%     |
| 数据管理   | 4        | 4          | 100%     |
| 截图录制   | 2        | 2          | 100%     |
| 性能分析   | 3        | 2          | 100%     |
| 文件对话框 | 3        | 3          | 100%     |
| **总计**   | **27**   | **31**     | **100%** |

**工作流测试**: 4 个典型场景

**总测试用例**: 35 个（31 个单工具 + 4 个工作流）

---

## ✅ 快速测试检查清单

### 基础功能（必测）

- [ ] Extension 加载成功
- [ ] Service Worker 连接成功
- [ ] `get_windows_and_tabs` 工具可用
- [ ] `chrome_navigate` 导航成功
- [ ] `chrome_click_element` 点击成功
- [ ] `chrome_screenshot` 截图成功

### 高级功能（推荐）

- [ ] `chrome_read_page` 返回元素树
- [ ] `chrome_network_capture` 捕获响应体
- [ ] `chrome_gif_recorder` 录制 GIF
- [ ] Side Panel 聊天界面正常

### 完整测试（全面）

- [ ] 所有 27 个工具都测试通过
- [ ] 4 个工作流场景测试通过
- [ ] 无错误日志
- [ ] 响应时间符合预期

---

**文档版本**: 2.0.0
**最后更新**: 2026-02-08
**维护者**: Qwen Code Team

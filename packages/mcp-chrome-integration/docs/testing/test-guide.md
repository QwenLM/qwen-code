# Chrome MCP Integration 测试执行指南

> **版本**: 2.0.0 | **最后更新**: 2026-02-08

本文档提供 Chrome MCP Integration 的测试环境配置、执行步骤和结果记录方法。

---

## 📋 测试前准备

### 1. 环境配置检查清单

#### ✅ Chrome 浏览器

- [ ] Chrome 版本 ≥ 120
- [ ] 已启用开发者模式
- [ ] 已清除缓存和 cookies（可选，用于干净测试）

验证方法：

```bash
# 查看 Chrome 版本
chrome://version
```

---

#### ✅ Node.js 环境

- [ ] Node.js 版本 ≥ 22
- [ ] npm 可用

验证方法：

```bash
node --version  # 应输出 v22.x.x 或更高
npm --version
```

---

#### ✅ 项目构建

- [ ] 所有依赖已安装
- [ ] Extension 已构建
- [ ] Native Server 已构建

执行命令：

```bash
cd /path/to/qwen-code
npm install

# 构建所有组件
npm run build --workspace=@qwen-code/mcp-chrome-integration
```

验证产物：

```bash
# 检查 Extension 构建产物
ls packages/mcp-chrome-integration/app/chrome-extension/dist/extension/

# 检查 Native Server 构建产物
ls packages/mcp-chrome-integration/app/native-server/dist/
```

---

#### ✅ Native Messaging 注册

- [ ] Native Messaging Host 已注册
- [ ] 配置文件路径正确

执行命令：

```bash
npm run install:native --workspace=@qwen-code/mcp-chrome-integration
npm run doctor --workspace=@qwen-code/mcp-chrome-integration
```

验证配置：

```bash
# macOS
cat ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# Linux
cat ~/.config/google-chrome/NativeMessagingHosts/com.chromemcp.nativehost.json

# Windows
type %LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\com.chromemcp.nativehost.json
```

---

#### ✅ Chrome Extension 加载

- [ ] Extension 已加载
- [ ] Extension ID 已记录
- [ ] Side Panel 可打开

步骤：

1. 打开 `chrome://extensions/`
2. 启用"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择 `packages/mcp-chrome-integration/app/chrome-extension/dist/extension`
5. 记录 Extension ID

---

#### ✅ Qwen CLI 配置

- [ ] Qwen CLI 已安装
- [ ] MCP Server 配置已添加

配置文件示例（`~/.qwen/config.json` 或类似路径）：

```json
{
  "mcpServers": {
    "chrome": {
      "command": "node",
      "args": [
        "/path/to/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js"
      ]
    }
  }
}
```

验证命令：

```bash
# 在 Qwen CLI 中执行
list tools

# 应看到所有 27 个 chrome_* 工具
```

---

### 2. 测试数据准备

#### 测试网页

创建或准备以下测试页面：

**test-form.html** - 表单测试页面：

```html
<!DOCTYPE html>
<html>
  <head>
    <title>测试表单</title>
  </head>
  <body>
    <h1>测试表单</h1>
    <form id="testForm">
      <label for="username">用户名：</label>
      <input type="text" id="username" name="username" />

      <label for="password">密码：</label>
      <input type="password" id="password" name="password" />

      <label for="country">国家：</label>
      <select id="country" name="country">
        <option value="cn">中国</option>
        <option value="us">美国</option>
      </select>

      <label>
        <input type="checkbox" id="agree" name="agree" />
        同意条款
      </label>

      <button type="submit" id="submitBtn">提交</button>
    </form>
    <script>
      document.getElementById('testForm').addEventListener('submit', (e) => {
        e.preventDefault();
        console.log('表单已提交');
        alert('提交成功！');
      });
    </script>
  </body>
</html>
```

**test-api.html** - 网络请求测试页面：

```html
<!DOCTYPE html>
<html>
  <head>
    <title>API 测试</title>
  </head>
  <body>
    <h1>API 测试页面</h1>
    <button id="fetchBtn">发起请求</button>
    <pre id="result"></pre>
    <script>
      document
        .getElementById('fetchBtn')
        .addEventListener('click', async () => {
          const response = await fetch('https://api.github.com/users/github');
          const data = await response.json();
          document.getElementById('result').textContent = JSON.stringify(
            data,
            null,
            2,
          );
          console.log('API 请求完成', data);
        });
    </script>
  </body>
</html>
```

**test-long-page.html** - 长页面（用于全页截图测试）：

```html
<!DOCTYPE html>
<html>
  <head>
    <title>长页面测试</title>
    <style>
      .section {
        height: 800px;
        border: 1px solid #ccc;
        margin: 20px;
      }
    </style>
  </head>
  <body>
    <h1>长页面测试</h1>
    <div class="section">Section 1</div>
    <div class="section">Section 2</div>
    <div class="section">Section 3</div>
  </body>
</html>
```

将这些文件保存到本地目录，如 `~/test-pages/`

---

#### 测试文件

准备用于上传测试的文件：

```bash
mkdir -p ~/test-files
echo "Test content" > ~/test-files/test.txt
# 准备一张测试图片 test.png
```

---

## 🧪 测试执行方式

### 方式 1: 自动化测试（推荐）

#### 编写测试脚本

创建测试脚本 `test-all-tools.js`：

```javascript
// test-all-tools.js
const testCases = [
  {
    name: 'get_windows_and_tabs',
    tool: 'get_windows_and_tabs',
    args: {},
    validate: (result) => {
      return Array.isArray(result.windows) && result.windows.length > 0;
    },
  },
  {
    name: 'chrome_navigate',
    tool: 'chrome_navigate',
    args: { url: 'https://example.com' },
    validate: (result) => {
      return result.success === true;
    },
  },
  // ... 其他工具测试
];

async function runTests() {
  const results = [];

  for (const test of testCases) {
    console.log(`测试: ${test.name}`);
    try {
      const result = await callTool(test.tool, test.args);
      const passed = test.validate(result);
      results.push({ name: test.name, passed, result });
      console.log(passed ? '✅ 通过' : '❌ 失败');
    } catch (error) {
      results.push({ name: test.name, passed: false, error: error.message });
      console.log('❌ 错误:', error.message);
    }
  }

  // 生成测试报告
  generateReport(results);
}

runTests();
```

#### 运行自动化测试

```bash
node test-all-tools.js
```

---

### 方式 2: 手动测试

#### 使用 Qwen CLI 逐个测试

**步骤模板**：

1. 启动 Qwen CLI
2. 准备测试环境（打开测试页面等）
3. 执行工具调用
4. 验证结果
5. 记录到测试报告

**示例：测试 chrome_click_element**

```bash
# 1. 在 Qwen CLI 中
> 打开 file:///Users/xxx/test-pages/test-form.html

# 2. 调用工具
> 使用 chrome_click_element 工具点击 ID 为 submitBtn 的按钮

# 3. 观察结果
# - 检查页面是否显示 "提交成功！" 的 alert
# - 检查控制台是否输出 "表单已提交"

# 4. 记录结果
测试通过 ✅
```

---

### 方式 3: 使用 Postman/REST Client 测试（高级）

如果 Native Server 提供 HTTP 接口（调试模式），可以使用 REST 客户端测试：

```bash
# 启动 Native Server 的 HTTP 模式（如果支持）
npm run dev --workspace=mcp-chrome-bridge

# 使用 curl 测试
curl -X POST http://localhost:3000/tools/get_windows_and_tabs \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## 📝 测试执行检查清单

### 基础集成测试

- [ ] 组件启动和连接（Scenario 1.1）
- [ ] 基础工具调用（Scenario 1.2）

### 浏览器管理工具（6个）

- [ ] get_windows_and_tabs
- [ ] chrome_navigate（基础导航、历史导航、刷新）
- [ ] chrome_switch_tab
- [ ] chrome_close_tabs
- [ ] chrome_read_page
- [ ] chrome_computer（截图）

### 页面交互工具（5个）

- [ ] chrome_click_element（CSS 选择器、ref）
- [ ] chrome_fill_or_select（文本输入、下拉选择、复选框）
- [ ] chrome_keyboard
- [ ] chrome_request_element_selection
- [ ] chrome_javascript

### 网络监控工具（2个）

- [ ] chrome_network_capture（基础捕获、响应体、WebSocket）
- [ ] chrome_network_request

### 内容分析工具（2个）

- [ ] chrome_get_web_content（文本、HTML、选择器）
- [ ] chrome_console（快照模式、缓冲模式）

### 数据管理工具（4个）

- [ ] chrome_history
- [ ] chrome_bookmark_search
- [ ] chrome_bookmark_add
- [ ] chrome_bookmark_delete

### 截图与录制工具（2个）

- [ ] chrome_screenshot（全页、元素）
- [ ] chrome_gif_recorder（固定 FPS、自动捕获）

### 性能分析工具（3个）

- [ ] performance_start_trace
- [ ] performance_stop_trace
- [ ] performance_analyze_insight

### 文件与对话框工具（3个）

- [ ] chrome_upload_file
- [ ] chrome_handle_dialog
- [ ] chrome_handle_download

### 典型工作流（4个）

- [ ] 智能表单填充
- [ ] 网页数据提取和分析
- [ ] 自动化测试录制
- [ ] 性能分析完整流程

### 错误处理（3个）

- [ ] 工具超时
- [ ] 元素未找到
- [ ] 权限拒绝

---

## 📊 测试结果记录

### 测试报告模板

创建 `test-results.md`：

```markdown
# Chrome MCP Integration 测试报告

**测试日期**: 2026-02-08
**测试人员**: [姓名]
**环境**:

- Chrome 版本: 120.0.6099.109
- Node.js 版本: 22.1.0
- OS: macOS 14.2

## 测试结果汇总

| 类别         | 总数   | 通过   | 失败  | 跳过  | 通过率   |
| ------------ | ------ | ------ | ----- | ----- | -------- |
| 浏览器管理   | 6      | 6      | 0     | 0     | 100%     |
| 页面交互     | 5      | 5      | 0     | 0     | 100%     |
| 网络监控     | 2      | 2      | 0     | 0     | 100%     |
| 内容分析     | 2      | 2      | 0     | 0     | 100%     |
| 数据管理     | 4      | 4      | 0     | 0     | 100%     |
| 截图与录制   | 2      | 2      | 0     | 0     | 100%     |
| 性能分析     | 3      | 3      | 0     | 0     | 100%     |
| 文件与对话框 | 3      | 3      | 0     | 0     | 100%     |
| **总计**     | **27** | **27** | **0** | **0** | **100%** |

## 详细测试结果

### ✅ get_windows_and_tabs

- **状态**: 通过
- **执行时间**: 0.5s
- **备注**: 正确返回所有窗口和标签

### ✅ chrome_navigate

- **状态**: 通过
- **执行时间**: 1.2s
- **备注**: 导航、历史、刷新功能正常

### ❌ chrome_screenshot

- **状态**: 失败
- **错误信息**: 权限不足
- **重现步骤**:
  1. 调用 chrome_screenshot
  2. 设置 fullPage: true
- **预期行为**: 返回完整页面截图
- **实际行为**: 返回错误 "Permission denied"
- **建议**: 检查 manifest.json 权限配置

## 性能基准测试

| 工具                   | 平均响应时间 | 目标 | 状态 |
| ---------------------- | ------------ | ---- | ---- |
| get_windows_and_tabs   | 0.5s         | < 1s | ✅   |
| chrome_navigate        | 1.2s         | < 2s | ✅   |
| chrome_click_element   | 0.8s         | < 2s | ✅   |
| chrome_network_capture | 3.5s         | < 5s | ✅   |

## 问题清单

1. **chrome_screenshot 权限问题** - 高优先级
   - 影响: 无法进行截图测试
   - 解决方案: 添加 activeTab 权限

2. **chrome_gif_recorder 文件过大** - 中优先级
   - 影响: GIF 文件 > 10MB
   - 解决方案: 降低帧率或分辨率

## 总结

- **测试覆盖率**: 27/27 工具 (100%)
- **总体通过率**: 96% (26/27)
- **关键问题**: 1 个
- **建议**: 修复权限问题后重新测试
```

---

## 🐛 故障排查

### 问题 1: Extension 无法连接 Native Host

**症状**: Extension 显示"连接失败"

**排查步骤**:

1. 检查 Native Messaging 配置文件是否存在
2. 检查配置文件中的路径是否正确
3. 检查 Extension ID 是否匹配
4. 查看 Native Host 日志

**解决方法**:

```bash
# 重新注册 Native Messaging
npm run install:native --workspace=@qwen-code/mcp-chrome-integration

# 检查日志
# macOS: 查看 Console.app 中的 Chrome 日志
# Linux: journalctl -f
```

---

### 问题 2: 工具调用超时

**症状**: 工具返回 "Timeout" 错误

**排查步骤**:

1. 检查网络连接
2. 检查页面是否加载完成
3. 增加超时时间

**解决方法**:

```javascript
// 增加超时配置
{
  "timeout": 30000  // 30 秒
}
```

---

### 问题 3: Qwen CLI 无法列出工具

**症状**: `list tools` 不显示 chrome\_\* 工具

**排查步骤**:

1. 检查 MCP Server 配置路径
2. 测试 Native Server 是否可以独立运行
3. 检查 Qwen CLI 日志

**解决方法**:

```bash
# 手动测试 Native Server
node packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js

# 应该看到 MCP Server 启动日志
```

---

## 📈 性能测试

### 性能测试脚本

创建 `performance-test.js`：

```javascript
async function measureToolPerformance(toolName, args, iterations = 10) {
  const times = [];

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    await callTool(toolName, args);
    const end = Date.now();
    times.push(end - start);
  }

  const avg = times.reduce((a, b) => a + b) / times.length;
  const min = Math.min(...times);
  const max = Math.max(...times);

  console.log(`${toolName}:`);
  console.log(`  平均: ${avg}ms`);
  console.log(`  最小: ${min}ms`);
  console.log(`  最大: ${max}ms`);

  return { avg, min, max };
}

// 测试所有工具
async function runPerformanceTests() {
  await measureToolPerformance('get_windows_and_tabs', {});
  await measureToolPerformance('chrome_navigate', {
    url: 'https://example.com',
  });
  // ... 其他工具
}

runPerformanceTests();
```

---

## 🔄 持续集成 (CI) 配置

### GitHub Actions 示例

创建 `.github/workflows/test-chrome-mcp.yml`：

```yaml
name: Chrome MCP Integration Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '22'

      - name: Install dependencies
        run: npm install

      - name: Build project
        run: npm run build --workspace=@qwen-code/mcp-chrome-integration

      - name: Install Chrome
        uses: browser-actions/setup-chrome@latest

      - name: Run tests
        run: npm test --workspace=@qwen-code/mcp-chrome-integration

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: test-results/
```

---

## 📚 参考资源

- **测试场景文档**: [test-scenarios.md](test-scenarios.md)
- **架构文档**: [../architecture.md](../architecture.md)
- **工具参考**: [../tools-reference.md](../tools-reference.md)
- **故障排查**: [../guides/development.md](../guides/development.md)

---

**文档版本**: 2.0.0
**最后更新**: 2026-02-08
**维护者**: Qwen Code Team

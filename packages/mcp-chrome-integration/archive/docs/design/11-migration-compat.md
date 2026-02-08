# 从 chrome-extension 迁移到 mcp-chrome-integration

本文档提供详细的迁移指南，帮助你从旧版 `chrome-extension` 平滑过渡到新版 `mcp-chrome-integration`。

## 📋 迁移概览

### 变化总结

| 方面         | 旧版                                       | 新版                              | 变化      |
| ------------ | ------------------------------------------ | --------------------------------- | --------- |
| **目录**     | `archive/chrome-extension`                 | `packages/mcp-chrome-integration` | 新目录    |
| **架构**     | Extension → HTTP → Native Host → ACP → MCP | Extension → MCP                   | 简化 60%  |
| **工具数量** | 10 个                                      | 20+ 个                            | 增加 100% |
| **安装**     | 复杂（Native Messaging 配置）              | 简单（npm install -g）            | 简化 70%  |
| **配置**     | `host.js` + manifest + ACP                 | 仅 Qwen CLI 配置                  | 简化      |
| **维护**     | 内部                                       | 社区                              | 零成本    |

## 🔄 工具映射表

### 网络监控

| 旧版工具                   | 新版工具                                                         | 迁移说明                                                                      |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `browser_get_network_logs` | `chrome_network_debugger_start` + `chrome_network_debugger_stop` | **需要两步操作**：<br>1. 先调用 `start` 开始捕获<br>2. 再调用 `stop` 获取结果 |

**示例对比**:

```javascript
// 旧版 - 一步获取
const logs = await qwen.call('browser_get_network_logs');

// 新版 - 两步操作
await qwen.call('chrome_network_debugger_start', {
  url: 'https://example.com',
});
// ... 等待页面加载和请求完成
const logs = await qwen.call('chrome_network_debugger_stop');
```

**优势**: 新版支持完整的 response body，数据更全面

### 页面内容

| 旧版工具            | 新版工具           | 迁移说明                                                                                          |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------- |
| `browser_read_page` | `chrome_read_page` | **参数变化**：<br>- 新增 `filter` 参数（可选 "interactive"）<br>- 返回格式包含 accessibility tree |

**示例对比**:

```javascript
// 旧版
const page = await qwen.call('browser_read_page');

// 新版 - 基本用法相同
const page = await qwen.call('chrome_read_page');

// 新版 - 仅获取可交互元素
const interactive = await qwen.call('chrome_read_page', {
  filter: 'interactive',
});
```

### 截图

| 旧版工具                     | 新版工具            | 迁移说明                                                                                                                                   |
| ---------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `browser_capture_screenshot` | `chrome_screenshot` | **功能增强**：<br>- 支持元素截图 (selector)<br>- 支持全页截图 (fullPage)<br>- 支持自定义尺寸 (width/height)<br>- 支持后台截图 (background) |

**示例对比**:

```javascript
// 旧版 - 基本截图
const screenshot = await qwen.call('browser_capture_screenshot');

// 新版 - 基本截图（兼容）
const screenshot = await qwen.call('chrome_screenshot');

// 新版 - 元素截图（新功能）
const elementShot = await qwen.call('chrome_screenshot', {
  selector: '.main-content',
  fullPage: false,
});

// 新版 - 全页截图（新功能）
const fullPage = await qwen.call('chrome_screenshot', {
  fullPage: true,
  storeBase64: true,
});
```

### Console 日志

| 旧版工具                   | 新版工具         | 迁移说明                       |
| -------------------------- | ---------------- | ------------------------------ |
| `browser_get_console_logs` | `chrome_console` | **API 基本兼容**，直接替换即可 |

**示例对比**:

```javascript
// 旧版
const logs = await qwen.call('browser_get_console_logs');

// 新版 - 直接替换
const logs = await qwen.call('chrome_console');
```

### 页面交互

| 旧版工具                 | 新版工具                | 迁移说明                                                                                                |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `browser_click`          | `chrome_click_element`  | **参数增强**：<br>- 支持 `ref`（从 chrome_read_page 获取）<br>- 支持 `selector`<br>- 支持 `coordinates` |
| `browser_click_text`     | `chrome_click_element`  | **合并到 chrome_click_element**：<br>先用 chrome_read_page 找到元素的 ref，再点击                       |
| `browser_fill_form`      | `chrome_fill_or_select` | **参数变化**：<br>- 使用 `ref` 或 `selector` 定位<br>- 使用 `value` 设置值                              |
| `browser_fill_form_auto` | `chrome_fill_or_select` | **需要循环调用**：<br>对每个字段调用一次                                                                |
| `browser_input_text`     | `chrome_fill_or_select` | **合并到 chrome_fill_or_select**                                                                        |
| `browser_run_js`         | `chrome_inject_script`  | **功能相同**，名称变化                                                                                  |

**示例对比**:

```javascript
// 旧版 - 点击元素
await qwen.call('browser_click', { selector: '#login-btn' });

// 新版 - 点击元素（更灵活）
await qwen.call('chrome_click_element', { selector: '#login-btn' });
// 或使用 ref
const page = await qwen.call('chrome_read_page');
await qwen.call('chrome_click_element', { ref: 'ref_42' });

// 旧版 - 填充表单
await qwen.call('browser_fill_form', {
  entries: [
    { selector: '#username', value: 'user@example.com' },
    { selector: '#password', value: 'password' },
  ],
});

// 新版 - 填充表单（需要循环）
await qwen.call('chrome_fill_or_select', {
  selector: '#username',
  value: 'user@example.com',
});
await qwen.call('chrome_fill_or_select', {
  selector: '#password',
  value: 'password',
});

// 旧版 - 执行 JavaScript
await qwen.call('browser_run_js', { code: 'console.log("test")' });

// 新版 - 注入脚本
await qwen.call('chrome_inject_script', { code: 'console.log("test")' });
```

## 🆕 新增功能

### 1. AI 语义搜索

```javascript
// 在所有打开的标签页中语义搜索
const results = await qwen.call('search_tabs_content', {
  query: 'machine learning tutorials',
});
```

### 2. 键盘快捷键

```javascript
// 模拟键盘输入
await qwen.call('chrome_keyboard', {
  keys: 'Ctrl+A',
  selector: '#text-input',
});
```

### 3. 高级交互 (chrome_computer)

```javascript
// 统一的高级交互工具
await qwen.call('chrome_computer', {
  action: 'hover',
  ref: 'ref_12',
});

await qwen.call('chrome_computer', {
  action: 'left_click_drag',
  startRef: 'ref_10',
  ref: 'ref_15',
});
```

### 4. 浏览器数据管理

```javascript
// 搜索浏览历史
const history = await qwen.call('chrome_history', {
  text: 'github',
  maxResults: 50,
});

// 管理书签
await qwen.call('chrome_bookmark_add', {
  url: 'https://example.com',
  title: 'Example',
  parentId: 'Work/Resources',
});

const bookmarks = await qwen.call('chrome_bookmark_search', {
  query: 'documentation',
});
```

### 5. 标签页管理

```javascript
// 列出所有窗口和标签
const tabs = await qwen.call('get_windows_and_tabs');

// 切换标签
await qwen.call('chrome_switch_tab', { tabId: 456 });

// 关闭标签
await qwen.call('chrome_close_tabs', {
  tabIds: [123, 456],
});

// 浏览器导航
await qwen.call('chrome_go_back_or_forward', {
  direction: 'back',
});
```

## 🔧 配置迁移

### 旧版配置（Native Messaging）

```json
// ~/.qwen/mcp-servers.json
{
  "chrome-browser": {
    "command": "node",
    "args": [
      "/path/to/qwen-code/archive/chrome-extension/native-host/dist/host.js"
    ]
  }
}
```

### 新版配置（Streamable HTTP）

```json
// ~/.qwen/mcp-servers.json
{
  "chrome-mcp": {
    "type": "streamableHttp",
    "url": "http://127.0.0.1:12306/mcp"
  }
}
```

### 并行运行（过渡期）

```json
{
  "chrome-browser": {
    "command": "node",
    "args": ["/path/to/chrome-extension/native-host/dist/host.js"]
  },
  "chrome-mcp": {
    "type": "streamableHttp",
    "url": "http://127.0.0.1:12306/mcp"
  }
}
```

## 📝 迁移清单

### 阶段 1: 准备（15 分钟）

- [ ] 备份当前配置
- [ ] 阅读本迁移指南
- [ ] 安装 mcp-chrome-bridge: `npm install -g mcp-chrome-bridge`
- [ ] 加载 Chrome Extension

### 阶段 2: 并行测试（1-2 天）

- [ ] 配置新版 MCP 服务器（保留旧版）
- [ ] 测试所有常用功能
- [ ] 对比性能和稳定性
- [ ] 记录问题和差异

### 阶段 3: 迁移代码（2-4 小时）

- [ ] 更新所有工具调用（参考上面的映射表）
- [ ] 测试迁移后的功能
- [ ] 验证无回归

### 阶段 4: 清理（30 分钟）

- [ ] 移除旧版 MCP 配置
- [x] `chrome-extension` 已归档到 `archive/chrome-extension`
- [ ] 更新文档

## ⚠️ 注意事项

### 1. 网络监控需要两步操作

旧版的 `browser_get_network_logs` 是一步获取，新版需要先 `start` 后 `stop`。

**建议**: 封装一个辅助函数:

```javascript
async function captureNetwork(url, maxTime = 30000) {
  await qwen.call('chrome_network_debugger_start', { url });
  await new Promise((resolve) => setTimeout(resolve, maxTime));
  return await qwen.call('chrome_network_debugger_stop');
}
```

### 2. 表单填充需要循环

旧版的 `browser_fill_form` 支持批量填充，新版需要逐个调用。

**建议**: 封装批量填充函数:

```javascript
async function fillForm(fields) {
  for (const field of fields) {
    await qwen.call('chrome_fill_or_select', {
      selector: field.selector,
      value: field.value,
    });
  }
}
```

### 3. 点击文本需要先查找

旧版的 `browser_click_text` 直接支持文本点击，新版需要先用 `chrome_read_page` 找到元素。

**建议**: 封装文本点击函数:

```javascript
async function clickByText(text) {
  const page = await qwen.call('chrome_read_page', { filter: 'interactive' });
  // 解析 page 找到包含 text 的元素的 ref
  const ref = findRefByText(page, text);
  await qwen.call('chrome_click_element', { ref });
}
```

## 🐛 常见问题

### Q: 旧版工具还能用吗？

**A**: 可以并行运行。在过渡期，你可以同时配置 `chrome-browser` 和 `chrome-mcp` 两个 MCP 服务器。

### Q: 如何回退到旧版？

**A**:

1. 移除新版配置: `qwen mcp remove chrome-mcp`
2. 保持旧版配置不变
3. `chrome-extension` 目录已保留，随时可用

### Q: 性能有差异吗？

**A**: 新版架构更简洁（2 层 vs 5 层），理论上性能更好。实际使用中应该感受不到明显差异。

### Q: 所有功能都能平滑迁移吗？

**A**: 是的。所有旧版功能在新版中都有对应或更强的替代。参考上面的工具映射表。

## 📚 延伸阅读

- [完整工具 API](tools-api.md)
- [与旧版详细对比](comparison.md)
- [配置示例](config-examples.md)
- [故障排查](troubleshooting.md)

---

**需要帮助？**

- 查看 [故障排查文档](troubleshooting.md)
- 查看 [hangwin/mcp-chrome Issues](https://github.com/hangwin/mcp-chrome/issues)

# MCP + Qwen CLI 使用指南

**日期**: 2026-01-17
**状态**: ✅ 可用

---

## 🎉 好消息

HTTP 服务器已成功启动！你现在可以通过 Qwen CLI 使用所有 27 个浏览器工具了。

---

## 📋 快速开始

### 1. HTTP 服务器已在运行

后台进程 ID: `bc09dba`

```bash
# 检查服务器状态
curl http://127.0.0.1:12306/ping

# 查看服务器日志
tail -f /private/tmp/claude/-Users-yiliang-projects-temp-qwen-code/tasks/bc09dba.output
```

### 2. 在 Qwen CLI 中使用浏览器工具

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension

qwen
```

**测试命令**:

```
> /mcp list

> 帮我截图当前 Chrome 页面

> 帮我读取当前页面的内容

> 帮我列出所有打开的 Chrome 标签页

> 帮我点击页面上的"登录"按钮
```

---

## 🛠️ 可用的 27 个工具

### 导航和标签管理

- `chrome_navigate` - 导航到 URL
- `chrome_go_back_or_forward` - 前进/后退
- `chrome_switch_tab` - 切换标签页
- `chrome_close_tabs` - 关闭标签页
- `get_windows_and_tabs` - 获取所有窗口和标签页

### 页面交互

- `chrome_read_page` - 读取页面内容（使用 accessibility tree）
- `chrome_screenshot` - 截图（全页/可见区域/元素）
- `chrome_click_element` - 点击元素
- `chrome_fill_or_select` - 填充表单/选择选项
- `chrome_inject_script` - 执行 JavaScript
- `chrome_computer` - 高级交互（hover、拖拽等）
- `chrome_keyboard` - 键盘快捷键

### 调试和分析

- `chrome_console` - 获取控制台日志
- `chrome_network_debugger_start` - 开始网络监控
- `chrome_network_debugger_stop` - 停止网络监控并获取日志
- `chrome_performance_debugger_start` - 性能分析
- `chrome_performance_debugger_stop` - 停止性能分析

### 书签和历史

- `chrome_bookmark_search` - 搜索书签
- `chrome_bookmark_add` - 添加书签
- `chrome_bookmark_delete` - 删除书签
- `chrome_history` - 浏览历史

### 高级功能

- `search_tabs_content` - AI 语义搜索标签页内容
- `chrome_request_element_selection` - 请求用户选择页面元素
- `chrome_request_user_file` - 请求用户选择文件
- `chrome_read_pdf` - 读取 PDF 内容
- `chrome_read_image` - 读取图片 OCR
- `chrome_download` - 下载文件
- `chrome_save_pdf` - 保存为 PDF

---

## 🔄 服务器管理

### 查看服务器状态

```bash
# 检查是否运行
curl http://127.0.0.1:12306/ping

# 查看日志
tail -f /private/tmp/claude/-Users-yiliang-projects-temp-qwen-code/tasks/bc09dba.output
```

### 停止服务器

```bash
# 方法 1: 使用 kill 命令
kill <PID>

# 方法 2: 如果你有服务器进程的终端
# 按 Ctrl+C
```

### 重新启动服务器

```bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server

node dist/start-server.js
```

或在后台运行：

```bash
nohup node dist/start-server.js > server.log 2>&1 &
```

---

## 🎯 使用示例

### 示例 1: 网页数据抓取

```
你: 帮我打开 https://example.com，然后读取页面标题和所有链接

Claude 会:
1. 使用 chrome_navigate 打开网页
2. 使用 chrome_read_page 读取内容
3. 提取标题和链接信息
```

### 示例 2: 表单自动填写

```
你: 帮我在当前页面的搜索框中输入"Claude AI"并搜索

Claude 会:
1. 使用 chrome_read_page 找到搜索框
2. 使用 chrome_fill_or_select 填写内容
3. 使用 chrome_click_element 点击搜索按钮
```

### 示例 3: 调试网络问题

```
你: 帮我监控这个页面的网络请求，看看哪些接口失败了

Claude 会:
1. 使用 chrome_network_debugger_start 开始监控
2. 让你刷新页面或执行操作
3. 使用 chrome_network_debugger_stop 获取日志
4. 分析失败的请求
```

---

## 📁 文件位置

| 文件/目录                                                                                                               | 说明                |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/start-server.js`         | HTTP 服务器启动脚本 |
| `/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server/dist/mcp/mcp-server-stdio.js` | MCP Server (stdio)  |
| `/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension/.qwen/settings.json`       | Qwen MCP 配置       |
| `/private/tmp/claude/-Users-yiliang-projects-temp-qwen-code/tasks/bc09dba.output`                                       | 服务器日志          |

---

## ⚠️ 注意事项

1. **HTTP 服务器必须运行**
   - MCP Server (stdio) 需要连接到 HTTP 服务器
   - 如果服务器停止，MCP 工具将无法使用

2. **Chrome 浏览器必须开启**
   - 工具需要连接到正在运行的 Chrome 实例
   - 确保 Chrome 的远程调试功能可用

3. **权限要求**
   - 某些工具需要用户确认（如 file picker）
   - 网络调试需要 debugger 权限

4. **Extension 连接（可选）**
   - HTTP 服务器可以独立运行，不需要 Extension
   - Extension UI 可以提供额外的可视化功能

---

## 🚀 自动启动设置（可选）

创建自动启动脚本：

```bash
# 创建启动脚本
cat > /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/start-mcp.sh <<'EOF'
#!/bin/bash
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/native-server
nohup node dist/start-server.js > logs/server.log 2>&1 &
echo "MCP Server started. PID: $!"
EOF

chmod +x /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/start-mcp.sh
```

使用：

```bash
/Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/start-mcp.sh
```

---

## ✅ 验证安装

```bash
# 1. 检查 HTTP 服务器
curl http://127.0.0.1:12306/ping

# 2. 检查 MCP 配置
cd /Users/yiliang/projects/temp/qwen-code/packages/mcp-chrome-integration/app/chrome-extension
qwen mcp list

# 3. 测试工具调用
qwen
# 然后在会话中:
> 帮我截图
```

如果所有步骤都成功，你就可以开始使用了！

---

**创建时间**: 2026-01-17
**更新时间**: 2026-01-17
**状态**: ✅ 完全可用

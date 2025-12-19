# Chrome Qwen Bridge 实施计划

## 项目背景

基于用户需求和技术调研，需要开发一个 Chrome 插件，实现浏览器与 Qwen CLI 之间的数据桥接，让 AI 能够分析和处理网页内容。

## 实施阶段

### 第一阶段：基础架构搭建（已完成 ✅）

#### 1.1 Chrome 插件基础结构
- ✅ 创建项目目录结构
- ✅ 配置 manifest.json (Manifest V3)
- ✅ 设置必要的权限和配置

#### 1.2 核心组件开发
- ✅ **Background Service Worker**
  - 实现消息路由
  - 管理 Native Messaging 连接
  - 处理扩展生命周期

- ✅ **Content Script**
  - DOM 内容提取
  - Console 日志拦截
  - 页面事件监听
  - HTML 转 Markdown 转换器

- ✅ **Popup UI**
  - 用户界面设计（渐变主题）
  - 状态指示器
  - 操作按钮组
  - 响应结果展示
  - 设置管理

#### 1.3 功能实现清单

| 功能模块 | 具体功能 | 状态 |
|---------|---------|------|
| **数据提取** | | |
| | 提取页面文本内容 | ✅ |
| | 提取页面 HTML | ✅ |
| | 转换为 Markdown | ✅ |
| | 提取链接列表 | ✅ |
| | 提取图片信息 | ✅ |
| | 提取表单结构 | ✅ |
| | 提取元数据 | ✅ |
| **监控功能** | | |
| | Console 日志捕获 | ✅ |
| | 网络请求监控 | ✅ |
| | 性能指标收集 | ✅ |
| **交互功能** | | |
| | 截图捕获 | ✅ |
| | 选中文本获取 | ✅ |
| | 元素高亮 | ✅ |
| | 执行 JavaScript | ✅ |
| | 页面滚动控制 | ✅ |

### 第二阶段：Native Messaging 实现（已完成 ✅）

#### 2.1 Native Host 开发
- ✅ **host.js 核心脚本**
  - Native Messaging 协议实现
  - 4字节长度前缀处理
  - JSON 消息解析
  - 双向通信管道

#### 2.2 进程管理
- ✅ Qwen CLI 进程启动/停止
- ✅ 进程状态监控
- ✅ 输出流捕获
- ✅ 错误处理
- ✅ 优雅退出机制

#### 2.3 安装脚本
- ✅ macOS/Linux 安装脚本 (`install.sh`)
- ✅ Windows 安装脚本 (`install.bat`)
- ✅ Manifest 文件生成
- ✅ 权限配置

### 第三阶段：Qwen CLI 集成（已完成 ✅）

#### 3.1 通信实现
- ✅ HTTP 请求封装
- ✅ MCP 服务器配置
- ✅ 动态端口管理
- ✅ 错误重试机制

#### 3.2 MCP 服务器支持
```javascript
// 支持的 MCP 服务器配置
const mcpServers = [
  'chrome-devtools-mcp',    // Chrome 开发工具
  'playwright-mcp',          // 浏览器自动化
  'custom-mcp'              // 自定义服务器
];
```

### 第四阶段：项目集成（已完成 ✅）

#### 4.1 Mono Repo 集成
- ✅ 移动到 packages 目录
- ✅ 配置 package.json
- ✅ 添加 TypeScript 配置
- ✅ 创建构建脚本
- ✅ 配置 .gitignore

#### 4.2 文档编写
- ✅ README 主文档
- ✅ 架构设计文档
- ✅ 实施计划文档（本文档）
- 🔄 技术细节文档
- 🔄 API 参考文档

## 技术栈选择

| 层次 | 技术选择 | 选择理由 |
|------|---------|----------|
| **Chrome Extension** | | |
| 开发语言 | JavaScript (ES6+) | 原生支持，无需构建 |
| UI 框架 | 原生 HTML/CSS | 轻量快速，无依赖 |
| 消息传递 | Chrome Extension API | 官方标准 |
| **Native Host** | | |
| 运行时 | Node.js | 跨平台，生态丰富 |
| 进程管理 | child_process | Node.js 内置 |
| **通信协议** | | |
| Extension ↔ Host | Native Messaging | Chrome 官方推荐 |
| Host ↔ Qwen | HTTP/REST | 简单可靠 |
| 数据格式 | JSON | 通用性好 |

## 实现细节

### Native Messaging 协议实现

```javascript
// 发送消息（4字节长度前缀 + JSON）
function sendMessage(message) {
  const buffer = Buffer.from(JSON.stringify(message));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(buffer.length, 0);

  process.stdout.write(length);
  process.stdout.write(buffer);
}

// 接收消息
function readMessages() {
  let messageLength = null;
  let chunks = [];

  process.stdin.on('readable', () => {
    // 读取长度前缀
    // 读取消息内容
    // 处理消息
  });
}
```

### 进程启动命令

```javascript
// 启动 Qwen CLI 的完整命令
const command = [
  // 添加 MCP 服务器
  'qwen mcp add --transport http chrome-devtools http://localhost:8080/mcp',
  '&&',
  // 启动 CLI 服务器
  'qwen server --port 8080'
].join(' ');

spawn(command, { shell: true });
```

## 测试计划

### 单元测试
- [ ] Message Handler 测试
- [ ] 数据提取功能测试
- [ ] 进程管理测试

### 集成测试
- [ ] Extension ↔ Native Host 通信
- [ ] Native Host ↔ Qwen CLI 通信
- [ ] 端到端数据流测试

### 用户测试
- [ ] 安装流程测试
- [ ] 功能完整性测试
- [ ] 错误恢复测试
- [ ] 性能测试

## 部署计划

### 开发环境部署
1. Clone 代码库
2. 加载未打包的扩展
3. 运行安装脚本
4. 测试功能

### 生产环境部署
1. 构建扩展包
2. 提交到 Chrome Web Store（可选）
3. 提供安装指南
4. 用户支持文档

## 时间线（已完成）

| 阶段 | 任务 | 预计时间 | 实际状态 |
|------|------|---------|----------|
| 第一阶段 | 基础架构 | 2小时 | ✅ 完成 |
| 第二阶段 | Native Host | 2小时 | ✅ 完成 |
| 第三阶段 | Qwen 集成 | 1小时 | ✅ 完成 |
| 第四阶段 | 项目集成 | 1小时 | ✅ 完成 |
| 第五阶段 | 测试优化 | 2小时 | 🔄 进行中 |

## 风险评估

| 风险项 | 可能性 | 影响 | 缓解措施 |
|--------|-------|------|----------|
| Native Host 安装失败 | 中 | 高 | 提供详细文档和脚本 |
| Qwen CLI 未安装 | 高 | 中 | 优雅降级，提示用户 |
| 权限不足 | 低 | 高 | 明确权限要求 |
| 性能问题 | 中 | 中 | 数据大小限制 |
| 兼容性问题 | 低 | 中 | 多平台测试 |

## 优化计划

### 短期优化（1-2周）
- 添加 TypeScript 类型定义
- 实现 WebSocket 通信
- 优化错误提示
- 添加更多 MCP 服务器

### 中期优化（1-2月）
- 开发选项页面
- 实现配置同步
- 添加快捷键支持
- 国际化支持

### 长期优化（3-6月）
- 支持 Firefox/Edge
- 云端配置同步
- 批量处理模式
- AI 模型选择

## 维护计划

### 日常维护
- Bug 修复
- 安全更新
- 依赖升级

### 版本发布
- 遵循语义化版本
- 维护 CHANGELOG
- 发布说明

### 用户支持
- GitHub Issues
- 文档更新
- FAQ 维护

## 成功指标

- ✅ 成功实现浏览器与 Qwen CLI 通信
- ✅ 支持主要数据提取功能
- ✅ 稳定的进程管理
- ✅ 良好的用户体验
- 🔄 完善的文档
- 🔄 社区反馈收集

## 总结

项目已成功完成核心功能开发，实现了：
1. Chrome 插件与本地 Qwen CLI 的桥接
2. 丰富的数据提取和监控功能
3. 安全可靠的 Native Messaging 通信
4. 灵活的 MCP 服务器集成
5. 跨平台支持

下一步将重点优化用户体验和完善文档。
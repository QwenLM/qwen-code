# Chrome MCP Bridge 安装指南

本文档详细说明了 Chrome MCP Bridge 的安装和注册流程。

## 安装流程概述

Chrome MCP Bridge 的安装和注册流程如下：

```
npm install -g mcp-chrome-bridge
└─ postinstall.js
   ├─ 复制可执行文件到 npm_prefix/bin   ← 总是可写（用户或root权限）
   ├─ 尝试用户级别注册                  ← 无需sudo，大多数情况下成功
   └─ 如果失败 ➜ 提示用户运行 mcp-chrome-bridge register --system
      └─ 需要手动使用管理员权限运行
```

上面的流程图展示了从全局安装开始，到最终完成注册的完整过程。

## 详细安装步骤

### 1. 全局安装

```bash
npm install -g mcp-chrome-bridge
```

安装完成后，系统会自动尝试在用户目录中注册 Native Messaging 主机。这不需要管理员权限，是推荐的安装方式。

### 2. 用户级别注册

用户级别注册会在以下位置创建清单文件：

```
清单文件位置
├─ 用户级别（无需管理员权限）
│  ├─ Windows: %APPDATA%\Google\Chrome\NativeMessagingHosts\
│  ├─ macOS:   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/
│  └─ Linux:   ~/.config/google-chrome/NativeMessagingHosts/
│
└─ 系统级别（需要管理员权限）
   ├─ Windows: %ProgramFiles%\Google\Chrome\NativeMessagingHosts\
   ├─ macOS:   /Library/Google/Chrome/NativeMessagingHosts/
   └─ Linux:   /etc/opt/chrome/native-messaging-hosts/
```

如果自动注册失败，或者您想手动注册，可以运行：

```bash
mcp-chrome-bridge register
```

**推荐：运行诊断工具检查问题：**

```bash
mcp-chrome-bridge doctor
```

### 3. 系统级别注册

如果用户级别注册失败（例如，由于权限问题），您可以尝试系统级别注册。系统级别注册需要管理员权限，但我们提供了两种便捷的方式来完成这一过程。

系统级别注册有两种方式：

#### 方式一：使用 `--system` 参数（推荐）

```bash
# macOS/Linux
sudo mcp-chrome-bridge register --system

# Windows (以管理员身份运行命令提示符)
mcp-chrome-bridge register --system
```

系统级安装需要管理员权限才能写入系统目录和注册表。

#### 方式二：直接使用管理员权限

**Windows**：
以管理员身份运行命令提示符或 PowerShell，然后执行：

```
mcp-chrome-bridge register
```

**macOS/Linux**：
使用 sudo 命令：

```
sudo mcp-chrome-bridge register
```

## 注册流程详解

### 注册流程图

```
注册流程
├─ 用户级别注册 (mcp-chrome-bridge register)
│  ├─ 获取用户级别清单路径
│  ├─ 创建用户目录
│  ├─ 生成清单内容
│  ├─ 写入清单文件
│  └─ Windows平台：创建用户级注册表项
│
└─ 系统级别注册 (mcp-chrome-bridge register --system)
   ├─ 检查是否有管理员权限
   │  ├─ 有权限 → 直接创建系统目录和写入清单
   │  └─ 无权限 → 提示用户使用管理员权限运行
   └─ Windows平台：创建系统级注册表项
```

### 清单文件结构

```
manifest.json
├─ name: "com.chromemcp.nativehost"
├─ description: "Node.js Host for Browser Bridge Extension"
├─ path: "/path/to/run_host.sh"       ← 启动脚本路径
├─ type: "stdio"                      ← 通信类型
└─ allowed_origins: [                 ← 允许连接的扩展
   "chrome-extension://扩展ID/"
]
```

### 用户级别注册流程

1. 确定用户级别清单文件路径
2. 创建必要的目录
3. 生成清单内容，包括：
   - 主机名称
   - 描述
   - Node.js 可执行文件路径
   - 通信类型（stdio）
   - 允许的扩展 ID
   - 启动参数
4. 写入清单文件
5. 在 Windows 上，还会创建相应的注册表项

### 系统级别注册流程

1. 检测是否已有管理员权限
2. 如果已有管理员权限：
   - 直接创建系统级目录
   - 写入清单文件
   - 设置适当的权限
   - 在 Windows 上创建系统级注册表项
3. 如果没有管理员权限：
   - 提示用户使用管理员权限重新运行命令
   - macOS/Linux: `sudo mcp-chrome-bridge register --system`
   - Windows: 以管理员身份运行命令提示符

## 验证安装

### 验证流程图

```
验证安装
├─ 检查清单文件
│  ├─ 文件存在 → 检查内容是否正确
│  └─ 文件不存在 → 重新安装
│
├─ 检查Chrome扩展
│  ├─ 扩展已安装 → 检查扩展权限
│  └─ 扩展未安装 → 安装扩展
│
└─ 测试连接
   ├─ 连接成功 → 安装完成
   └─ 连接失败 → 检查错误日志 → 参考故障排除
```

### 验证步骤

安装完成后，您可以通过以下方式验证安装是否成功：

1. 检查清单文件是否存在于相应目录
   - 用户级别：检查用户目录下的清单文件
   - 系统级别：检查系统目录下的清单文件
   - 确认清单文件内容是否正确

2. 在 Chrome 中安装对应的扩展
   - 确保扩展已正确安装
   - 确保扩展有 `nativeMessaging` 权限

3. 尝试通过扩展连接到本地服务
   - 使用扩展的测试功能尝试连接
   - 检查 Chrome 的扩展日志是否有错误信息

## 故障排除

### 故障排除流程图

```
故障排除
├─ 权限问题
│  ├─ 检查用户权限
│  │  ├─ 有足够权限 → 检查目录权限
│  │  └─ 无足够权限 → 尝试系统级别安装
│  │
│  ├─ 执行权限问题 (macOS/Linux)
│  │  ├─ "Permission denied" 错误
│  │  ├─ "Native host has exited" 错误
│  │  └─ 运行 mcp-chrome-bridge fix-permissions
│  │
│  └─ 尝试 mcp-chrome-bridge register --system
│
├─ 路径问题
│  ├─ 检查Node.js安装 (node -v)
│  └─ 检查全局NPM路径 (npm root -g)
│
├─ 注册表问题 (Windows)
│  ├─ 检查注册表访问权限
│  └─ 尝试手动创建注册表项
│
└─ 其他问题
   ├─ 检查控制台错误信息
   └─ 提交Issue到项目仓库
```

### 常见问题解决步骤

如果安装过程中遇到问题，请尝试以下步骤：

1. 确保 Node.js 已正确安装
   - 运行 `node -v` 和 `npm -v` 检查版本
   - 确保 Node.js 版本 >= 20.x

2. 检查是否有足够的权限创建文件和目录
   - 用户级别安装需要对用户目录有写入权限
   - 系统级别安装需要管理员/root权限

3. **修复执行权限问题**

   **macOS/Linux 平台**：

   **问题描述**：
   - npm 安装通常会保留文件权限，但 pnpm 可能不会
   - 可能遇到 "Permission denied" 或 "Native host has exited" 错误
   - Chrome 扩展无法启动 native host 进程

   **解决方案**：

   a) **使用内置修复命令（推荐）**：

   ```bash
   mcp-chrome-bridge fix-permissions
   ```

   b) **运行诊断工具自动修复**：

   ```bash
   mcp-chrome-bridge doctor --fix
   ```

   c) **手动设置权限**：

   ```bash
   # 查找安装路径
   npm list -g mcp-chrome-bridge
   # 或者对于 pnpm
   pnpm list -g mcp-chrome-bridge

   # 设置执行权限（替换为实际路径）
   chmod +x /path/to/node_modules/mcp-chrome-bridge/run_host.sh
   chmod +x /path/to/node_modules/mcp-chrome-bridge/index.js
   chmod +x /path/to/node_modules/mcp-chrome-bridge/cli.js
   ```

   **Windows 平台**：

   **问题描述**：
   - Windows 上 `.bat` 文件通常不需要执行权限，但可能遇到其他问题
   - 文件可能被标记为只读
   - 可能遇到 "Access denied" 或文件无法执行的错误

   **解决方案**：

   a) **使用内置修复命令（推荐）**：

   ```cmd
   mcp-chrome-bridge fix-permissions
   ```

   b) **运行诊断工具自动修复**：

   ```cmd
   mcp-chrome-bridge doctor --fix
   ```

   c) **手动检查文件属性**：

   ```cmd
   # 查找安装路径
   npm list -g mcp-chrome-bridge

   # 检查文件属性（在文件资源管理器中右键 -> 属性）
   # 确保 run_host.bat 不是只读文件
   ```

   d) **重新安装并强制权限**：

   ```bash
   # 卸载
   npm uninstall -g mcp-chrome-bridge
   # 或 pnpm uninstall -g mcp-chrome-bridge

   # 重新安装
   npm install -g mcp-chrome-bridge
   # 或 pnpm install -g mcp-chrome-bridge

   # 如果仍有问题，运行权限修复
   mcp-chrome-bridge fix-permissions
   ```

4. 在 Windows 上，确保注册表访问没有被限制
   - 检查是否可以访问 `HKCU\Software\Google\Chrome\NativeMessagingHosts\`
   - 对于系统级别，检查 `HKLM\Software\Google\Chrome\NativeMessagingHosts\`

5. 尝试使用系统级别安装
   - 使用 `mcp-chrome-bridge register --system` 命令
   - 或直接使用管理员权限运行

6. 检查控制台输出的错误信息
   - 详细的错误信息通常会指出问题所在
   - 可以添加 `--verbose` 参数获取更多日志信息

如果问题仍然存在，请提交 issue 到项目仓库，并附上以下信息：

- 操作系统版本
- Node.js 版本
- 安装命令
- 错误信息
- 尝试过的解决方法

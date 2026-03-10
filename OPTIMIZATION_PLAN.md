# Qwen Code 0.12.0 MCP & Extension Management 优化方案

## 问题梳理与解决方案

根据钉钉文档《0.12.0 体验反馈》中提出的问题，本文件详细分析了每个问题的根本原因，并提供具体的解决方案和代码修改建议。

---

## 文档问题概览

本文档共包含 **6 个问题** (3 个 P1 + 3 个 P2),分为两个主要部分:

### Part 1: MCP Management TUI (5 个问题)

- **P1 级别**: 3 个问题
- **P2 级别**: 2 个细节问题 (共 10 个小点)

### Part 2: Extension Management TUI (1 个问题)

- **P2 级别**: 1 个命令报错问题

## 问题 1: 【P1】Auth 属于 manage 的一部分，应该加到 manage 里

### 问题描述

- **现状**: 当前 MCP Management Dialog 中**没有 OAuth 认证功能**,用户必须使用 `/mcp auth <server-name>` 命令进行认证
- **问题**:
  - Auth 功能独立于 Manage Dialog 之外，用户体验割裂
  - 需要记住命令行才能认证，不够直观
  - MCP 管理对话框中只能查看服务器状态和工具，无法进行认证操作
- **文档建议**: Auth 应该整合到 manage dialog 中，在 UI 界面内完成所有 MCP 管理操作

### 根本原因分析

#### 当前实现

```typescript
// packages/cli/src/ui/commands/mcpCommand.ts
const mcpCommand: SlashCommand = {
  name: 'mcp',
  subCommands: [manageCommand, authCommand], // auth 作为独立子命令存在
  action: async (): Promise<OpenDialogActionReturn> => ({
    type: 'dialog',
    dialog: 'mcp', // 默认打开管理对话框
  }),
};
```

#### MCP Management Dialog 现状

```typescript
// packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx
// 当前的步骤类型
export const MCP_MANAGEMENT_STEPS = {
  SERVER_LIST: 'server-list',
  SERVER_DETAIL: 'server-detail',
  DISABLE_SCOPE_SELECT: 'disable-scope-select',
  TOOL_LIST: 'tool-list',
  TOOL_DETAIL: 'tool-detail',
} as const;

// ServerDetailStep 中的操作选项
const actions = [
  { label: 'View tools', value: 'view-tools' },
  { label: 'Reconnect', value: 'reconnect' },
  { label: 'Enable/Disable', value: 'toggle-disable' },
  // ❌ 缺少 'Authenticate' 选项
];
```

#### 问题分析

1. **UI 层面**: MCP Management Dialog 中没有认证相关的 UI 组件和操作入口
2. **代码层面**: OAuth 认证逻辑只在命令行 handler 中实现 (`mcpCommand.ts` 的 `authCommand`)
3. **体验层面**: 用户需要在 TUI 和 CLI 之间切换，无法在一个界面内完成所有操作

### 解决方案

#### 方案 A: 在 MCP Dialog 中集成完整的 OAuth 认证功能 (强烈推荐)

**核心思路**:

- 在 Server Detail 页面添加 "Authenticate" 操作选项
- 复用现有的 `MCPOAuthProvider` 和 OAuth 流程
- 通过事件系统显示认证过程中的提示信息

**实现步骤**:

##### 1. 扩展 MCP_MANAGEMENT_STEPS

```typescript
// packages/cli/src/ui/components/mcp/types.ts
export const MCP_MANAGEMENT_STEPS = {
  SERVER_LIST: 'server-list',
  SERVER_DETAIL: 'server-detail',
  DISABLE_SCOPE_SELECT: 'disable-scope-select',
  TOOL_LIST: 'tool-list',
  TOOL_DETAIL: 'tool-detail',
  AUTHENTICATE: 'authenticate', // 新增：认证步骤
} as const;
```

##### 2. 在 ServerDetailStep 中添加认证选项

```typescript
// packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx
type ServerAction =
  | 'view-tools'
  | 'reconnect'
  | 'toggle-disable'
  | 'authenticate'; // 新增

const actions = useMemo(() => {
  const result: Array<{ label: string; value: ServerAction }> = [];

  result.push({ label: t('View Tools'), value: 'view-tools' });

  if (!server.isDisabled && server.status === MCPServerStatus.DISCONNECTED) {
    result.push({ label: t('Reconnect'), value: 'reconnect' });
  }

  // 新增：显示认证选项的场景
  const needsAuth =
    server.config.oauth?.enabled ||
    server.status === MCPServerStatus.DISCONNECTED ||
    server.errorMessage?.includes('401') ||
    server.errorMessage?.includes('OAuth');

  if (needsAuth) {
    result.push({
      label: t('Authenticate'),
      value: 'authenticate',
      icon: '🔐', // 可选：添加图标增强视觉提示
    });
  }

  result.push({
    label: server.isDisabled ? t('Enable') : t('Disable'),
    value: 'toggle-disable',
  });

  return result;
}, [server]);
```

##### 3. 在 MCPManagementDialog 中实现认证逻辑

```typescript
// packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx
import { MCPOAuthProvider, MCPOAuthConfig } from '@qwen-code/qwen-code-core';
import { appEvents, AppEvent } from '../../utils/events.js';

// 新增：处理认证
const handleAuthenticate = useCallback(async () => {
  if (!config || !selectedServer) return;

  try {
    setIsLoading(true);

    // 显示开始认证提示
    context.ui.addItem(
      {
        type: 'info',
        text: t("Starting OAuth authentication for '{{name}}'...", {
          name: selectedServer.name,
        }),
      },
      Date.now()
    );

    // 监听并显示认证过程中的消息
    const displayListener = (message: string) => {
      context.ui.addItem({ type: 'info', text: message }, Date.now());
    };
    appEvents.on(AppEvent.OauthDisplayMessage, displayListener);

    // 准备 OAuth 配置
    let oauthConfig: MCPOAuthConfig = selectedServer.config.oauth || { enabled: false };

    // 执行认证
    const authProvider = new MCPOAuthProvider(new MCPOAuthTokenStorage());
    await authProvider.authenticate(
      selectedServer.name,
      oauthConfig,
      selectedServer.config.httpUrl || selectedServer.config.url
    );

    // 认证成功
    context.ui.addItem(
      {
        type: 'success',
        text: t("✓ Authentication successful for '{{name}}'", {
          name: selectedServer.name,
        }),
      },
      Date.now()
    );

    // 移除消息监听器
    appEvents.off(AppEvent.OauthDisplayMessage, displayListener);

    // 重新加载服务器数据以更新状态
    await reloadServers();

    // 返回上一级
    handleNavigateBack();
  } catch (error) {
    debugLogger.error(
      `Authentication failed for '${selectedServer.name}':`,
      error
    );
    context.ui.addItem(
      {
        type: 'error',
        text: t("✗ Authentication failed: {{error}}", {
          error: getErrorMessage(error),
        }),
      },
      Date.now()
    );
  } finally {
    setIsLoading(false);
  }
}, [config, selectedServer, reloadServers, handleNavigateBack, context]);

// 在 renderStepContent 中添加认证步骤的处理
case MCP_MANAGEMENT_STEPS.AUTHENTICATE:
  // 可以直接执行认证，或者显示一个确认对话框
  void handleAuthenticate();
  return <Text>{t('Authenticating...')}</Text>;
```

##### 4. 更新 i18n 翻译文件

```javascript
// packages/cli/src/i18n/locales/en.js
{
  'Authenticate': 'Authenticate',
  'Authenticate with OAuth': 'Authenticate with OAuth',
  "Starting OAuth authentication for '{{name}}'...": "Starting OAuth authentication for '{{name}}'...",
  "✓ Authentication successful for '{{name}}'": "✓ Authentication successful for '{{name}}'",
  "✗ Authentication failed: {{error}}": "✗ Authentication failed: {{error}}",
}
```

**优点**:

- ✅ 用户体验统一，所有 MCP 管理操作在一个界面完成
- ✅ 复用现有 OAuth 认证逻辑，开发成本低
- ✅ 直观的视觉反馈，认证过程透明
- ✅ 符合现代 UI/UX 设计原则

**缺点**:

- ⚠️ 需要处理浏览器跳转和回调 (已有完善实现，风险低)

#### 方案 B: 保留命令行但改进引导提示

如果某些场景下确实需要命令行认证 (如自动化脚本),可以:

- 保留 `/mcp auth` 命令
- 在 Dialog 中提供快速复制的命令模板
- 添加"Copy Auth Command"按钮

但这会增加复杂性，不如方案 A 简洁。

---

## 问题 2: 【P1】一些异常状态

### 2.1 禁用之后还可以点击"查看工具",点进去是空的

#### 问题描述

- **现象**: MCP Server 被禁用后，仍然可以在 UI 中看到"查看工具"选项，点击进入后显示空列表
- **期望**: 禁用后的服务器不应该显示"查看工具"选项，或者应该给出明确的提示信息

#### 根本原因分析

当前代码逻辑:

```typescript
// packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx
const actions = useMemo(() => {
  const result: Array<{ label: string; value: ServerAction }> = [];

  // 无论服务器是否禁用，都添加"查看工具"选项
  result.push({ label: t('View Tools'), value: 'view-tools' });

  if (server.status === 'disconnected') {
    result.push({ label: t('Reconnect'), value: 'reconnect' });
  }

  result.push({
    label: server.isDisabled ? t('Enable') : t('Disable'),
    value: 'toggle-disable',
  });

  return result;
}, [server]);
```

问题在于:

1. 没有根据 `server.isDisabled` 状态过滤操作选项
2. 禁用服务器的工具列表获取逻辑可能存在问题
3. 缺少用户友好的提示信息

#### 解决方案

**方案 A: 禁用时隐藏"查看工具"选项 (推荐)**

**代码修改**:

```typescript
// packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx
const actions = useMemo(() => {
  const result: Array<{ label: string; value: ServerAction }> = [];

  // 只在服务器启用且已连接时显示"查看工具"选项
  if (!server.isDisabled && server.status === MCPServerStatus.CONNECTED) {
    result.push({
      label: t('View Tools'),
      value: 'view-tools',
      disabled: server.toolCount === 0, // 可选：工具数量为 0 时禁用
    });
  }

  // 禁用状态下显示提示信息
  if (server.isDisabled) {
    result.push({
      label: t('Enable to view tools'),
      value: 'toggle-disable',
    });
  } else {
    if (server.status === MCPServerStatus.DISCONNECTED) {
      result.push({ label: t('Reconnect'), value: 'reconnect' });
    }

    result.push({
      label: t('Disable'),
      value: 'toggle-disable',
    });
  }

  return result;
}, [server]);
```

**同时修改 ToolListStep**:

```typescript
// packages/cli/src/ui/components/mcp/steps/ToolListStep.tsx
export const ToolListStep: React.FC<ToolListStepProps> = ({
  tools,
  serverName,
  onSelect,
  onBack,
}) => {
  // 添加禁用状态检查
  if (tools.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No tools available for this server.')}
        </Text>
        {/* 添加提示：服务器可能被禁用 */}
        <Text color={theme.text.warning}>
          {t('Note: This server may be disabled. Please enable it in the server settings.')}
        </Text>
      </Box>
    );
  }
  // ... 其余代码保持不变
};
```

**方案 B: 显示友好提示并阻止导航**

在 `MCPManagementDialog` 中添加拦截逻辑:

```typescript
// packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx
const handleViewTools = useCallback(() => {
  if (!selectedServer) return;

  // 检查服务器是否禁用
  if (selectedServer.isDisabled) {
    // 显示提示信息，不执行导航
    debugLogger.warn(
      `Cannot view tools for disabled server '${selectedServer.name}'`,
    );
    // 可选：在 UI 上显示临时消息
    return;
  }

  // 检查是否有工具
  if (selectedServer.toolCount === 0) {
    debugLogger.info(`No tools available for server '${selectedServer.name}'`);
    // 仍然可以进入查看，但会显示空状态提示
  }

  handleNavigateToStep(MCP_MANAGEMENT_STEPS.TOOL_LIST);
}, [selectedServer, handleNavigateToStep]);
```

#### 推荐方案：方案 A + ToolListStep 的提示增强

---

### 2.2 禁用之后还能重新连接

#### 问题描述

- **现象**: MCP Server 被禁用后，仍然可以看到"重新连接"选项
- **期望**: 禁用之后应该没有"重新连接"入口
- **文档建议**: 禁用之后应该没有"重新连接"入口

#### 根本原因分析

当前代码逻辑:

```typescript
// packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx
if (server.status === 'disconnected') {
  result.push({ label: t('Reconnect'), value: 'reconnect' });
}
```

问题在于:

1. 只检查了连接状态，没有检查禁用状态
2. 禁用的服务器不应该允许重新连接操作
3. 逻辑上矛盾：既然禁用了就不应该尝试连接

#### 解决方案

**代码修改**:

```typescript
// packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx
const actions = useMemo(() => {
  const result: Array<{ label: string; value: ServerAction }> = [];

  // View Tools 选项
  if (!server.isDisabled && server.toolCount > 0) {
    result.push({ label: t('View Tools'), value: 'view-tools' });
  }

  // Reconnect 选项：只在未禁用且断开连接时显示
  if (!server.isDisabled && server.status === MCPServerStatus.DISCONNECTED) {
    result.push({ label: t('Reconnect'), value: 'reconnect' });
  }

  // Enable/Disable 选项
  result.push({
    label: server.isDisabled ? t('Enable Server') : t('Disable Server'),
    value: 'toggle-disable',
  });

  return result;
}, [server]);
```

**同时在 ServerListStep 中添加视觉提示**:

```typescript
// packages/cli/src/ui/components/mcp/steps/ServerListStep.tsx
{server.isDisabled && (
  <Text color={theme.status.warning}>
    {' '}
    {t('(disabled - no connection possible)')}
  </Text>
)}
```

---

### 问题 3: 【P1】禁用有个选择设置的 dialog，有点费解

#### 问题描述

- **现象**: 禁用服务器时会弹出一个对话框让用户选择禁用范围 (user/workspace)
- **问题**: 这个选择让用户体验困惑，特别是当 MCP server 在项目级配置时，在用户级别禁用就有点费解
- **文档建议**: MCP server 在哪里，就在哪里禁用（如果 MCP server 在项目级，在用户级别禁用就有点费解）

#### 根本原因分析

当前实现逻辑:

```typescript
// packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx
const handleSelectDisableScope = useCallback(
  async (scope: 'user' | 'workspace') => {
    // 允许用户在 user 或 workspace 层面禁用服务器
    // 即使服务器配置在 workspace 层面，也允许在 user 层面禁用
  },
  [config, selectedServer, handleNavigateBack, reloadServers],
);
```

问题在于:

1. 用户可以跨 scope 禁用服务器，造成配置混乱
2. 不符合"在哪里配置就在哪里管理"的直觉
3. 增加了不必要的复杂性

#### 解决方案

**方案 A: 根据服务器来源自动确定禁用 scope (强烈推荐)**

**核心思路**:

- User 级别的配置 → 只能在 User 级别禁用
- Workspace 级别的配置 → 只能在 Workspace 级别禁用
- Extension 级别的配置 → 不允许禁用 (只能卸载扩展)

**代码修改**:

```typescript
// packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx

// 修改 handleDisable 函数
const handleDisable = useCallback(() => {
  if (!selectedServer) return;

  // 如果服务器已经被禁用，直接启用
  if (selectedServer.isDisabled) {
    void handleEnableServer();
    return;
  }

  // Extension 提供的服务器不允许禁用
  if (selectedServer.source === 'extension') {
    debugLogger.warn(
      `Cannot disable extension-provided server '${selectedServer.name}'`,
    );
    // 显示提示信息
    return;
  }

  // 根据服务器 scope 直接禁用，不再询问
  const scope =
    selectedServer.scope === 'extension'
      ? SettingScope.User
      : selectedServer.scope === 'workspace'
        ? SettingScope.Workspace
        : SettingScope.User;

  // 直接执行禁用操作
  void executeDisable(scope);
}, [selectedServer, handleEnableServer]);

// 新增执行禁用函数
const executeDisable = useCallback(
  async (scope: SettingScope) => {
    if (!config || !selectedServer) return;

    try {
      setIsLoading(true);

      const settings = loadSettings();
      const scopeSettings = settings.forScope(scope).settings;
      const currentExcluded = scopeSettings.mcp?.excluded || [];

      if (!currentExcluded.includes(selectedServer.name)) {
        const newExcluded = [...currentExcluded, selectedServer.name];
        settings.setValue(scope, 'mcp.excluded', newExcluded);
      }

      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        await toolRegistry.disableMcpServer(selectedServer.name);
      }

      await reloadServers();
      handleNavigateBack();
    } catch (error) {
      debugLogger.error(
        `Error disabling server '${selectedServer.name}':`,
        error,
      );
    } finally {
      setIsLoading(false);
    }
  },
  [config, selectedServer, reloadServers, handleNavigateBack],
);

// 移除 DisableScopeSelectStep 相关的代码和导航逻辑
```

**同时修改 UI 提示**:

```typescript
// packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx
<Box>
  <Box width={LABEL_WIDTH}>
    <Text color={theme.text.primary}>{t('Scope:')}</Text>
  </Box>
  <Box>
    <Text>
      {t(server.scope)}
      {server.source === 'extension' && (
        <Text color={theme.text.secondary}>
          {' '}({t('provided by {{name}}', { name: server.config.extensionName })})
        </Text>
      )}
    </Text>
  </Box>
</Box>

// 禁用按钮文本根据 scope 调整
{server.isDisabled ? (
  <Text>{t('Enable (will remove from exclusion list)')}</Text>
) : server.source === 'extension' ? (
  <Text color={theme.text.secondary}>{t('Cannot disable extension server')}</Text>
) : (
  <Text>{t('Disable (in {{scope}})', { scope: server.scope })}</Text>
)}
```

**方案 B: 保留选择但改进 UX**

如果确实需要支持跨 scope 禁用 (考虑到某些特殊场景),至少应该:

1. 明确显示当前服务器的配置位置
2. 说明不同选择的影响
3. 给出推荐选项

但这会增加复杂性，不如方案 A 简洁明了。

#### 推荐方案：方案 A

---

## 实施计划

---

## 问题 6: 【P2】Extension Management - /extension manage 报错

### 问题描述

- **现象**: 使用 `/extension manage` 命令时直接报错
- **期望**: 应该能正常打开 Extension Management Dialog

### 根本原因分析

#### 可能的原因

1. **命令拼写错误** (最可能)
   - 正确的命令是 `/extensions manage` (复数形式)
   - 用户可能输入了 `/extension manage` (单数形式)
2. **ExtensionManager 未正确初始化**

   ```typescript
   // packages/cli/src/ui/commands/extensionsCommand.ts#L103-108
   async function listAction(_context: CommandContext, _args: string) {
     const extensionManager = context.services.config?.getExtensionManager();
     if (!(extensionManager instanceof ExtensionManager)) {
       debugLogger.error(
         `Cannot ${context.invocation?.name} extensions in this environment`,
       );
       return; // ❌ 这里直接返回，没有给用户任何提示
     }
     // ...
   }
   ```

3. **环境限制**
   - 某些环境下无法加载 ExtensionManager
   - 沙箱模式可能限制扩展管理功能

#### 当前错误处理问题

- 如果 `getExtensionManager()` 返回 null 或不是 ExtensionManager 实例
- 代码只是记录 debug 日志并静默返回
- **用户看不到任何错误提示**,只会感到困惑

### 解决方案

#### 方案 A: 改进错误提示 (强烈推荐)

**代码修改**:

```typescript
// packages/cli/src/ui/commands/extensionsCommand.ts
async function listAction(context: CommandContext, _args: string) {
  const extensionManager = context.services.config?.getExtensionManager();

  if (!(extensionManager instanceof ExtensionManager)) {
    debugLogger.error(
      `Cannot ${context.invocation?.name} extensions in this environment`,
    );

    // ✅ 添加用户友好的错误提示
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t(
          'Extension management is not available in the current environment. ' +
            'This feature may not be supported in your current mode or configuration.',
        ),
      },
      Date.now(),
    );
    return;
  }

  return {
    type: 'dialog' as const,
    dialog: 'extensions_manage' as const,
  };
}
```

#### 方案 B: 检查命令拼写并给出提示

在命令解析层面添加提示:

```typescript
// packages/cli/src/ui/commands/registry.ts 或相关位置
// 当检测到用户输入 '/extension'(单数) 时，给出提示
if (commandName === 'extension') {
  context.ui.addItem(
    {
      type: MessageType.INFO,
      text: t('Did you mean "/extensions"? (plural form)'),
    },
    Date.now(),
  );
}
```

#### 方案 C: 同时支持单复数形式

为了用户体验，可以同时支持两种形式:

```typescript
// packages/cli/src/ui/commands/extensionsCommand.ts
export const extensionsCommand: SlashCommand = {
  name: 'extensions', // 主要命令 (复数)
  aliases: ['extension'], // ✅ 添加别名 (单数)
  get description() {
    return t('Manage extensions');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    manageExtensionsCommand,
    installCommand,
    exploreExtensionsCommand,
  ],
  action: async (context, args) =>
    manageExtensionsCommand.action!(context, args),
};
```

**注意**: 需要检查 SlashCommand 类型定义是否支持 `aliases` 属性

### 推荐方案

**采用方案 A + 方案 C**:

1. 改进错误提示，让用户知道发生了什么
2. 如果可能，同时支持单复数形式

---

## 实施计划

### Phase 1: 修复异常状态问题 (优先级：高)

1. **修复问题 2.1**: 禁用后可查看工具
   - 修改 `ServerDetailStep.tsx` 的操作列表逻辑
   - 修改 `ToolListStep.tsx` 添加友好提示
   - 预计工时：2 小时

2. **修复问题 2.2**: 禁用后可重新连接
   - 修改 `ServerDetailStep.tsx` 的 reconnect 选项条件
   - 预计工时：1 小时

### Phase 2: 在 Dialog 中集成 Auth 功能 (优先级：高)

3. **修复问题 1**: MCP Dialog 集成 OAuth 认证
   - 扩展 `MCP_MANAGEMENT_STEPS` 添加认证步骤
   - 在 `ServerDetailStep` 中添加"Authenticate"选项
   - 在 `MCPManagementDialog` 中实现认证逻辑
   - 更新 i18n 翻译文件
   - 预计工时：4 小时

### Phase 3: 改进禁用体验 (优先级：中)

4. **修复问题 3**: 简化禁用流程
   - 移除 `DisableScopeSelectStep`
   - 实现自动 scope 判断逻辑
   - 更新 UI 提示
   - 预计工时：4 小时

### Phase 4: UI 细节优化 (优先级：中)

5. **修复问题 4**: Dialog 1 细节优化
   - 移除重复的来源显示
   - 优化错误信息显示逻辑 (只在有错误时显示)
   - 移除多余的空格
   - 优化布局紧凑度
   - 预计工时：3 小时

6. **修复问题 5**: Dialog 2 细节优化
   - 统一来源颜色与其他部分一致
   - 添加功能说明 tooltip
   - 统一选中色为 theme.text.accent
   - 优化工具标注文案 (如"destructive, open-world")
   - 移除不必要的序号
   - 预计工时：3 小时

### Phase 5: Extension Management 修复 (优先级：低)

7. **修复问题 6**: Extension 命令报错
   - 改进错误提示 (方案 A)
   - 考虑支持单复数形式 (方案 C)
   - 预计工时：2 小时

### Phase 6: 测试与验证 (优先级：高)

8. **回归测试**
   - 更新所有相关测试用例
   - 手动测试各个场景
   - 确保没有破坏性变更
   - 预计工时：4 小时

**总预计工时**: 约 23 小时 (约 3 个工作日)

---

## 影响评估

### 兼容性影响

- **Breaking Changes**: 无
- **Deprecation**: 无
- **新功能**: MCP Dialog 集成 OAuth 认证功能

### 需要更新的文档

1. `docs/developers/tools/mcp-server.md` - 更新 MCP 管理对话框使用说明
2. `docs/users/features/mcp-servers.md` - 更新用户指南
3. `docs/users/features/extensions.md` - 更新扩展管理说明
4. 内联帮助文本和 i18n 文件

### 需要更新的测试

1. `packages/cli/src/ui/commands/mcpCommand.test.ts`
2. `packages/cli/src/ui/components/mcp/MCPManagementDialog.test.tsx`
3. `packages/cli/src/ui/components/mcp/steps/ServerDetailStep.test.tsx`
4. `packages/cli/src/ui/commands/extensionsCommand.test.ts`
5. `packages/cli/src/ui/components/extensions/ExtensionsManagerDialog.test.tsx`

---

## 验收标准

### 问题 1 验收标准

- [ ] MCP Management Dialog 中显示"Authenticate"选项 (针对需要认证的服务器)
- [ ] 点击认证后能正确启动 OAuth 流程
- [ ] 认证过程中显示友好的提示信息
- [ ] 认证成功后自动刷新服务器状态
- [ ] 认证失败时显示明确的错误信息
- [ ] 保留 `/mcp auth` 命令作为备选方案 (可选)

### 问题 2.1 验收标准

- [ ] 禁用的服务器不显示"查看工具"选项，或显示友好提示
- [ ] 工具列表为空时，明确提示原因
- [ ] 用户不会看到空的工具列表页面

### 问题 2.2 验收标准

- [ ] 禁用的服务器不显示"重新连接"选项
- [ ] UI 逻辑自洽，不会出现矛盾的操作选项
- [ ] 禁用状态下只能看到"启用"选项

### 问题 3 验收标准

- [ ] 禁用操作一键完成，无需选择 scope
- [ ] 禁用范围自动匹配配置范围
- [ ] UI 明确显示服务器的配置位置
- [ ] 用户体验流畅，无困惑点

### 问题 4 验收标准 (Dialog 1 细节优化)

- [ ] 移除重复的来源显示
- [ ] 只在有错误时显示"运行 qwen --debug..."提示
- [ ] 没有错误时不显示多余的空格
- [ ] 布局更加紧凑，接近 claude code 的视觉效果

### 问题 5 验收标准 (Dialog 2 细节优化)

- [ ] 来源颜色与其他部分统一
- [ ] 添加清晰的功能说明
- [ ] 统一选中色为 theme.text.accent
- [ ] 工具标注文案更易懂 (如改为"Destructive, Open-world")
- [ ] 移除列表项前的序号 (1、2、3...)

### 问题 6 验收标准 (Extension Management)

- [ ] `/extensions manage` 命令能正常工作
- [ ] 如果 ExtensionManager 不可用，显示明确的错误提示
- [ ] 考虑支持 `/extension`(单数) 作为别名 (可选)
- [ ] 测试不同环境下的行为 (普通模式、沙箱模式等)

---

## 技术细节补充

### 关键文件清单

```
# MCP Management
packages/cli/src/ui/commands/mcpCommand.ts
packages/cli/src/ui/components/mcp/MCPManagementDialog.tsx
packages/cli/src/ui/components/mcp/steps/ServerDetailStep.tsx
packages/cli/src/ui/components/mcp/steps/ServerListStep.tsx
packages/cli/src/ui/components/mcp/steps/ToolListStep.tsx
packages/cli/src/ui/components/mcp/types.ts
packages/core/src/tools/mcp-client-manager.ts
packages/core/src/config/config.ts

# Extension Management
packages/cli/src/ui/commands/extensionsCommand.ts
packages/cli/src/ui/components/extensions/ExtensionsManagerDialog.tsx
packages/cli/src/ui/components/extensions/types.ts
packages/core/src/extension/extensionManager.ts
```

### 依赖关系

- MCP Management Dialog 依赖于 Config、ToolRegistry、PromptRegistry
- 禁用逻辑涉及 Settings 的多 scope 管理
- 状态跟踪通过 `getMCPServerStatus` 和状态监听器实现

### 潜在风险点

1. **OAuth 认证流程**: 确保在 Dialog 中集成的认证功能不影响现有命令行认证
2. **多 Scope 配置**: 确保自动 scope 判断不会误删其他 scope 的配置
3. **Extension 集成**: 确保扩展提供的服务器正确处理
4. **环境兼容性**: 确保 Extension Management 在不同环境下都能给出正确的错误提示

---

## 总结

本文档针对 0.12.0 版本体验反馈中提出的 **6 个问题** (3 个 P1 + 3 个 P2) 进行了详细分析，并提供了具体的解决方案。所有修改都遵循以下原则:

1. **用户体验优先**: 简化操作流程，减少困惑
2. **逻辑一致性**: 确保 UI 状态和行为逻辑自洽
3. **向后兼容**: 避免破坏性变更
4. **代码质量**: 简化代码结构，提高可维护性
5. **错误友好**: 提供清晰、有帮助的错误信息

建议按优先级分阶段实施，确保每个问题都得到妥善解决。

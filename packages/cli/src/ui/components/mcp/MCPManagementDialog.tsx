/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { t } from '../../../i18n/index.js';
import type {
  MCPManagementDialogProps,
  MCPServerDisplayInfo,
  MCPToolDisplayInfo,
} from './types.js';
import { MCP_MANAGEMENT_STEPS } from './types.js';
import { ServerListStep } from './steps/ServerListStep.js';
import { ServerDetailStep } from './steps/ServerDetailStep.js';
import { ToolListStep } from './steps/ToolListStep.js';
import { ToolDetailStep } from './steps/ToolDetailStep.js';
import { DisableScopeSelectStep } from './steps/DisableScopeSelectStep.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import {
  getMCPServerStatus,
  DiscoveredMCPTool,
  type MCPServerConfig,
  type AnyDeclarativeTool,
  type DiscoveredMCPPrompt,
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../../config/settings.js';

const debugLogger = createDebugLogger('MCP_DIALOG');

export const MCPManagementDialog: React.FC<MCPManagementDialogProps> = ({
  onClose,
}) => {
  const config = useConfig();

  const [servers, setServers] = useState<MCPServerDisplayInfo[]>([]);
  const [selectedServerIndex, setSelectedServerIndex] = useState<number>(-1);
  const [selectedTool, setSelectedTool] = useState<MCPToolDisplayInfo | null>(
    null,
  );
  const [navigationStack, setNavigationStack] = useState<string[]>([
    MCP_MANAGEMENT_STEPS.SERVER_LIST,
  ]);
  const [isLoading, setIsLoading] = useState(true);

  // Load MCP server data - extracted to a separate function for reuse
  const fetchServerData = useCallback(async (): Promise<
    MCPServerDisplayInfo[]
  > => {
    if (!config) return [];

    const mcpServers = config.getMcpServers() || {};
    const toolRegistry = config.getToolRegistry();
    const promptRegistry = config.getPromptRegistry();

    // Get settings to determine the scope of each server
    const settings = loadSettings();
    const userSettings = settings.forScope(SettingScope.User).settings;
    const workspaceSettings = settings.forScope(
      SettingScope.Workspace,
    ).settings;

    const serverInfos: MCPServerDisplayInfo[] = [];

    for (const [name, serverConfig] of Object.entries(mcpServers) as Array<
      [string, MCPServerConfig]
    >) {
      const status = getMCPServerStatus(name);

      // Get tools for this server
      const allTools: AnyDeclarativeTool[] = toolRegistry?.getAllTools() || [];
      const serverTools = allTools.filter(
        (t): t is DiscoveredMCPTool =>
          t instanceof DiscoveredMCPTool && t.serverName === name,
      );

      // Get prompts for this server
      const allPrompts: DiscoveredMCPPrompt[] =
        promptRegistry?.getAllPrompts() || [];
      const serverPrompts = allPrompts.filter(
        (p) => 'serverName' in p && p.serverName === name,
      );

      // Determine source type
      let source: 'user' | 'project' | 'extension' = 'user';
      if (serverConfig.extensionName) {
        source = 'extension';
      }

      // Determine the scope of the configuration
      let scope: 'user' | 'workspace' | 'extension' = 'user';
      if (serverConfig.extensionName) {
        scope = 'extension';
      } else if (workspaceSettings.mcpServers?.[name]) {
        scope = 'workspace';
      } else if (userSettings.mcpServers?.[name]) {
        scope = 'user';
      }

      // Use config.isMcpServerDisabled() to check if server is disabled
      const isDisabled = config.isMcpServerDisabled(name);

      serverInfos.push({
        name,
        status,
        source,
        scope,
        config: serverConfig,
        toolCount: serverTools.length,
        promptCount: serverPrompts.length,
        isDisabled,
      });
    }

    return serverInfos;
  }, [config]);

  // Load MCP server data on initial render
  useEffect(() => {
    const loadServers = async () => {
      setIsLoading(true);
      try {
        const serverInfos = await fetchServerData();
        setServers(serverInfos);
      } catch (error) {
        debugLogger.error('Error loading MCP servers:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadServers();
  }, [fetchServerData]);

  // Selected server
  const selectedServer = useMemo(() => {
    if (selectedServerIndex >= 0 && selectedServerIndex < servers.length) {
      return servers[selectedServerIndex];
    }
    return null;
  }, [servers, selectedServerIndex]);

  // Current step
  const getCurrentStep = useCallback(
    () =>
      navigationStack[navigationStack.length - 1] ||
      MCP_MANAGEMENT_STEPS.SERVER_LIST,
    [navigationStack],
  );

  // Navigation handlers
  const handleNavigateToStep = useCallback((step: string) => {
    setNavigationStack((prev) => [...prev, step]);
  }, []);

  const handleNavigateBack = useCallback(() => {
    setNavigationStack((prev) => {
      if (prev.length <= 1) return prev;
      return prev.slice(0, -1);
    });
  }, []);

  // Select server
  const handleSelectServer = useCallback(
    (index: number) => {
      setSelectedServerIndex(index);
      handleNavigateToStep(MCP_MANAGEMENT_STEPS.SERVER_DETAIL);
    },
    [handleNavigateToStep],
  );

  // Get server tool list
  const getServerTools = useCallback((): MCPToolDisplayInfo[] => {
    if (!config || !selectedServer) return [];

    const toolRegistry = config.getToolRegistry();
    if (!toolRegistry) return [];

    const allTools: AnyDeclarativeTool[] = toolRegistry.getAllTools();
    const mcpTools: DiscoveredMCPTool[] = [];
    for (const tool of allTools) {
      if (
        tool instanceof DiscoveredMCPTool &&
        tool.serverName === selectedServer.name
      ) {
        mcpTools.push(tool);
      }
    }
    return mcpTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      serverName: tool.serverName,
      schema: tool.parameterSchema as object | undefined,
      annotations: tool.annotations,
    }));
  }, [config, selectedServer]);

  // View tool list
  const handleViewTools = useCallback(() => {
    handleNavigateToStep(MCP_MANAGEMENT_STEPS.TOOL_LIST);
  }, [handleNavigateToStep]);

  // Select tool
  const handleSelectTool = useCallback(
    (tool: MCPToolDisplayInfo) => {
      setSelectedTool(tool);
      handleNavigateToStep(MCP_MANAGEMENT_STEPS.TOOL_DETAIL);
    },
    [handleNavigateToStep],
  );

  // Reload server data - uses the extracted fetchServerData function
  const reloadServers = useCallback(async () => {
    setIsLoading(true);
    try {
      const serverInfos = await fetchServerData();
      setServers(serverInfos);
    } catch (error) {
      debugLogger.error('Error reloading MCP servers:', error);
    } finally {
      setIsLoading(false);
    }
  }, [fetchServerData]);

  // Reconnect server
  const handleReconnect = useCallback(async () => {
    if (!config || !selectedServer) return;

    try {
      setIsLoading(true);
      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        await toolRegistry.discoverToolsForServer(selectedServer.name);
      }
      // Reload server data to update status
      await reloadServers();
    } catch (error) {
      debugLogger.error(
        `Error reconnecting to server '${selectedServer.name}':`,
        error,
      );
    } finally {
      setIsLoading(false);
    }
  }, [config, selectedServer, reloadServers]);

  // Enable server
  const handleEnableServer = useCallback(async () => {
    if (!config || !selectedServer) return;

    try {
      setIsLoading(true);

      const server = selectedServer;
      const settings = loadSettings();

      // Remove from user and workspace exclusion lists
      for (const scope of [SettingScope.User, SettingScope.Workspace]) {
        const scopeSettings = settings.forScope(scope).settings;
        const currentExcluded = scopeSettings.mcp?.excluded || [];

        if (currentExcluded.includes(server.name)) {
          const newExcluded = currentExcluded.filter(
            (name: string) => name !== server.name,
          );
          settings.setValue(scope, 'mcp.excluded', newExcluded);
        }
      }

      // Update runtime config exclusion list
      const currentExcluded = config.getExcludedMcpServers() || [];
      const newExcluded = currentExcluded.filter(
        (name: string) => name !== server.name,
      );
      config.setExcludedMcpServers(newExcluded);

      // Rediscover tools for this server
      const toolRegistry = config.getToolRegistry();
      if (toolRegistry) {
        await toolRegistry.discoverToolsForServer(server.name);
      }

      // Reload server data
      await reloadServers();
    } catch (error) {
      debugLogger.error(
        `Error enabling server '${selectedServer.name}':`,
        error,
      );
    } finally {
      setIsLoading(false);
    }
  }, [config, selectedServer, reloadServers]);

  // Handle disable/enable action
  const handleDisable = useCallback(() => {
    if (!selectedServer) return;

    // If server is already disabled, enable it directly
    if (selectedServer.isDisabled) {
      void handleEnableServer();
    } else {
      // Otherwise navigate to disable scope selection
      handleNavigateToStep(MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT);
    }
  }, [selectedServer, handleEnableServer, handleNavigateToStep]);

  // Execute disable after selecting scope
  const handleSelectDisableScope = useCallback(
    async (scope: 'user' | 'workspace') => {
      if (!config || !selectedServer) return;

      try {
        setIsLoading(true);

        const server = selectedServer;
        const settings = loadSettings();

        // Get current exclusion list
        const scopeSettings = settings.forScope(
          scope === 'user' ? SettingScope.User : SettingScope.Workspace,
        ).settings;
        const currentExcluded = scopeSettings.mcp?.excluded || [];

        // If server is not in exclusion list, add it
        if (!currentExcluded.includes(server.name)) {
          const newExcluded = [...currentExcluded, server.name];
          settings.setValue(
            scope === 'user' ? SettingScope.User : SettingScope.Workspace,
            'mcp.excluded',
            newExcluded,
          );
        }

        // Use new disableMcpServer method to disable server
        const toolRegistry = config.getToolRegistry();
        if (toolRegistry) {
          await toolRegistry.disableMcpServer(server.name);
        }

        // Reload server list
        await reloadServers();

        // Return to server detail page
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
    [config, selectedServer, handleNavigateBack, reloadServers],
  );

  // Render step header
  const renderStepHeader = useCallback(() => {
    const currentStep = getCurrentStep();
    let headerText = '';

    switch (currentStep) {
      case MCP_MANAGEMENT_STEPS.SERVER_LIST:
        headerText = t('Manage MCP servers');
        break;
      case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
        headerText = selectedServer?.name || t('Server Detail');
        break;
      case MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
        headerText = t('Disable Server');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_LIST:
        headerText = t('Tools');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
        headerText = selectedTool?.name || t('Tool Detail');
        break;
      default:
        headerText = t('MCP Management');
    }

    return (
      <Box>
        <Text bold>{headerText}</Text>
      </Box>
    );
  }, [getCurrentStep, selectedServer, selectedTool]);

  // Render step content
  const renderStepContent = useCallback(() => {
    if (isLoading) {
      return (
        <Box>
          <Text color={theme.text.secondary}>{t('Loading...')}</Text>
        </Box>
      );
    }

    const currentStep = getCurrentStep();

    switch (currentStep) {
      case MCP_MANAGEMENT_STEPS.SERVER_LIST:
        return (
          <ServerListStep servers={servers} onSelect={handleSelectServer} />
        );

      case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
        return (
          <ServerDetailStep
            server={selectedServer}
            onViewTools={handleViewTools}
            onReconnect={handleReconnect}
            onDisable={handleDisable}
            onBack={handleNavigateBack}
          />
        );

      case MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
        return (
          <DisableScopeSelectStep
            server={selectedServer}
            onSelectScope={handleSelectDisableScope}
            onBack={handleNavigateBack}
          />
        );

      case MCP_MANAGEMENT_STEPS.TOOL_LIST:
        return (
          <ToolListStep
            tools={getServerTools()}
            serverName={selectedServer?.name || ''}
            onSelect={handleSelectTool}
            onBack={handleNavigateBack}
          />
        );

      case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
        return (
          <ToolDetailStep tool={selectedTool} onBack={handleNavigateBack} />
        );

      default:
        return (
          <Box>
            <Text color={theme.status.error}>{t('Unknown step')}</Text>
          </Box>
        );
    }
  }, [
    isLoading,
    getCurrentStep,
    servers,
    selectedServer,
    selectedTool,
    handleSelectServer,
    handleViewTools,
    handleReconnect,
    handleDisable,
    handleNavigateBack,
    handleSelectTool,
    handleSelectDisableScope,
    getServerTools,
  ]);

  // Render step footer
  const renderStepFooter = useCallback(() => {
    const currentStep = getCurrentStep();
    let footerText = '';

    switch (currentStep) {
      case MCP_MANAGEMENT_STEPS.SERVER_LIST:
        if (servers.length === 0) {
          footerText = t('Esc to close');
        } else {
          footerText = t('↑↓ to navigate · Enter to select · Esc to close');
        }
        break;
      case MCP_MANAGEMENT_STEPS.SERVER_DETAIL:
        footerText = t('↑↓ to navigate · Enter to select · Esc to back');
        break;
      case MCP_MANAGEMENT_STEPS.DISABLE_SCOPE_SELECT:
        footerText = t('↑↓ to navigate · Enter to confirm · Esc to back');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_LIST:
        footerText = t('↑↓ to navigate · Enter to select · Esc to back');
        break;
      case MCP_MANAGEMENT_STEPS.TOOL_DETAIL:
        footerText = t('Esc to back');
        break;
      default:
        footerText = t('Esc to close');
    }

    return (
      <Box>
        <Text color={theme.text.secondary}>{footerText}</Text>
      </Box>
    );
  }, [getCurrentStep, servers.length]);

  // ESC key handler - only close dialog, child components handle back navigation to avoid duplicate triggers
  useKeypress(
    (key) => {
      if (
        key.name === 'escape' &&
        getCurrentStep() === MCP_MANAGEMENT_STEPS.SERVER_LIST
      ) {
        onClose();
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="single"
        borderColor={theme.border.default}
        flexDirection="column"
        padding={1}
        width="100%"
        gap={1}
      >
        {renderStepHeader()}
        {renderStepContent()}
        {renderStepFooter()}
      </Box>
    </Box>
  );
};

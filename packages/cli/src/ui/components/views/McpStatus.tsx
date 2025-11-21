/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { MCPServerStatus } from '@qwen-code/qwen-code-core';
import { Box, Text } from 'ink';
import type React from 'react';
import { theme } from '../../semantic-colors.js';
import type {
  HistoryItemMcpStatus,
  JsonMcpPrompt,
  JsonMcpTool,
} from '../../types.js';
import { t } from '../../../i18n/index.js';

interface McpStatusProps {
  servers: Record<string, MCPServerConfig>;
  tools: JsonMcpTool[];
  prompts: JsonMcpPrompt[];
  blockedServers: Array<{ name: string; extensionName: string }>;
  serverStatus: (serverName: string) => MCPServerStatus;
  authStatus: HistoryItemMcpStatus['authStatus'];
  discoveryInProgress: boolean;
  connectingServers: string[];
  showDescriptions: boolean;
  showSchema: boolean;
  showTips: boolean;
}

export const McpStatus: React.FC<McpStatusProps> = ({
  servers,
  tools,
  prompts,
  blockedServers,
  serverStatus,
  authStatus,
  discoveryInProgress,
  connectingServers,
  showDescriptions,
  showSchema,
  showTips,
}) => {
  const serverNames = Object.keys(servers);

  if (serverNames.length === 0 && blockedServers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>{t('No MCP servers configured.')}</Text>
        <Text>
          {t('Please view MCP documentation in your browser:')}{' '}
          <Text color={theme.text.link}>
            https://goo.gle/gemini-cli-docs-mcp
          </Text>{' '}
          {t('or use the cli /docs command')}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {discoveryInProgress && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.status.warning}>
            {t('⏳ MCP servers are starting up ({{count}} initializing)...', {
              count: String(connectingServers.length),
            })}
          </Text>
          <Text color={theme.text.primary}>
            {t(
              'Note: First startup may take longer. Tool availability will update automatically.',
            )}
          </Text>
        </Box>
      )}

      <Text bold>{t('Configured MCP servers:')}</Text>
      <Box height={1} />

      {serverNames.map((serverName) => {
        const server = servers[serverName];
        const serverTools = tools.filter(
          (tool) => tool.serverName === serverName,
        );
        const serverPrompts = prompts.filter(
          (prompt) => prompt.serverName === serverName,
        );
        const originalStatus = serverStatus(serverName);
        const hasCachedItems =
          serverTools.length > 0 || serverPrompts.length > 0;
        const status =
          originalStatus === MCPServerStatus.DISCONNECTED && hasCachedItems
            ? MCPServerStatus.CONNECTED
            : originalStatus;

        let statusIndicator = '';
        let statusText = '';
        let statusColor = theme.text.primary;

        switch (status) {
          case MCPServerStatus.CONNECTED:
            statusIndicator = '🟢';
            statusText = t('Ready');
            statusColor = theme.status.success;
            break;
          case MCPServerStatus.CONNECTING:
            statusIndicator = '🔄';
            statusText = t('Starting... (first startup may take longer)');
            statusColor = theme.status.warning;
            break;
          case MCPServerStatus.DISCONNECTED:
          default:
            statusIndicator = '🔴';
            statusText = t('Disconnected');
            statusColor = theme.status.error;
            break;
        }

        let serverDisplayName = serverName;
        if (server.extensionName) {
          serverDisplayName += ` ${t('(from {{extensionName}})', {
            extensionName: server.extensionName,
          })}`;
        }

        const toolCount = serverTools.length;
        const promptCount = serverPrompts.length;
        const parts = [];
        if (toolCount > 0) {
          parts.push(
            toolCount === 1
              ? t('{{count}} tool', { count: String(toolCount) })
              : t('{{count}} tools', { count: String(toolCount) }),
          );
        }
        if (promptCount > 0) {
          parts.push(
            promptCount === 1
              ? t('{{count}} prompt', { count: String(promptCount) })
              : t('{{count}} prompts', { count: String(promptCount) }),
          );
        }

        const serverAuthStatus = authStatus[serverName];
        let authStatusNode: React.ReactNode = null;
        if (serverAuthStatus === 'authenticated') {
          authStatusNode = <Text> ({t('OAuth')})</Text>;
        } else if (serverAuthStatus === 'expired') {
          authStatusNode = (
            <Text color={theme.status.error}> ({t('OAuth expired')})</Text>
          );
        } else if (serverAuthStatus === 'unauthenticated') {
          authStatusNode = (
            <Text color={theme.status.warning}>
              {' '}
              ({t('OAuth not authenticated')})
            </Text>
          );
        }

        return (
          <Box key={serverName} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={statusColor}>{statusIndicator} </Text>
              <Text bold>{serverDisplayName}</Text>
              <Text>
                {' - '}
                {statusText}
                {status === MCPServerStatus.CONNECTED &&
                  parts.length > 0 &&
                  ` (${parts.join(', ')})`}
              </Text>
              {authStatusNode}
            </Box>
            {status === MCPServerStatus.CONNECTING && (
              <Text> ({t('tools and prompts will appear when ready')})</Text>
            )}
            {status === MCPServerStatus.DISCONNECTED && toolCount > 0 && (
              <Text>
                ({t('{{count}} tools cached', { count: String(toolCount) })})
              </Text>
            )}

            {showDescriptions && server?.description && (
              <Text color={theme.text.secondary}>
                {server.description.trim()}
              </Text>
            )}

            {serverTools.length > 0 && (
              <Box flexDirection="column" marginLeft={2}>
                <Text color={theme.text.primary}>{t('Tools:')}</Text>
                {serverTools.map((tool) => {
                  const schemaContent =
                    showSchema &&
                    tool.schema &&
                    (tool.schema.parametersJsonSchema || tool.schema.parameters)
                      ? JSON.stringify(
                          tool.schema.parametersJsonSchema ??
                            tool.schema.parameters,
                          null,
                          2,
                        )
                      : null;

                  return (
                    <Box key={tool.name} flexDirection="column">
                      <Text>
                        - <Text color={theme.text.primary}>{tool.name}</Text>
                      </Text>
                      {showDescriptions && tool.description && (
                        <Box marginLeft={2}>
                          <Text color={theme.text.secondary}>
                            {tool.description.trim()}
                          </Text>
                        </Box>
                      )}
                      {schemaContent && (
                        <Box flexDirection="column" marginLeft={4}>
                          <Text color={theme.text.secondary}>
                            {t('Parameters:')}
                          </Text>
                          <Text color={theme.text.secondary}>
                            {schemaContent}
                          </Text>
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            )}

            {serverPrompts.length > 0 && (
              <Box flexDirection="column" marginLeft={2}>
                <Text color={theme.text.primary}>{t('Prompts:')}</Text>
                {serverPrompts.map((prompt) => (
                  <Box key={prompt.name} flexDirection="column">
                    <Text>
                      - <Text color={theme.text.primary}>{prompt.name}</Text>
                    </Text>
                    {showDescriptions && prompt.description && (
                      <Box marginLeft={2}>
                        <Text color={theme.text.primary}>
                          {prompt.description.trim()}
                        </Text>
                      </Box>
                    )}
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        );
      })}

      {blockedServers.map((server) => (
        <Box key={server.name} marginBottom={1}>
          <Text color={theme.status.error}>🔴 </Text>
          <Text bold>
            {server.name}
            {server.extensionName
              ? ` ${t('(from {{extensionName}})', {
                  extensionName: server.extensionName,
                })}`
              : ''}
          </Text>
          <Text> - {t('Blocked')}</Text>
        </Box>
      ))}

      {showTips && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text.accent}>{t('💡 Tips:')}</Text>
          <Text>
            {'  '}- {t('Use')} <Text color={theme.text.accent}>/mcp desc</Text>{' '}
            {t('to show server and tool descriptions')}
          </Text>
          <Text>
            {'  '}- {t('Use')}{' '}
            <Text color={theme.text.accent}>/mcp schema</Text>{' '}
            {t('to show tool parameter schemas')}
          </Text>
          <Text>
            {'  '}- {t('Use')}{' '}
            <Text color={theme.text.accent}>/mcp nodesc</Text>{' '}
            {t('to hide descriptions')}
          </Text>
          <Text>
            {'  '}- {t('Use')}{' '}
            <Text color={theme.text.accent}>/mcp auth &lt;server-name&gt;</Text>{' '}
            {t('to authenticate with OAuth-enabled servers')}
          </Text>
          <Text>
            {'  '}- {t('Press')} <Text color={theme.text.accent}>Ctrl+T</Text>{' '}
            {t('to toggle tool descriptions on/off')}
          </Text>
        </Box>
      )}
    </Box>
  );
};

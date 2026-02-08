/**
 * Chrome Extension Side Panel App
 * Simplified version adapted from vscode-ide-companion
 */

import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useVSCode } from './hooks/useVSCode.js';
import { InputForm } from './platform/InputForm.js';
import { EmptyState } from './platform/EmptyState.js';
import {
  UserMessage,
  AssistantMessage,
  ThinkingMessage,
  WaitingMessage,
  PermissionDrawer,
  GenericToolCall,
} from '@qwen-code/webui';
import type { PermissionOption, PermissionToolCall } from '@qwen-code/webui';
import { useToolCalls } from './hooks/useToolCalls.js';
import type { ToolCallUpdate } from './types/chatTypes.js';

interface Message {
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: number;
}

interface McpTool {
  name: string;
  description: string;
  // Add other properties as needed based on the actual structure
}

export const App: React.FC = () => {
  const vscode = useVSCode();

  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isWaitingForResponse, setIsWaitingForResponse] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [thinkingContent, setThinkingContent] = useState('');
  const [thinkingStatus, setThinkingStatus] = useState<'loading' | 'default'>(
    'default',
  );
  // Debug: cache slash-commands (available_commands_update) & MCP tools list
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [showToolsPanel, setShowToolsPanel] = useState(false);
  const [authUri, setAuthUri] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<{
    authenticated: boolean;
    method?: string;
    error?: string;
  } | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<{
    requestId: number;
    sessionId?: string | null;
    options: PermissionOption[];
    toolCall: PermissionToolCall;
  } | null>(null);
  const { toolCalls, handleToolCallUpdate, clearToolCalls } = useToolCalls();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputFieldRef = useRef<HTMLDivElement>(null);
  const autoConnectAttemptedRef = useRef(false);

  const finalizeThinking = useCallback(
    (timestamp?: number) => {
      setThinkingContent((current) => {
        if (current) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'thinking',
              content: current,
              timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
            },
          ]);
        }
        return '';
      });
      setThinkingStatus('default');
    },
    [setMessages],
  );

  const flushStreamingToMessages = useCallback(
    (timestamp?: number) => {
      setStreamingContent((current) => {
        if (current) {
          setMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              content: current,
              timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
            },
          ]);
        }
        return '';
      });
    },
    [setMessages],
  );

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, toolCalls, thinkingContent]);

  // Listen for messages from background script
  useEffect(() => {
    const handleMessage = (message: { type: string; data?: unknown }) => {
      console.log('[App] Received message:', message);

      switch (message.type) {
        case 'STATUS_UPDATE': {
          const statusData = message.data as { status: string } | undefined;
          if (statusData && 'status' in statusData) {
            setIsConnected(statusData.status !== 'disconnected');
          } else {
            setIsConnected(false); // default to disconnected if status data is missing
          }
          break;
        }
        case 'hostInfo': {
          const messageAny = message as { data?: unknown };
          console.log('[HostInfo]', messageAny.data);
          break;
        }
        case 'hostLog': {
          const logMessage = message as { data?: { line?: string } };
          const line = logMessage.data?.line;
          if (line) console.log('[HostLog]', line);
          break;
        }
        case 'authUpdate': {
          const authMessage = message as { data?: { authUri?: string } };
          const uri = authMessage.data?.authUri;
          if (uri) {
            setAuthUri(uri);
            setAuthStatus({
              authenticated: false,
              method: authStatus?.method,
              error: 'Authentication required',
            });
          }
          break;
        }
        case 'authStatus': {
          const authMessage = message as {
            data?: {
              authenticated?: boolean;
              method?: string;
              error?: string;
            };
          };
          if (authMessage.data) {
            setAuthStatus({
              authenticated: !!authMessage.data.authenticated,
              method: authMessage.data.method,
              error: authMessage.data.error,
            });
          }
          break;
        }
        case 'mcpTools': {
          const toolMessage: { data?: { tools?: McpTool[] } } = message as {
            data?: { tools?: McpTool[] };
          };
          const tools = toolMessage.data?.tools || [];
          setMcpTools(tools);
          console.log('[App] MCP tools:', tools);
          break;
        }

        case 'toolProgress': {
          break;
        }

        case 'streamStart': {
          setIsStreaming(true);
          setIsWaitingForResponse(false);
          setStreamingContent('');
          break;
        }

        case 'streamChunk': {
          const chunkMessage = message as { data: { chunk: string } };
          setStreamingContent(
            (prev) => prev + (chunkMessage.data?.chunk || ''),
          );
          break;
        }

        case 'streamEnd': {
          finalizeThinking(Date.now() - 1);
          flushStreamingToMessages();
          setIsStreaming(false);
          setIsWaitingForResponse(false);
          break;
        }

        case 'thinkingChunk': {
          const chunkMessage = message as { data: { chunk: string } };
          setThinkingStatus('loading');
          setThinkingContent((prev) => prev + (chunkMessage.data?.chunk || ''));
          break;
        }

        case 'thinkingEnd': {
          finalizeThinking();
          break;
        }

        case 'toolCall':
        case 'toolCallUpdate': {
          const toolCallData = (message as { data?: ToolCallUpdate }).data;
          if (toolCallData) {
            const normalized =
              toolCallData.sessionUpdate && !toolCallData.type
                ? {
                    ...toolCallData,
                    type: toolCallData.sessionUpdate as
                      | 'tool_call'
                      | 'tool_call_update',
                  }
                : toolCallData;
            handleToolCallUpdate(normalized as ToolCallUpdate);
            const status = (normalized as ToolCallUpdate).status;
            const isStart = normalized.type === 'tool_call';
            const isFinal =
              normalized.type === 'tool_call_update' &&
              (status === 'completed' || status === 'failed');
            if (isStart || isFinal) {
              const ts = (normalized as ToolCallUpdate).timestamp;
              flushStreamingToMessages(
                typeof ts === 'number' ? ts - 1 : undefined,
              );
            }
          }
          break;
        }

        case 'message': {
          const msgData = (message as { data: Message }).data;
          if (msgData) {
            setMessages((prev) => [
              ...prev,
              {
                role: msgData.role,
                content: msgData.content,
                timestamp: msgData.timestamp || Date.now(),
              },
            ]);
          }
          break;
        }
        case 'error': {
          finalizeThinking();
          setIsStreaming(false);
          setIsWaitingForResponse(false);
          setLoadingMessage(null);
          break;
        }

        case 'permissionRequest': {
          // Handle permission request from Qwen CLI
          console.log('[App] Permission request:', message);
          const permData = (
            message as {
              data: {
                requestId: number;
                sessionId?: string | null;
                options: PermissionOption[];
                toolCall: PermissionToolCall;
              };
            }
          ).data;
          if (permData) {
            setPermissionRequest({
              requestId: permData.requestId,
              sessionId: permData.sessionId,
              options: permData.options,
              toolCall: permData.toolCall,
            });
          }
          break;
        }

        default:
          // Handle unknown message types
          console.log('[App] Unknown message type:', message.type);
          break;
      }
    };

    // Add Chrome message listener
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.onMessage.addListener(handleMessage);
      return () => {
        chrome.runtime.onMessage.removeListener(handleMessage);
      };
    }
  }, [
    streamingContent,
    finalizeThinking,
    flushStreamingToMessages,
    authStatus?.method,
    handleToolCallUpdate,
  ]);

  // Check connection status on mount
  useEffect(() => {
    const checkStatus = async () => {
      const response = (await vscode.postMessage({ type: 'GET_STATUS' })) as {
        connected?: boolean;
        status?: string;
        mcpTools?: McpTool[];
      } | null;
      if (response) {
        setIsConnected(response.connected || false);
        if (Array.isArray(response.mcpTools)) {
          setMcpTools(response.mcpTools);
        }
      }
    };
    checkStatus();
  }, [vscode]);

  // Auto-connect once on mount/when disconnected (defined after handleConnect to avoid TDZ)

  // Handle submit
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      const text = inputText.trim();
      if (!text || isStreaming || isWaitingForResponse) return;

      // Add user message
      setMessages((prev) => [
        ...prev,
        {
          role: 'user',
          content: text,
          timestamp: Date.now(),
        },
      ]);
      setThinkingContent('');
      setThinkingStatus('default');

      // Clear input
      setInputText('');
      if (inputFieldRef.current) {
        inputFieldRef.current.textContent = '';
      }

      // Send to background
      setIsWaitingForResponse(true);
      setLoadingMessage('Thinking...');

      await vscode.postMessage({
        type: 'sendMessage',
        data: { text },
      });
    },
    [inputText, isStreaming, isWaitingForResponse, vscode],
  );

  // Handle cancel
  const handleCancel = useCallback(async () => {
    await vscode.postMessage({ type: 'cancelStreaming', data: {} });
    setIsStreaming(false);
    setIsWaitingForResponse(false);
    setLoadingMessage(null);
  }, [vscode]);

  // Handle connect
  const handleConnect = useCallback(async () => {
    setLoadingMessage('Connecting...');
    const response = (await vscode.postMessage({ type: 'CONNECT' })) as {
      success?: boolean;
      status?: string;
    } | null;
    if (response?.success) {
      setIsConnected(true);
      setLoadingMessage(null);
    } else {
      setLoadingMessage('Connection failed');
      setTimeout(() => setLoadingMessage(null), 3000);
    }
  }, [vscode]);

  // Handle exit (stop CLI session)
  const handleExit = useCallback(async () => {
    const response = (await vscode.postMessage({ type: 'EXIT' })) as {
      success?: boolean;
    } | null;
    if (response?.success) {
      setIsConnected(false);
      setIsStreaming(false);
      setIsWaitingForResponse(false);
      setLoadingMessage(null);
      setStreamingContent('');
      setThinkingContent('');
      setThinkingStatus('default');
      setAuthUri(null);
      setAuthStatus(null);
      setPermissionRequest(null);
      clearToolCalls();
    }
  }, [vscode, clearToolCalls]);

  // Auto-connect once on mount/when disconnected
  useEffect(() => {
    if (!isConnected && !autoConnectAttemptedRef.current) {
      autoConnectAttemptedRef.current = true;
      (async () => {
        try {
          await handleConnect();
        } catch (err) {
          console.error('[AutoConnect] failed', err);
          autoConnectAttemptedRef.current = false;
          setLoadingMessage(null);
        }
      })();
    }
  }, [isConnected, handleConnect]);

  // Read current page and ask Qwen to analyze (bypasses MCP; uses content-script extractor)
  /* const handleReadPage = useCallback(async () => {
    try {
      setIsWaitingForResponse(true);
      setLoadingMessage('Reading page...');
      const extract = (await vscode.postMessage({
        type: 'EXTRACT_PAGE_DATA',
      })) as any;
      if (!extract || !extract.success) {
        setIsWaitingForResponse(false);
        setLoadingMessage(null);
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Read Page failed: ${extract?.error || 'unknown error'}`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }
      await vscode.postMessage({
        type: 'SEND_TO_QWEN',
        action: 'analyze_page',
        data: extract.data,
      });
      // streamStart will arrive from service worker; keep waiting state until it starts streaming
    } catch (err: any) {
      setIsWaitingForResponse(false);
      setLoadingMessage(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Read Page error: ${err?.message || String(err)}`,
          timestamp: Date.now(),
        },
      ]);
    }
  }, [vscode]); */

  // Get network logs and send to Qwen to analyze (bypasses MCP; uses debugger API)
  /* const handleGetNetworkLogs = useCallback(async () => {
    try {
      setIsWaitingForResponse(true);
      setLoadingMessage('Collecting network logs...');
      const resp = (await vscode.postMessage({
        type: 'GET_NETWORK_LOGS',
      })) as any;
      if (!resp || !resp.success) {
        setIsWaitingForResponse(false);
        setLoadingMessage(null);
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Get Network Logs failed: ${resp?.error || 'unknown error'}`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }
      const logs = resp.data || resp.logs || [];
      const summary = Array.isArray(logs) ? logs.slice(-50) : [];
      const text =
        `Network logs (last ${summary.length} entries):\n` +
        JSON.stringify(
          summary.map((l: any) => ({
            method: l.method,
            url: l.params?.request?.url || l.params?.documentURL,
            status: l.params?.response?.status,
            timestamp: l.timestamp,
          })),
          null,
          2,
        );
      // Show a short message to user
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Running tool: Get Network Logs…',
          timestamp: Date.now(),
        },
      ]);
      // Ask Qwen to analyze
      await vscode.postMessage({
        type: 'SEND_TO_QWEN',
        action: 'ai_analyze',
        data: {
          pageData: { content: { text } },
          prompt:
            'Please analyze these network logs, list failed or slow requests and possible causes.',
        },
      });
    } catch (err: any) {
      setIsWaitingForResponse(false);
      setLoadingMessage(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Get Network Logs error: ${err?.message || String(err)}`,
          timestamp: Date.now(),
        },
      ]);
    }
  }, [vscode]); */

  // Handle permission response
  const handlePermissionResponse = useCallback(
    (optionId: string) => {
      if (!permissionRequest) return;

      console.log(
        '[App] Sending permission response:',
        optionId,
        'for requestId:',
        permissionRequest.requestId,
      );
      vscode.postMessage({
        type: 'permissionResponse',
        data: {
          requestId: permissionRequest.requestId,
          optionId,
          sessionId: permissionRequest.sessionId,
        },
      });
      setPermissionRequest(null);
    },
    [vscode, permissionRequest],
  );

  // Get console logs and send to Qwen to analyze (bypasses MCP; uses content-script capture)
  /* const handleGetConsoleLogs = useCallback(async () => {
    try {
      setIsWaitingForResponse(true);
      setLoadingMessage('Collecting console logs...');
      const resp = (await vscode.postMessage({
        type: 'GET_CONSOLE_LOGS',
      })) as any;
      if (!resp || !resp.success) {
        setIsWaitingForResponse(false);
        setLoadingMessage(null);
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `Get Console Logs failed: ${resp?.error || 'unknown error'}`,
            timestamp: Date.now(),
          },
        ]);
        return;
      }
      const logs = resp.data || [];
      const formatted = logs
        .slice(-50)
        .map((l: any) => `[${l.type}] ${l.message}`)
        .join('\n');
      const text = `Console logs (last ${Math.min(logs.length, 50)} entries):
${formatted || '(no logs captured)'}`;
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: 'Running tool: Get Console Logs…',
          timestamp: Date.now(),
        },
      ]);
      await vscode.postMessage({
        type: 'SEND_TO_QWEN',
        action: 'ai_analyze',
        data: {
          pageData: { content: { text } },
          prompt:
            'Please analyze these console logs and summarize errors/warnings.',
        },
      });
    } catch (err: any) {
      setIsWaitingForResponse(false);
      setLoadingMessage(null);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: `Get Console Logs error: ${err?.message || String(err)}`,
          timestamp: Date.now(),
        },
      ]);
    }
  }, [vscode]); */

  const hasContent =
    messages.length > 0 ||
    isStreaming ||
    streamingContent ||
    thinkingContent ||
    toolCalls.size > 0;
  const toolCallItems = Array.from(toolCalls.values()).sort(
    (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
  );
  const timelineItems = [
    ...messages.map((msg) => ({
      type: 'message' as const,
      timestamp: msg.timestamp,
      data: msg,
    })),
    ...toolCallItems.map((tc) => ({
      type: 'toolCall' as const,
      timestamp: tc.timestamp || Date.now(),
      data: tc,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);
  const formatAuthMethod = (method?: string) => {
    if (!method) return 'ok';
    if (method === 'openai') return 'OpenAI';
    if (method === 'qwen-oauth') return 'Qwen OAuth';
    return method;
  };
  const authLabel = authStatus
    ? authStatus.authenticated
      ? formatAuthMethod(authStatus.method)
      : authStatus.error || 'required'
    : null;

  return (
    <div className="chat-container relative flex flex-col h-screen bg-[#1e1e1e] text-white">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-gray-700">
        <h1 className="text-sm font-medium">Qwen Code</h1>
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-gray-500'}`}
          />
          <span className="text-xs text-gray-400">
            {isConnected ? `Connected` : 'Disconnected'}
          </span>
          {authLabel && (
            <span className="text-xs text-gray-400">Auth: {authLabel}</span>
          )}
          {isConnected && (
            <button
              className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              onClick={handleExit}
              title="Stop CLI session"
            >
              Exit
            </button>
          )}
          {/* {isConnected && (
            <button
              className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              onClick={handleReadPage}
              title="Read current page"
            >
              Read Page
            </button>
          )}
          {isConnected && (
            <button
              className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              onClick={handleGetNetworkLogs}
              title="Get network logs"
            >
              Network Logs
            </button>
          )}
          {isConnected && (
            <button
              className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              onClick={handleGetConsoleLogs}
              title="Get console logs"
            >
              Console Logs
            </button>
          )}
          {isConnected && mcpTools.length > 0 && (
            <button
              className="text-xs px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              onClick={() => setShowToolsPanel((v) => !v)}
              title="Show available tools"
            >
              Tools
            </button>
          )} */}
        </div>
      </div>

      {/* Messages */}
      <div
        ref={messagesContainerRef}
        className="flex-1 overflow-y-auto p-4 pb-36 space-y-4"
      >
        {!hasContent ? (
          <EmptyState
            isAuthenticated={isConnected}
            loadingMessage={!isConnected ? 'Click Connect to start' : undefined}
          />
        ) : (
          <>
            {timelineItems.map((item, index) => {
              if (item.type === 'message') {
                if (item.data.role === 'user') {
                  return (
                    <UserMessage
                      key={`msg-${index}`}
                      content={item.data.content}
                      timestamp={item.data.timestamp}
                      onFileClick={() => {
                        // No action required
                      }}
                    />
                  );
                }
                if (item.data.role === 'thinking') {
                  return (
                    <ThinkingMessage
                      key={`msg-${index}`}
                      content={item.data.content}
                      timestamp={item.data.timestamp}
                      status="default"
                    />
                  );
                }
                return (
                  <AssistantMessage
                    key={`msg-${index}`}
                    content={item.data.content}
                    timestamp={item.data.timestamp}
                    onFileClick={() => {
                      // No action required
                    }}
                  />
                );
              }

              const prevType = timelineItems[index - 1]?.type;
              const nextType = timelineItems[index + 1]?.type;
              const isFirst = prevType !== 'toolCall';
              const isLast = nextType !== 'toolCall';
              return (
                <GenericToolCall
                  key={`tool-${item.data.toolCallId}-${index}`}
                  toolCall={item.data}
                  isFirst={isFirst}
                  isLast={isLast}
                />
              );
            })}

            {thinkingContent && (
              <ThinkingMessage
                content={thinkingContent}
                timestamp={Date.now()}
                status={thinkingStatus}
              />
            )}
            {/* Streaming message */}
            {isStreaming && streamingContent && (
              <AssistantMessage
                content={streamingContent}
                timestamp={Date.now()}
                onFileClick={() => {}}
              />
            )}

            {/* Waiting indicator */}
            {isWaitingForResponse && loadingMessage && (
              <WaitingMessage loadingMessage={loadingMessage} />
            )}
            {/* If streaming started but no chunks yet, show thinking indicator */}
            {isStreaming && !streamingContent && (
              <WaitingMessage
                loadingMessage={loadingMessage || 'Thinking...'}
              />
            )}

            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input */}
      {isConnected ? (
        <InputForm
          inputText={inputText}
          inputFieldRef={inputFieldRef as React.RefObject<HTMLDivElement>}
          isStreaming={isStreaming}
          isWaitingForResponse={isWaitingForResponse}
          isComposing={isComposing}
          editMode="default"
          thinkingEnabled={false}
          activeFileName={null}
          activeSelection={null}
          skipAutoActiveContext={true}
          onInputChange={setInputText}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={() => {
            // No special key handling required
          }}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onToggleEditMode={() => {
            // No edit mode toggle required
          }}
          onToggleThinking={() => {
            // No thinking mode toggle required
          }}
          onFocusActiveEditor={() => {
            // No editor focus required
          }}
          onToggleSkipAutoActiveContext={() => {
            // No context toggle required
          }}
          onShowCommandMenu={() => {
            // No command menu required
          }}
          onAttachContext={() => {
            // No context attachment required
          }}
          completionIsOpen={false}
          completionItems={[]}
          onCompletionSelect={() => {
            // No completion selection required
          }}
          onCompletionClose={() => {
            // No completion closing required
          }}
        />
      ) : (
        <div className="p-4 border-t border-gray-700">
          <button
            onClick={handleConnect}
            className="w-full py-2 px-4 bg-indigo-600 hover:bg-indigo-700 rounded text-white text-sm font-medium transition-colors"
          >
            Connect to Qwen CLI
          </button>
        </div>
      )}

      {/* Permission Request Drawer */}
      {permissionRequest && (
        <PermissionDrawer
          isOpen={!!permissionRequest}
          options={permissionRequest.options}
          toolCall={permissionRequest.toolCall}
          onResponse={handlePermissionResponse}
          onClose={() => setPermissionRequest(null)}
        />
      )}

      {/* Auth Required banner */}
      {authUri && (
        <div className="absolute left-3 right-3 top-10 z-50 bg-[#2a2d2e] border border-yellow-600 text-yellow-200 rounded p-2 text-[12px] flex items-center justify-between gap-2">
          <div>Authentication required. Click to sign in.</div>
          <div className="flex items-center gap-2">
            <button
              className="px-2 py-0.5 rounded bg-yellow-700 hover:bg-yellow-600 text-white"
              onClick={() => {
                try {
                  chrome.tabs.create({ url: authUri });
                } catch {
                  // Ignore errors when opening tab
                }
              }}
            >
              Open Link
            </button>
            <button
              className="px-2 py-0.5 rounded bg-gray-700 hover:bg-gray-600"
              onClick={() => setAuthUri(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Debug: Tools panel */}
      {showToolsPanel && mcpTools.length > 0 && (
        <div className="absolute right-3 top-10 z-50 max-w-[80%] w-[360px] max-h-[50vh] overflow-auto bg-[#2a2d2e] text-[13px] text-gray-200 border border-gray-700 rounded shadow-lg p-2">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">
              Available Tools ({mcpTools.length})
            </div>
            <button
              className="text-gray-400 hover:text-gray-200"
              onClick={() => setShowToolsPanel(false)}
            >
              ×
            </button>
          </div>
          <div className="text-[11px] text-gray-400 mb-1">MCP Tools</div>
          <ul className="space-y-1">
            {mcpTools.map(
              (
                t: McpTool & { tool?: { name?: string; description?: string } },
                i: number,
              ) => {
                const name = (t && (t.name || t.tool?.name)) || String(t);
                const desc =
                  (t && (t.description || t.tool?.description)) || '';
                return (
                  <li
                    key={`discovered-${i}`}
                    className="px-2 py-1 rounded hover:bg-[#3a3d3e]"
                  >
                    <div className="font-mono text-xs text-[#a6e22e] break-all">
                      {name}
                    </div>
                    {desc && (
                      <div className="text-[11px] text-gray-400 break-words">
                        {desc}
                      </div>
                    )}
                  </li>
                );
              },
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

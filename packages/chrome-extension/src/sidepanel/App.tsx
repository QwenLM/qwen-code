/**
 * Chrome Extension Side Panel App
 * Simplified version adapted from vscode-ide-companion
 */

import type React from 'react';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useVSCode } from './hooks/useVSCode.js';
import { InputForm } from './components/layout/InputForm.js';
import { EmptyState } from './components/layout/EmptyState.js';
import {
  UserMessage,
  AssistantMessage,
  WaitingMessage,
} from './components/messages/index.js';
import { PermissionDrawer } from './components/PermissionDrawer/PermissionDrawer.js';
import type {
  PermissionOption,
  ToolCall,
} from './components/PermissionDrawer/PermissionRequest.js';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface McpTool {
  name: string;
  description: string;
  // Add other properties as needed based on the actual structure
}

interface InternalTool {
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
  // Debug: cache slash-commands (available_commands_update) & MCP tools list
  const [mcpTools, setMcpTools] = useState<McpTool[]>([]);
  const [internalTools, setInternalTools] = useState<InternalTool[]>([]);
  const [showToolsPanel, setShowToolsPanel] = useState(false);
  const [authUri, setAuthUri] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [permissionRequest, setPermissionRequest] = useState<{
    requestId: number;
    options: PermissionOption[];
    toolCall: ToolCall;
  } | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const inputFieldRef = useRef<HTMLDivElement>(null);
  const autoConnectAttemptedRef = useRef(false);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent]);

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
          if (uri) setAuthUri(uri);
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
        case 'internalMcpTools': {
          const internalToolMessage: { data?: { tools?: InternalTool[] } } =
            message as { data?: { tools?: InternalTool[] } };
          const tools = internalToolMessage.data?.tools || [];
          setInternalTools(tools);
          console.log('[App] Internal MCP tools:', tools);
          break;
        }

        case 'toolProgress': {
          const payload =
            (
              message as {
                data?: {
                  name?: string;
                  stage?: string;
                  ok?: boolean;
                  error?: string;
                };
              }
            ).data || {};
          const name = payload.name || '';
          const stage = payload.stage || '';
          const ok = payload.ok;
          const pretty = (n: string) => {
            switch (n) {
              case 'read_page':
                return 'Read Page';
              case 'capture_screenshot':
                return 'Capture Screenshot';
              case 'get_network_logs':
                return 'Get Network Logs';
              case 'get_console_logs':
                return 'Get Console Logs';
              default:
                return n;
            }
          };
          if (stage === 'start') {
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: `Running tool: ${pretty(name)}…`,
                timestamp: Date.now(),
              },
            ]);
          } else if (stage === 'end') {
            const endText =
              ok === false
                ? `Tool failed: ${pretty(name)}${payload.error ? ` — ${payload.error}` : ''}`
                : `Tool finished: ${pretty(name)}`;
            setMessages((prev) => [
              ...prev,
              { role: 'assistant', content: endText, timestamp: Date.now() },
            ]);
          }
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
          setStreamingContent((current) => {
            if (current) {
              setMessages((prev) => [
                ...prev,
                {
                  role: 'assistant',
                  content: current,
                  timestamp: Date.now(),
                },
              ]);
            }
            return '';
          });
          setIsStreaming(false);
          setIsWaitingForResponse(false);
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
                options: PermissionOption[];
                toolCall: ToolCall;
              };
            }
          ).data;
          if (permData) {
            setPermissionRequest({
              requestId: permData.requestId,
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
  }, [streamingContent]);

  // Check connection status on mount
  useEffect(() => {
    const checkStatus = async () => {
      const response = (await vscode.postMessage({ type: 'GET_STATUS' })) as {
        connected?: boolean;
        status?: string;
        mcpTools?: McpTool[];
        internalTools?: InternalTool[];
      } | null;
      if (response) {
        setIsConnected(response.connected || false);
        if (Array.isArray(response.mcpTools)) {
          setMcpTools(response.mcpTools);
        }
        if (Array.isArray(response.internalTools)) {
          setInternalTools(response.internalTools);
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

  const hasContent = messages.length > 0 || isStreaming || streamingContent;

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
          {isConnected && mcpTools.length + internalTools.length > 0 && (
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
        className="flex-1 overflow-y-auto p-4 space-y-4"
      >
        {!hasContent ? (
          <EmptyState
            isAuthenticated={isConnected}
            loadingMessage={!isConnected ? 'Click Connect to start' : undefined}
          />
        ) : (
          <>
            {messages.map((msg, index) =>
              msg.role === 'user' ? (
                <UserMessage
                  key={index}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  onFileClick={() => {
                    // No action required
                  }}
                />
              ) : (
                <AssistantMessage
                  key={index}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  onFileClick={() => {
                    // No action required
                  }}
                />
              ),
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
      {showToolsPanel && mcpTools.length + internalTools.length > 0 && (
        <div className="absolute right-3 top-10 z-50 max-w-[80%] w-[360px] max-h-[50vh] overflow-auto bg-[#2a2d2e] text-[13px] text-gray-200 border border-gray-700 rounded shadow-lg p-2">
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">
              Available Tools ({mcpTools.length + internalTools.length})
            </div>
            <button
              className="text-gray-400 hover:text-gray-200"
              onClick={() => setShowToolsPanel(false)}
            >
              ×
            </button>
          </div>
          <div className="text-[11px] text-gray-400 mb-1">
            Internal (chrome-browser)
          </div>
          <ul className="space-y-1 mb-2">
            {internalTools.map(
              (
                t: InternalTool & {
                  tool?: { name?: string; description?: string };
                },
                i: number,
              ) => {
                const name = (t && (t.name || t.tool?.name)) || String(t);
                const desc =
                  (t && (t.description || t.tool?.description)) || '';
                return (
                  <li
                    key={`internal-${i}`}
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
          <div className="text-[11px] text-gray-400 mb-1">Discovered (MCP)</div>
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

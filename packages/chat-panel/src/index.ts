/**
 * @qwen-code/chat-panel — the shared chat panel (input composer + conversation
 * flow) reused by web-shell, the VSCode webview, and the desktop app.
 *
 * Scaffold (WS1 in progress). The `Message[]` contract, `ChatPanel`, message
 * renderers, `ChatEditor`, and the render seam land as their workstreams complete.
 */
export * from './todos-types';
export * from './setting-descriptor';
export * from './context';
export * from './ChatPanelProviders';
export * from './useStreamingLoadingMetrics';

/**
 * Type definitions for export-html
 */

export type ChatData = {
  messages?: unknown[];
  sessionId?: string;
  startTime?: string;
  metadata?: ExportMetadata;
};

export type ExportMetadata = {
  sessionId: string;
  startTime: string;
  exportTime: string;
  cwd: string;
  gitRepo?: string;
  gitBranch?: string;
  model?: string;
  channel?: string;
  promptCount: number;
  contextUsagePercent?: number;
  contextWindowSize?: number;
  totalTokens?: number;
  filesRead?: number;
  filesWritten?: number;
  linesAdded?: number;
  linesRemoved?: number;
  uniqueFiles: string[];
};

export type PlatformContextValue = {
  platform: 'web';
  postMessage: (message: unknown) => void;
  onMessage: (handler: (event: MessageEvent) => void) => () => void;
  openFile: (path: string) => void;
  openTempFile?: (content: string, fileName?: string) => void;
  getResourceUrl: () => string | undefined;
  features: {
    canOpenFile: boolean;
    canOpenTempFile?: boolean;
    canCopy: boolean;
  };
};

export type ChatViewerMessage = { type?: string } & Record<string, unknown>;

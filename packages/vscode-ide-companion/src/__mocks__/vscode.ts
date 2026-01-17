/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * VSCode API Mock
 *
 * 为测试环境提供完整的 VSCode API mock 实现。
 * 这个文件通过 vitest.config.ts 中的 alias 配置被引用。
 */

import { vi } from 'vitest';

// Window API - 用于创建 UI 元素
export const window = {
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  createOutputChannel: vi.fn(() => ({
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  })),
  createWebviewPanel: vi.fn(),
  createTerminal: vi.fn(() => ({
    show: vi.fn(),
    sendText: vi.fn(),
  })),
  onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  tabGroups: {
    all: [],
    activeTabGroup: { viewColumn: 1, tabs: [], isActive: true, activeTab: undefined },
    close: vi.fn(),
  },
  showTextDocument: vi.fn(),
  showWorkspaceFolderPick: vi.fn(),
  registerWebviewPanelSerializer: vi.fn(() => ({ dispose: vi.fn() })),
  withProgress: vi.fn(
    (
      _options: unknown,
      callback: (progress: { report: () => void }) => unknown,
    ) => callback({ report: vi.fn() }),
  ),
};

// Workspace API - 用于访问工作区
export const workspace = {
  workspaceFolders: [] as unknown[],
  onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidDeleteFiles: vi.fn(() => ({ dispose: vi.fn() })),
  onDidRenameFiles: vi.fn(() => ({ dispose: vi.fn() })),
  onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
  onDidGrantWorkspaceTrust: vi.fn(() => ({ dispose: vi.fn() })),
  registerTextDocumentContentProvider: vi.fn(() => ({ dispose: vi.fn() })),
  registerFileSystemProvider: vi.fn(() => ({ dispose: vi.fn() })),
  openTextDocument: vi.fn(),
  isTrusted: true,
};

// Commands API - 用于注册和执行命令
export const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
  executeCommand: vi.fn(),
  getCommands: vi.fn(() => Promise.resolve([])),
};

// URI 工具类
export const Uri = {
  file: (path: string) => ({
    fsPath: path,
    scheme: 'file',
    path,
    authority: '',
    query: '',
    fragment: '',
    toString: () => `file://${path}`,
    toJSON: () => ({ scheme: 'file', path }),
    with: vi.fn(),
  }),
  joinPath: vi.fn((base: { fsPath: string }, ...paths: string[]) => ({
    fsPath: `${base.fsPath}/${paths.join('/')}`,
    scheme: 'file',
    path: `${base.fsPath}/${paths.join('/')}`,
    toString: () => `file://${base.fsPath}/${paths.join('/')}`,
  })),
  from: vi.fn(
    ({
      scheme,
      path,
      query,
    }: {
      scheme: string;
      path: string;
      query?: string;
    }) => ({
      scheme,
      path,
      fsPath: path,
      authority: '',
      query: query || '',
      fragment: '',
      toString: () => `${scheme}://${path}${query ? '?' + query : ''}`,
      toJSON: () => ({ scheme, path, query }),
      with: vi.fn(),
    }),
  ),
  parse: vi.fn((uri: string) => ({
    scheme: 'file',
    fsPath: uri.replace('file://', ''),
    path: uri.replace('file://', ''),
    authority: '',
    query: '',
    fragment: '',
    toString: () => uri,
    toJSON: () => ({ scheme: 'file', path: uri }),
    with: vi.fn(),
  })),
};

// 扩展相关
export const ExtensionMode = {
  Development: 1,
  Production: 2,
  Test: 3,
};

// 事件发射器
export class EventEmitter<T = unknown> {
  private listeners: Array<(e: T) => void> = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
  };

  fire = (data: T) => {
    this.listeners.forEach((listener) => listener(data));
  };

  dispose = vi.fn();
}

// 扩展管理
export const extensions = {
  getExtension: vi.fn(),
};

// ViewColumn 枚举
export const ViewColumn = {
  One: 1,
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
  Active: -1,
  Beside: -2,
};

// 进度位置
export const ProgressLocation = {
  Notification: 15,
  Window: 10,
  SourceControl: 1,
};

// 文本编辑器选择变更类型
export const TextEditorSelectionChangeKind = {
  Keyboard: 1,
  Mouse: 2,
  Command: 3,
};

// Disposable
export class Disposable {
  static from(...disposables: Array<{ dispose: () => void }>) {
    return {
      dispose: () => disposables.forEach((d) => d.dispose()),
    };
  }
}

// Position
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}

  isBefore(other: Position): boolean {
    return (
      this.line < other.line ||
      (this.line === other.line && this.character < other.character)
    );
  }

  isAfter(other: Position): boolean {
    return (
      this.line > other.line ||
      (this.line === other.line && this.character > other.character)
    );
  }
}

// Range
export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}

  get isEmpty(): boolean {
    return (
      this.start.line === this.end.line &&
      this.start.character === this.end.character
    );
  }
}

// Selection
export class Selection extends Range {
  constructor(
    public readonly anchor: Position,
    public readonly active: Position,
  ) {
    super(anchor, active);
  }
}

// TextEdit
export class TextEdit {
  static replace(range: Range, newText: string) {
    return { range, newText };
  }

  static insert(position: Position, newText: string) {
    return { range: new Range(position, position), newText };
  }

  static delete(range: Range) {
    return { range, newText: '' };
  }
}

// WorkspaceEdit
export class WorkspaceEdit {
  private edits = new Map<string, TextEdit[]>();

  replace(uri: { toString: () => string }, range: Range, newText: string) {
    const key = uri.toString();
    if (!this.edits.has(key)) {
      this.edits.set(key, []);
    }
    this.edits.get(key)!.push(TextEdit.replace(range, newText));
  }

  insert(uri: { toString: () => string }, position: Position, newText: string) {
    const key = uri.toString();
    if (!this.edits.has(key)) {
      this.edits.set(key, []);
    }
    this.edits.get(key)!.push(TextEdit.insert(position, newText));
  }

  delete(uri: { toString: () => string }, range: Range) {
    const key = uri.toString();
    if (!this.edits.has(key)) {
      this.edits.set(key, []);
    }
    this.edits.get(key)!.push(TextEdit.delete(range));
  }
}

// CancellationTokenSource
export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: vi.fn(() => ({ dispose: vi.fn() })),
  };

  cancel() {
    this.token.isCancellationRequested = true;
  }

  dispose() {}
}

// FileSystemError
export class FileSystemError extends Error {
  static FileNotFound(uri?: { toString: () => string }) {
    return new FileSystemError(`File not found: ${uri?.toString() || 'unknown'}`);
  }

  static FileExists(uri?: { toString: () => string }) {
    return new FileSystemError(`File exists: ${uri?.toString() || 'unknown'}`);
  }

  static FileNotADirectory(uri?: { toString: () => string }) {
    return new FileSystemError(`Not a directory: ${uri?.toString() || 'unknown'}`);
  }

  static FileIsADirectory(uri?: { toString: () => string }) {
    return new FileSystemError(`Is a directory: ${uri?.toString() || 'unknown'}`);
  }

  static NoPermissions(uri?: { toString: () => string }) {
    return new FileSystemError(`No permissions: ${uri?.toString() || 'unknown'}`);
  }

  static Unavailable(uri?: { toString: () => string }) {
    return new FileSystemError(`Unavailable: ${uri?.toString() || 'unknown'}`);
  }
}

// FileType
export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
};

// 默认导出所有 mock
export default {
  window,
  workspace,
  commands,
  Uri,
  ExtensionMode,
  EventEmitter,
  extensions,
  ViewColumn,
  ProgressLocation,
  TextEditorSelectionChangeKind,
  Disposable,
  Position,
  Range,
  Selection,
  TextEdit,
  WorkspaceEdit,
  CancellationTokenSource,
  FileSystemError,
  FileType,
};

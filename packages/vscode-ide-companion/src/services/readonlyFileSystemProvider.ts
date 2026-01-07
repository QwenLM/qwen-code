/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as vscode from 'vscode';

/**
 * Readonly file system provider for temporary files
 * Uses custom URI scheme to create readonly documents in VS Code
 */
export class ReadonlyFileSystemProvider
  implements vscode.FileSystemProvider, vscode.Disposable
{
  private static readonly scheme = 'qwen-readonly';
  private static instance: ReadonlyFileSystemProvider | null = null;

  private readonly files = new Map<string, Uint8Array>();
  private readonly emitter = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeFile = this.emitter.event;

  constructor() {
    // Ensure only one instance exists
    if (ReadonlyFileSystemProvider.instance !== null) {
      console.warn(
        '[ReadonlyFileSystemProvider] Instance already exists, replacing with new instance',
      );
    }
    this.disposables.push(this.emitter);
    // Register as global singleton
    ReadonlyFileSystemProvider.instance = this;
  }

  static getScheme(): string {
    return ReadonlyFileSystemProvider.scheme;
  }

  /**
   * Get the global singleton instance
   * Returns null if not initialized yet
   */
  static getInstance(): ReadonlyFileSystemProvider | null {
    return ReadonlyFileSystemProvider.instance;
  }

  /**
   * Create a URI for a readonly temporary file (static version)
   */
  static createUri(fileName: string, content: string): vscode.Uri {
    // For tool-call related filenames, keep the URI stable so repeated clicks focus the same document.
    // Note: toolCallId can include underscores (e.g. "call_..."), so match everything after the prefix.
    const isToolCallFile =
      /^(bash-input|bash-output|execute-input|execute-output)-.+$/.test(
        fileName,
      );

    if (isToolCallFile) {
      return vscode.Uri.from({
        scheme: ReadonlyFileSystemProvider.scheme,
        path: `/${fileName}`,
      });
    }

    // For other cases, keep the original approach with timestamp to avoid collisions.
    const timestamp = Date.now();
    const hash = Buffer.from(content.substring(0, 100)).toString('base64url');
    const uniqueId = `${timestamp}-${hash.substring(0, 8)}`;
    return vscode.Uri.from({
      scheme: ReadonlyFileSystemProvider.scheme,
      path: `/${fileName}-${uniqueId}`,
    });
  }

  /**
   * Create a URI for a readonly temporary file (instance method)
   */
  createUri(fileName: string, content: string): vscode.Uri {
    return ReadonlyFileSystemProvider.createUri(fileName, content);
  }

  /**
   * Set content for a URI
   */
  setContent(uri: vscode.Uri, content: string): void {
    const buffer = Buffer.from(content, 'utf8');
    const key = uri.toString();
    const existed = this.files.has(key);
    this.files.set(key, buffer);
    this.emitter.fire([
      {
        type: existed
          ? vscode.FileChangeType.Changed
          : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }

  /**
   * Get content for a URI
   */
  getContent(uri: vscode.Uri): string | undefined {
    const buffer = this.files.get(uri.toString());
    return buffer ? Buffer.from(buffer).toString('utf8') : undefined;
  }

  // FileSystemProvider implementation

  watch(): vscode.Disposable {
    // No watching needed for readonly files
    return new vscode.Disposable(() => {});
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const buffer = this.files.get(uri.toString());
    if (!buffer) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return {
      type: vscode.FileType.File,
      ctime: Date.now(),
      mtime: Date.now(),
      size: buffer.byteLength,
    };
  }

  readDirectory(): Array<[string, vscode.FileType]> {
    // Not needed for our use case
    return [];
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Readonly file system');
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const buffer = this.files.get(uri.toString());
    if (!buffer) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return buffer;
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean },
  ): void {
    // Check if file exists
    const exists = this.files.has(uri.toString());

    // For readonly files, only allow creation, not modification
    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }
    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    this.files.set(uri.toString(), content);
    this.emitter.fire([
      {
        type: exists
          ? vscode.FileChangeType.Changed
          : vscode.FileChangeType.Created,
        uri,
      },
    ]);
  }

  delete(uri: vscode.Uri): void {
    if (!this.files.has(uri.toString())) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.files.delete(uri.toString());
    this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Readonly file system');
  }

  /**
   * Clear all cached files
   */
  clear(): void {
    this.files.clear();
  }

  dispose(): void {
    this.clear();
    this.disposables.forEach((d) => d.dispose());
    // Clear global instance on dispose
    if (ReadonlyFileSystemProvider.instance === this) {
      ReadonlyFileSystemProvider.instance = null;
    }
  }
}

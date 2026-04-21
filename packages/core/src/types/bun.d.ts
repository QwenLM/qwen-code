/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bun runtime type declarations
 * These types are available when running with Bun runtime
 */

declare global {
  /**
   * Bun runtime global object
   */
  var Bun: {
    /**
     * Bun version
     */
    readonly version: string;

    /**
     * Embedded files in compiled binary
     */
    readonly embeddedFiles: Array<{
      name: string;
      text(): Promise<string>;
      blob(): Blob;
      stream(): ReadableStream<Uint8Array>;
    }>;

    /**
     * Built-in YAML parser
     */
    readonly YAML: {
      parse(input: string): unknown;
      stringify(input: Record<string, unknown>): string;
    };

    /**
     * File API
     */
    file(path: string): {
      text(): Promise<string>;
      json(): Promise<unknown>;
      exists(): boolean;
    };

    /**
     * Write file
     */
    write(path: string, content: string | Blob | ArrayBuffer): Promise<void>;

    /**
     * Spawn subprocess
     */
    spawn<T extends 'pipe' | 'ignore' | 'inherit'>(options: {
      cmd: string[];
      cwd?: string;
      env?: Record<string, string>;
      stdout?: T;
      stderr?: T;
    }): {
      stdout: T extends 'pipe' ? ReadableStream<Uint8Array> : null;
      stderr: T extends 'pipe' ? ReadableStream<Uint8Array> : null;
      exitCode: number | null;
      exited: Promise<number>;
    };

    /**
     * Shell execution
     */
    $: {
      (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }>;
      quiet(): {
        (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ): Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>;
      };
    };

    /**
     * Generate UUID v7
     */
    randomUUIDv7(): string;

    /**
     * Generate random bytes
     */
    randomBytes(length: number): Uint8Array;

    /**
     * Build API
     */
    build(options: {
      entrypoints: string[];
      outdir?: string;
      target?: string;
      compile?: boolean;
      bytecode?: boolean;
      minify?: boolean | { whitespace?: boolean; syntax?: boolean };
      define?: Record<string, string>;
      external?: string[];
      sourcemap?: 'external' | 'inline' | 'none';
    }): Promise<{
      success: boolean;
      outputs: Array<{ path: string }>;
      logs: Array<{ message: string }>;
    }>;
  };

  /**
   * Extend ProcessVersions to include bun
   */
  interface ProcessVersions {
    bun?: string;
  }
}

export {};

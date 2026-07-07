/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable no-console, @typescript-eslint/no-explicit-any */
/**
 * LSP End-to-End Test Script
 *
 * Directly instantiates NativeLspService against real LSP servers
 * (typescript-language-server, clangd, jdtls) to verify all 12 LSP methods
 * return correct results after the ensureDocumentOpen delay fix.
 *
 * Key design decisions:
 * - Uses per-method cursor positions (different LSP methods need different
 *   positions, e.g. implementations requires an interface, call hierarchy
 *   requires a function with both callers and callees).
 * - Warms up the server by calling documentSymbols first (opens the file),
 *   then waits for the server to index before testing timing-sensitive
 *   methods like hover and definitions.
 *
 * Usage: npx tsx packages/core/src/lsp/__e2e__/lsp-e2e-test.ts
 */

import { NativeLspService } from '../NativeLspService.js';
import { EventEmitter } from 'events';
import { pathToFileURL } from 'url';
import * as path from 'path';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

interface TestResult {
  method: string;
  language: string;
  passed: boolean;
  detail: string;
}

const results: TestResult[] = [];

function record(
  method: string,
  language: string,
  passed: boolean,
  detail: string,
): void {
  results.push({ method, language, passed, detail });
  const icon = passed ? green('PASS') : red('FAIL');
  console.log(`  [${icon}] ${language}/${method}: ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build an LSP location object from file path + 0-indexed line/char. */
function loc(filePath: string, line: number, char: number) {
  return {
    uri: pathToFileURL(filePath).toString(),
    range: {
      start: { line, character: char },
      end: { line, character: char },
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Per-method cursor position config                                 */
/* ------------------------------------------------------------------ */
interface MethodPositions {
  /** File + position for hover (on a type name or variable) */
  hover: { file: string; line: number; char: number };
  /** File + position for go-to-definition (on a function/method call) */
  definitions: { file: string; line: number; char: number };
  /** File + position for find-references (on a function/method name) */
  references: { file: string; line: number; char: number };
  /** File for documentSymbols (any file with multiple symbols) */
  documentSymbolsFile: string;
  /** Query string for workspaceSymbols */
  symbolQuery: string;
  /** File + position for implementations (on an interface/base class) */
  implementations: { file: string; line: number; char: number };
  /** File + position for call hierarchy (on a function that has callers AND callees) */
  callHierarchy: { file: string; line: number; char: number };
  /** File for diagnostics / codeActions */
  diagnosticsFile: string;
}

interface LanguageTestConfig {
  langName: string;
  workspaceRoot: string;
  positions: MethodPositions;
  /** Extra wait time (ms) after opening a file for server to index. */
  indexWaitMs: number;
  /**
   * Methods where empty results are acceptable due to known server
   * limitations (e.g. clangd doesn't implement callHierarchy/outgoingCalls).
   * These methods will pass with a "Server limitation" note instead of failing.
   */
  serverLimitedMethods?: Set<string>;
}

/* ------------------------------------------------------------------ */
/*  Service factory (lightweight mocks for config/workspace)          */
/* ------------------------------------------------------------------ */
function createService(workspaceRoot: string): NativeLspService {
  const config = {
    isTrustedFolder: () => true,
    getProjectRoot: () => workspaceRoot,
    get: () => undefined,
    getActiveExtensions: () => [],
  };
  const workspaceContext = {
    getDirectories: () => [workspaceRoot],
    isPathWithinWorkspace: () => true,
    fileExists: async () => false,
    readFile: async () => '{}',
    resolvePath: (p: string) => path.resolve(workspaceRoot, p),
  };
  const fileDiscovery = {
    discoverFiles: async () => [],
    shouldIgnoreFile: () => false,
  };

  return new NativeLspService(
    config as any,
    workspaceContext as any,
    new EventEmitter(),
    fileDiscovery as any,
    {} as any,
    { workspaceRoot, requireTrustedWorkspace: false },
  );
}

/* ------------------------------------------------------------------ */
/*  Per-language test runner                                          */
/* ------------------------------------------------------------------ */
async function testLanguage(cfg: LanguageTestConfig): Promise<void> {
  const {
    langName,
    workspaceRoot,
    positions,
    indexWaitMs,
    serverLimitedMethods,
  } = cfg;
  const isServerLimited = (method: string) =>
    serverLimitedMethods?.has(method) ?? false;

  console.log(bold(`\n=============== ${langName} ===============`));
  console.log(`  workspace : ${workspaceRoot}`);

  const service = createService(workspaceRoot);

  try {
    /* ---------- startup ---------- */
    console.log(`  Discovering and starting LSP server...`);
    await service.discoverAndPrepare();
    await service.start();

    const status = service.getStatus();
    const serverStatuses = Array.from(status.entries());
    if (serverStatuses.length === 0) {
      record('startup', langName, false, 'No servers discovered');
      return;
    }
    let anyReady = false;
    for (const [name, s] of serverStatuses) {
      console.log(`  Server "${name}": ${s}`);
      if (s === 'READY') anyReady = true;
    }
    if (!anyReady) {
      record('startup', langName, false, 'No server reached READY');
      return;
    }
    record('startup', langName, true, 'Server ready');

    /* ---------- warmup: open main files via documentSymbols ---------- */
    // This triggers ensureDocumentOpen for each file, so the server starts
    // indexing. We then wait for full indexing before timing-sensitive tests.
    const filesToWarmUp = new Set<string>();
    filesToWarmUp.add(positions.hover.file);
    filesToWarmUp.add(positions.definitions.file);
    filesToWarmUp.add(positions.references.file);
    filesToWarmUp.add(positions.documentSymbolsFile);
    filesToWarmUp.add(positions.implementations.file);
    filesToWarmUp.add(positions.callHierarchy.file);
    filesToWarmUp.add(positions.diagnosticsFile);

    console.log(`  Warming up ${filesToWarmUp.size} file(s)...`);
    for (const file of filesToWarmUp) {
      const fileUri = pathToFileURL(file).toString();
      try {
        await service.documentSymbols(fileUri);
      } catch {
        // Ignore errors during warmup; files will be retried in actual tests
      }
    }

    console.log(`  Waiting ${indexWaitMs}ms for server to index...`);
    await sleep(indexWaitMs);

    /* ---------- 1. hover ---------- */
    try {
      const hoverLoc = loc(
        positions.hover.file,
        positions.hover.line,
        positions.hover.char,
      );
      const hover = await service.hover(hoverLoc);
      if (hover?.contents) {
        record(
          'hover',
          langName,
          true,
          `"${hover.contents.substring(0, 100)}"`,
        );
      } else {
        record('hover', langName, false, 'Empty/null result');
      }
    } catch (e: any) {
      record('hover', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 2. definitions ---------- */
    try {
      const defLoc = loc(
        positions.definitions.file,
        positions.definitions.line,
        positions.definitions.char,
      );
      const defs = await service.definitions(defLoc);
      record(
        'definitions',
        langName,
        defs.length > 0,
        defs.length > 0 ? `${defs.length} def(s)` : 'Empty result',
      );
    } catch (e: any) {
      record('definitions', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 3. references ---------- */
    try {
      const refLoc = loc(
        positions.references.file,
        positions.references.line,
        positions.references.char,
      );
      const refs = await service.references(refLoc, undefined, true);
      record(
        'references',
        langName,
        refs.length > 0,
        refs.length > 0 ? `${refs.length} ref(s)` : 'Empty result',
      );
    } catch (e: any) {
      record('references', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 4. documentSymbols ---------- */
    try {
      const docSymUri = pathToFileURL(positions.documentSymbolsFile).toString();
      const symbols = await service.documentSymbols(docSymUri);
      if (symbols.length > 0) {
        const names = symbols
          .slice(0, 5)
          .map((s) => s.name)
          .join(', ');
        record(
          'documentSymbols',
          langName,
          true,
          `${symbols.length} symbol(s): ${names}`,
        );
      } else {
        record('documentSymbols', langName, false, 'Empty result');
      }
    } catch (e: any) {
      record('documentSymbols', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 5. workspaceSymbols ---------- */
    try {
      const wsSymbols = await service.workspaceSymbols(positions.symbolQuery);
      if (wsSymbols.length > 0) {
        const names = wsSymbols
          .slice(0, 5)
          .map((s) => s.name)
          .join(', ');
        record(
          'workspaceSymbols',
          langName,
          true,
          `${wsSymbols.length} symbol(s): ${names}`,
        );
      } else {
        record('workspaceSymbols', langName, false, 'Empty result');
      }
    } catch (e: any) {
      record('workspaceSymbols', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 6. implementations ---------- */
    try {
      const implLoc = loc(
        positions.implementations.file,
        positions.implementations.line,
        positions.implementations.char,
      );
      const impls = await service.implementations(implLoc);
      record(
        'implementations',
        langName,
        impls.length > 0,
        impls.length > 0 ? `${impls.length} impl(s)` : 'Empty result',
      );
    } catch (e: any) {
      record('implementations', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 7/8/9. call hierarchy ---------- */
    try {
      const callLoc = loc(
        positions.callHierarchy.file,
        positions.callHierarchy.line,
        positions.callHierarchy.char,
      );
      const callItems = await service.prepareCallHierarchy(callLoc);
      if (callItems.length > 0) {
        record(
          'prepareCallHierarchy',
          langName,
          true,
          `${callItems.length} item(s): ${callItems[0]!.name}`,
        );

        try {
          const incoming = await service.incomingCalls(callItems[0]!);
          record(
            'incomingCalls',
            langName,
            incoming.length > 0,
            incoming.length > 0
              ? `${incoming.length} caller(s)`
              : 'Empty (no callers found)',
          );
        } catch (e: any) {
          record('incomingCalls', langName, false, `Error: ${e.message}`);
        }

        try {
          const outgoing = await service.outgoingCalls(callItems[0]!);
          if (outgoing.length > 0) {
            record(
              'outgoingCalls',
              langName,
              true,
              `${outgoing.length} callee(s)`,
            );
          } else if (isServerLimited('outgoingCalls')) {
            record(
              'outgoingCalls',
              langName,
              true,
              'Empty (server does not implement this method)',
            );
          } else {
            record(
              'outgoingCalls',
              langName,
              false,
              'Empty (no callees found)',
            );
          }
        } catch (e: any) {
          record('outgoingCalls', langName, false, `Error: ${e.message}`);
        }
      } else {
        record('prepareCallHierarchy', langName, false, 'Empty result');
        record('incomingCalls', langName, false, 'Skipped');
        record('outgoingCalls', langName, false, 'Skipped');
      }
    } catch (e: any) {
      record('prepareCallHierarchy', langName, false, `Error: ${e.message}`);
      record('incomingCalls', langName, false, 'Skipped');
      record('outgoingCalls', langName, false, 'Skipped');
    }

    /* ---------- 10. diagnostics ---------- */
    try {
      const diagUri = pathToFileURL(positions.diagnosticsFile).toString();
      const diags = await service.diagnostics(diagUri);
      // 0 diagnostics is fine for clean code
      record('diagnostics', langName, true, `${diags.length} diagnostic(s)`);
    } catch (e: any) {
      record('diagnostics', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 11. codeActions ---------- */
    try {
      const caUri = pathToFileURL(positions.diagnosticsFile).toString();
      const actions = await service.codeActions(
        caUri,
        { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
        { diagnostics: [], triggerKind: 'invoked' as const },
      );
      // 0 actions is fine when there are no diagnostics
      record('codeActions', langName, true, `${actions.length} action(s)`);
    } catch (e: any) {
      record('codeActions', langName, false, `Error: ${e.message}`);
    }

    /* ---------- 12. workspaceDiagnostics ---------- */
    try {
      const wsDiags = await service.workspaceDiagnostics();
      record(
        'workspaceDiagnostics',
        langName,
        true,
        `${wsDiags.length} file(s) with diagnostics`,
      );
    } catch (e: any) {
      record('workspaceDiagnostics', langName, false, `Error: ${e.message}`);
    }

    await service.stop();
  } catch (e: any) {
    console.log(red(`  Fatal error: ${e.message}`));
    console.log(e.stack);
    try {
      await service.stop();
    } catch {
      // Best-effort cleanup; ignore errors during shutdown
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Language configs                                                   */
/* ------------------------------------------------------------------ */

const TS_ROOT = '/tmp/lsp-e2e-test/ts-project';
const CPP_ROOT = '/tmp/lsp-e2e-test/cpp-project';
const JAVA_ROOT = '/tmp/lsp-e2e-test/java-project';

/**
 * TypeScript positions (all in index.ts / math.ts):
 *
 * index.ts:
 *   L0: import { createCalculator, Calculator } from './math.js';
 *   L1: (empty)
 *   L2: const calc: Calculator = createCalculator();
 *   L3: console.log(calc.add(1, 2));
 *   L4: console.log(calc.subtract(5, 3));
 *
 * math.ts:
 *   L0: export interface Calculator {
 *   L5: export class SimpleCalculator implements Calculator {
 *   L15: export function createCalculator(): Calculator {
 */
const tsConfig: LanguageTestConfig = {
  langName: 'TypeScript',
  workspaceRoot: TS_ROOT,
  indexWaitMs: 3000,
  positions: {
    // hover on `createCalculator` call: L2 char 27
    hover: { file: `${TS_ROOT}/src/index.ts`, line: 2, char: 27 },
    // definitions on `createCalculator` call → math.ts definition
    definitions: { file: `${TS_ROOT}/src/index.ts`, line: 2, char: 27 },
    // references on `Calculator` → found in both files
    references: { file: `${TS_ROOT}/src/index.ts`, line: 2, char: 12 },
    // documentSymbols on math.ts (has interface, class, function)
    documentSymbolsFile: `${TS_ROOT}/src/math.ts`,
    symbolQuery: 'Calculator',
    // implementations on `Calculator` interface → SimpleCalculator
    implementations: { file: `${TS_ROOT}/src/math.ts`, line: 0, char: 17 },
    // call hierarchy on `createCalculator` (called by index.ts, calls SimpleCalculator)
    callHierarchy: { file: `${TS_ROOT}/src/math.ts`, line: 15, char: 16 },
    diagnosticsFile: `${TS_ROOT}/src/index.ts`,
  },
};

/**
 * C++ positions (main.cpp / calculator.h / calculator.cpp):
 *
 * main.cpp:
 *   L0:  #include "calculator.h"
 *   L1:  #include <iostream>
 *   L2:  (empty)
 *   L3:  int addValues(Calculator& calc, int a, int b) {
 *   L4:      return calc.add(a, b);
 *   L5:  }
 *   ...
 *   L11: int computeSum(Calculator& calc) {
 *   L12:     return addValues(calc, 1, 2) + subtractValues(calc, 5, 3);
 *   L13: }
 *   ...
 *   L15: int main() {
 *   L16:     Calculator calc;
 *   L17:     int result = computeSum(calc);
 *   L18:     std::cout << result << std::endl;
 *   ...
 *
 * calculator.h:
 *   L0:  #pragma once
 *   L1:  (empty)
 *   L2:  class Calculator {
 *   L3:  public:
 *   L4:      int add(int a, int b);
 *   L5:      int subtract(int a, int b);
 *   ...
 *   L9:  class AdvancedCalculator : public Calculator {
 *
 * calculator.cpp:
 *   L0:  #include "calculator.h"
 *   L1:  (empty)
 *   L2:  int Calculator::add(int a, int b) {
 */
const cppConfig: LanguageTestConfig = {
  langName: 'C++',
  workspaceRoot: CPP_ROOT,
  indexWaitMs: 5000,
  // clangd v19.x does not implement callHierarchy/outgoingCalls (returns -32601)
  serverLimitedMethods: new Set(['outgoingCalls']),
  positions: {
    // hover on `Calculator` type at main.cpp L16:4 → class info
    hover: { file: `${CPP_ROOT}/src/main.cpp`, line: 16, char: 4 },
    // definitions on `computeSum` call at main.cpp L17:17 → L11 definition
    definitions: { file: `${CPP_ROOT}/src/main.cpp`, line: 17, char: 17 },
    // references on `add` method at calculator.h L4:8 → all usages
    references: { file: `${CPP_ROOT}/src/calculator.h`, line: 4, char: 8 },
    // documentSymbols on main.cpp → addValues, subtractValues, computeSum, main
    documentSymbolsFile: `${CPP_ROOT}/src/main.cpp`,
    symbolQuery: 'Calculator',
    // implementations on `Calculator` class at calculator.h L2:6
    // → should find AdvancedCalculator (derived class)
    implementations: { file: `${CPP_ROOT}/src/calculator.h`, line: 2, char: 6 },
    // call hierarchy on `computeSum` at main.cpp L11:4
    // → incomingCalls: main; outgoingCalls: addValues, subtractValues
    callHierarchy: { file: `${CPP_ROOT}/src/main.cpp`, line: 11, char: 4 },
    diagnosticsFile: `${CPP_ROOT}/src/main.cpp`,
  },
};

/**
 * Java positions (Main.java / Calculator.java / SimpleCalculator.java):
 *
 * Main.java:
 *   L0:  package com.test;
 *   L1:  (empty)
 *   L2:  public class Main {
 *   L3:      public static int computeSum(Calculator calc) {
 *   L4:          return calc.add(1, 2) + calc.subtract(5, 3);
 *   L5:      }
 *   L6:  (empty)
 *   L7:      public static void main(String[] args) {
 *   L8:          Calculator calc = new SimpleCalculator();
 *   L9:          int result = computeSum(calc);
 *   L10:         System.out.println(result);
 *   L11:     }
 *   L12: }
 *
 * Calculator.java:
 *   L0:  package com.test;
 *   L1:  (empty)
 *   L2:  public interface Calculator {
 *   L3:      int add(int a, int b);
 *
 * SimpleCalculator.java:
 *   L2:  public class SimpleCalculator implements Calculator {
 *   L4:      public int add(int a, int b) {
 */
const javaConfig: LanguageTestConfig = {
  langName: 'Java',
  workspaceRoot: JAVA_ROOT,
  indexWaitMs: 20000,
  positions: {
    // hover on `Calculator` type at Main.java L8:8 → interface info
    hover: {
      file: `${JAVA_ROOT}/src/main/java/com/test/Main.java`,
      line: 8,
      char: 8,
    },
    // definitions on `computeSum` call at Main.java L9:21 → L3 definition
    definitions: {
      file: `${JAVA_ROOT}/src/main/java/com/test/Main.java`,
      line: 9,
      char: 21,
    },
    // references on `add` at Calculator.java L3:8 → all usages
    references: {
      file: `${JAVA_ROOT}/src/main/java/com/test/Calculator.java`,
      line: 3,
      char: 8,
    },
    // documentSymbols on Main.java → Main class, computeSum, main
    documentSymbolsFile: `${JAVA_ROOT}/src/main/java/com/test/Main.java`,
    symbolQuery: 'Calculator',
    // implementations on `Calculator` interface at Calculator.java L2:17
    implementations: {
      file: `${JAVA_ROOT}/src/main/java/com/test/Calculator.java`,
      line: 2,
      char: 17,
    },
    // call hierarchy on `computeSum` at Main.java L3:22
    // → incomingCalls: main; outgoingCalls: add, subtract
    callHierarchy: {
      file: `${JAVA_ROOT}/src/main/java/com/test/Main.java`,
      line: 3,
      char: 22,
    },
    diagnosticsFile: `${JAVA_ROOT}/src/main/java/com/test/Main.java`,
  },
};

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */
async function main(): Promise<void> {
  console.log(bold('LSP End-to-End Test Suite'));
  console.log(
    'Verifying all 12 LSP methods with real servers (TS / C++ / Java)\n',
  );

  await testLanguage(tsConfig);
  await testLanguage(cppConfig);
  await testLanguage(javaConfig);

  /* ---------- Summary ---------- */
  console.log(bold('\n================== Summary =================='));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(
    `Total: ${results.length} | ${green(`Passed: ${passed}`)} | ${red(`Failed: ${failed}`)}`,
  );

  console.log(bold('\nPer Language:'));
  for (const lang of ['TypeScript', 'C++', 'Java']) {
    const lr = results.filter((r) => r.language === lang);
    const lp = lr.filter((r) => r.passed).length;
    const icon =
      lp === lr.length ? green('ALL PASS') : yellow(`${lp}/${lr.length}`);
    console.log(`  ${lang}: ${icon}`);
  }

  console.log(bold('\nPer Method:'));
  const methods = [
    'startup',
    'hover',
    'definitions',
    'references',
    'documentSymbols',
    'workspaceSymbols',
    'implementations',
    'prepareCallHierarchy',
    'incomingCalls',
    'outgoingCalls',
    'diagnostics',
    'codeActions',
    'workspaceDiagnostics',
  ];
  for (const m of methods) {
    const mr = results.filter((r) => r.method === m);
    const langs = mr
      .map((r) => (r.passed ? green(r.language) : red(r.language)))
      .join(' | ');
    console.log(`  ${m}: ${langs}`);
  }

  if (failed > 0) {
    console.log(yellow('\nFailed tests:'));
    for (const r of results.filter((rr) => !rr.passed)) {
      console.log(red(`  ${r.language}/${r.method}: ${r.detail}`));
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();

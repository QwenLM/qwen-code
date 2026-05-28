import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ComputerUseTool,
  buildLlmContent,
  buildDisplayText,
  coerceTypes,
} from './tool.js';
import { ComputerUseClient } from './client.js';
import { COMPUTER_USE_SCHEMAS } from './schemas.js';
import { saveInstallState, isPackageSpecApproved } from './install-state.js';
import { ToolConfirmationOutcome } from '../tools.js';
import type { Part } from '@google/genai';

function makeFakeClient(
  callToolImpl: (name: string, args: unknown) => Promise<unknown>,
) {
  // probeFinderPermissions calls get_app_state during runBootstrap to probe
  // macOS permissions. The probe requires an image content block to return
  // 'ok'; without one it blocks on 'screenRecording' permission.
  //
  // We intercept the FIRST get_app_state call (the bootstrap probe) to
  // simulate a healthy macOS environment (both permissions granted).
  // Subsequent get_app_state calls — the real tool invocation — are
  // forwarded to callToolImpl so that per-test assertions still work.
  let bootstrapProbeDone = false;
  const wrappedImpl = async (name: string, args: unknown) => {
    if (name === 'get_app_state' && !bootstrapProbeDone) {
      bootstrapProbeDone = true;
      return {
        content: [
          { type: 'text', text: '<AXApplication>Finder</AXApplication>' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        isError: false,
      };
    }
    return callToolImpl(name, args);
  };
  const fake = {
    isStarted: () => true,
    start: vi.fn(async () => {}),
    callTool: vi.fn(wrappedImpl),
    stop: vi.fn(async () => {}),
  };
  return fake as unknown as ComputerUseClient;
}

describe('ComputerUseTool', () => {
  beforeEach(() => {
    ComputerUseClient.setSharedForTest(undefined);
    // Auto-approve install so tool.test.ts doesn't block on the install
    // confirmation prompt. The bootstrap state machine is tested in detail
    // in bootstrap.test.ts; tool.test.ts focuses on the tool wrapper logic.
    process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'] = '1';
  });

  afterEach(() => {
    delete process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'];
  });

  it('exposes qwen-facing name with computer_use__ prefix', () => {
    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    expect(tool.name).toBe('computer_use__click');
    expect(tool.displayName).toBe('computer_use__click');
  });

  it('marks itself as deferred', () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    expect(tool.shouldDefer).toBe(true);
    expect(tool.alwaysLoad).toBe(false);
  });

  it('forwards execute() to the shared client with the upstream name', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: '[]' }],
      isError: false,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(fake.callTool).toHaveBeenCalledWith('list_apps', {});
  });

  it('returns an error result when client returns isError=true', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'something went wrong' }],
      isError: true,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    const invocation = tool.build({ app: 'TextEdit' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(String(result.llmContent)).toContain('something went wrong');
  });
});

// ---------------------------------------------------------------------------
// Bidirectional type coercion tests
// ---------------------------------------------------------------------------

describe('coerceTypes', () => {
  const schema = COMPUTER_USE_SCHEMAS.click.parameterSchema;

  // Direction 1: string → number (schema wants number, model sent string)
  it('coerces string x/y coordinates to numbers (schema type: number)', () => {
    const result = coerceTypes({ app: 'X', x: '500', y: '920' }, schema);
    expect(result['x']).toBe(500);
    expect(result['y']).toBe(920);
    expect(typeof result['x']).toBe('number');
    expect(typeof result['y']).toBe('number');
  });

  // Direction 2: number → string (schema wants string, model sent number)
  it('coerces integer element_index to string (schema type: string)', () => {
    const result = coerceTypes({ app: 'X', element_index: 11 }, schema);
    expect(result['element_index']).toBe('11');
    expect(typeof result['element_index']).toBe('string');
  });

  it('leaves string element_index unchanged (already correct type)', () => {
    const result = coerceTypes({ app: 'X', element_index: '11' }, schema);
    expect(result['element_index']).toBe('11');
    expect(typeof result['element_index']).toBe('string');
  });

  it('does not coerce garbage strings — they remain strings and fail validation', () => {
    const result = coerceTypes({ app: 'X', x: 'abc' }, schema);
    // 'abc' is not a clean numeric string; stays as-is so AJV produces the correct type error
    expect(result['x']).toBe('abc');
  });

  it('does not coerce non-numeric string fields like app', () => {
    const result = coerceTypes(
      { app: 'com.apple.stocks', element_index: 5 },
      schema,
    );
    expect(result['app']).toBe('com.apple.stocks');
    expect(typeof result['app']).toBe('string');
  });

  it('passes through real numbers unchanged for number-typed fields', () => {
    const result = coerceTypes({ app: 'X', x: 100, y: 200 }, schema);
    expect(result['x']).toBe(100);
    expect(result['y']).toBe(200);
  });
});

describe('ComputerUseTool.build() coercion integration', () => {
  beforeEach(() => {
    ComputerUseClient.setSharedForTest(undefined);
    process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'] = '1';
  });

  afterEach(() => {
    delete process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'];
  });

  it('build() succeeds when element_index is a string (schema type: string)', () => {
    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    // element_index is type: "string" in upstream schema — "11" is already correct
    expect(() =>
      tool.build({ app: 'TextEdit', element_index: '11' }),
    ).not.toThrow();
  });

  it('build() succeeds when element_index is an integer (coerces to string)', () => {
    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    // qwen3.6 may send element_index: 11 (integer); coerceTypes converts to "11"
    expect(() =>
      tool.build({ app: 'TextEdit', element_index: 11 }),
    ).not.toThrow();
  });

  it('build() forwards string element_index to client', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'clicked' }],
      isError: false,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    // Pass integer 11 — coercion should stringify it to "11" before forwarding
    const invocation = tool.build({ app: 'TextEdit', element_index: 11 });
    await invocation.execute(new AbortController().signal);

    // The client must receive the string "11", not the integer 11
    expect(fake.callTool).toHaveBeenCalledWith(
      'click',
      expect.objectContaining({ element_index: '11' }),
    );
  });

  it('build() accepts any string for element_index (string schema does not restrict values)', () => {
    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    // "abc" is a valid string — the schema only requires type: string, not numeric format
    expect(() =>
      tool.build({ app: 'TextEdit', element_index: 'abc' }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Confirmation pathway tests (install-approval UX)
// Mock install-state functions so we can inject per-test tmpHome behaviour
// without needing to spy on the non-configurable ESM `homedir` export.
// ---------------------------------------------------------------------------

// Shared state read by the mocks below — set in beforeEach.
let mockHome = '';

vi.mock('./install-state.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./install-state.js')>();
  return {
    ...real,
    isPackageSpecApproved: vi.fn(async (_home: string, spec: string) =>
      real.isPackageSpecApproved(mockHome, spec),
    ),
    saveInstallState: vi.fn(
      async (
        _home: string,
        state: Parameters<typeof real.saveInstallState>[1],
      ) => real.saveInstallState(mockHome, state),
    ),
    loadInstallState: vi.fn(async (_home?: string) =>
      real.loadInstallState(mockHome),
    ),
  };
});

describe('ComputerUseInvocation confirmation pathway', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'qwen-cu-tool-'));
    mockHome = tmpHome;
    ComputerUseClient.setSharedForTest(undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    ComputerUseClient.setSharedForTest(undefined);
  });

  it('getDefaultPermission returns ask when install state is absent', async () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const permission = await invocation.getDefaultPermission();
    expect(permission).toBe('ask');
  });

  it('getDefaultPermission returns allow when install state exists', async () => {
    const packageSpec =
      process.env['QWEN_COMPUTER_USE_PACKAGE'] ?? 'open-computer-use@latest';
    await saveInstallState(tmpHome, {
      approvedPackageSpec: packageSpec,
      approvedAtIso: new Date().toISOString(),
    });

    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const permission = await invocation.getDefaultPermission();
    expect(permission).toBe('allow');
  });

  it('getConfirmationDetails returns info dialog with install reason', async () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );

    expect(details.type).toBe('info');
    if (details.type === 'info') {
      expect(details.title).toContain('list_apps');
      expect(details.prompt).toContain('computer_use__list_apps');
      expect(details.prompt).toContain('50MB');
      expect(details.permissionRules).toContain('computer_use__list_apps');
    }
  });

  it('onConfirm(ProceedOnce) writes the install state file', async () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );

    await details.onConfirm(ToolConfirmationOutcome.ProceedOnce);

    const packageSpec =
      process.env['QWEN_COMPUTER_USE_PACKAGE'] ?? 'open-computer-use@latest';
    const approved = await isPackageSpecApproved(tmpHome, packageSpec);
    expect(approved).toBe(true);
  });

  it('onConfirm(Cancel) does NOT write the install state file', async () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );

    await details.onConfirm(ToolConfirmationOutcome.Cancel);

    const packageSpec =
      process.env['QWEN_COMPUTER_USE_PACKAGE'] ?? 'open-computer-use@latest';
    const approved = await isPackageSpecApproved(tmpHome, packageSpec);
    expect(approved).toBe(false);
  });

  it('onConfirm(ProceedAlwaysUser) also writes the install state file', async () => {
    const tool = new ComputerUseTool(
      'list_apps',
      COMPUTER_USE_SCHEMAS.list_apps,
    );
    const invocation = tool.build({});
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );

    await details.onConfirm(ToolConfirmationOutcome.ProceedAlwaysUser);

    const packageSpec =
      process.env['QWEN_COMPUTER_USE_PACKAGE'] ?? 'open-computer-use@latest';
    const approved = await isPackageSpecApproved(tmpHome, packageSpec);
    expect(approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Content transformation unit tests
// ---------------------------------------------------------------------------

describe('buildLlmContent', () => {
  it('returns a plain string when content has only text parts', () => {
    const content = [
      { type: 'text' as const, text: 'hello' },
      { type: 'text' as const, text: 'world' },
    ];
    const result = buildLlmContent(content, 'get_app_state');
    expect(typeof result).toBe('string');
    expect(result).toBe('hello\nworld');
  });

  it('returns Part[] when content includes an image part', () => {
    const content = [
      { type: 'text' as const, text: 'screenshot below' },
      {
        type: 'image' as const,
        mimeType: 'image/png',
        data: 'base64data==',
      },
    ];
    const result = buildLlmContent(content, 'get_app_state');
    expect(Array.isArray(result)).toBe(true);

    const parts = result as Part[];
    // text label for text block
    expect(parts.some((p) => p.text === 'screenshot below')).toBe(true);
    // contextual label for image
    expect(
      parts.some(
        (p) => p.text?.includes('image') && p.text.includes('image/png'),
      ),
    ).toBe(true);
    // inlineData part with the base64 payload
    const inlinePart = parts.find((p) => p.inlineData !== undefined);
    expect(inlinePart?.inlineData?.mimeType).toBe('image/png');
    expect(inlinePart?.inlineData?.data).toBe('base64data==');
  });

  it('returns Part[] with only the image when content has no text', () => {
    const content = [
      {
        type: 'image' as const,
        mimeType: 'image/jpeg',
        data: 'imgdata==',
      },
    ];
    const result = buildLlmContent(content, 'screenshot');
    expect(Array.isArray(result)).toBe(true);

    const parts = result as Part[];
    const inlinePart = parts.find((p) => p.inlineData !== undefined);
    expect(inlinePart?.inlineData?.mimeType).toBe('image/jpeg');
    expect(inlinePart?.inlineData?.data).toBe('imgdata==');
  });

  it('returns empty string for empty content', () => {
    const result = buildLlmContent([], 'noop');
    expect(result).toBe('');
  });
});

describe('buildDisplayText', () => {
  it('returns only text parts joined by newline', () => {
    const content = [
      { type: 'text' as const, text: 'line1' },
      { type: 'image' as const, mimeType: 'image/png', data: 'base64==' },
      { type: 'text' as const, text: 'line2' },
    ];
    expect(buildDisplayText(content)).toBe('line1\nline2');
  });

  it('returns empty string when there are no text parts', () => {
    const content = [
      { type: 'image' as const, mimeType: 'image/png', data: 'base64==' },
    ];
    expect(buildDisplayText(content)).toBe('');
  });
});

describe('execute() image content forwarding', () => {
  beforeEach(() => {
    ComputerUseClient.setSharedForTest(undefined);
    process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'] = '1';
  });

  afterEach(() => {
    delete process.env['QWEN_COMPUTER_USE_AUTO_APPROVE'];
    ComputerUseClient.setSharedForTest(undefined);
  });

  it('llmContent is Part[] containing inlineData when MCP returns an image', async () => {
    const fake = makeFakeClient(async () => ({
      content: [
        { type: 'text', text: 'app state captured' },
        { type: 'image', mimeType: 'image/png', data: 'PNGBASE64==' },
      ],
      isError: false,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool(
      'get_app_state',
      COMPUTER_USE_SCHEMAS.get_app_state,
    );
    const invocation = tool.build({ app: 'TextEdit' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.llmContent)).toBe(true);

    const parts = result.llmContent as Part[];
    const inlinePart = parts.find((p) => p.inlineData !== undefined);
    expect(inlinePart?.inlineData?.mimeType).toBe('image/png');
    expect(inlinePart?.inlineData?.data).toBe('PNGBASE64==');
  });

  it('llmContent is string when MCP returns only text', async () => {
    const fake = makeFakeClient(async () => ({
      content: [{ type: 'text', text: 'click confirmed' }],
      isError: false,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    const invocation = tool.build({ app: 'TextEdit', element_index: 1 });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeUndefined();
    expect(typeof result.llmContent).toBe('string');
    expect(result.llmContent).toBe('click confirmed');
  });

  it('error result still sets result.error when isError=true with image content', async () => {
    const fake = makeFakeClient(async () => ({
      content: [
        { type: 'text', text: 'error occurred' },
        { type: 'image', mimeType: 'image/png', data: 'ERRPNG==' },
      ],
      isError: true,
    }));
    ComputerUseClient.setSharedForTest(fake);

    const tool = new ComputerUseTool('click', COMPUTER_USE_SCHEMAS.click);
    const invocation = tool.build({ app: 'TextEdit', element_index: 0 });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('error occurred');
  });
});

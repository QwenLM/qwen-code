import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerUseTool } from './tool.js';
import { ComputerUseClient } from './client.js';
import { COMPUTER_USE_SCHEMAS } from './schemas.js';
import { saveInstallState, isPackageSpecApproved } from './install-state.js';
import { ToolConfirmationOutcome } from '../tools.js';

function makeFakeClient(
  callToolImpl: (name: string, args: unknown) => Promise<unknown>,
) {
  const fake = {
    isStarted: () => true,
    start: vi.fn(async () => {}),
    callTool: vi.fn(callToolImpl),
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

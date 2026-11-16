// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../adapters/types';
import { useWorkspaceFileChanges } from './useWorkspaceFileChanges';

const mock = vi.hoisted(() => ({
  ignored: vi.fn(),
  workspaceByCwd: vi.fn(),
  features: ['workspace_git_check_ignore'],
  connection: {
    status: 'connected',
    loadingTranscript: false,
  },
  capabilitiesReady: true,
  sessionStatus: vi.fn(),
  availability: 'available',
}));
const client = {
  workspaceByCwd: mock.workspaceByCwd,
  sessionStatus: mock.sessionStatus,
};
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({
    client,
    capabilities: mock.capabilitiesReady
      ? { features: mock.features }
      : undefined,
  }),
  useConnection: () => mock.connection,
}));
vi.mock('../../daemon/availability-context', () => ({
  useDaemonAvailability: () => mock.availability,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const artifacts = new Map();
let root: Root;
let output: ReturnType<typeof useWorkspaceFileChanges>;

function messages(...paths: string[]): Message[] {
  return [
    { id: 'turn', role: 'user', content: 'edit' },
    {
      id: 'tools',
      role: 'tool_group',
      tools: paths.map((file_path, index) => ({
        callId: `call-${index}`,
        toolName: 'write_file',
        status: 'completed',
        args: { file_path, content: 'hello\n' },
      })),
    },
  ];
}

function Host({
  input,
  session = 'session-1',
  cwd = '/project',
  gitCwd,
}: {
  input: Message[];
  session?: string;
  cwd?: string;
  gitCwd?: string | null;
}) {
  output = useWorkspaceFileChanges(input, artifacts, cwd, session, gitCwd);
  return null;
}

beforeEach(() => {
  artifacts.clear();
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mock.features = ['workspace_git_check_ignore'];
  mock.connection.status = 'connected';
  mock.connection.loadingTranscript = false;
  mock.capabilitiesReady = true;
  mock.availability = 'available';
  mock.sessionStatus.mockReset().mockResolvedValue({});
  mock.workspaceByCwd.mockReturnValue({
    workspaceGitIgnoredPaths: mock.ignored,
  });
  mock.ignored.mockResolvedValue({ ignoredPaths: ['ignored.log'] });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe('useWorkspaceFileChanges', () => {
  it('only resolves metadata when file edits are loaded', async () => {
    await act(async () => root.render(<Host input={[]} />));
    expect(mock.sessionStatus).not.toHaveBeenCalled();
    mock.connection.loadingTranscript = true;
    const input = messages('/project/source.ts');
    await act(async () => root.render(<Host input={input} />));
    expect(mock.sessionStatus).not.toHaveBeenCalled();
    mock.connection.loadingTranscript = false;
    await act(async () => root.render(<Host input={input} />));
    expect(mock.sessionStatus).toHaveBeenCalledTimes(1);
    expect(output.get('turn')).toHaveLength(1);
  });

  it('does not resolve metadata while the shell is disconnected', async () => {
    mock.features = [];
    mock.connection.status = 'disconnected';
    const input = messages('source.ts');
    await act(async () => root.render(<Host input={input} />));
    expect(mock.sessionStatus).not.toHaveBeenCalled();
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      'source.ts',
    ]);
  });

  it('does not resolve metadata while the daemon is unavailable', async () => {
    mock.features = [];
    mock.availability = 'unavailable';
    const input = messages('source.ts');
    await act(async () => root.render(<Host input={input} />));
    expect(mock.sessionStatus).not.toHaveBeenCalled();
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      'source.ts',
    ]);
  });

  it('resolves worktree containment without the ignore capability', async () => {
    mock.features = [];
    const cwd = '/repo/.qwen/worktrees/one';
    mock.sessionStatus.mockResolvedValue({ worktree: { path: cwd } });
    await act(async () =>
      root.render(
        <Host
          cwd="/repo/packages/web"
          input={messages(`${cwd}/source.ts`, '/repo/packages/web/base.ts')}
        />,
      ),
    );
    expect(mock.sessionStatus).toHaveBeenCalledWith('session-1');
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      `${cwd}/source.ts`,
    ]);
    expect(mock.ignored).not.toHaveBeenCalled();
  });

  it('retains Live edits when the session does not expose its working directory', async () => {
    await act(async () =>
      root.render(
        <Host
          cwd=""
          gitCwd={null}
          input={messages('/conversations/notes/report.md')}
        />,
      ),
    );
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      '/conversations/notes/report.md',
    ]);
    expect(mock.ignored).not.toHaveBeenCalled();
  });

  it('matches worktree artifacts against the base workspace', async () => {
    const cwd = '/project/.qwen/worktrees/one';
    artifacts.set('turn', [
      { workspacePath: '.qwen/worktrees/one/reports/data.csv' },
    ]);
    await act(async () =>
      root.render(
        <Host gitCwd={cwd} input={messages(`${cwd}/reports/data.csv`)} />,
      ),
    );
    expect(output.get('turn')?.[0].isArtifact).toBe(true);
    expect(mock.ignored).toHaveBeenCalledWith(
      ['reports/data.csv'],
      cwd,
      'session-1',
    );
    expect(mock.sessionStatus).not.toHaveBeenCalled();
  });

  it('uses the real parent for both metadata and Git when given a virtual session', async () => {
    const parent = '11111111-1111-4111-8111-111111111111';
    const virtual = `subagent.${btoa(parent).replace(/=+$/, '')}.YWdlbnQ`;
    const cwd = '/project/.qwen/worktrees/a';
    mock.sessionStatus.mockResolvedValue({ worktree: { path: cwd } });
    mock.ignored.mockImplementation(async (_paths, _cwd, sessionId) => {
      if (sessionId !== parent) throw new Error('invalid_cwd');
      return { v: 1, ignoredPaths: ['ignored.log'] };
    });
    await act(async () =>
      root.render(
        <Host
          input={messages(`${cwd}/source.ts`, `${cwd}/ignored.log`)}
          session={virtual}
        />,
      ),
    );
    expect(mock.sessionStatus).toHaveBeenCalledWith(parent);
    expect(mock.ignored).toHaveBeenCalledWith(
      ['source.ts', 'ignored.log'],
      cwd,
      parent,
    );
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      `${cwd}/source.ts`,
    ]);
  });

  it('waits for execution metadata before showing ignored paths', async () => {
    let finish!: (value: object) => void;
    mock.sessionStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () =>
      root.render(<Host input={messages('source.ts', 'ignored.log')} />),
    );
    expect(output.size).toBe(0);
    expect(mock.ignored).not.toHaveBeenCalled();
    await act(async () => finish({}));
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      'source.ts',
    ]);
  });

  it('settles a failed metadata request into containment-only fallback', async () => {
    mock.sessionStatus.mockRejectedValueOnce(new Error('offline'));
    await act(async () =>
      root.render(
        <Host
          input={messages('source.ts', 'ignored.log', '/elsewhere/a.ts')}
        />,
      ),
    );
    expect(output.get('turn')).toHaveLength(2);
    expect(mock.ignored).not.toHaveBeenCalled();
  });
  it('keeps known cards while a new path waits for classification', async () => {
    const input = messages('source.ts');
    await act(async () => root.render(<Host input={input} />));
    let finish: (value: { ignoredPaths: string[] }) => void = () => {};
    mock.ignored.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () =>
      root.render(<Host input={messages('source.ts', 'new.ts')} />),
    );
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      'source.ts',
    ]);
    await act(async () => finish({ ignoredPaths: [] }));
    expect(output.get('turn')).toHaveLength(2);
  });

  it('does not invalidate known cards for an external memory edit', async () => {
    await act(async () => root.render(<Host input={messages('source.ts')} />));
    await act(async () =>
      root.render(<Host input={messages('source.ts', '/global/memory.md')} />),
    );
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      'source.ts',
    ]);
    expect(mock.ignored).toHaveBeenCalledTimes(1);
  });

  it('retries a failed verdict when the session reconnects', async () => {
    const input = messages('source.ts', 'ignored.log');
    mock.ignored.mockRejectedValueOnce(new Error('temporary failure'));
    await act(async () => root.render(<Host input={input} />));
    expect(output.get('turn')).toHaveLength(2);
    mock.connection.status = 'disconnected';
    await act(async () => root.render(<Host input={input} />));
    mock.connection.status = 'connected';
    await act(async () => root.render(<Host input={input} />));
    expect(mock.ignored).toHaveBeenCalledTimes(2);
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      'source.ts',
    ]);
  });

  it('keeps standalone outputs and unknown execution roots without querying a base checkout', async () => {
    await act(async () =>
      root.render(
        <Host
          input={messages('/output/report.md', '/other/outside.md')}
          cwd="/output"
          gitCwd={null}
        />,
      ),
    );
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      '/output/report.md',
    ]);
    expect(mock.ignored).not.toHaveBeenCalled();
  });

  it('waits for capabilities on a cold load', async () => {
    mock.capabilitiesReady = false;
    const input = messages('source.ts', 'ignored.log');
    await act(async () => root.render(<Host input={input} />));
    expect(output.size).toBe(0);
    mock.capabilitiesReady = true;
    await act(async () => root.render(<Host input={input} />));
    expect(output.get('turn')).toHaveLength(1);
  });

  it('queries only contained files and filters ignored edits', async () => {
    const input = messages(
      '/project/src/a.ts',
      '/project/ignored.log',
      '/project-other/outside.ts',
      '/global/memory.md',
    );
    await act(async () => root.render(<Host input={input} />));
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      '/project/src/a.ts',
    ]);
    expect(mock.workspaceByCwd).toHaveBeenCalledWith('/project');
    expect(mock.ignored).toHaveBeenCalledWith(
      ['src/a.ts', 'ignored.log'],
      undefined,
      'session-1',
    );
    expect(input).toHaveLength(2);
  });

  it('retains containment filtering with old or unavailable daemons', async () => {
    const input = messages('source.ts', 'ignored.log', '../outside.ts');
    mock.features = [];
    await act(async () => root.render(<Host input={input} />));
    expect(output.get('turn')).toHaveLength(2);
    expect(mock.ignored).not.toHaveBeenCalled();
    mock.features = ['workspace_git_check_ignore'];
    mock.ignored.mockRejectedValue(new Error('offline'));
    await act(async () => root.render(<Host input={input} />));
    expect(output.get('turn')).toHaveLength(2);
  });

  it('does not re-query while assistant text streams without new file edits', async () => {
    const input = messages('source.ts', 'ignored.log');
    await act(async () => root.render(<Host input={input} />));
    await act(async () =>
      root.render(
        <Host
          input={[
            ...input,
            { id: 'assistant', role: 'assistant', content: 'more text' },
          ]}
        />,
      ),
    );
    expect(mock.ignored).toHaveBeenCalledTimes(1);
    expect(output.get('turn')).toHaveLength(1);
  });

  it('discards a late response after switching sessions', async () => {
    let finish: (value: { ignoredPaths: string[] }) => void = () => {};
    mock.ignored.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const input = messages('source.ts');
    await act(async () => root.render(<Host input={input} />));
    mock.ignored.mockResolvedValue({ ignoredPaths: [] });
    await act(async () =>
      root.render(<Host input={input} session="session-2" />),
    );
    await act(async () => finish({ ignoredPaths: ['source.ts'] }));
    expect(output.get('turn')).toHaveLength(1);
  });

  it('rechecks ignores after another edit to an already aggregated path', async () => {
    const input = messages('.gitignore', 'ignored.log');
    mock.ignored.mockResolvedValueOnce({ ignoredPaths: [] });
    await act(async () => root.render(<Host input={input} />));
    expect(output.get('turn')).toHaveLength(2);
    const updated: Message[] = [
      ...input,
      {
        id: 'more-tools',
        role: 'tool_group',
        tools: [
          {
            callId: 'edit-ignore',
            toolName: 'edit',
            status: 'completed',
            args: {
              file_path: '.gitignore',
              old_string: '',
              new_string: '*.log',
            },
          },
        ],
      },
    ];
    await act(async () => root.render(<Host input={updated} />));
    expect(mock.ignored).toHaveBeenCalledTimes(2);
    expect(output.get('turn')?.map((change) => change.path)).toEqual([
      '.gitignore',
    ]);
  });

  it('uses a session worktree as scope and the base workspace as owner', async () => {
    mock.ignored.mockResolvedValue({ ignoredPaths: ['ignored.log'] });
    await act(async () =>
      root.render(
        <Host
          input={messages(
            '/project/.qwen/worktrees/a/ignored.log',
            '/project/source.ts',
          )}
          gitCwd="/project/.qwen/worktrees/a"
        />,
      ),
    );
    expect(mock.workspaceByCwd).toHaveBeenCalledWith('/project');
    expect(mock.ignored).toHaveBeenCalledWith(
      ['ignored.log'],
      '/project/.qwen/worktrees/a',
      'session-1',
    );
    expect(output.size).toBe(0);
  });

  it('queries a large history in bounded batches', async () => {
    mock.ignored.mockResolvedValue({ ignoredPaths: [] });
    await act(async () =>
      root.render(
        <Host
          input={messages(
            ...Array.from({ length: 257 }, (_, index) => `source${index}.ts`),
          )}
        />,
      ),
    );
    expect(mock.ignored.mock.calls.map(([paths]) => paths.length)).toEqual([
      256, 1,
    ]);
    expect(output.get('turn')).toHaveLength(257);
  });
});

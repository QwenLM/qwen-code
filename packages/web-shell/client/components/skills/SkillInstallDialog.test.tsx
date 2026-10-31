// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { DaemonSkillInstallError } from '@qwen-code/sdk/daemon';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider, type WebShellLanguage } from '../../i18n';
import { SkillInstallDialog } from './SkillInstallDialog';

let container: HTMLDivElement;
let root: Root;
const onInstall = vi.fn();
const onOpenChange = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onInstall.mockReset();
  onOpenChange.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function renderDialog(
  language: WebShellLanguage = 'en',
  archive?: ComponentProps<typeof SkillInstallDialog>['archive'],
) {
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
        <SkillInstallDialog
          open
          onOpenChange={onOpenChange}
          onInstall={onInstall}
          archive={archive}
        />
      </I18nProvider>,
    );
  });
  const inputs = document.querySelectorAll('input');
  await act(async () => {
    for (const [index, value] of [
      'demo',
      'https://github.com/example/skills/blob/main/demo/SKILL.md',
    ].entries()) {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(inputs[index], value);
      inputs[index].dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

async function submit(language: WebShellLanguage = 'en') {
  const button = Array.from(document.querySelectorAll('button')).find(
    (item) =>
      item.textContent?.trim() === (language === 'zh-CN' ? '上传' : 'Upload'),
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
}

function rejectWith(code: string, detail: string) {
  onInstall.mockRejectedValueOnce(
    Object.assign(new Error('Skill request failed'), {
      body: { code, error: detail },
    }),
  );
}

const frontmatterError =
  'Failed to parse skill file: Invalid format: missing YAML frontmatter';

async function selectZip(size = 3) {
  const tab = Array.from(document.querySelectorAll('[role="tab"]')).find(
    (tab) => tab.textContent === 'ZIP',
  );
  await act(async () => {
    tab!.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, button: 0 }),
    );
  });
  const file = new File(['zip'], 'demo.zip', { type: 'application/zip' });
  Object.defineProperty(file, 'size', { value: size });
  const read = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
  Object.defineProperty(file, 'arrayBuffer', { value: read });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(input).not.toBeNull();
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () =>
    input.dispatchEvent(new Event('change', { bubbles: true })),
  );
  return { file, read };
}

describe('native Skill archive dialog', () => {
  const attemptId = '87ff2204-4713-49bf-929e-cc46e83ab710';
  const installed = {
    skillName: 'demo',
    scope: 'workspace' as const,
    attemptId,
    archiveSha256: 'a'.repeat(64),
  };
  const receipt = {
    attemptId,
    skillName: 'demo',
    scope: 'workspace' as const,
    workspaceId: 'owner',
    state: 'committed' as const,
    phase: 'cleanup' as const,
    result: installed,
  };
  function archive() {
    return {
      limits: {
        maxSkillArchiveBytes: 50 * 1024 * 1024,
        maxSkillArchiveExpandedBytes: 200 * 1024 * 1024,
        maxSkillArchiveEntries: 4096,
        maxSkillArchiveManifestBytes: 32 * 1024 * 1024,
      },
      install: vi
        .fn<
          NonNullable<
            ComponentProps<typeof SkillInstallDialog>['archive']
          >['install']
        >()
        .mockResolvedValue(installed),
      lookup: vi
        .fn<
          NonNullable<
            ComponentProps<typeof SkillInstallDialog>['archive']
          >['lookup']
        >()
        .mockResolvedValue(receipt),
      committed: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('sends the original File without reading it and limits new help to the ZIP source', async () => {
    const api = archive();
    await renderDialog('en', api);
    expect(document.body.textContent).toContain('64 MiB total');
    expect(document.body.textContent).not.toContain('200 MiB');
    const { file, read } = await selectZip(20 * 1024 * 1024);
    expect(document.body.textContent).toContain('200 MiB extracted');
    await submit();
    expect(api.install).toHaveBeenCalledWith(
      expect.objectContaining({
        data: file,
        name: 'demo',
        signal: expect.any(AbortSignal),
      }),
      'workspace',
    );
    expect(read).not.toHaveBeenCalled();
    expect(onInstall).not.toHaveBeenCalled();
    expect(api.committed).toHaveBeenCalledWith(installed);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('prechecks the advertised native maximum without reading or sending the file', async () => {
    const api = archive();
    api.limits.maxSkillArchiveBytes = 10 * 1024 * 1024;
    await renderDialog('en', api);
    const { read } = await selectZip(12 * 1024 * 1024);
    await submit();
    expect(document.body.textContent).toContain('10 MiB compressed limit');
    expect(api.install).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('keeps base64 for an old daemon and rejects a large ZIP before reading it', async () => {
    await renderDialog();
    const small = await selectZip();
    await submit();
    expect(onInstall).toHaveBeenCalledWith({
      name: 'demo',
      scope: 'workspace',
      source: { type: 'zip', contentBase64: 'AQID' },
    });
    expect(small.read).toHaveBeenCalledOnce();
    await renderDialog();
    const large = await selectZip(8 * 1024 * 1024);
    await submit();
    expect(document.body.textContent).toContain('Upgrade the daemon');
    expect(large.read).not.toHaveBeenCalled();
    expect(onInstall).toHaveBeenCalledOnce();
  });

  it('cancels, queries once independently, then checks manually without resending', async () => {
    const api = archive();
    api.lookup.mockResolvedValueOnce(undefined);
    api.install.mockImplementationOnce(
      (request) =>
        new Promise((_resolve, reject) =>
          request.signal?.addEventListener(
            'abort',
            () =>
              reject(
                new DaemonSkillInstallError(attemptId, request.signal?.reason),
              ),
            { once: true },
          ),
        ),
    );
    await renderDialog('en', api);
    await selectZip();
    await submit();
    expect(onOpenChange).not.toHaveBeenCalled();
    const cancel = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Cancel installation',
    )!;
    expect(cancel.disabled).toBe(false);
    await act(async () => cancel.click());
    expect(api.lookup).toHaveBeenCalledExactlyOnceWith('workspace', attemptId);
    expect(document.body.textContent).toContain('could not be confirmed');
    const check = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Check result',
    )!;
    await act(async () => check.click());
    expect(api.lookup).toHaveBeenCalledTimes(2);
    expect(api.install).toHaveBeenCalledOnce();
    expect(onInstall).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('keeps the original owner callbacks after props change while the result is pending', async () => {
    const original = archive();
    original.install.mockRejectedValueOnce(
      new DaemonSkillInstallError(attemptId, new TypeError('disconnected')),
    );
    original.lookup.mockResolvedValueOnce({ ...receipt, state: 'running' });
    await renderDialog('en', original);
    await selectZip();
    await submit();
    expect(document.body.textContent).toContain('still running');
    const next = archive();
    await act(async () =>
      root.render(
        <I18nProvider language="en">
          <SkillInstallDialog
            open
            onOpenChange={onOpenChange}
            onInstall={onInstall}
            archive={next}
          />
        </I18nProvider>,
      ),
    );
    const check = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Check result',
    )!;
    await act(async () => check.click());
    expect(original.lookup).toHaveBeenCalledTimes(2);
    expect(original.committed).toHaveBeenCalledWith(installed);
    expect(next.lookup).not.toHaveBeenCalled();
    expect(next.committed).not.toHaveBeenCalled();
    expect(original.install).toHaveBeenCalledOnce();
  });

  it.each(['not_committed', 'recovery_required'] as const)(
    'shows a confirmed %s outcome without retrying',
    async (state) => {
      const api = archive();
      api.install.mockRejectedValueOnce(
        new DaemonSkillInstallError(
          attemptId,
          new DOMException('timeout', 'TimeoutError'),
        ),
      );
      api.lookup.mockResolvedValueOnce({
        ...receipt,
        state,
        error: {
          code: 'failed',
          message: 'specific cause',
          retainedPaths:
            state === 'recovery_required'
              ? ['/daemon/.backup-kept']
              : undefined,
        },
      });
      await renderDialog('en', api);
      await selectZip();
      await submit();
      expect(document.body.textContent).toContain('specific cause');
      expect(document.body.textContent).toContain(
        state === 'recovery_required'
          ? '/daemon/.backup-kept'
          : 'This archive was not installed',
      );
      expect(api.install).toHaveBeenCalledOnce();
      expect(api.lookup).toHaveBeenCalledOnce();
      expect(api.committed).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalled();
    },
  );

  it('does not reclassify a committed installation when client activation fails', async () => {
    const api = archive();
    api.committed.mockRejectedValueOnce(new Error('runtime unavailable'));
    await renderDialog('en', api);
    await selectZip();
    await submit();
    expect(document.body.textContent).toContain(
      'runtime activation failed: runtime unavailable',
    );
    expect(api.lookup).not.toHaveBeenCalled();
    expect(api.install).toHaveBeenCalledOnce();
  });
});

describe('SkillInstallDialog failure diagnostics', () => {
  it.each([
    ['en', 'first line of SKILL.md (remove any leading blank lines)'],
    ['zh-CN', 'SKILL.md 第一行直接以 --- 开始（删除前面的空行）'],
  ] as const)(
    'shows frontmatter repair guidance in %s',
    async (language, hint) => {
      rejectWith('invalid_skill_manifest', frontmatterError);
      await renderDialog(language);
      await submit(language);

      const alert = document.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(frontmatterError);
      expect(alert?.textContent).toContain(hint);
      expect(onOpenChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      'invalid_skill_manifest',
      'Missing "name" in frontmatter',
      'correct the field',
    ],
    [
      'invalid_skill_manifest',
      'Missing "description" in frontmatter',
      'correct the field',
    ],
    [
      'invalid_skill_manifest',
      '"allowedTools" must be an array',
      'correct the field',
    ],
    ['invalid_skill_manifest', '"model" must be a string', 'correct the field'],
    [
      'invalid_skill_manifest',
      '"paths" must be an array of glob patterns',
      'correct the field',
    ],
    [
      'skill_name_mismatch',
      'Skill name "authored" does not match requested name "demo"',
      'Make the entered skill name match',
    ],
    ['invalid_skill_name', 'Invalid skill name', 'ASCII letters'],
    [
      'invalid_skill_package',
      'Duplicate skill file path: scripts/run.sh',
      'Correct the reported file or package structure',
    ],
    [
      'skill_manifest_missing',
      'Skill package must contain a root SKILL.md',
      'at its root',
    ],
    [
      'unsafe_skill_path',
      'Refusing to replace an unsafe Skill path',
      'instead of symbolic links',
    ],
    [
      'github_skill_download_failed',
      'GitHub request failed (HTTP 503)',
      'Check the URL or authentication',
    ],
    [
      'skill_package_too_large',
      'Skill package exceeds the allowed size',
      '32 MiB per file or 64 MiB total',
    ],
    [
      'skill_too_many_files',
      'Skill package has too many files (max 2000)',
      'The skill package has too many files',
    ],
  ])('retains %s details: %s', async (code, detail, hint) => {
    rejectWith(code, detail);
    await renderDialog();
    await submit();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(detail);
    expect(alert?.textContent).toContain(hint);
  });

  it('does not mistake an invalid name for a missing frontmatter block', async () => {
    rejectWith(
      'invalid_skill_manifest',
      'Failed to parse skill file: "name" must match the allowed pattern; got "missing YAML frontmatter"',
    );
    await renderDialog();
    await submit();
    const text = document.querySelector('[role="alert"]')?.textContent;
    expect(text).toContain('correct the field');
    expect(text).not.toContain('remove any leading blank lines');
  });

  it('renders server details as plain text', async () => {
    const detail = 'Invalid name: <img src=x onerror="alert(1)">';
    rejectWith('invalid_skill_manifest', detail);
    await renderDialog();
    await submit();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(detail);
    expect(alert?.querySelector('img')).toBeNull();
  });

  it('preserves inputs on failure and closes after a successful retry', async () => {
    rejectWith('invalid_skill_manifest', frontmatterError);
    onInstall.mockResolvedValueOnce(undefined);
    await renderDialog();
    await submit();
    const request = {
      name: 'demo',
      scope: 'workspace',
      source: {
        type: 'github',
        url: 'https://github.com/example/skills/blob/main/demo/SKILL.md',
      },
    };
    expect(onInstall).toHaveBeenNthCalledWith(1, request);
    expect(document.querySelectorAll('input')[0].value).toBe('demo');
    expect(document.querySelectorAll('input')[1].value).toBe(
      request.source.url,
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    await submit();
    expect(onInstall).toHaveBeenNthCalledWith(2, request);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('preserves unknown errors and local validation feedback', async () => {
    onInstall.mockRejectedValueOnce(new Error('Connection interrupted'));
    await renderDialog();
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Connection interrupted',
    );

    await act(async () => {
      const name = document.querySelector('input')!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(name, '');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Enter the skill name.',
    );
    expect(onInstall).toHaveBeenCalledTimes(1);
  });
});

// @vitest-environment jsdom

import { act } from 'react';
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

async function renderDialog(language: WebShellLanguage = 'en') {
  await act(async () => {
    root.render(
      <I18nProvider language={language}>
        <SkillInstallDialog
          open
          onOpenChange={onOpenChange}
          onInstall={onInstall}
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

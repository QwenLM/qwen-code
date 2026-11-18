import { expect, test } from '@playwright/test';
import type { JavaAgentSession } from '../components/managed/java-managed-agent-client';

const SESSION_ID = 'managed-attach-session';
const SCOPE_REVISION = 'rev-1';

function sessionSummary(inputAttachments: boolean): JavaAgentSession {
  return {
    sessionId: SESSION_ID,
    title: 'Attachment conversation',
    agentId: 'qwen-code',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
    lastSequence: 0,
    workspace: {
      workspaceId: 'ws-a',
      cwdRelative: '.',
      contextRevision: 1,
      state: 'ready',
    },
    capabilities: {
      actions: false,
      artifacts: false,
      tasks: false,
      workspaceTurns: true,
      inputAttachments,
    },
  } as JavaAgentSession;
}

interface Captured {
  submits: {
    sessionId: string;
    input: { type: string; text?: string }[];
  }[];
  uploads: { query: URLSearchParams; bytes: number }[];
  fileQueries: Record<string, unknown>[];
  unexpected: string[];
}

async function mockManagedRoutes(
  page: import('@playwright/test').Page,
  options: { inputAttachments: boolean; maxUploadBytes?: number },
): Promise<Captured> {
  const captured: Captured = {
    submits: [],
    uploads: [],
    fileQueries: [],
    unexpected: [],
  };
  const summary = sessionSummary(options.inputAttachments);
  await page.route('**/api/agent/web-shell/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith('/files/upload')) {
      const body = request.postDataBuffer();
      captured.uploads.push({
        query: url.searchParams,
        bytes: body?.length ?? 0,
      });
      return route.fulfill({
        json: {
          uploadId: url.searchParams.get('uploadId'),
          path: url.searchParams.get('path'),
          sizeBytes: body?.length ?? 0,
          sha256: 'a'.repeat(64),
          scopeRevision: SCOPE_REVISION,
        },
      });
    }
    const body = request.postDataJSON();
    if (path.endsWith('/runtime-nodes/query'))
      return route.fulfill({ json: { supported: false, data: [] } });
    if (path.endsWith('/user-messages/query'))
      return route.fulfill({ json: { paused: false, messages: [] } });
    if (path.endsWith('/workspace-extensions/query'))
      return route.fulfill({ json: { supported: false, extensions: [] } });
    if (path.endsWith('/workspaces/worktrees/options'))
      return route.fulfill({ json: { supported: false } });
    if (path.endsWith('/session-skills/query'))
      return route.fulfill({ json: { skills: [] } });
    if (path.endsWith('/sessions/query'))
      return route.fulfill({ json: { data: [summary], hasMore: false } });
    if (path.endsWith('/sessions/get')) return route.fulfill({ json: summary });
    if (path.endsWith('/workspaces/query'))
      return route.fulfill({
        json: {
          data: [
            {
              workspaceId: 'ws-a',
              displayName: 'Project A',
              canCreateSession: true,
              state: 'active',
              defaultCwdRelative: '.',
            },
          ],
          hasMore: false,
          capabilities: { workspaceBinding: true },
        },
      });
    if (path.endsWith('/workspaces/get'))
      return route.fulfill({
        json: {
          workspaceId: 'ws-a',
          displayName: 'Project A',
          canCreateSession: true,
          state: 'active',
          defaultCwdRelative: '.',
        },
      });
    if (path.endsWith('/workspaces/files/query')) {
      captured.fileQueries.push(body);
      return route.fulfill({
        json: {
          scopeRevision: SCOPE_REVISION,
          directory: body.directory ?? '.',
          entries: [
            { path: 'existing.txt', name: 'existing.txt', kind: 'file' },
          ],
          truncated: false,
          ...(options.maxUploadBytes === undefined
            ? {}
            : { maxUploadBytes: options.maxUploadBytes }),
        },
      });
    }
    if (path.endsWith('/workspaces/files/uploads/query'))
      return route.fulfill({
        json: {
          uploadId: body.uploadId,
          state: 'completed',
          path: 'data.bin',
          sizeBytes: 4,
          sha256: 'a'.repeat(64),
          scopeRevision: SCOPE_REVISION,
        },
      });
    if (path.endsWith('/transcript/query'))
      return route.fulfill({
        json: {
          items: [],
          events: [],
          coveredSequence: 0,
          lastSequence: 0,
          hasMore: false,
        },
      });
    if (path.endsWith('/events/stream'))
      return route.fulfill({ contentType: 'text/event-stream', body: '' });
    if (path.endsWith('/turns/submit')) {
      captured.submits.push(body);
      return route.fulfill({
        status: 202,
        json: {
          sessionId: body.sessionId,
          turnId: `turn-${captured.submits.length}`,
          operationId: `op-${captured.submits.length}`,
          admissionStage: 'java_durable',
          deliveryState: 'pending',
          status: 'accepted',
          replayed: false,
        },
      });
    }
    captured.unexpected.push(path);
    return route.fulfill({
      status: 500,
      json: { error: `Unexpected request: ${path}` },
    });
  });
  return captured;
}

async function openSession(page: import('@playwright/test').Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`/e2e/fixtures/managed-usability.html?session=${SESSION_ID}`);
  const editor = page.locator('[data-web-shell-composer-editor] .cm-content');
  await expect(editor).toBeVisible();
  return { editor, errors };
}

async function pickComposerFile(
  page: import('@playwright/test').Page,
  entry: 'attach' | 'upload',
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await page.getByTestId('composer-add-menu-trigger').click();
  await page.getByTestId('composer-add-menu-file').click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByTestId(`composer-add-menu-file-${entry}`).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
}

test('Managed composer encodes an attached text file into the submitted input @smoke', async ({
  page,
}) => {
  const captured = await mockManagedRoutes(page, {
    inputAttachments: true,
    maxUploadBytes: 8 * 1024 * 1024,
  });
  const { editor, errors } = await openSession(page);
  await pickComposerFile(page, 'attach', {
    name: 'notes.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('attached notes body\n'),
  });
  await expect(
    page.locator('[data-web-shell-composer-attachments]'),
  ).toContainText('notes.md');
  await editor.fill('read the attachment');
  await editor.press('Enter');
  await expect.poll(() => captured.submits.length).toBe(1);
  expect(captured.submits[0].input).toEqual([
    { type: 'input_text', text: 'read the attachment' },
    {
      type: 'input_file',
      name: 'notes.md',
      mime_type: 'text/markdown',
      text: 'attached notes body\n',
    },
  ]);
  expect(captured.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test('Managed composer encodes an attached PNG into the submitted input @smoke', async ({
  page,
}) => {
  const captured = await mockManagedRoutes(page, {
    inputAttachments: true,
    maxUploadBytes: 8 * 1024 * 1024,
  });
  const { editor, errors } = await openSession(page);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await pickComposerFile(page, 'attach', {
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: png,
  });
  // Images render as a thumbnail strip with a remove control, not as a
  // named file card in the attachments container.
  await expect(
    page.getByRole('button', { name: 'Remove image' }),
  ).toBeVisible();
  await editor.fill('describe the image');
  await editor.press('Enter');
  await expect.poll(() => captured.submits.length).toBe(1);
  expect(captured.submits[0].input).toEqual([
    { type: 'input_text', text: 'describe the image' },
    {
      type: 'input_image',
      mime_type: 'image/png',
      data: png.toString('base64'),
    },
  ]);
  expect(captured.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test('Managed composer uploads a picked file to the Workspace and references its path @smoke', async ({
  page,
}) => {
  const captured = await mockManagedRoutes(page, {
    inputAttachments: true,
    maxUploadBytes: 8 * 1024 * 1024,
  });
  const { editor, errors } = await openSession(page);
  await expect.poll(() => captured.fileQueries.length).toBeGreaterThan(0);
  // Type first: the upload inserts its reference into the editor, and a
  // later fill() would replace the reference along with the draft text.
  await editor.fill('use the uploaded file');
  await pickComposerFile(page, 'upload', {
    name: 'data.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from([0, 1, 2, 3]),
  });
  await expect.poll(() => captured.uploads.length).toBe(1);
  expect(captured.uploads[0].query.get('sessionId')).toBe(SESSION_ID);
  expect(captured.uploads[0].query.get('path')).toBe('data.bin');
  expect(captured.uploads[0].query.get('expectedScopeRevision')).toBe(
    SCOPE_REVISION,
  );
  expect(captured.uploads[0].bytes).toBe(4);
  await editor.press('Enter');
  await expect.poll(() => captured.submits.length).toBe(1);
  const text = captured.submits[0].input
    .filter((block) => block.type === 'input_text')
    .map((block) => block.text)
    .join('\n');
  expect(text).toContain('use the uploaded file');
  expect(text).toContain('Uploaded Workspace files');
  expect(text).toContain('"data.bin"');
  expect(captured.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test('Managed composer hides attachment affordances without the inputAttachments capability @smoke', async ({
  page,
}) => {
  const captured = await mockManagedRoutes(page, { inputAttachments: false });
  const { editor, errors } = await openSession(page);
  await editor.fill('plain text only');
  const trigger = page.getByTestId('composer-add-menu-trigger');
  if (await trigger.isVisible()) {
    await trigger.click();
    await expect(page.getByTestId('composer-add-menu-file-attach')).toHaveCount(
      0,
    );
    await expect(page.getByTestId('composer-add-menu-file-upload')).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
  }
  await editor.press('Enter');
  await expect.poll(() => captured.submits.length).toBe(1);
  expect(captured.submits[0].input).toEqual([
    { type: 'input_text', text: 'plain text only' },
  ]);
  expect(captured.uploads).toEqual([]);
  expect(captured.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

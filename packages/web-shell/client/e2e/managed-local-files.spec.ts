import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

// The disposable peer lives on its own loopback port; headless Chromium
// auto-denies the Local Network Access permission prompt, so disable the
// check for this suite (the peer still answers the LNA preflight header).
test.use({
  launchOptions: {
    args: [
      '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests',
    ],
  },
});

/**
 * A disposable control-plane peer with a real, kept-open SSE downlink —
 * Playwright's route.fulfill cannot hold a stream open, so the browser
 * talks to this node server directly (the fixture takes ?api=<origin>).
 */
function startPeer(clientFilesEnabled: boolean): Promise<{
  server: Server;
  url: string;
  registered: Record<string, unknown>[];
  responses: Record<string, unknown>[];
  unregistered: Record<string, unknown>[];
}> {
  const registered: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  const unregistered: Record<string, unknown>[] = [];
  const heartbeats = new Set<NodeJS.Timeout>();
  const summary = {
    sessionId: 's1',
    title: 'Local files task',
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
    lastSequence: 1,
    capabilities: {
      tasks: true,
      artifacts: false,
      actions: false,
      workspaceTurns: true,
      sessionClose: false,
      sessionArchive: false,
      sessionUnarchive: false,
      sessionDelete: false,
      diagnostics: true,
      ...(clientFilesEnabled ? { clientFiles: true } : {}),
    },
  };
  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'content-type,x-qwen-tenant-id',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      // Chrome's Local Network Access check gates cross-port loopback
      // fetches; the preflight must acknowledge the private address space.
      'Access-Control-Allow-Private-Network': 'true',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      const json = (status: number, data: unknown) => {
        res.writeHead(status, {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
      };
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (path.endsWith('/sessions/query'))
        return json(200, { data: [summary], hasMore: false });
      if (path.endsWith('/sessions/get')) return json(200, summary);
      if (path.endsWith('/transcript/query'))
        return json(200, {
          items: [],
          events: [],
          coveredSequence: 0,
          olderCursor: null,
          hasMore: false,
          lastSequence: 0,
        });
      if (path.endsWith('/user-messages/query'))
        return json(200, { paused: false, messages: [] });
      if (path.endsWith('/runtime-nodes/query'))
        return json(200, { supported: false, data: [] });
      if (path.endsWith('/workspaces/query'))
        return json(200, {
          data: [],
          hasMore: false,
          capabilities: { workspaceBinding: true },
        });
      if (path.endsWith('/client-files/register')) {
        registered.push(parsed);
        return json(200, {
          serverId: 'local-files',
          generation: 1,
          token: 'fixture-token',
          expiresAt: Date.now() + 3_600_000,
          toolCount: 1,
        });
      }
      if (path.endsWith('/client-files/status'))
        return json(200, {
          serverId: 'local-files',
          generation: 1,
          state: 'active',
          expiresAt: Date.now() + 3_600_000,
        });
      if (path.endsWith('/client-files/unregister')) {
        unregistered.push(parsed);
        return json(200, {
          serverId: 'local-files',
          generation: 1,
          state: 'closed',
          expiresAt: Date.now() + 3_600_000,
        });
      }
      if (path.endsWith('/client-files/responses')) {
        responses.push(parsed);
        return json(200, { settled: true });
      }
      if (path.endsWith('/events/stream')) {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
        });
        res.write(': open\n\n');
        const heartbeat = setInterval(() => res.write(': hb\n\n'), 1_000);
        heartbeats.add(heartbeat);
        res.on('close', () => {
          clearInterval(heartbeat);
          heartbeats.delete(heartbeat);
        });
        return;
      }
      if (path.endsWith('/client-files/requests/stream')) {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
        });
        res.write(': open\n\n');
        res.write(
          `event: request\ndata: ${JSON.stringify({
            requestId: 'd1',
            payloadJson: JSON.stringify({
              jsonrpc: '2.0',
              id: 'd1',
              method: 'tools/list',
            }),
          })}\n\n`,
        );
        const heartbeat = setInterval(() => res.write(': hb\n\n'), 1_000);
        heartbeats.add(heartbeat);
        res.on('close', () => {
          clearInterval(heartbeat);
          heartbeats.delete(heartbeat);
        });
        return;
      }
      return json(404, { error: `Unexpected request: ${path}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        registered,
        responses,
        unregistered,
      });
    });
  });
}

/**
 * The dev server ships a connect-src 'self' CSP; the disposable peer lives
 * on its own origin, so relax the policy for this fixture document only.
 */
async function relaxFixtureCsp(page: import('@playwright/test').Page) {
  await page.route(
    '**/e2e/fixtures/managed-local-files.html**',
    async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers });
    },
  );
}

async function stopPeer(peer: { server: Server }) {
  await new Promise<void>((resolve) => {
    peer.server.close(() => resolve());
    peer.server.closeAllConnections();
  });
}

/** A granted directory grant with one file, standing in for the picker. */
function installPickerStub() {
  return `
    window.showDirectoryPicker = async () => {
      const file = {
        kind: 'file',
        name: 'a.txt',
        getFile: async () => ({ text: async () => 'client file content' }),
      };
      const handle = {
        kind: 'directory',
        name: 'my-dir',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getFileHandle: async (name) => {
          if (name === 'a.txt') return file;
          throw Object.assign(new Error('no such file'), { name: 'NotFoundError' });
        },
        getDirectoryHandle: async () => {
          throw Object.assign(new Error('no such dir'), { name: 'NotFoundError' });
        },
        values: () => {
          let done = false;
          return {
            next: async () => {
              if (done) return { value: undefined, done: true };
              done = true;
              return { value: file, done: false };
            },
            [Symbol.asyncIterator]() { return this; },
          };
        },
        isSameEntry: async (other) => other === handle,
      };
      return handle;
    };
  `;
}

test('Managed local files entry connects a directory through the relay peer @smoke', async ({
  page,
}) => {
  const peer = await startPeer(true);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await relaxFixtureCsp(page);
    await page.addInitScript(installPickerStub());
    await page.goto(
      `/e2e/fixtures/managed-local-files.html?api=${encodeURIComponent(peer.url)}&session=s1`,
    );
    const trigger = page.getByRole('button', {
      name: 'Local files',
      exact: true,
    });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.getByRole('button', { name: 'Connect a directory…' }).click();
    await expect(page.getByText('my-dir')).toBeVisible();
    await expect(page.getByText('1 tools')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Disconnect' }),
    ).toBeVisible();
    // Usability: the connected panel names the bound session and offers a
    // one-step change-directory affordance.
    const panel = page.locator('[data-web-shell-local-files-panel]');
    await expect(panel.getByText('Local files task')).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Change directory…' }),
    ).toBeVisible();
    expect(peer.registered.length).toBeGreaterThanOrEqual(1);
    expect(peer.registered[0]).toMatchObject({ sessionId: 's1' });
    await expect
      .poll(() => peer.responses.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    expect(peer.responses[0]).toMatchObject({
      sessionId: 's1',
      generation: 1,
      rpcRequestId: 'd1',
    });
    const answer = JSON.parse(peer.responses[0].responseJson as string);
    expect(answer.result.tools.length).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await expect
      .poll(() => peer.unregistered.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(
      page.getByRole('button', { name: 'Connect a directory…' }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await stopPeer(peer);
  }
});

test('Managed local files entry is withheld without the capability', async ({
  page,
}) => {
  const peer = await startPeer(false);
  try {
    await relaxFixtureCsp(page);
    await page.addInitScript(installPickerStub());
    await page.goto(
      `/e2e/fixtures/managed-local-files.html?api=${encodeURIComponent(peer.url)}&session=s1`,
    );
    await expect(page.locator('[data-web-shell-root]')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Local files', exact: true }),
    ).toHaveCount(0);
    expect(peer.registered).toEqual([]);
  } finally {
    await stopPeer(peer);
  }
});

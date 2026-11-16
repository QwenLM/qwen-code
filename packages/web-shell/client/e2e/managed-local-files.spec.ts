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
 * The peer speaks the Public REST wire: snake_case, epoch seconds for the
 * Session projection, per-session client-files paths, GET status/downlink.
 */
function startPeer(clientFilesEnabled: boolean): Promise<{
  server: Server;
  url: string;
  registered: Record<string, unknown>[];
  responses: Record<string, unknown>[];
  unregistered: Record<string, unknown>[];
  summaryReads: number;
}> {
  const registered: Record<string, unknown>[] = [];
  const responses: Record<string, unknown>[] = [];
  const unregistered: Record<string, unknown>[] = [];
  let relayConnectionId: unknown;
  let summaryReads = 0;
  const heartbeats = new Set<NodeJS.Timeout>();
  const summary = {
    id: 's1',
    object: 'agent.session',
    agent_id: 'qwen-code',
    agent_revision: '1',
    status: 'active',
    created_at: 1_790_777_114,
    updated_at: 1_790_777_115,
    last_event_id: 1,
    title: 'Local files task',
    capabilities: {
      items: true,
      snapshots: true,
      artifacts: false,
      resync: true,
      tasks: true,
      actions: false,
      workspace_turns: true,
      session_close: false,
      session_archive: false,
      session_unarchive: false,
      session_delete: false,
      ...(clientFilesEnabled ? { client_files: true } : {}),
    },
  };
  const server = createServer((req, res) => {
    const origin = req.headers.origin ?? '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'content-type,x-qwen-tenant-id',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      const url = new URL(req.url ?? '/', 'http://local');
      const path = url.pathname;
      const json = (status: number, data: unknown) => {
        res.writeHead(status, {
          ...cors,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(data));
      };
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (path === '/v1/agents/sessions' && req.method === 'GET') {
        summaryReads += 1;
        return json(200, {
          object: 'list',
          data: [summary],
          has_more: false,
          next_cursor: null,
        });
      }
      if (path === '/v1/agents/sessions/s1' && req.method === 'GET') {
        summaryReads += 1;
        return json(200, summary);
      }
      if (path === '/v1/agents/sessions/s1/transcript')
        return json(200, {
          items: [],
          events: [],
          covered_sequence: 0,
          older_cursor: null,
          has_more: false,
          last_sequence: 0,
        });
      if (path === '/v1/agents/sessions/s1/user-messages')
        return json(200, { paused: false, messages: [] });
      if (path === '/v1/agents/runtime-nodes')
        return json(200, { supported: false, data: [] });
      if (path === '/v1/agents/workspaces')
        return json(200, {
          object: 'list',
          data: [],
          has_more: false,
          next_cursor: null,
          default_workspace: null,
          capabilities: { workspace_context: false, workspace_binding: true },
        });
      if (
        path === '/v1/agents/sessions/s1/client-files/register' &&
        req.method === 'POST'
      ) {
        registered.push({ ...parsed, path });
        relayConnectionId = parsed.connection_id;
        return json(200, {
          server_id: 'local-files',
          generation: 1,
          expires_at: Date.now() + 3_600_000,
          tool_count: 1,
          connection_id: relayConnectionId,
        });
      }
      if (
        path === '/v1/agents/sessions/s1/client-files' &&
        req.method === 'GET'
      ) {
        // Mirror the server's ownership gate: the generation/identity is echoed
        // only to a caller that proves it knows the registration identity.
        const connectionId = url.searchParams.get('connection_id');
        const owned =
          connectionId !== null && connectionId === relayConnectionId;
        return json(
          200,
          owned
            ? {
                server_id: 'local-files',
                generation: 1,
                state: 'active',
                expires_at: Date.now() + 3_600_000,
                connection_id: relayConnectionId,
                owned: true,
              }
            : {
                server_id: 'local-files',
                state: 'active',
                expires_at: Date.now() + 3_600_000,
                owned: false,
              },
        );
      }
      if (
        path === '/v1/agents/sessions/s1/client-files/unregister' &&
        req.method === 'POST'
      ) {
        unregistered.push(parsed);
        return json(200, {
          server_id: 'local-files',
          generation: 1,
          state: 'closed',
          expires_at: Date.now() + 3_600_000,
        });
      }
      if (
        path === '/v1/agents/sessions/s1/client-files/responses' &&
        req.method === 'POST'
      ) {
        responses.push({ ...parsed, path });
        return json(200, { settled: true });
      }
      if (
        path === '/v1/agents/sessions/s1/events' &&
        url.searchParams.get('stream') === 'true'
      ) {
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
      if (
        path === '/v1/agents/sessions/s1/client-files/requests' &&
        req.method === 'GET'
      ) {
        res.writeHead(200, {
          ...cors,
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
        });
        res.write(': open\n\n');
        res.write(
          `event: request\ndata: ${JSON.stringify({
            request_id: 'd1',
            payload_json: JSON.stringify({
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
        get summaryReads() {
          return summaryReads;
        },
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
    // Exact match: the trigger's sr-only state description also names the
    // directory ("Local files — Connected (my-dir)"), so a substring match
    // resolves to two elements.
    await expect(page.getByText('my-dir', { exact: true })).toBeVisible();
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
    // The Session rides in the per-session path; the register body carries
    // only the connection identity.
    expect(peer.registered[0]).toMatchObject({
      path: '/v1/agents/sessions/s1/client-files/register',
      connection_id: expect.any(String),
    });
    await expect
      .poll(() => peer.responses.length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    expect(peer.responses[0]).toMatchObject({
      path: '/v1/agents/sessions/s1/client-files/responses',
      generation: 1,
      rpc_request_id: 'd1',
    });
    const answer = JSON.parse(peer.responses[0].response_json as string);
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
    // Anchor past mount: the session summary (which carries the capability)
    // must actually have been served before asserting the entry is absent, or
    // the count-0 check would pass even if the gate never ran.
    await expect
      .poll(() => peer.summaryReads, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    await expect(
      page.getByRole('button', { name: 'Local files', exact: true }),
    ).toHaveCount(0);
    expect(peer.registered).toEqual([]);
  } finally {
    await stopPeer(peer);
  }
});

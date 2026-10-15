/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as GenAiLib from '@google/genai';
import * as ClientLib from '@modelcontextprotocol/client';
import {
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import * as SdkClientStdioLib from '@modelcontextprotocol/client/stdio';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:net';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  AuthProviderType,
  MCPServerConfig,
  type Config,
} from '../config/config.js';
import { GoogleCredentialProvider } from '../mcp/google-auth-provider.js';
import { MCPOAuthProvider } from '../mcp/oauth-provider.js';
import { MCPOAuthTokenStorage } from '../mcp/oauth-token-storage.js';
import { OAuthUtils } from '../mcp/oauth-utils.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  INVOCATION_CONTEXT_META_KEY,
  runWithInvocationContext,
  type InvocationContextV1,
} from '../utils/invocation-context.js';
import {
  _resetMcpFetchDispatcherForTest,
  _setMcpFetchForTest,
  addMCPStatusChangeListener,
  attemptAutomaticMcpOAuth,
  connectAndDiscover,
  connectToMcpServer,
  createStreamableHttpCompatibilityFetch,
  createTransport,
  discoverPrompts,
  discoverResources,
  getAllMCPServerStatuses,
  getMCPServerLastError,
  getMcpOAuthDialogInstruction,
  getMCPServerStatus,
  hasNetworkTransport,
  isEnabled,
  listMcpPrompts,
  listMcpResources,
  MCPServerStatus,
  McpClient,
  mcpServerRequiresOAuth,
  discoverTools,
  populateMcpServerCommand,
  probeMcpServerForOAuth,
  removeMCPServerStatus,
  removeMCPStatusChangeListener,
  updateMCPServerStatus,
} from './mcp-client.js';
import type { DiscoveredMCPTool } from './mcp-tool.js';
import type { ToolRegistry } from './tool-registry.js';

const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
const ORIGINAL_ENV = process.env;
const TEST_MCP_TOOL_IDLE_TIMEOUT_MS = 300000;

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));
vi.mock('@modelcontextprotocol/client/stdio');
vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return { ...actual, Client: vi.fn() };
});
vi.mock('@google/genai');
vi.mock('../mcp/oauth-provider.js');
vi.mock('../mcp/oauth-token-storage.js');
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

type Obj = Record<string, unknown>;

/**
 * Minimal Config stub for the non-pool `discover()` path, which reads
 * `cliConfig.getResourceRegistry()` to register discovered resources. By
 * default the registry only has to accept calls; pass one to assert on it.
 */
function cfgWithResources(
  registry: Obj = {
    registerResource: vi.fn(),
    removeResourcesByServer: vi.fn(),
  },
): Config {
  return {
    getMcpToolIdleTimeoutMs: () => TEST_MCP_TOOL_IDLE_TIMEOUT_MS,
    getResourceRegistry: () => ({ ...registry }),
  } as unknown as Config;
}

/** Makes `new Client()` return `client`; returns it. */
function mockSdkClient<T extends Obj>(client: T): T {
  vi.mocked(ClientLib.Client).mockReturnValue(
    client as unknown as ClientLib.Client,
  );
  return client;
}

/** Makes `new Client()` return a connectable client plus `extra`. */
function mockClient<T extends Obj>(extra: T) {
  return mockSdkClient({
    connect: vi.fn(),
    registerCapabilities: vi.fn(),
    setRequestHandler: vi.fn(),
    getInstructions: vi.fn(),
    ...extra,
  });
}

/** Stubs the stdio transport constructor to return `transport`. */
function stubStdio(transport: Obj = {}) {
  return vi
    .spyOn(SdkClientStdioLib, 'StdioClientTransport')
    .mockReturnValue(
      transport as unknown as SdkClientStdioLib.StdioClientTransport,
    );
}

/** mockClient() behind a stubbed stdio transport. */
function mockStdioClient<T extends Obj>(extra: T, transport?: Obj) {
  stubStdio(transport);
  return mockClient(extra);
}

/** Makes `mcpToTool().tool()` resolve these declarations (a name is `{ name }`). */
function mockToolDecls(...decls: Array<string | Obj>) {
  return vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
    tool: () =>
      Promise.resolve({
        functionDeclarations: decls.map((d) =>
          typeof d === 'string' ? { name: d } : d,
        ),
      }),
  } as unknown as GenAiLib.CallableTool);
}

/** An McpClient (stdio `test-command` by default), not in debug mode. */
function newClient(
  name: string,
  config: MCPServerConfig = { command: 'test-command' },
  tools = {} as ToolRegistry,
  prompts = {} as PromptRegistry,
  workspaceContext = {} as WorkspaceContext,
) {
  return new McpClient(name, config, tools, prompts, workspaceContext, false);
}

/** newClient() after a successful connect(). */
async function connectedClient(...args: Parameters<typeof newClient>) {
  const client = newClient(...args);
  await client.connect();
  return client;
}

/** newClient() whose workspace has no directories. */
const clientInWorkspace = (name: string, config?: MCPServerConfig) =>
  newClient(name, config, undefined, undefined, workspace(false));

const toolReg = () => ({ registerTool: vi.fn() }) as unknown as ToolRegistry;
const promptReg = () =>
  ({ registerPrompt: vi.fn() }) as unknown as PromptRegistry;

/** A workspace with no directories; `watch` adds onDirectoriesChanged. */
function workspace(watch = true) {
  return {
    getDirectories: vi.fn().mockReturnValue([]),
    ...(watch
      ? { onDirectoriesChanged: vi.fn().mockReturnValue(vi.fn()) }
      : {}),
  } as unknown as WorkspaceContext;
}

function mockTokenStorage(getCredentials: Mock) {
  vi.mocked(MCPOAuthTokenStorage).mockImplementation(
    () => ({ getCredentials }) as unknown as MCPOAuthTokenStorage,
  );
  return getCredentials;
}

const noStoredCredentials = () =>
  mockTokenStorage(vi.fn().mockResolvedValue(null));

function mockOAuthProvider<T extends Obj>(provider: T): T {
  vi.mocked(MCPOAuthProvider).mockImplementation(
    () => ({ ...provider }) as unknown as MCPOAuthProvider,
  );
  return provider;
}

/** Stubs OAuth discovery with the test authorization server. */
function mockDiscoveredOAuth(scopes: string[] = []) {
  return vi.spyOn(OAuthUtils, 'discoverOAuthConfig').mockResolvedValue({
    authorizationUrl: 'https://auth.example/authorize',
    tokenUrl: 'https://auth.example/token',
    scopes,
  });
}

/** Stubs globalThis.fetch with an empty response of `status`. */
const stubGlobalFetch = (status: number) =>
  vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response(null, { status }));

/** A 401 response carrying an OAuth resource-metadata challenge. */
const challenge401 = (resourceMetadata: string) =>
  new Response(null, {
    status: 401,
    headers: {
      'www-authenticate': `Bearer resource_metadata="${resourceMetadata}"`,
    },
  });

const unauthorized = () =>
  Object.assign(new Error('unauthorized'), { status: 401 });

/** vi.fn() resolving each value once in order (an Error rejects instead). */
function sequence(...values: unknown[]) {
  const fn = vi.fn();
  for (const value of values) {
    if (value instanceof Error) fn.mockRejectedValueOnce(value);
    else fn.mockResolvedValueOnce(value);
  }
  return fn;
}

type TransportInternals = {
  _url: URL;
  _fetch: typeof fetch;
  _requestInit?: RequestInit;
  _oauthProvider?: unknown;
};

/** createTransport() cast so tests can inspect SDK-private fields. */
async function transportFor(config: MCPServerConfig, name = 'test-server') {
  const transport = await createTransport(name, config, false);
  return transport as unknown as TransportInternals;
}

function mockAppOnlyMcpServer(): void {
  const methodNotFound = Object.assign(new Error('Method not found'), {
    code: -32601,
  });
  mockStdioClient({
    getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
    request: vi.fn().mockRejectedValue(methodNotFound),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'internal_refresh',
          _meta: { ui: { visibility: ['app'] } },
        },
      ],
    }),
    close: vi.fn(),
  });
  mockToolDecls('internal_refresh');
}

function legacyOptionalMethodTransportError(
  status = 400,
  code = -32601,
  responseBody?: string,
): Error {
  const methodMessage =
    code === -32601 ? 'Method not found' : 'Session not found';
  const body =
    responseBody ??
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message: methodMessage },
      id: 1,
    });
  return new ClientLib.SdkHttpError(
    ClientLib.SdkErrorCode.ClientHttpNotImplemented,
    `Error POSTing to endpoint: ${body}`,
    { status, statusText: `HTTP ${status}`, text: body },
  );
}

function legacyOptionalMethodSseTransportError(
  status?: number,
  code = -32601,
  responseBody?: string,
): Error {
  const methodMessage =
    code === -32601 ? 'Method not found' : 'Session not found';
  const body =
    responseBody ??
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message: methodMessage },
      id: null,
    });
  const statusMessage = status === undefined ? '' : ` (HTTP ${status})`;
  return new Error(`Error POSTing to endpoint${statusMessage}: ${body}`);
}

describe('mcp-client', () => {
  afterEach(() => {
    _setMcpFetchForTest(undefined);
    _resetMcpFetchDispatcherForTest();
    vi.unstubAllEnvs();
  });

  describe('dedicated undici fetch (#7147)', () => {
    const okHandler = (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };
    /**
     * Listens `srv` on loopback and hands `body` a POST through the fetch of
     * a transport built for it (createMcpStreamableHttpFetch is private, so
     * this exercises the same wiring), then closes the server.
     */
    async function withServer(
      srv: Server,
      scheme: string,
      name: string,
      body: (post: () => Promise<Response>) => Promise<void>,
    ) {
      await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
      const url = `${scheme}://127.0.0.1:${(srv.address() as { port: number }).port}/mcp`;
      try {
        const realFetch = (await transportFor({ httpUrl: url }, name))._fetch;
        await body(() =>
          realFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }),
        );
      } finally {
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      }
    }
    async function expectOk(res: Response) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }

    // Contract test against a real local HTTP server: the transport fetch
    // built by createStreamableHttpCompatibilityFetch over the dedicated
    // undici fetch performs real requests end to end. The stall this
    // guards against only manifests with specific server/undici-version
    // combinations (see #7147), so this pins the plumbing, not the stall.
    it('performs real requests through the dedicated dispatcher', async () => {
      const http = await import('node:http');
      await withServer(
        http.createServer(okHandler),
        'http',
        'undici-contract',
        async (post) => expectOk(await post()),
      );
    });

    // Self-signed pair generated for this test (CN/SAN 127.0.0.1, 100-year
    // validity) — it never leaves the local loopback server below.
    const SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQgVXO0KxbNqR8
QpXVihSXYn/q9CkzT74dLRtDzYZnhD89XhICg9vW6KhRbB7L6MTKQ0Lg501AC74f
hkPrxEjgR6EHmUPiRizGZcb0h165OoQEuQfkceNGmOnH4R+EZbrWdDeVkdtjuQdI
dG0jM4ZWs1ibqfCxScO2QWcovEmxRO/ZvISNWfzJCIIwr0SC3uC6dmgvj34ZSMNY
kJww3G0de8wGG01QPUYBFol9e0iQok5DmPrbnped4Ms1TWe+L4ws+EcFm9CNVPoX
05POJqTVKbVNy8/sU/5zTiRS8E5r28pTfUiijIFEyK5qQyE1T6C0kdB0PAGMhDPR
ZXMijfkhAgMBAAECggEAD8giVw+bZCIMLC2cCrgzW8wEU6PcdHpOMQYngKfPSwmL
Admbcl5JpwggKV2OLS/2qTqTFtPbGIRrBRbUEEXgoD07togGx9s462FrwDl41XtU
38ijjMqEAeV0GIF1Mb/DdxT/2g3atb8dCoJpelcdjXVwuQORaNHlAugLZ11tFII4
yEp+FQgkc5YIJwQWTvyqdZ1qJ4l31FhRvB7GhVDnYRHv1y27jCJiB6vPrv0AQzgh
jVPXS03dswlkMI+ur2Lt3s8qVtdMD2M7Q5dmjHHuKuQvA2rg6iAf2raXOE9oAXQy
MQTgi3bF4s/8uuzgm8hmM+/Gz91sTKJCSQ2742okGQKBgQDvTgxXm+xxLk1DqHGZ
DEtplyl9fQ2qNSpzCgUtIdL3UyWFDRBDS2g9o+8Z8SSWUTiKlcrVU88vepVLduTk
g5cNF2W/qKg+ycRR76E+t6+ApnF13atEr2DCIrLq8nqwbG3ZsU/XD04MWI496/ov
4ZXpvTcyxxW/TRb259qJWWSE/QKBgQDfDTWWh/tWngkBOEMs0GaLLElkwIMmjOtm
CWplylna1vBUsct/lozTNIVrvVSlE41VeQq6TtpSVrEGhQ2KlFXow7iBHkRQkujl
8MmJJF/wF/6EQGvfvtg+7e9s8CD22P9Cf35cec+PPQA5Rw8j644OKnjyy8Q4sojg
xsIPHcVv9QKBgQCUO/CBRGDOKzRJOMpFV8xO+AgHZ7NTP+OvpwFV16Hq+mI/bLwq
M0e7BxVRKILVajJwBiHCy0uHyZM5T8ixlKG4xkmM01iErE8jwiBLzVS1iGS38jvp
LAnvt7bEurctGb1iH+eo/B4In8JcsRQlHMPUKhVLKu9ZtNMI1s4UTn9psQKBgBCj
sqC1KjnO9ksCAHjiXxP4zMzYU7BXiOQGxcosK0HZEPqwfMba20ySOXXNHPhnmf6L
VhKJ+V11HCWpXVY+NJ51o1j2ghAktX0Z1l8FuKZ3k8QX7jQ1z3n6VAcjbsIbdAdo
7WtGpwY/fbnIJEgAtYs2/ejW7J9yKiXije2EwgrVAoGBAIiZcGSxIs4biak00HmY
XXncJp8jBl9HdqrBH7wn9IuCRU4G2a1gLi0LTHcuIo4HMpMqXmrsuCMh8a9teCpP
ZEyVOb7bwmXfTJrL0iFThl/nXzvUyQ5J0/jXqBwIdQu4DbORAtjwRlZRxe05yrza
N8JEixv6MDQEx9NiIqpn+V6Y
-----END PRIVATE KEY-----`;
    const SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIDHDCCAgSgAwIBAgIUCjr0jOOpgv0drL4OfEIp85UQ6mwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDcxOTA0NDAxNloYDzIxMjYw
NjI1MDQ0MDE2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDQgVXO0KxbNqR8QpXVihSXYn/q9CkzT74dLRtDzYZn
hD89XhICg9vW6KhRbB7L6MTKQ0Lg501AC74fhkPrxEjgR6EHmUPiRizGZcb0h165
OoQEuQfkceNGmOnH4R+EZbrWdDeVkdtjuQdIdG0jM4ZWs1ibqfCxScO2QWcovEmx
RO/ZvISNWfzJCIIwr0SC3uC6dmgvj34ZSMNYkJww3G0de8wGG01QPUYBFol9e0iQ
ok5DmPrbnped4Ms1TWe+L4ws+EcFm9CNVPoX05POJqTVKbVNy8/sU/5zTiRS8E5r
28pTfUiijIFEyK5qQyE1T6C0kdB0PAGMhDPRZXMijfkhAgMBAAGjZDBiMB0GA1Ud
DgQWBBSYkNfOElpRlCq/zavOPLU9fIFgbzAfBgNVHSMEGDAWgBSYkNfOElpRlCq/
zavOPLU9fIFgbzAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBH8AAAEwDQYJ
KoZIhvcNAQELBQADggEBAGKk+sZgU1OnjK/NObfqVcpdRdA4gP15Nn3kUvsU8H6m
A+gMgFwr20G+0uMsvxrWCBJwm/Q16XT/ctCIClRf98t3reu685h/fD/akLv0g/qo
FIgZqCVyMgOBWGLSdDIyNBQHs16ZcV178/WyHfobnMcmtNOQpVg6vDKawBGyopmI
nV5F0SDrn4lpQexUfJqikDj8VDgKEovDsSPdXJv9J2aJChqkeQHAexbbj3P+SDyr
MxT7pKQh7HN5ulX1fgCsf+VCiF/Sbd5QCkn4i4obIC95CU3MCOCQCiPo1B43HpHc
lOTTGqPpwFUbw2EMOOpFYuIyzGMIpUNMBjE2gvJiqFQ=
-----END CERTIFICATE-----`;

    // Pins the isTlsVerificationDisabled() branch of the dispatcher: the
    // env probe uses QWEN_TLS_INSECURE (read only by that helper) rather
    // than NODE_TLS_REJECT_UNAUTHORIZED, which Node's own TLS layer also
    // honors and would make the positive phase pass without our branch.
    it('honors the TLS-insecure switch for self-signed MCP endpoints', async () => {
      const https = await import('node:https');
      const srv = https.createServer(
        { key: SELF_SIGNED_KEY, cert: SELF_SIGNED_CERT },
        okHandler,
      );
      await withServer(srv, 'https', 'undici-tls-contract', async (post) => {
        // Default dispatcher: certificate verification stays ON.
        _resetMcpFetchDispatcherForTest();
        await expect(post()).rejects.toThrow();

        // TLS-insecure switch set when the dispatcher is (re)built: the
        // self-signed endpoint connects.
        vi.stubEnv('QWEN_TLS_INSECURE', '1');
        _resetMcpFetchDispatcherForTest();
        await expectOk(await post());
      });
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = ORIGINAL_ENV;
  });

  describe('getMcpOAuthDialogInstruction', () => {
    it('builds an authenticate instruction for the named MCP server', () => {
      expect(getMcpOAuthDialogInstruction('authenticate', 'foo')).toBe(
        "In interactive Qwen Code sessions, open the /mcp dialog to authenticate with MCP server 'foo'. For headless or SDK usage, configure MCP OAuth with qwen mcp add --oauth-* or settings.json, then authenticate once in an interactive session before connecting.",
      );
    });

    it('builds a re-authenticate instruction for the named MCP server', () => {
      expect(getMcpOAuthDialogInstruction('re-authenticate', 'foo')).toBe(
        "In interactive Qwen Code sessions, open the /mcp dialog to re-authenticate with MCP server 'foo'. For headless or SDK usage, configure MCP OAuth with qwen mcp add --oauth-* or settings.json, then re-authenticate once in an interactive session before connecting.",
      );
    });
  });

  describe('connectToMcpServer', () => {
    afterEach(() => {
      vi.mocked(MCPOAuthProvider).mockReset();
      vi.mocked(MCPOAuthTokenStorage).mockReset();
    });

    const creds = () => ({ clientId: 'client-id' });
    const SSE_EXPIRED =
      "Stored OAuth tokens for SSE server 'sse-server' are expired or could not be refreshed. " +
      getMcpOAuthDialogInstruction('re-authenticate', 'sse-server');
    /** "<prefix> for server 'http-server'. <authenticate instruction>" */
    const httpGuidance = (prefix: string) =>
      `${prefix} for server 'http-server'. ` +
      getMcpOAuthDialogInstruction('authenticate', 'http-server');

    /** Makes the SDK client's connect() be `connect`. */
    function mockConnect(connect: Mock) {
      mockSdkClient({
        connect,
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        notification: vi.fn(),
      });
      return connect;
    }
    const connectSse = () =>
      connectToMcpServer(
        'sse-server',
        { url: 'http://test-server/sse' },
        false,
        workspace(),
      );
    const connectHttp = (config = { httpUrl: 'http://test-server/mcp' }) =>
      connectToMcpServer('http-server', config, false, workspace());

    /** Connects the SSE server through a 401 with these token-store mocks. */
    function sse401(getCredentials: Mock, provider?: Obj) {
      mockConnect(
        vi.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized')),
      );
      mockTokenStorage(getCredentials);
      if (provider) mockOAuthProvider(provider);
      return connectSse();
    }

    /** HTTP server failing connect() once with `connectError`, then OAuth. */
    function setupHttpOAuthRetry(connectError: Error) {
      const connect = mockConnect(
        vi
          .fn()
          .mockRejectedValueOnce(connectError)
          .mockResolvedValueOnce(undefined),
      );
      const getCredentials = mockTokenStorage(sequence(null, creds()));
      const { authenticate, getValidToken } = mockOAuthProvider({
        authenticate: vi.fn().mockResolvedValue(undefined),
        getValidToken: vi.fn().mockResolvedValue('access-token'),
      });
      const discoverOAuthConfig = mockDiscoveredOAuth(['mcp.read']);
      return {
        authenticate,
        connect,
        discoverOAuthConfig,
        getCredentials,
        getValidToken,
      };
    }
    const expectAuthenticated = (authenticate: Mock) =>
      expect(authenticate).toHaveBeenCalledWith(
        'http-server',
        {
          enabled: true,
          authorizationUrl: 'https://auth.example/authorize',
          tokenUrl: 'https://auth.example/token',
          scopes: ['mcp.read'],
        },
        'http://test-server/mcp',
      );

    it('reports rejected stored OAuth tokens for SSE servers', async () => {
      await expect(
        sse401(vi.fn().mockResolvedValue(creds()), {
          getValidToken: vi.fn().mockResolvedValue('stored-token'),
        }),
      ).rejects.toThrow(
        "Stored OAuth token for SSE server 'sse-server' was rejected. " +
          getMcpOAuthDialogInstruction('re-authenticate', 'sse-server'),
      );
    });

    it('reports unusable stored OAuth tokens for SSE servers', async () => {
      await expect(
        sse401(sequence(creds(), creds(), null), {
          getValidToken: vi.fn().mockResolvedValue(null),
        }),
      ).rejects.toThrow(SSE_EXPIRED);
    });

    it('reports unusable SSE OAuth tokens when token validation fails', async () => {
      const getValidToken = vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValue(new Error('Token store unavailable'));

      await expect(
        sse401(sequence(creds(), creds(), creds()), { getValidToken }),
      ).rejects.toThrow(SSE_EXPIRED);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        "Failed to validate stored OAuth token for SSE server 'sse-server': Token store unavailable",
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(SSE_EXPIRED);
    });

    it('logs unusable SSE OAuth tokens when stored credentials disappear', async () => {
      await expect(sse401(sequence(creds(), null))).rejects.toThrow(
        SSE_EXPIRED,
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(SSE_EXPIRED);
    });

    it('reports SSE OAuth guidance when credentials fail to re-read after 401', async () => {
      await expect(
        sse401(sequence(creds(), creds(), new Error('Corrupt token file'))),
      ).rejects.toThrow(SSE_EXPIRED);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        "Failed to re-read stored OAuth credentials for SSE server 'sse-server' after 401: Corrupt token file",
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(SSE_EXPIRED);
    });

    it('reports missing OAuth configuration for SSE servers without stored credentials', async () => {
      await expect(sse401(vi.fn().mockResolvedValue(null))).rejects.toThrow(
        "401 error received for SSE server 'sse-server' without OAuth configuration. " +
          getMcpOAuthDialogInstruction('authenticate', 'sse-server'),
      );
    });

    it('continues connecting when the SSE OAuth credential pre-read fails', async () => {
      const connect = mockConnect(vi.fn());
      mockTokenStorage(
        vi
          .fn()
          .mockRejectedValueOnce(new Error('Corrupt token file'))
          .mockResolvedValue(null),
      );

      await expect(connectSse()).resolves.toBeDefined();
      expect(connect).toHaveBeenCalledOnce();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        "Failed to pre-read stored OAuth credentials for SSE server 'sse-server': Corrupt token file",
      );
    });

    it('reports OAuth guidance when automatic OAuth handling fails', async () => {
      mockConnect(
        vi
          .fn()
          .mockRejectedValue(
            new Error(
              'HTTP 401 Unauthorized\nwww-authenticate: Bearer realm="example", resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
            ),
          ),
      );
      noStoredCredentials();
      vi.spyOn(OAuthUtils, 'discoverOAuthConfig').mockResolvedValue(null);
      const oauthMessage = httpGuidance('Failed to handle automatic OAuth');

      await expect(connectHttp()).rejects.toThrow(oauthMessage);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(oauthMessage);
    });

    it('retries HTTP connections after base-url OAuth discovery without www-authenticate', async () => {
      const { authenticate, connect, discoverOAuthConfig, getValidToken } =
        setupHttpOAuthRetry(
          new Error(
            'Streamable HTTP error: Error POSTing to endpoint: {"error":"unauthorized"}',
          ),
        );
      stubGlobalFetch(401);

      await expect(connectHttp()).resolves.toBeDefined();

      expect(discoverOAuthConfig).toHaveBeenCalledWith('http://test-server');
      expectAuthenticated(authenticate);
      expect(getValidToken).toHaveBeenCalledWith('http-server', creds());
      expect(connect).toHaveBeenCalledTimes(2);
      const oauthTransport = connect.mock.calls[1][0] as {
        _requestInit?: { headers?: Record<string, string> };
      };
      expect(oauthTransport._requestInit?.headers).toMatchObject({
        Authorization: 'Bearer access-token',
      });
    });

    it('falls back to base-url OAuth discovery when www-authenticate lacks resource metadata', async () => {
      const { authenticate, connect, discoverOAuthConfig } =
        setupHttpOAuthRetry(
          new Error(
            'HTTP 401 Unauthorized\nwww-authenticate: Bearer realm="example"',
          ),
        );

      await expect(connectHttp()).resolves.toBeDefined();

      expect(discoverOAuthConfig).toHaveBeenCalledWith('http://test-server');
      expectAuthenticated(authenticate);
      expect(connect).toHaveBeenCalledTimes(2);
    });

    it('reports OAuth guidance when post-discovery transport creation fails', async () => {
      const config = { httpUrl: 'http://test-server/mcp' };
      const { connect, discoverOAuthConfig, getValidToken } =
        setupHttpOAuthRetry(new Error('HTTP 401 Unauthorized'));
      stubGlobalFetch(401);
      getValidToken.mockImplementation(async () => {
        config.httpUrl = 'not a valid URL';
        return 'access-token';
      });
      const oauthMessage = httpGuidance('Failed to create OAuth transport');

      await expect(connectHttp(config)).rejects.toThrow(oauthMessage);

      expect(discoverOAuthConfig).toHaveBeenCalledWith('http://test-server');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(oauthMessage);
    });

    it('reports OAuth guidance when post-discovery token lookup fails', async () => {
      const { getValidToken } = setupHttpOAuthRetry(
        new Error('HTTP 401 Unauthorized'),
      );
      stubGlobalFetch(401);
      getValidToken.mockResolvedValue(null);
      const oauthMessage = httpGuidance('Failed to get OAuth token');

      await expect(connectHttp()).rejects.toThrow(oauthMessage);

      expect(mockDebugLogger.error).toHaveBeenCalledWith(oauthMessage);
    });

    it('reports OAuth guidance when post-discovery credentials are unavailable', async () => {
      const { getCredentials } = setupHttpOAuthRetry(
        new Error('HTTP 401 Unauthorized'),
      );
      stubGlobalFetch(401);
      getCredentials.mockReset();
      getCredentials.mockResolvedValue(null);
      const oauthMessage = httpGuidance('Failed to get stored credentials');

      await expect(connectHttp()).rejects.toThrow(oauthMessage);

      expect(mockDebugLogger.error).toHaveBeenCalledWith(oauthMessage);
    });

    it('wraps OAuth discovery errors with remediation guidance', async () => {
      mockConnect(
        vi.fn().mockRejectedValue(new Error('HTTP 401 Unauthorized')),
      );
      noStoredCredentials();
      stubGlobalFetch(404);
      vi.spyOn(OAuthUtils, 'discoverOAuthConfig').mockRejectedValue(
        new Error('Discovery timed out'),
      );
      const oauthMessage =
        httpGuidance('OAuth discovery failed') +
        ' Original error: Discovery timed out';

      await expect(connectHttp()).rejects.toThrow(oauthMessage);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(oauthMessage);
    });
  });

  describe('McpClient', () => {
    it.each(
      ([400, 404, 405, 422, 501] as const).flatMap((status) => [
        {
          status,
          transport: 'structured HTTP status',
          makeError: () => legacyOptionalMethodTransportError(status),
        },
        {
          status,
          transport: 'legacy SSE error message',
          makeError: () => legacyOptionalMethodSseTransportError(status),
        },
      ]),
    )(
      'does not disconnect for a legacy HTTP -32601 optional-method response from $transport with status $status',
      async ({ makeError }) => {
        const mockedClient = {
          connect: vi.fn(),
          registerCapabilities: vi.fn(),
          setRequestHandler: vi.fn(),
          getInstructions: vi.fn(),
          onerror: undefined as ((error: Error) => void) | undefined,
        };
        vi.mocked(ClientLib.Client).mockReturnValue(
          mockedClient as unknown as ClientLib.Client,
        );
        vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
          {} as SdkClientStdioLib.StdioClientTransport,
        );

        const serverName = 'legacy-optional-method-server';
        const client = new McpClient(
          serverName,
          { command: 'test-command' },
          {} as ToolRegistry,
          {} as PromptRegistry,
          {
            getDirectories: vi.fn().mockReturnValue([]),
          } as unknown as WorkspaceContext,
          false,
        );
        await client.connect();

        mockedClient.onerror?.(makeError());

        expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);
        expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.CONNECTED);
        removeMCPServerStatus(serverName);
      },
    );

    it.each([
      {
        description: 'an unrelated transport error',
        error: () => new Error('ECONNRESET'),
      },
      {
        description: 'a JSON-RPC session-not-found response',
        error: () => legacyOptionalMethodTransportError(400, -32001),
      },
      {
        description: 'a method-not-found response with HTTP 401',
        error: () => legacyOptionalMethodTransportError(401),
      },
      {
        description: 'a method-not-found response with HTTP 403',
        error: () => legacyOptionalMethodTransportError(403),
      },
      {
        description: 'a legacy SSE method-not-found response with HTTP 401',
        error: () => legacyOptionalMethodSseTransportError(401),
      },
      {
        description: 'a legacy SSE method-not-found response without a status',
        error: () => legacyOptionalMethodSseTransportError(),
      },
      {
        description: 'peer-controlled HTTP metadata on a JSON-RPC error',
        error: () =>
          Object.assign(new Error('Unsupported method'), {
            code: -32601,
            data: {
              status: 404,
              text: JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32601 },
                id: null,
              }),
            },
          }),
      },
      {
        description: 'an allowlisted legacy SSE status with an HTML body',
        error: () =>
          legacyOptionalMethodSseTransportError(
            400,
            -32601,
            '<html>route not found</html>',
          ),
      },
      {
        description: 'an allowlisted legacy SSE status with malformed JSON',
        error: () =>
          legacyOptionalMethodSseTransportError(400, -32601, '{"jsonrpc":'),
      },
      {
        description:
          'an allowlisted legacy SSE status without a JSON-RPC version',
        error: () =>
          legacyOptionalMethodSseTransportError(
            400,
            -32601,
            JSON.stringify({ error: { code: -32601 } }),
          ),
      },
      {
        description: 'a peer-controlled HTTP_STATUS marker under HTTP 401',
        error: () =>
          legacyOptionalMethodSseTransportError(
            401,
            -32601,
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32601,
                message: 'Method not found HTTP_STATUS/400',
              },
              id: null,
            }),
          ),
      },
    ])('still disconnects for $description', async ({ error }) => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getInstructions: vi.fn(),
        onerror: undefined as ((error: Error) => void) | undefined,
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );

      const serverName = 'unrelated-transport-error-server';
      const client = new McpClient(
        serverName,
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {
          getDirectories: vi.fn().mockReturnValue([]),
        } as unknown as WorkspaceContext,
        false,
      );
      await client.connect();

      mockedClient.onerror?.(error());

      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.DISCONNECTED);
      removeMCPServerStatus(serverName);
    });

    it('keeps standalone discovery connected for a legacy -32601 error', async () => {
      const methodNotFoundTransportError =
        legacyOptionalMethodSseTransportError(
          400,
          -32601,
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32601, message: 'Unsupported method' },
            id: null,
          }),
        );
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        getInstructions: vi.fn(),
        close: vi.fn(),
        onerror: undefined as ((error: Error) => void) | undefined,
        request: vi.fn(),
        listTools: vi.fn(),
      };
      mockedClient.request.mockImplementation(async () => {
        mockedClient.onerror?.(methodNotFoundTransportError);
        throw methodNotFoundTransportError;
      });
      mockedClient.listTools.mockImplementation(async () => {
        setTimeout(() => {
          mockedClient.onerror?.(methodNotFoundTransportError);
        }, 0);
        return { tools: [{ name: 'healthy-tool' }] };
      });
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 'healthy-tool' }],
          }),
      } as unknown as GenAiLib.CallableTool);

      const serverName = 'standalone-legacy-optional-method-server';
      await connectAndDiscover(
        serverName,
        { command: 'test-command' },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        false,
        {
          getDirectories: vi.fn().mockReturnValue([]),
          onDirectoriesChanged: vi.fn().mockReturnValue(vi.fn()),
        } as unknown as WorkspaceContext,
        cfgWithResources(),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.CONNECTED);
      mockedClient.onerror?.(new Error('ECONNRESET'));
      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.DISCONNECTED);
      removeMCPServerStatus(serverName);
    });

    it('recovers HTTP connections when the SDK omits the 401 status', async () => {
      const { connect } = mockClient({
        connect: vi
          .fn()
          .mockRejectedValueOnce(
            new Error(
              'Streamable HTTP error: Error POSTing to endpoint: {"error":"unauthorized"}',
            ),
          )
          .mockResolvedValueOnce(undefined),
      });
      mockTokenStorage(sequence(null, { clientId: 'client-id' }));
      const { authenticate } = mockOAuthProvider({
        authenticate: vi.fn().mockResolvedValue(undefined),
        getValidToken: vi.fn().mockResolvedValue('access-token'),
      });
      mockDiscoveredOAuth(['mcp.read']);
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          challenge401(
            'https://example.com/.well-known/oauth-protected-resource',
          ),
        );
      const serverName = 'active-http-oauth-server';
      const serverConfig = {
        httpUrl: 'https://example.com/mcp',
        headers: { 'X-Tenant': 'tenant-a' },
      };
      const client = clientInWorkspace(serverName, serverConfig);
      await expect(client.connect()).rejects.toThrow('unauthorized');

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mcpServerRequiresOAuth.has(serverName)).toBe(false);

      await expect(
        Promise.all([
          probeMcpServerForOAuth(serverName, serverConfig),
          probeMcpServerForOAuth(serverName, serverConfig),
        ]),
      ).resolves.toEqual([true, true]);

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.com/mcp',
        expect.objectContaining({
          method: 'HEAD',
          headers: expect.objectContaining({ 'X-Tenant': 'tenant-a' }),
          redirect: 'manual',
        }),
      );
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mcpServerRequiresOAuth.get(serverName)).toBe(true);
      expect(authenticate).not.toHaveBeenCalled();

      await expect(
        attemptAutomaticMcpOAuth(serverName, serverConfig, false),
      ).resolves.toBe(false);
      expect(authenticate).not.toHaveBeenCalled();

      await expect(
        Promise.all([
          attemptAutomaticMcpOAuth(serverName, serverConfig, true),
          attemptAutomaticMcpOAuth(serverName, serverConfig, true),
        ]),
      ).resolves.toEqual([true, true]);
      await expect(client.connect()).resolves.toBeUndefined();

      expect(authenticate).toHaveBeenCalledOnce();
      expect(connect).toHaveBeenCalledTimes(2);
      expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);
      expect(mcpServerRequiresOAuth.has(serverName)).toBe(false);
    });

    it('preserves a captured OAuth challenge when the SDK error only reports 401', async () => {
      const serverName = 'status-only-http-oauth-server';
      const serverConfig = { httpUrl: 'https://example.com/mcp' };
      const resourceMetadataUrl =
        'https://example.com/.well-known/oauth-protected-resource';
      // The MCP transport uses a dedicated undici fetch (#7147); stub it via
      // the test seam instead of globalThis.fetch.
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(challenge401(resourceMetadataUrl));
      _setMcpFetchForTest(fetchSpy as unknown as typeof fetch);
      mockClient({
        connect: vi.fn().mockImplementation(async (transport: unknown) => {
          const transportFetch = (transport as { _fetch: typeof fetch })._fetch;
          await transportFetch(serverConfig.httpUrl, { method: 'POST' });
          throw new Error('Streamable HTTP error: HTTP 401 Unauthorized');
        }),
      });
      noStoredCredentials();
      const { authenticate } = mockOAuthProvider({
        authenticate: vi.fn().mockResolvedValue(undefined),
      });
      const discoverOAuthConfig = mockDiscoveredOAuth();
      const client = clientInWorkspace(serverName, serverConfig);

      await expect(client.connect()).rejects.toThrow('HTTP 401 Unauthorized');
      await expect(
        attemptAutomaticMcpOAuth(serverName, serverConfig, true),
      ).resolves.toBe(true);

      expect(discoverOAuthConfig).toHaveBeenCalledWith(resourceMetadataUrl);
      expect(authenticate).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('does not classify a non-401 HTTP failure as OAuth', async () => {
      mockClient({
        connect: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'HTTP 403 Forbidden\nwww-authenticate: Bearer error="insufficient_scope"',
            ),
          ),
      });
      noStoredCredentials();
      stubGlobalFetch(503);
      const serverName = 'active-http-non-oauth-server';
      const client = clientInWorkspace(serverName, {
        httpUrl: 'https://example.com/mcp',
      });
      mcpServerRequiresOAuth.set(serverName, true);

      await expect(client.connect()).rejects.toThrow('HTTP 403 Forbidden');

      await expect(
        probeMcpServerForOAuth(serverName, {
          httpUrl: 'https://example.com/mcp',
        }),
      ).resolves.toBe(false);

      expect(mcpServerRequiresOAuth.has(serverName)).toBe(false);
    });

    it('serializes browser OAuth across servers and isolates requirements by URL', async () => {
      const firstConfig = { httpUrl: 'https://first.example/mcp' };
      const secondConfig = { httpUrl: 'https://second.example/mcp' };
      await probeMcpServerForOAuth('queued-first', firstConfig, unauthorized());
      await probeMcpServerForOAuth(
        'queued-second',
        secondConfig,
        unauthorized(),
      );
      mockDiscoveredOAuth();
      let activeAuthentications = 0;
      let maxActiveAuthentications = 0;
      const { authenticate } = mockOAuthProvider({
        authenticate: vi.fn().mockImplementation(async () => {
          activeAuthentications += 1;
          maxActiveAuthentications = Math.max(
            maxActiveAuthentications,
            activeAuthentications,
          );
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeAuthentications -= 1;
        }),
      });

      await expect(
        attemptAutomaticMcpOAuth(
          'queued-first',
          { httpUrl: 'https://other.example/mcp' },
          true,
        ),
      ).resolves.toBe(false);
      await expect(
        Promise.all([
          attemptAutomaticMcpOAuth('queued-first', firstConfig, true),
          attemptAutomaticMcpOAuth('queued-second', secondConfig, true),
        ]),
      ).resolves.toEqual([true, true]);

      expect(authenticate).toHaveBeenCalledTimes(2);
      expect(maxActiveAuthentications).toBe(1);
    });

    it('times out automatic OAuth so discovery can settle', async () => {
      vi.useFakeTimers();
      const serverName = 'hanging-oauth-server';
      const serverConfig = { httpUrl: 'https://hanging.example/mcp' };
      await probeMcpServerForOAuth(serverName, serverConfig, unauthorized());
      mockDiscoveredOAuth();
      mockOAuthProvider({
        authenticate: vi.fn(() => new Promise(() => undefined)),
      });

      const recovery = attemptAutomaticMcpOAuth(serverName, serverConfig, true);
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(recovery).resolves.toBe(false);
    });

    it('ignores stale OAuth probe results after the requirement is cleared', async () => {
      let resolveProbe!: (response: Response) => void;
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveProbe = resolve;
        }),
      );
      const serverName = 'cleared-oauth-probe-server';
      const serverConfig = { httpUrl: 'https://example.com/mcp' };
      mockClient({
        connect: vi.fn().mockRejectedValue(new Error('unauthorized')),
      });
      noStoredCredentials();
      const client = clientInWorkspace(serverName, serverConfig);
      await expect(client.connect()).rejects.toThrow('unauthorized');

      const probe = probeMcpServerForOAuth(serverName, serverConfig);
      client.clearOAuthState();
      resolveProbe(new Response(null, { status: 401 }));

      await expect(probe).resolves.toBe(false);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(mcpServerRequiresOAuth.has(serverName)).toBe(false);
    });

    it('clears only the matching URL from the name-level OAuth marker', async () => {
      const serverName = 'shared-name-oauth-server';
      const firstConfig = { httpUrl: 'https://first.example/mcp' };
      const secondConfig = { httpUrl: 'https://second.example/mcp' };
      await probeMcpServerForOAuth(serverName, firstConfig, unauthorized());
      await probeMcpServerForOAuth(serverName, secondConfig, unauthorized());
      const firstClient = newClient(serverName, firstConfig);
      const secondClient = newClient(serverName, secondConfig);

      firstClient.clearOAuthState();
      expect(mcpServerRequiresOAuth.get(serverName)).toBe(true);

      secondClient.clearOAuthState();
      expect(mcpServerRequiresOAuth.has(serverName)).toBe(false);
    });

    it('should discover tools', async () => {
      mockStdioClient({
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
      });
      const mockedMcpToTool = vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => ({ functionDeclarations: [{ name: 'testFunction' }] }),
      } as unknown as GenAiLib.CallableTool);
      const client = await connectedClient('test-server', undefined, toolReg());
      await client.discover(cfgWithResources());
      expect(mockedMcpToTool).toHaveBeenCalledOnce();
    });

    it('stores server instructions returned during initialization', async () => {
      mockStdioClient({
        getInstructions: vi.fn().mockReturnValue('Use concise replies.'),
      });

      const client = await connectedClient(
        'test-server',
        undefined,
        toolReg(),
        undefined,
        workspace(false),
      );

      expect(client.getInstructions()).toBe('Use concise replies.');
    });

    /** A connected 'srv' client whose SDK client is `extra`; reads res://doc. */
    async function readDoc<T extends Obj>(extra: T) {
      const mockedClient = mockStdioClient(extra);
      const client = await connectedClient('srv');
      const result = await client.readResource('res://doc');
      return {
        mockedClient,
        text: (result.contents[0] as { text: string }).text,
      };
    }
    const docContents = (text: string) =>
      vi.fn().mockResolvedValue({ contents: [{ uri: 'res://doc', text }] });
    const rawReadCall = [
      { method: 'resources/read', params: { uri: 'res://doc' } },
      expect.anything(),
      undefined,
    ];

    it('readResource does not gate on the resources capability (lenient read)', async () => {
      // Regression guard for the discover/read parity bug: a server that
      // answers resources/read but under-declares the `resources` capability
      // must still be readable (matching the lenient `listMcpResources`).
      const { mockedClient, text } = await readDoc({
        getServerCapabilities: vi.fn().mockReturnValue({}), // not declared
        request: docContents('BODY'),
      });
      expect(mockedClient.request).toHaveBeenCalledWith(...rawReadCall);
      expect(text).toBe('BODY');
    });

    it('readResource uses the cache-aware helper for modern sessions', async () => {
      const { mockedClient, text } = await readDoc({
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        readResource: docContents('BODY'),
      });
      expect(mockedClient.readResource).toHaveBeenCalledWith(
        { uri: 'res://doc' },
        undefined,
      );
      expect(text).toBe('BODY');
    });

    it('readResource falls back to a raw request when a modern server omits resources', async () => {
      const { mockedClient, text } = await readDoc({
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        readResource: docContents('TYPED'),
        request: docContents('BODY'),
      });
      expect(mockedClient.readResource).not.toHaveBeenCalled();
      expect(mockedClient.request).toHaveBeenCalledWith(...rawReadCall);
      expect(text).toBe('BODY');
    });

    it('should not skip tools even if a parameter is missing a type', async () => {
      mockStdioClient({
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        tool: vi.fn(),
      });
      const withParam = (name: string, param1: Obj) => ({
        name,
        parametersJsonSchema: { type: 'object', properties: { param1 } },
      });
      mockToolDecls(
        withParam('validTool', { type: 'string' }),
        withParam('invalidTool', { description: 'a param with no type' }),
      );
      const toolRegistry = toolReg();
      const client = await connectedClient(
        'test-server',
        undefined,
        toolRegistry,
      );
      await client.discover(cfgWithResources());
      expect(toolRegistry.registerTool).toHaveBeenCalledTimes(2);
    });

    it('should handle errors when discovering prompts', async () => {
      mockStdioClient({
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('Test error')),
      });
      mockToolDecls();
      const client = await connectedClient('test-server');
      await expect(client.discover(cfgWithResources())).rejects.toThrow(
        'No prompts, tools, or resources found on the server.',
      );
    });

    it('flips status to DISCONNECTED when discover() throws', async () => {
      // `Config.getFailedMcpServerNames()` filters by `status !== CONNECTED`,
      // so a server that connects but whose `discover()` then crashes (e.g.
      // tools/list rejects, or the "no prompts or tools found" guard fires)
      // must be marked DISCONNECTED before the error propagates. Otherwise it
      // stays CONNECTED in the global registry, the non-interactive failure
      // banner omits it, and the Footer's MCP health pill counts it healthy.
      mockStdioClient({
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('tools/list crashed')),
        close: vi.fn(),
      });
      mockToolDecls();
      const serverName = `discover-error-${Date.now()}`;
      const client = await connectedClient(serverName);
      // Sanity: connect succeeded, so CONNECTED before the discover failure.
      expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);

      await expect(client.discover(cfgWithResources())).rejects.toThrow();

      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.DISCONNECTED);
    });

    /** Server declaring prompts whose prompts/list returns `prompts`. */
    const promptServer = (prompts: Obj[], extra: Obj = {}) =>
      mockStdioClient({
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({ prompts }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        ...extra,
      });

    it('discoverAndReturn returns tools and prompts WITHOUT registering them', async () => {
      // F2 (#4175) pool path: a single shared McpClient produces this
      // snapshot once; per-session SessionMcpView instances each register a
      // filtered copy. The bare method must therefore NOT touch any registry,
      // or sharing a snapshot would double-register or cross-contaminate.
      promptServer([{ name: 'pure-prompt', description: 'p' }]);
      mockToolDecls('pure-tool');
      const toolRegistry = toolReg();
      const promptRegistry = promptReg();
      const client = await connectedClient(
        'pure-server',
        undefined,
        toolRegistry,
        promptRegistry,
      );

      const snapshot = await client.discoverAndReturn(cfgWithResources());

      expect(snapshot.tools).toHaveLength(1);
      expect(snapshot.tools[0].serverToolName).toBe('pure-tool');
      expect(snapshot.prompts).toHaveLength(1);
      expect(snapshot.prompts[0].name).toBe('pure-prompt');
      expect(snapshot.prompts[0].serverName).toBe('pure-server');
      expect(typeof snapshot.prompts[0].invoke).toBe('function');
      // The critical assertion: registries untouched.
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(promptRegistry.registerPrompt).not.toHaveBeenCalled();
    });

    it('marks discovered tools alwaysLoad when the MCP server config requests it', async () => {
      mockToolDecls('chrome_tool');

      const tools = await discoverTools(
        'chrome-devtools',
        { command: 'test-command', alwaysLoadTools: true },
        {
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
        } as unknown as ClientLib.Client,
        cfgWithResources(),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].alwaysLoad).toBe(true);
    });

    it('preserves App-only tools for the separate App registry', async () => {
      const appTool = (
        name: string,
        resourceUri: string,
        visibility: string,
      ) => ({
        name,
        _meta: { ui: { resourceUri, visibility: [visibility] } },
      });
      const mockedClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            appTool('show_dashboard', 'ui://demo/dash', 'model'),
            appTool('internal_refresh', 'ui://demo/refresh', 'app'),
          ],
        }),
      } as unknown as ClientLib.Client;
      mockToolDecls('show_dashboard', 'internal_refresh');

      const tools = await discoverTools(
        'apps',
        { command: 'test-command' },
        mockedClient,
        cfgWithResources(),
        { applyConfigFilters: false },
      );

      expect(tools.map((tool) => tool.serverToolName)).toEqual([
        'show_dashboard',
        'internal_refresh',
      ]);
      expect(tools[0].isAppVisible).toBe(false);
      expect(tools[1].isModelVisible).toBe(false);
      expect(tools[1].appVisibility).toEqual(['app']);
    });

    it.each(
      [[], ['unknown'], null, 'app', [42]].map((visibility) => ({
        visibility,
      })),
    )('rejects unsupported visibility $visibility', async ({ visibility }) => {
      const client = {
        listTools: vi.fn().mockResolvedValue({
          tools: [{ name: 'private', _meta: { ui: { visibility } } }],
        }),
      } as unknown as ClientLib.Client;
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: async () => ({ functionDeclarations: [{ name: 'private' }] }),
      } as unknown as GenAiLib.CallableTool);
      expect(
        await discoverTools(
          'apps',
          { command: 'test' },
          client,
          cfgWithResources(),
        ),
      ).toEqual([]);
    });

    it('attaches listing-level app resource UI onto discovered tools', async () => {
      const ui = {
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      };
      mockStdioClient({
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({
          tools: {},
          resources: {},
        }),
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'show_dashboard',
              _meta: { ui: { resourceUri: 'ui://demo/dash' } },
            },
          ],
        }),
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'ui://demo/dash', name: 'dash', _meta: { ui } }],
        }),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
        request: vi.fn().mockResolvedValue({ prompts: [] }),
      });
      mockToolDecls('show_dashboard');

      const client = await connectedClient(
        'apps',
        {
          command: 'test-command',
          appResourceMaxBytes: 2_097_152,
          appResourceTimeoutMs: 30_000,
        },
        toolReg(),
        promptReg(),
      );
      const snapshot = await client.discoverAndReturn(cfgWithResources(), {
        applyConfigFilters: false,
      });

      expect(snapshot.tools[0]?.appResourceLimits).toEqual({
        appResourceMaxBytes: 2_097_152,
        appResourceTimeoutMs: 30_000,
      });
      expect(snapshot.tools[0]?.appResourceUri).toBe('ui://demo/dash');
      expect(snapshot.tools[0]?.appResourceUi).toEqual({
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      });
    });

    it('lists tools via request when a modern server omits the tools capability', async () => {
      const mockedClient = {
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        request: vi.fn().mockResolvedValue({ tools: [{ name: 'echo' }] }),
      } as unknown as ClientLib.Client;
      mockToolDecls('echo');

      const tools = await discoverTools(
        'under-declared',
        { command: 'test-command' },
        mockedClient,
        cfgWithResources(),
        { applyConfigFilters: false },
      );

      expect(vi.mocked(mockedClient.request)).toHaveBeenCalledWith(
        { method: 'tools/list', params: {} },
        expect.anything(),
      );
      expect(vi.mocked(mockedClient.listTools)).not.toHaveBeenCalled();
      expect(tools.map((tool) => tool.serverToolName)).toEqual(['echo']);
    });

    const okCallTool = () =>
      vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    /** A client without capabilities or listed tools, plus `extra`. */
    const bareServer = (extra: Obj = {}) => ({
      getServerCapabilities: vi.fn().mockReturnValue({}),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      ...extra,
    });
    /** Executes `tool` under a fixed invocation context; returns the context. */
    async function runInContext(tool: DiscoveredMCPTool) {
      const context: InvocationContextV1 = {
        version: 1,
        sessionId: 'session-1',
        promptId: 'prompt-1',
      };
      await runWithInvocationContext(context, () =>
        tool.build({ param: 'test' }).execute(new AbortController().signal),
      );
      return context;
    }

    it('allows invocation context only for a client bound to a created stdio transport', async () => {
      const callTool = okCallTool();
      mockStdioClient(bareServer({ callTool }));
      mockToolDecls('local-tool');
      const client = await connectedClient('local-server');
      const { tools } = await client.discoverAndReturn(cfgWithResources());

      const context = await runInContext(tools[0]);

      expect(callTool.mock.calls[0][0]._meta).toEqual({
        [INVOCATION_CONTEXT_META_KEY]: context,
      });
    });

    it('does not trust a stdio-shaped config without an internally bound client', async () => {
      const callTool = okCallTool();
      mockToolDecls('unbound-tool');
      const [unboundTool] = await discoverTools(
        'unbound-server',
        { command: 'looks-like-stdio' },
        {
          listTools: vi.fn().mockResolvedValue({ tools: [] }),
          callTool,
        } as unknown as ClientLib.Client,
        cfgWithResources(),
      );

      await runInContext(unboundTool);

      expect(Object.hasOwn(callTool.mock.calls[0][0], '_meta')).toBe(false);
    });

    it.each([
      ['Streamable HTTP', { httpUrl: 'http://example.test/mcp' }],
      ['SSE', { url: 'http://example.test/sse' }],
    ])(
      'denies invocation context for %s transport clients',
      async (_transportName, serverConfig) => {
        const callTool = okCallTool();
        mockClient(bareServer({ callTool }));
        noStoredCredentials();
        mockToolDecls('remote-tool');
        const client = await connectedClient('remote-server', serverConfig);
        const { tools } = await client.discoverAndReturn(cfgWithResources());

        await runInContext(tools[0]);

        expect(Object.hasOwn(callTool.mock.calls[0][0], '_meta')).toBe(false);
      },
    );

    /** A connected client including 'allowed', excluding 'filtered_out', trusted. */
    function filteredClient(name: string, toolRegistry: ToolRegistry) {
      mockStdioClient(bareServer());
      mockToolDecls('allowed', 'filtered_out');
      return connectedClient(
        name,
        new MCPServerConfig(
          'test-command',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          ['allowed'],
          ['filtered_out'],
        ),
        toolRegistry,
      );
    }

    it('discoverAndReturn with { applyConfigFilters: false } ignores config filters and trust for shared pool snapshots', async () => {
      const toolRegistry = toolReg();
      const client = await filteredClient('pure-filter-server', toolRegistry);

      // R23 T1: pool callers opt out of filters via `applyConfigFilters:
      // false`. Default `discoverAndReturn(cliConfig)` (no opts) applies
      // them, matching the legacy `discover()` semantics non-pool consumers
      // expect.
      const snapshot = await client.discoverAndReturn(cfgWithResources(), {
        applyConfigFilters: false,
      });

      expect(snapshot.tools.map((tool) => tool.serverToolName)).toEqual([
        'allowed',
        'filtered_out',
      ]);
      expect(snapshot.tools.every((tool) => tool.trust === undefined)).toBe(
        true,
      );
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
    });

    it('discoverAndReturn (default) applies config filters and trust — legacy non-pool callers (R23 T1)', async () => {
      // R23 T1 regression: pre-fix `discoverAndReturn` hardcoded
      // `{ applyConfigFilters: false }`, so legacy `discover()` (which
      // delegates here) silently lost filtering and trust: operators with
      // `trust: true` saw unexpected permission prompts, and `excludeTools`
      // was ignored.
      const client = await filteredClient('legacy-filter-server', toolReg());

      // No opts → default applyConfigFilters=true → filters applied.
      const snapshot = await client.discoverAndReturn(cfgWithResources());

      // `excludeTools: ['filtered_out']` excludes the second tool;
      // `includeTools: ['allowed']` keeps the first.
      expect(snapshot.tools.map((tool) => tool.serverToolName)).toEqual([
        'allowed',
      ]);
      // `trust: true` → tools carry trust=true (pre-fix always undefined
      // because discoverAndReturn forced applyConfigFilters=false).
      expect(snapshot.tools[0].trust).toBe(true);
    });

    const EMPTY = 'No prompts, tools, or resources found on the server.';

    it('discoverAndReturn throws "No prompts or tools found" when both empty', async () => {
      // Preserves the discover() pre-F2 invariant — the wrapping
      // McpClientManager / pool entry uses this signal to mark the
      // entry as failed (vs "server up, just empty").
      promptServer([]);
      mockToolDecls();
      // Forward defense (per code-reviewer P2.4): registries must stay
      // untouched on the throw path too, catching a refactor that registers
      // a partial batch before the "no prompts or tools" guard fires.
      const toolRegistry = toolReg();
      const promptRegistry = promptReg();
      const client = await connectedClient(
        'empty-server',
        undefined,
        toolRegistry,
        promptRegistry,
      );
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow(EMPTY);
      // Status flipped to DISCONNECTED (same as discover() path).
      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      // Registries strictly untouched even on throw — pure method invariant.
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(promptRegistry.registerPrompt).not.toHaveBeenCalled();
    });

    it('discoverAndReturn records the discovery failure cause in the status registry (issue #9944)', async () => {
      // Same carrier as connect()'s catch: a server that connects but fails
      // discovery (up-but-empty) reaches discoverAndReturn()'s catch, which
      // the manager swallows for best-effort discovery. `qwen mcp reconnect`
      // relies on `getMCPServerLastError` to print the cause — the status
      // enum alone only says DISCONNECTED.
      promptServer([]);
      mockToolDecls();

      const client = await connectedClient(
        'discovery-cause-server',
        undefined,
        toolReg(),
        promptReg(),
      );
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow(EMPTY);

      expect(getMCPServerLastError('discovery-cause-server')).toBe(EMPTY);

      removeMCPServerStatus('discovery-cause-server');
    });

    it('keeps a server with only app-visible tools connected', async () => {
      mockAppOnlyMcpServer();
      const client = await connectedClient('app-only-server');

      const snapshot = await client.discoverAndReturn(cfgWithResources());

      expect(snapshot.tools).toHaveLength(1);
      expect(snapshot.tools[0].serverToolName).toBe('internal_refresh');
      expect(snapshot.tools[0].isModelVisible).toBe(false);
      expect(snapshot.tools[0].isAppVisible).toBe(true);
      expect(snapshot.prompts).toEqual([]);
      expect(snapshot.resources).toEqual([]);
      expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);
    });

    it('keeps standalone discovery connected for app-visible-only tools', async () => {
      mockAppOnlyMcpServer();
      const serverName = `app-only-standalone-${Date.now()}`;
      const toolRegistry = toolReg();

      await connectAndDiscover(
        serverName,
        { command: 'test-command' },
        toolRegistry,
        promptReg(),
        false,
        workspace(),
        cfgWithResources(),
      );

      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.CONNECTED);
      expect(toolRegistry.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverToolName: 'internal_refresh',
          appVisibility: ['app'],
        }),
      );
    });

    it('discoverAndReturn throws when called before connect()', async () => {
      const client = newClient('unconnected-server');
      // Status starts DISCONNECTED; discoverAndReturn must reject without
      // hitting the network.
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow('Client is not connected.');
    });

    it('discover() delegates to discoverAndReturn and registers both tools and prompts', async () => {
      // Backward-compat sanity: the historical discover() entry point still
      // produces side effects in BOTH registries. Prompt registration used
      // to be a side effect inside discoverPrompts; post-F2-1 it is an
      // explicit step in discover() after discoverAndReturn returns.
      promptServer([{ name: 'p1' }, { name: 'p2' }]);
      mockToolDecls('t1');
      const toolRegistry = toolReg();
      const promptRegistry = promptReg();
      const client = await connectedClient(
        'compat-server',
        undefined,
        toolRegistry,
        promptRegistry,
      );
      await client.discover(cfgWithResources());
      expect(toolRegistry.registerTool).toHaveBeenCalledTimes(1);
      expect(promptRegistry.registerPrompt).toHaveBeenCalledTimes(2);
    });

    const resourceRegistry = () => ({
      registerResource: vi.fn(),
      removeResourcesByServer: vi.fn(),
    });
    /** request() answering resources/list with res://a and prompts with []. */
    const resourceRequest = () =>
      vi
        .fn()
        .mockImplementation((req: { method?: string }) =>
          req.method === 'resources/list'
            ? Promise.resolve({ resources: [{ uri: 'res://a', name: 'a' }] })
            : Promise.resolve({ prompts: [] }),
        );
    /** Connected 'srv' client declaring resources, with fresh registries. */
    function resourceClient(extra: Obj) {
      mockStdioClient({
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        ...extra,
      });
      return connectedClient('srv', undefined, toolReg(), promptReg());
    }

    it('discover() registers discovered resources into the Config ResourceRegistry', async () => {
      const registry = resourceRegistry();
      mockToolDecls();
      const client = await resourceClient({ request: resourceRequest() });
      await client.discover(cfgWithResources(registry));
      // Clear-then-register so re-discovery (reconnect) is idempotent and a
      // dropped resource doesn't linger.
      expect(registry.removeResourcesByServer).toHaveBeenCalledWith('srv');
      expect(registry.registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'res://a', serverName: 'srv' }),
      );
    });

    it('discover() does NOT clear resources when the list returns empty (transient-failure guard)', async () => {
      // listMcpResources swallows a transient resources/list failure to [].
      // With tools present (discovery still succeeds), an empty resource list
      // must NOT wipe the registry.
      const registry = resourceRegistry();
      // A tool exists so discovery does not fail with "no prompts/tools/resources".
      mockToolDecls('t1');
      const client = await resourceClient({
        request: vi.fn().mockResolvedValue({ resources: [], prompts: [] }),
      });
      await client.discover(cfgWithResources(registry));
      expect(registry.removeResourcesByServer).not.toHaveBeenCalled();
      expect(registry.registerResource).not.toHaveBeenCalled();
    });

    it('discoverAndReturn connects a resource-only server (does not throw)', async () => {
      // The failed-discovery guard now counts resources: a server exposing
      // only resources (no tools/prompts) is a successful discovery.
      mockStdioClient({
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: resourceRequest(),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
      });
      mockToolDecls();
      const client = await connectedClient('srv');
      const snap = await client.discoverAndReturn(cfgWithResources());
      expect(snap.resources).toHaveLength(1);
      expect(snap.tools).toHaveLength(0);
      expect(snap.prompts).toHaveLength(0);
    });
  });

  /** A raw SDK client declaring `caps` whose request() is `request`. */
  const listClient = (caps: Obj, request: Mock, extra: Obj = {}) =>
    ({
      getServerCapabilities: vi.fn().mockReturnValue(caps),
      request,
      ...extra,
    }) as unknown as ClientLib.Client;
  /** listClient() for a modern-era session. */
  const modernClient = (caps: Obj, request: Mock, extra: Obj) =>
    listClient(caps, request, {
      getProtocolEra: vi.fn().mockReturnValue('modern'),
      ...extra,
    });
  const rejects = (message: string) =>
    vi.fn().mockRejectedValue(new Error(message));
  const methodNotFound = () => rejects('MCP error -32601: Method not found');
  /** Fails with ECONNRESET once, then resolves `result`. */
  const flakyOnce = (result: Obj) =>
    vi
      .fn()
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce(result);

  describe('listMcpPrompts (F2 pure helper)', () => {
    const PROMPTS = () => ({ prompts: {} });

    it('returns enriched DiscoveredMCPPrompt[] with serverName + bound invoke', async () => {
      const mockClient = listClient(
        PROMPTS(),
        vi.fn().mockResolvedValue({
          prompts: [
            { name: 'greet', description: 'Greet a user' },
            { name: 'farewell' },
          ],
        }),
      );

      const result = await listMcpPrompts('my-server', mockClient);
      expect(result).toHaveLength(2);
      expect(result[0].serverName).toBe('my-server');
      expect(result[0].name).toBe('greet');
      expect(typeof result[0].invoke).toBe('function');
      expect(result[1].name).toBe('farewell');
    });

    it('attempts prompts/list even when the prompts capability is undeclared (lenient)', async () => {
      // Regression guard: the v2 typed helper returns [] WITHOUT a request
      // when `capabilities.prompts` is absent. Modern under-declared servers
      // must still hit the wire.
      const mockClient = modernClient({}, methodNotFound(), {
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      });
      const result = await listMcpPrompts('no-prompts', mockClient);
      expect(result).toEqual([]);
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.listPrompts)).not.toHaveBeenCalled();
    });

    it('lists prompts from a server that omits the prompts capability but still answers', async () => {
      const mockClient = modernClient(
        {},
        vi.fn().mockResolvedValue({ prompts: [{ name: 'greet' }] }),
        { listPrompts: vi.fn().mockResolvedValue({ prompts: [] }) },
      );
      const result = await listMcpPrompts('under-declared', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('greet');
      expect(result[0].serverName).toBe('under-declared');
      expect(vi.mocked(mockClient.listPrompts)).not.toHaveBeenCalled();
    });

    it('uses the typed helper when a modern server declares prompts', async () => {
      const mockClient = modernClient(PROMPTS(), vi.fn(), {
        listPrompts: vi
          .fn()
          .mockResolvedValue({ prompts: [{ name: 'greet' }] }),
      });
      const result = await listMcpPrompts('modern', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('greet');
      expect(vi.mocked(mockClient.listPrompts)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.request)).not.toHaveBeenCalled();
    });

    it('returns [] on protocol error (server up but list call rejects)', async () => {
      const mockClient = listClient(PROMPTS(), rejects('boom'));
      const result = await listMcpPrompts('flaky', mockClient);
      expect(result).toEqual([]);
    });

    it('swallows a transport-wrapped -32601 body regardless of message wording', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(
          legacyOptionalMethodTransportError(
            400,
            -32601,
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32601, message: 'Unsupported method' },
              id: 1,
            }),
          ),
        ),
      } as unknown as ClientLib.Client;

      await expect(listMcpPrompts('localized', mockClient)).resolves.toEqual(
        [],
      );

      expect(mockDebugLogger.error).not.toHaveBeenCalled();
    });

    it('silently accepts a legacy -32601 envelope with alternate wording', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(
          legacyOptionalMethodSseTransportError(
            400,
            -32601,
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32601, message: 'Unsupported method' },
              id: null,
            }),
          ),
        ),
      } as unknown as ClientLib.Client;

      await expect(
        listMcpPrompts('legacy-wording', mockClient),
      ).resolves.toEqual([]);
      expect(mockDebugLogger.error).not.toHaveBeenCalled();
    });

    it('retries on transient ECONNRESET and succeeds on second attempt', async () => {
      const mockClient = listClient(
        PROMPTS(),
        flakyOnce({ prompts: [{ name: 'greet', description: 'Greet' }] }),
      );
      const result = await listMcpPrompts('retry-prompts', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('greet');
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries on persistent transient errors and returns []', async () => {
      const mockClient = listClient(PROMPTS(), rejects('read ECONNRESET'));
      const result = await listMcpPrompts('always-failing', mockClient);
      expect(result).toEqual([]);
      // 1 initial + 2 retries = 3 total calls
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(3);
    });
  });

  describe('listMcpResources', () => {
    const RESOURCES = () => ({ resources: {} });
    const fileA = () => ({ uri: 'file:///a.txt', name: 'a' });

    it('returns enriched DiscoveredMCPResource[] with serverName', async () => {
      const mockClient = listClient(
        RESOURCES(),
        vi.fn().mockResolvedValue({
          resources: [
            fileA(),
            { uri: 'file:///b.txt', name: 'b', mimeType: 'text/plain' },
          ],
        }),
      );

      const result = await listMcpResources('my-server', mockClient);
      expect(result).toHaveLength(2);
      expect(result[0].serverName).toBe('my-server');
      expect(result[0].uri).toBe('file:///a.txt');
      expect(result[1].mimeType).toBe('text/plain');
      // Resources carry no bound invoke (unlike prompts).
      expect((result[0] as Record<string, unknown>)['invoke']).toBeUndefined();
    });

    it('attempts resources/list even when the resources capability is undeclared (lenient)', async () => {
      const mockClient = modernClient({}, methodNotFound(), {
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
      });
      const result = await listMcpResources('no-resources', mockClient);
      expect(result).toEqual([]);
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.listResources)).not.toHaveBeenCalled();
    });

    it('uses the typed helper when a modern server declares resources', async () => {
      const mockClient = modernClient(RESOURCES(), vi.fn(), {
        listResources: vi.fn().mockResolvedValue({ resources: [fileA()] }),
      });
      const result = await listMcpResources('modern', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].uri).toBe('file:///a.txt');
      expect(vi.mocked(mockClient.listResources)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.request)).not.toHaveBeenCalled();
    });

    it('returns [] on protocol error (server up but list call rejects)', async () => {
      const mockClient = listClient(RESOURCES(), rejects('boom'));
      const result = await listMcpResources('flaky', mockClient);
      expect(result).toEqual([]);
    });

    it('treats JSON-RPC code -32601 as method-absent even when the message differs (no error logged)', async () => {
      // A spec-compliant server signals an unimplemented method by the
      // numeric code; the message text is not guaranteed (it may be
      // localized or worded "Method not implemented"). It must not be
      // logged as an error.
      const err = Object.assign(new Error('Método no implementado'), {
        code: -32601,
      });
      const mockClient = listClient({}, vi.fn().mockRejectedValue(err));
      const result = await listMcpResources('localized', mockClient);
      expect(result).toEqual([]);
      expect(mockDebugLogger.error).not.toHaveBeenCalled();
    });

    it('does not swallow a method-not-found phrase inside an HTTP 401 body', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi
          .fn()
          .mockRejectedValue(legacyOptionalMethodSseTransportError(401)),
      } as unknown as ClientLib.Client;

      await expect(
        listMcpResources('unauthorized', mockClient),
      ).resolves.toEqual([]);
      expect(mockDebugLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Error discovering resources from unauthorized:',
        ),
      );
    });

    it.each([
      [
        'logs genuinely unexpected errors (not method-absent)',
        'broken',
        'connection reset',
        true,
      ],
      [
        'swallows the exact "Method not found" message even without a code',
        'no-method',
        'Method not found',
        false,
      ],
      // Regression guard for the message-substring narrowing: the old broad
      // /method not found/i would have hidden this genuine failure.
      [
        'does NOT swallow an unrelated error that merely contains "method not found" (case-sensitive)',
        'weird',
        'Error in method not found handler: null pointer',
        true,
      ],
    ])('%s', async (_title, serverName, message, logged) => {
      const mockClient = listClient(RESOURCES(), rejects(message));
      const result = await listMcpResources(serverName, mockClient);
      expect(result).toEqual([]);
      if (logged) expect(mockDebugLogger.error).toHaveBeenCalled();
      else expect(mockDebugLogger.error).not.toHaveBeenCalled();
    });

    it('retries on transient ECONNRESET and succeeds on second attempt', async () => {
      const mockClient = listClient(
        RESOURCES(),
        flakyOnce({ resources: [fileA()] }),
      );
      const result = await listMcpResources('retry-server', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('a');
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries on persistent transient errors and returns []', async () => {
      const mockClient = listClient(RESOURCES(), rejects('read ECONNRESET'));
      const result = await listMcpResources('always-failing', mockClient);
      expect(result).toEqual([]);
      // 1 initial + 2 retries = 3 total calls
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(3);
    });
  });

  describe('discoverResources wrapper', () => {
    it('registers discovered resources into the supplied ResourceRegistry', async () => {
      const mockClient = listClient(
        { resources: {} },
        vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///x.txt', name: 'x' }],
        }),
      );
      const resourceRegistry = {
        registerResource: vi.fn(),
      } as unknown as ResourceRegistry;
      const out = await discoverResources(
        'wrapper-server',
        mockClient,
        resourceRegistry,
      );
      expect(resourceRegistry.registerResource).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect(out[0].uri).toBe('file:///x.txt');
      expect(out[0].serverName).toBe('wrapper-server');
    });
  });

  describe('discoverPrompts wrapper (backward compat after F2-1 split)', () => {
    it('still registers prompts into the supplied PromptRegistry', async () => {
      const mockClient = listClient(
        { prompts: {} },
        vi.fn().mockResolvedValue({ prompts: [{ name: 'register-me' }] }),
      );
      const promptRegistry = promptReg();
      const out = await discoverPrompts(
        'wrapper-server',
        mockClient,
        promptRegistry,
      );
      expect(promptRegistry.registerPrompt).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('register-me');
      // Historical contract: return type strips serverName/invoke.
      expect((out[0] as Record<string, unknown>)['serverName']).toBeUndefined();
      expect((out[0] as Record<string, unknown>)['invoke']).toBeUndefined();
    });
  });

  describe('appendMcpServerCommand', () => {
    it('should do nothing if no MCP servers or command are configured', () => {
      const out = populateMcpServerCommand({}, undefined);
      expect(out).toEqual({});
    });

    it('should discover tools via mcpServerCommand', () => {
      const commandString = 'command --arg1 value1';
      const cwd = '/session/worktree';
      const out = populateMcpServerCommand({}, commandString, cwd);
      expect(out).toEqual({
        mcp: {
          command: 'command',
          args: ['--arg1', 'value1'],
          cwd,
        },
      });
    });

    it('should handle error if mcpServerCommand parsing fails', () => {
      expect(() => populateMcpServerCommand({}, 'derp && herp')).toThrowError();
    });

    it('stamps cwd onto implicit stdio servers', () => {
      const cwd = '/session/worktree';
      const out = populateMcpServerCommand(
        {
          implicit: { command: 'node', args: ['server.js'] },
          explicit: { command: 'node', cwd: '/explicit' },
          remote: { httpUrl: 'https://example.test/mcp' },
          sdk: { type: 'sdk', command: 'placeholder' },
          tcpWithCommand: { tcp: 'tcp://example.test:9000', command: 'node' },
        },
        undefined,
        cwd,
      );
      expect(out['implicit']).toEqual({
        command: 'node',
        args: ['server.js'],
        cwd,
      });
      expect(out['explicit']?.cwd).toBe('/explicit');
      expect(out['remote']?.cwd).toBeUndefined();
      expect(out['sdk']?.cwd).toBeUndefined();
      expect(out['tcpWithCommand']?.cwd).toBeUndefined();
    });

    it('does not stamp cwd when cwd is undefined', () => {
      const servers = { local: { command: 'node', args: [] } };
      const out = populateMcpServerCommand(servers, undefined);
      expect(out['local']?.cwd).toBeUndefined();
    });

    it('does not mutate the input map', () => {
      const servers = { local: { command: 'node', args: [] } };
      const out = populateMcpServerCommand(servers, 'cmd --flag', '/wd');
      expect(servers).toEqual({ local: { command: 'node', args: [] } });
      expect(out['mcp']).toBeDefined();
      expect(out['local']?.cwd).toBe('/wd');
    });
  });

  describe('createTransport', () => {
    describe('should connect via httpUrl', () => {
      it('without headers', async () => {
        const transport = await transportFor({ httpUrl: 'http://test-server' });

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(transport._url).toEqual(new URL('http://test-server'));
        expect(transport._fetch).toEqual(expect.any(Function));
      });

      it('with headers', async () => {
        const transport = await transportFor({
          httpUrl: 'http://test-server',
          headers: { Authorization: 'derp' },
        });

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(transport._url).toEqual(new URL('http://test-server'));
        expect(transport._requestInit?.headers).toEqual({
          Authorization: 'derp',
        });
        expect(transport._fetch).toEqual(expect.any(Function));
      });

      it('captures OAuth challenges from the initial HTTP handshake', async () => {
        // The MCP transport uses a dedicated undici fetch (#7147), so stub
        // it via the test seam instead of globalThis.fetch.
        const fetchSpy = vi
          .fn()
          .mockResolvedValue(
            challenge401(
              'https://test-server/.well-known/oauth-protected-resource',
            ),
          );
        _setMcpFetchForTest(fetchSpy as unknown as typeof fetch);
        const serverName = 'handshake-oauth-server';
        const serverConfig = { httpUrl: 'https://test-server/mcp' };
        const { _fetch: transportFetch } = await transportFor(
          serverConfig,
          serverName,
        );

        const response = await transportFetch(serverConfig.httpUrl, {
          method: 'POST',
        });

        expect(response.status).toBe(401);
        expect(mcpServerRequiresOAuth.get(serverName)).toBe(true);
        await expect(
          probeMcpServerForOAuth(serverName, serverConfig),
        ).resolves.toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it('stops Agent Plugin redirects when headers or authorization are present', async () => {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(null, { status: 204 }));
        const url = 'https://example.com/mcp';
        const compat = (name: string, config?: MCPServerConfig) =>
          createStreamableHttpCompatibilityFetch(name, fetchFn, {
            httpUrl: url,
            ...config,
          });
        const bearer = { Authorization: 'Bearer token' };

        await compat('configured-headers', {
          headers: { 'X-Tenant': 'portable' },
          agentPluginV1: true,
        })(url, { method: 'POST' });
        await compat('authorization', { agentPluginV1: true })(url, {
          method: 'POST',
          headers: bearer,
        });
        await compat('ordinary')(url, { method: 'POST' });
        await compat('request-authorization', { agentPluginV1: true })(
          new Request(url, { method: 'POST', headers: bearer }),
        );

        expect(fetchFn.mock.calls[0]?.[1]).toMatchObject({
          method: 'POST',
          redirect: 'manual',
        });
        expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({
          method: 'POST',
          redirect: 'manual',
        });
        expect(fetchFn.mock.calls[2]?.[1]).toEqual({ method: 'POST' });
        expect(fetchFn.mock.calls[3]?.[1]).toMatchObject({
          redirect: 'manual',
        });
      });

      /**
       * Sends `init` (the optional GET/SSE probe by default) to /mcp through
       * the compatibility fetch over a stub answering `body` with `status`.
       */
      async function compatFetch(
        name: string,
        body: BodyInit | null,
        status: number,
        init: RequestInit = {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        },
      ) {
        const fetchFn = vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(body, { status }));
        const response = await createStreamableHttpCompatibilityFetch(
          name,
          fetchFn,
        )('http://test-server/mcp', init);
        return { fetchFn, response };
      }
      const getJson = () => ({
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      async function expectUnsupported(fetchFn: Mock, response: Response) {
        expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(405);
        expect(response.statusText).toBe('Method Not Allowed');
        expect(await response.text()).toBe('');
      }
      async function expectPassedThrough(
        response: Response,
        status: number,
        text: string,
      ) {
        expect(response.status).toBe(status);
        expect(await response.text()).toBe(text);
      }
      const expectNoBodyDiagnostics = () =>
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          expect.not.stringContaining('Response body:'),
        );

      it('treats 400 from optional GET SSE stream as unsupported', async () => {
        const { fetchFn, response } = await compatFetch(
          'spring-ai',
          'bad method',
          400,
        );
        await expectUnsupported(fetchFn, response);
      });

      it('treats 404 from optional GET SSE stream as unsupported', async () => {
        // Streamable HTTP servers with no GET route at all reject the optional
        // standalone GET/SSE notification stream with 404 — e.g. the official
        // MCP SDK's documented stateless StreamableHTTPServerTransport pattern
        // behind Express, where 404 is Express's own default fallthrough for
        // the unhandled GET (#8784). (Note: context7 returns a raw 405, which
        // the SDK tolerates natively — the earlier claim that it returned 404
        // was retracted in the issue as a reporter-side misconfiguration.)
        const { fetchFn, response } = await compatFetch(
          'no-get-route',
          'not found',
          404,
        );
        await expectUnsupported(fetchFn, response);
      });

      it.each([422, 501])(
        'treats %i from optional GET SSE stream as unsupported',
        async (status) => {
          const fetchFn = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('gateway rejection', { status }));
          const fetchWithFallback = createStreamableHttpCompatibilityFetch(
            `gateway-${status}`,
            fetchFn,
          );

          const response = await fetchWithFallback('http://test-server/mcp', {
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
          });

          expect(response.status).toBe(405);
          expect(response.statusText).toBe('Method Not Allowed');
          expect(await response.text()).toBe('');
        },
      );

      it('does not rewrite non-SSE GET 404 responses', async () => {
        const { response } = await compatFetch(
          'plain-get-404',
          'not found',
          404,
          getJson(),
        );
        await expectPassedThrough(response, 404, 'not found');
      });

      it('does not rewrite POST 404 responses', async () => {
        // The SDK's real POST requests set this exact Accept header
        // (streamableHttp.ts's transport always sends
        // 'application/json, text/event-stream'), so the method check is
        // the only thing standing between a genuine tool-call 404 and being
        // silently rewritten into a synthetic 405 — the Accept header alone
        // does not disambiguate POST from the optional GET/SSE probe.
        const { response } = await compatFetch('post-404', 'not found', 404, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
        });
        await expectPassedThrough(response, 404, 'not found');
      });

      it('bounds the fallback body excerpt read when the 404 body stalls', async () => {
        // A server that answers the optional GET/SSE probe with 404 headers and
        // then never sends a body chunk must not park the diagnostics read
        // forever: the MCP dispatcher runs with `headersTimeout: 0,
        // bodyTimeout: 0` and nothing above this wrapper bounds the body.
        vi.useFakeTimers();
        try {
          const pending = compatFetch(
            'stalled-404-body',
            // Headers are already delivered; the body never yields.
            new ReadableStream({ pull: () => new Promise<void>(() => {}) }),
            404,
          );
          await vi.advanceTimersByTimeAsync(2_000);
          const { response } = await pending;

          expect(response.status).toBe(405);
          expectNoBodyDiagnostics();
        } finally {
          vi.useRealTimers();
        }
      });

      it('omits response body diagnostics when the fallback body is empty', async () => {
        const { response } = await compatFetch('empty-body', null, 400);

        expect(response.status).toBe(405);
        expectNoBodyDiagnostics();
      });

      it('truncates Streamable HTTP GET SSE error body diagnostics', async () => {
        const { response } = await compatFetch(
          'large-error-body',
          'x'.repeat(1024),
          400,
        );

        expect(response.status).toBe(405);
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `Response body: ${JSON.stringify(`${'x'.repeat(512)}...`)}`,
          ),
        );
        expect(mockDebugLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('x'.repeat(600)),
        );
      });

      it('treats parameterized GET SSE Accept headers as unsupported', async () => {
        const { response } = await compatFetch('spring-ai', 'bad method', 400, {
          method: 'GET',
          headers: {
            Accept: 'application/json, text/event-stream; charset=utf-8',
          },
        });

        expect(response.status).toBe(405);
      });

      it('does not hide Streamable HTTP GET SSE server errors', async () => {
        const { response } = await compatFetch(
          'server-error',
          'server exploded',
          502,
        );

        expect(response.status).toBe(502);
      });

      it('does not rewrite the SDK-native GET SSE unsupported sentinel', async () => {
        const { response } = await compatFetch(
          'native-unsupported',
          'method not allowed',
          405,
        );
        await expectPassedThrough(response, 405, 'method not allowed');
      });

      it('does not rewrite resumable GET SSE errors with Last-Event-ID', async () => {
        const body = '{"error":"invalid cursor"}';
        const { response } = await compatFetch('resume-error', body, 400, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            'Last-Event-ID': 'event-123',
          },
        });
        await expectPassedThrough(response, 400, body);
      });

      it('does not rewrite non-SSE GET responses', async () => {
        const { response } = await compatFetch(
          'plain-get',
          'bad request',
          400,
          getJson(),
        );

        expect(response.status).toBe(400);
      });

      it('does not rewrite POST responses', async () => {
        const { response } = await compatFetch(
          'post-test',
          'bad request',
          400,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
        );

        expect(response.status).toBe(400);
      });
    });

    describe('should connect via url', () => {
      it('without headers', async () => {
        const transport = await transportFor({ url: 'http://test-server' });
        expect(transport).toBeInstanceOf(SSEClientTransport);
        expect(transport._url).toEqual(new URL('http://test-server'));
      });

      it('with headers', async () => {
        const transport = await transportFor({
          url: 'http://test-server',
          headers: { Authorization: 'derp' },
        });

        expect(transport).toBeInstanceOf(SSEClientTransport);
        expect(transport._url).toEqual(new URL('http://test-server'));
        expect(transport._requestInit?.headers).toEqual({
          Authorization: 'derp',
        });
      });
    });

    /** Creates a stdio transport for `config`; returns the constructor spy. */
    async function spawnStdio(
      config: MCPServerConfig = { command: 'test-command' },
    ) {
      const mockedTransport = stubStdio();
      await createTransport('test-server', config, false);
      return mockedTransport;
    }
    /** The env handed to the stdio child spawned for `config`. */
    const spawnedEnv = async (config?: MCPServerConfig) =>
      (await spawnStdio(config)).mock.calls[0]?.[0]?.env ?? {};
    const setEnv = (env: NodeJS.ProcessEnv) => {
      process.env = { ...ORIGINAL_ENV, ...env };
    };

    it('should connect via command', async () => {
      const mockedTransport = await spawnStdio({
        command: 'test-command',
        args: ['--foo', 'bar'],
        env: { FOO: 'bar' },
        cwd: 'test/cwd',
      });

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: ['--foo', 'bar'],
        cwd: 'test/cwd',
        // Use objectContaining because normalizePathEnvForWindows deduplicates
        // PATH entries on Windows, so the env won't be an exact spread match.
        env: expect.objectContaining({ FOO: 'bar' }),
        stderr: 'pipe',
      });
    });

    it('strips Qwen-internal daemon secrets from the stdio child env (#6601)', async () => {
      setEnv({
        QWEN_SERVER_TOKEN: 'serve-secret',
        QWEN_DAEMON_TOKEN: 'daemon-secret',
        GH_TOKEN: 'gh-abc',
      });

      const transportEnv = await spawnedEnv();
      // Internal daemon secrets must never reach an agent-launched stdio server.
      expect(transportEnv['QWEN_SERVER_TOKEN']).toBeUndefined();
      expect(transportEnv['QWEN_DAEMON_TOKEN']).toBeUndefined();
      // Third-party credentials the server may legitimately need are preserved.
      expect(transportEnv['GH_TOKEN']).toBe('gh-abc');
    });

    it('strips the AppImage Python environment from stdio children only under the desktop shell (#11718)', async () => {
      setEnv({
        QWEN_CODE_DESKTOP: '1',
        PYTHONHOME: '/tmp/.mount_qwen/usr/',
        PYTHONPATH: '/tmp/.mount_qwen/usr/share/pyshared/',
      });

      const transportEnv = await spawnedEnv();
      expect(transportEnv['PYTHONHOME']).toBeUndefined();
      expect(transportEnv['PYTHONPATH']).toBeUndefined();
    });

    it('keeps an explicit PYTHONHOME from the server config under the desktop shell (#11718)', async () => {
      setEnv({ QWEN_CODE_DESKTOP: '1', PYTHONHOME: '/tmp/.mount_qwen/usr/' });

      const transportEnv = await spawnedEnv({
        command: 'test-command',
        env: { PYTHONHOME: '/home/user/py313' },
      });
      // An explicit per-server override still wins — the strip only covers
      // the inherited (AppImage) value, not an operator's deliberate setting.
      expect(transportEnv['PYTHONHOME']).toBe('/home/user/py313');
    });

    it('leaves a user-provided PYTHONHOME untouched outside the desktop shell (#11718)', async () => {
      setEnv({ PYTHONHOME: '/home/user/py313' });
      delete process.env['QWEN_CODE_DESKTOP'];

      const transportEnv = await spawnedEnv();
      expect(transportEnv['PYTHONHOME']).toBe('/home/user/py313');
    });

    /** Simulates Windows with both PATH and Path in the parent env. */
    function mockWindowsPaths() {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      setEnv({
        PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools',
        Path: 'C:\\Users\\tester\\bin;C:\\Shared\\Tools',
      });
    }

    it('should normalize PATH-like env keys on Windows for stdio transport', async () => {
      mockWindowsPaths();
      const mockedTransport = await spawnStdio({
        command: 'test-command',
        env: { FOO: 'bar' },
      });

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: [],
        cwd: undefined,
        env: expect.objectContaining({
          PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools;C:\\Users\\tester\\bin',
          FOO: 'bar',
        }),
        stderr: 'pipe',
      });
      const transportOptions = mockedTransport.mock.calls[0]?.[0];
      expect(transportOptions?.env?.['Path']).toBeUndefined();
    });

    it('should let server config PATH override parent PATH on Windows', async () => {
      mockWindowsPaths();
      const transportEnv = await spawnedEnv({
        command: 'test-command',
        env: { PATH: 'C:\\ServerToolchain\\bin' },
      });

      // Server-provided PATH should fully replace the parent PATH, not merge
      expect(transportEnv['PATH']).toBe('C:\\ServerToolchain\\bin');
      expect(transportEnv['Path']).toBeUndefined();
    });

    it('should connect via command without cwd', async () => {
      const mockedTransport = await spawnStdio({
        command: 'test-command',
        args: ['--foo', 'bar'],
      });

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: ['--foo', 'bar'],
        cwd: undefined,
        env: expect.any(Object),
        stderr: 'pipe',
      });
    });

    it('should throw if cwd does not exist', async () => {
      mockExistsSync.mockReturnValueOnce(false);

      await expect(
        createTransport(
          'test-server',
          { command: 'test-command', cwd: '/nonexistent/path' },
          false,
        ),
      ).rejects.toThrow(
        "MCP server 'test-server': configured cwd does not exist: /nonexistent/path",
      );
    });

    describe('useGoogleCredentialProvider', () => {
      const googleAuth = () => ({
        authProviderType: AuthProviderType.GOOGLE_CREDENTIALS,
        oauth: { scopes: ['scope1'] },
      });

      it('should use GoogleCredentialProvider when specified', async () => {
        const transport = await transportFor({
          httpUrl: 'http://test.googleapis.com',
          ...googleAuth(),
        });

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(transport._oauthProvider).toBeInstanceOf(
          GoogleCredentialProvider,
        );
        expect(transport._fetch).toEqual(expect.any(Function));
      });

      it('should use GoogleCredentialProvider with SSE transport', async () => {
        const transport = await transportFor({
          url: 'http://test.googleapis.com',
          ...googleAuth(),
        });

        expect(transport).toBeInstanceOf(SSEClientTransport);
        expect(transport._oauthProvider).toBeInstanceOf(
          GoogleCredentialProvider,
        );
      });

      it('should throw an error if no URL is provided with GoogleCredentialProvider', async () => {
        await expect(
          createTransport('test-server', googleAuth(), false),
        ).rejects.toThrow(
          'URL must be provided in the config for Google Credentials provider',
        );
      });
    });

    describe('authenticated Streamable HTTP compatibility fetch', () => {
      afterEach(() => {
        vi.mocked(MCPOAuthProvider).mockReset();
        vi.mocked(MCPOAuthTokenStorage).mockReset();
      });

      const oauthConfig = () => ({
        httpUrl: 'http://test-server',
        oauth: { enabled: true, clientId: 'client-id' },
      });

      it('throws the /mcp instruction when OAuth has no valid token', async () => {
        const { getValidToken } = mockOAuthProvider({
          getValidToken: vi.fn().mockResolvedValue(null),
        });

        await expect(
          createTransport('oauth-test-server', oauthConfig(), false),
        ).rejects.toThrow(
          getMcpOAuthDialogInstruction('authenticate', 'oauth-test-server'),
        );
        expect(getValidToken).toHaveBeenCalledWith('oauth-test-server', {
          enabled: true,
          clientId: 'client-id',
        });
      });

      it('warns when stored OAuth credentials cannot produce a token', async () => {
        const getCredentials = mockTokenStorage(
          vi.fn().mockResolvedValue({ clientId: 'client-id' }),
        );
        const { getValidToken } = mockOAuthProvider({
          getValidToken: vi.fn().mockResolvedValue(null),
        });

        const transport = await transportFor(
          { httpUrl: 'http://test-server' },
          'oauth-test-server',
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(getCredentials).toHaveBeenCalledWith('oauth-test-server');
        expect(getValidToken).toHaveBeenCalledWith('oauth-test-server', {
          clientId: 'client-id',
        });
        expect(mockDebugLogger.warn).toHaveBeenCalledWith(
          "Stored OAuth credentials exist for server 'oauth-test-server' but no valid token could be obtained. Transport will be created without authentication; expect a 401. " +
            getMcpOAuthDialogInstruction(
              're-authenticate',
              'oauth-test-server',
            ),
        );
      });

      it('wires the compatibility fetch for OAuth httpUrl transports', async () => {
        const { getValidToken } = mockOAuthProvider({
          getValidToken: vi.fn().mockResolvedValue('oauth-token'),
        });

        const transport = await transportFor(
          oauthConfig(),
          'oauth-test-server',
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(getValidToken).toHaveBeenCalledWith('oauth-test-server', {
          enabled: true,
          clientId: 'client-id',
        });
        expect(transport._fetch).toEqual(expect.any(Function));
      });

      it('wires the compatibility fetch for service account httpUrl transports', async () => {
        const transport = await transportFor(
          {
            httpUrl: 'http://test-server',
            authProviderType: AuthProviderType.SERVICE_ACCOUNT_IMPERSONATION,
            targetAudience: 'client.apps.googleusercontent.com',
            targetServiceAccount:
              'service-account@example-project.iam.gserviceaccount.com',
          },
          'service-account-test-server',
        );

        expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
        expect(transport._fetch).toEqual(expect.any(Function));
      });
    });
  });
  describe('isEnabled', () => {
    const funcDecl = { name: 'myTool' };
    const serverName = 'myServer';

    it.each<[string, MCPServerConfig, boolean]>([
      [
        'should return true if no include or exclude lists are provided',
        {},
        true,
      ],
      [
        'should return false if the tool is in the exclude list',
        { excludeTools: ['myTool'] },
        false,
      ],
      [
        'should return true if the tool is in the include list',
        { includeTools: ['myTool'] },
        true,
      ],
      [
        'should return true if the tool is in the include list with parentheses',
        { includeTools: ['myTool()'] },
        true,
      ],
      [
        'should return false if the include list exists but does not contain the tool',
        { includeTools: ['anotherTool'] },
        false,
      ],
      [
        'should return false if the tool is in both the include and exclude lists',
        { includeTools: ['myTool'], excludeTools: ['myTool'] },
        false,
      ],
    ])('%s', (_title, mcpServerConfig, expected) => {
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(expected);
    });

    it('should return false if the function declaration has no name', () => {
      expect(isEnabled({}, serverName, {})).toBe(false);
    });
  });

  describe('removeMCPServerStatus', () => {
    afterEach(() => {
      // Clean up any state left in the module-level registry between tests.
      for (const name of getAllMCPServerStatuses().keys()) {
        removeMCPServerStatus(name);
      }
    });

    it('removes the entry from the global status map', () => {
      updateMCPServerStatus('srv-a', MCPServerStatus.DISCONNECTED);
      expect(getAllMCPServerStatuses().has('srv-a')).toBe(true);

      removeMCPServerStatus('srv-a');

      expect(getAllMCPServerStatuses().has('srv-a')).toBe(false);
      // getMCPServerStatus falls back to DISCONNECTED for unknown servers,
      // but the snapshot map should no longer include the entry.
      expect(getMCPServerStatus('srv-a')).toBe(MCPServerStatus.DISCONNECTED);
    });

    it('notifies listeners with undefined to signal removal', () => {
      const events: Array<[string, MCPServerStatus | undefined]> = [];
      const listener = (name: string, status: MCPServerStatus | undefined) => {
        events.push([name, status]);
      };
      addMCPStatusChangeListener(listener);

      updateMCPServerStatus('srv-b', MCPServerStatus.CONNECTED);
      removeMCPServerStatus('srv-b');

      removeMCPStatusChangeListener(listener);

      expect(events).toEqual([
        ['srv-b', MCPServerStatus.CONNECTED],
        ['srv-b', undefined],
      ]);
    });

    it('is a no-op (no listener fired) when the server is not tracked', () => {
      const listener = vi.fn();
      addMCPStatusChangeListener(listener);

      removeMCPServerStatus('never-registered');

      removeMCPStatusChangeListener(listener);
      expect(listener).not.toHaveBeenCalled();
    });

    /** A stdio client with close() (plus `extra`) over `transport`. */
    const closableClient = (transport: Obj, extra: Obj = {}) =>
      mockStdioClient({ close: vi.fn(), ...extra }, transport);

    it('a stale status update from an in-flight connect cannot resurrect a removed server', async () => {
      // Race scenario from PR review: `disableMcpServer` removes the entry,
      // but `McpClient.connect()`'s catch block could still fire afterwards
      // and call `updateStatus(DISCONNECTED)`. The `isDisconnecting` guard
      // inside `McpClient.updateStatus` must prevent that resurrection.
      closableClient(
        { close: vi.fn() },
        { connect: vi.fn().mockRejectedValue(new Error('connect failed')) },
      );
      const client = newClient('racy-server');

      // Kick off connect() but don't await it; it will reject and run its
      // catch block which calls updateStatus(DISCONNECTED).
      const connectPromise = client.connect();

      // Simulate the disable path running before connect's catch fires.
      await client.disconnect();
      removeMCPServerStatus('racy-server');

      // Now let the rejected connect propagate.
      await expect(connectPromise).rejects.toThrow('connect failed');

      // The entry must remain absent — no resurrection.
      expect(getAllMCPServerStatuses().has('racy-server')).toBe(false);
      // Same invariant for the failure-cause map: the status write is
      // suppressed by the `isDisconnecting` guard, and the lastError record
      // in connect()'s catch must be gated the same way — otherwise the
      // doomed in-flight connect resurrects an orphan cause entry that
      // `removeMCPServerStatus` already dropped (persisting until process
      // exit and misattributing to a later re-added incarnation).
      expect(getMCPServerLastError('racy-server')).toBeUndefined();
    });

    it('disconnect() propagates DISCONNECTED to the global registry', async () => {
      // Regression: a previous version set `isDisconnecting = true` BEFORE
      // calling `updateStatus(DISCONNECTED)`, and `updateStatus`'s guard
      // (designed to block stale `connect()` catch updates) silently
      // swallowed the write. The global registry stayed CONNECTED forever,
      // so `Config.getFailedMcpServerNames()` (which filters
      // `status !== CONNECTED`) omitted timeout-disconnected servers from
      // the non-interactive failure banner and the Footer's MCP health
      // pill kept counting them as healthy.
      closableClient({ close: vi.fn().mockResolvedValue(undefined) });
      const client = clientInWorkspace('healthy-server');

      await client.connect();
      // After connect, the registry should show CONNECTED.
      expect(getMCPServerStatus('healthy-server')).toBe(
        MCPServerStatus.CONNECTED,
      );

      await client.disconnect();
      // After an intentional disconnect, the global registry MUST reflect
      // DISCONNECTED — otherwise downstream code (failure banner, health
      // pill) treats the server as still healthy.
      expect(getMCPServerStatus('healthy-server')).toBe(
        MCPServerStatus.DISCONNECTED,
      );

      // Cleanup the registry entry so this test doesn't leak.
      removeMCPServerStatus('healthy-server');
    });

    it('disconnect() terminates a Streamable HTTP session before closing the transport (issue #9944)', async () => {
      // The SDK's `transport.close()` only tears down local state; the
      // server-side session stays alive unless we send the spec's DELETE
      // (`terminateSession()`). An abandoned session keeps occupying
      // single-session servers, which then reject every later `initialize`
      // with "Server already initialized".
      const callOrder: string[] = [];
      const mockedTransport = {
        terminateSession: vi.fn().mockImplementation(async () => {
          callOrder.push('terminateSession');
        }),
        close: vi.fn().mockImplementation(async () => {
          callOrder.push('close');
        }),
      };
      closableClient(mockedTransport);
      const client = clientInWorkspace('http-server');

      await client.connect();
      await client.disconnect();

      expect(mockedTransport.terminateSession).toHaveBeenCalledTimes(1);
      // Termination must happen while the transport can still send
      // requests — i.e. before `close()` aborts it.
      expect(callOrder).toEqual(['terminateSession', 'close']);

      removeMCPServerStatus('http-server');
    });

    it('disconnect() swallows session-termination failures (issue #9944)', async () => {
      // A dead server must not block teardown: the DELETE fails, but
      // disconnect still completes and closes the transport.
      const mockedTransport = {
        terminateSession: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        close: vi.fn().mockResolvedValue(undefined),
      };
      closableClient(mockedTransport);
      const client = clientInWorkspace('dead-http-server');

      await client.connect();
      await expect(client.disconnect()).resolves.toBeUndefined();
      expect(mockedTransport.close).toHaveBeenCalledTimes(1);
      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);

      removeMCPServerStatus('dead-http-server');
    });

    it('disconnect() does not hang when terminateSession never responds (issue #9944)', async () => {
      // A live-but-unresponsive server (TCP open, never answers the DELETE)
      // must not block teardown: the SDK's `terminateSession()` has no
      // timeout of its own and the transport's abort controller is only
      // aborted by `close()` — which runs after the await. `disconnect()`
      // therefore bounds the call and proceeds to `close()`, which aborts
      // the still-in-flight request.
      vi.useFakeTimers();
      try {
        const mockedTransport = {
          terminateSession: vi.fn(() => new Promise<void>(() => {})), // never settles
          close: vi.fn().mockResolvedValue(undefined),
        };
        closableClient(mockedTransport);
        const client = clientInWorkspace('unresponsive-http-server');

        await client.connect();
        const disconnected = client.disconnect();
        // The bounded wait fires, and teardown completes even though the
        // DELETE never got an answer.
        await vi.advanceTimersByTimeAsync(2_000);
        await expect(disconnected).resolves.toBeUndefined();
        expect(mockedTransport.close).toHaveBeenCalledTimes(1);
        expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);

        removeMCPServerStatus('unresponsive-http-server');
      } finally {
        vi.useRealTimers();
      }
    });

    it('records the connect failure cause in the status registry (issue #9944)', async () => {
      // Discovery is best-effort and swallows connect errors (the manager's
      // catch logs them via debugLogger only), so the status enum alone
      // cannot tell a consumer WHY a server is not CONNECTED. connect() must
      // record the cause so `qwen mcp reconnect` can print it.
      const cause = 'connect ECONNREFUSED 127.0.0.1:3939';
      const mockedClient = closableClient(
        { close: vi.fn().mockResolvedValue(undefined) },
        { connect: vi.fn().mockRejectedValue(new Error(cause)) },
      );
      const client = clientInWorkspace('cause-recording-server');

      await expect(client.connect()).rejects.toThrow(cause);
      expect(getMCPServerLastError('cause-recording-server')).toBe(cause);

      // A recovered connection clears the stale cause.
      mockedClient.connect.mockResolvedValue(undefined);
      await client.connect();
      expect(getMCPServerLastError('cause-recording-server')).toBeUndefined();

      removeMCPServerStatus('cause-recording-server');
    });
  });

  describe('hasNetworkTransport', () => {
    it.each<[string, MCPServerConfig, boolean]>([
      [
        'should return true if only url is provided',
        { url: 'http://example.com' },
        true,
      ],
      [
        'should return true if only httpUrl is provided',
        { httpUrl: 'http://example.com' },
        true,
      ],
      [
        'should return true if both url and httpUrl are provided',
        { url: 'http://example.com/sse', httpUrl: 'http://example.com/http' },
        true,
      ],
      [
        'should return false if neither url nor httpUrl is provided',
        { command: 'do-something' },
        false,
      ],
      ['should return false for an empty config object', {}, false],
    ])('%s', (_title, config, expected) => {
      expect(hasNetworkTransport(config)).toBe(expected);
    });
  });
});

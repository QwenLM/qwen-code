/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 本文件锁 `registerHostMcpServers` 的三类不变量：
 *
 * 1. **`mcp_message` 的语义负载与回包处理是外部契约。** 会话交给宿主的是 camelCase 的
 *    `{ serverName, message }`——蛇形 `server_name` 字段名与 request_id 相关性配对
 *    （多帧并发时不能串）都归宿主编解码器，本层锁的是：负载形状正确、每次调用各等各的
 *    回包，且只有 `mcp_response` 里的内容能交给 MCP 客户端——整包回传会让 JSON-RPC 层
 *    多一层壳。回包缺 `mcp_response` 时的错误文本与 worker 逐字对齐，改文案会让同一个
 *    失败在两种形态下分叉。
 * 2. **声明与工具级覆盖的校验决定 core 拿到什么。** server 名过滤、只认已声明 server、
 *    `exposedName` 走 isStringProp、`alwaysLoad` 走本模块手抄的 isBooleanProp、两者都不可用
 *    就整条丢掉、丢空了连 server 键都不留——这份 `toolOverridesByServer` 直接决定发现出的
 *    工具集里有哪些 `mcp__<server>__<tool>`、以什么名字暴露给模型。
 * 3. **失败不冒泡。** mcpManager 取不到或注册抛错都只 warn：一个连不上的 server 不该让
 *    整个 initialize 失败。
 *
 * 最后一组用例把本模块产出的传输层闭包直接喂给 core 真实的 SDK bridge，闭环验证
 * 文件头声称的「没接这一段就等于 mcp_message 这条反向请求永远不会出现」。
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  runLogger,
  setupSdkMcpClients,
  type Config,
  type McpClientContext,
  type McpToolRuntimeOverride,
  type SendMcpMessageCallback,
} from '@qwen-code/core';
import { registerHostMcpServers } from './sessionHostMcpServers.js';
import type { ThreadSessionDeclarations } from '../contract/threadSessionTypes.js';

type ToolOverridesByServer = Record<
  string,
  Record<string, McpToolRuntimeOverride>
>;

/** 会话交给宿主反向请求通道的语义负载（camelCase；蛇形映射归宿主）。 */
interface McpPayload {
  serverName: string;
  message: Record<string, unknown>;
}

interface RegisterCall {
  serverNames: string[];
  send: SendMcpMessageCallback;
  overrides: ToolOverridesByServer;
}

interface HostCall {
  payload: McpPayload;
  resolve: (response: unknown) => void;
  reject: (error: unknown) => void;
}

interface SetupOptions {
  /** missing = getter 返回 undefined；absent = config 上根本没有这个 getter。 */
  manager?: 'missing' | 'absent';
  result?: { connectedServers: string[]; failedServers: string[] };
  /** 假宿主：按负载自动产出 `{ mcp_response: ... }` 回包，供闭环用例使用。 */
  host?: (serverName: string, message: Record<string, unknown>) => unknown;
}

function setup(options: SetupOptions = {}) {
  const calls: RegisterCall[] = [];
  const hostCalls: HostCall[] = [];
  const registerSdkMcpClients = vi.fn(
    async (
      serverNames: string[],
      send: SendMcpMessageCallback,
      overrides: ToolOverridesByServer,
    ) => {
      calls.push({ serverNames, send, overrides });
      return (
        options.result ?? {
          connectedServers: [...serverNames],
          failedServers: [] as string[],
        }
      );
    },
  );
  const config = (options.manager === 'absent'
    ? {}
    : {
        getMcpClientManager: () =>
          options.manager === 'missing' ? undefined : { registerSdkMcpClients },
      }) as unknown as Config;

  // 假宿主反向请求通道：没有自动应答 host 时保持在途，由用例逐次回包驱动。
  const sendMcpMessage = vi.fn(
    (payload: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const record = payload as McpPayload;
        hostCalls.push({ payload: record, resolve, reject });
        if (options.host) {
          resolve({
            mcp_response: options.host(record.serverName, record.message),
          });
        }
      }),
  );

  return {
    hostCalls,
    calls,
    registerSdkMcpClients,
    sendMcpMessage,
    run: (declarations: ThreadSessionDeclarations) =>
      registerHostMcpServers({ config, declarations, sendMcpMessage }),
    overrides: () => calls[0]!.overrides,
    send: () => calls[0]!.send,
    lastCall: () => hostCalls[hostCalls.length - 1]!,
    /** 就地回最后一次反向请求，等价于宿主按自己的关联表把回包路由回来。 */
    replyLast: (response: unknown) => {
      hostCalls[hostCalls.length - 1]!.resolve(response);
    },
  };
}

/** 假 SDK Host：用最小 JSON-RPC 应答撑起一次 MCP 握手与 tools/list。 */
function sdkHost(tools: Array<Record<string, unknown>>) {
  return (_serverName: string, message: Record<string, unknown>): unknown => {
    const id = message['id'];
    // 通知没有 id，但传输层一律要等一次回包，所以也得回。
    if (id === undefined || id === null) return null;
    if (message['method'] === 'initialize') {
      const params = message['params'] as Record<string, unknown>;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params['protocolVersion'],
          capabilities: { tools: {} },
          serverInfo: { name: 'sdk-host', version: '1.0.0' },
        },
      };
    }
    if (message['method'] === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools } };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    };
  };
}

function mcpTool(name: string) {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
  };
}

async function discover(harness: ReturnType<typeof setup>) {
  const call = harness.calls[0]!;
  const diagnostics = vi.fn();
  const { tools } = await setupSdkMcpClients(call.serverNames, call.send, {
    clientVersion: '0.0.1',
    cliConfig: { emitMcpDiagnostic: diagnostics } as unknown as McpClientContext,
    toolOverridesByServer: call.overrides,
  });
  return { tools, diagnostics };
}

let warnSpy: MockInstance;
let logSpy: MockInstance;

beforeEach(() => {
  warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe('registerHostMcpServers: 声明解析', () => {
  it.each([
    ['没有 mcpServers 字段', {}],
    ['字段不是数组', { mcpServers: 'sdk' }],
    ['字段是对象', { mcpServers: { 0: 'sdk' } }],
    ['数组为空', { mcpServers: [] }],
    [
      '数组里全是非字符串或空串',
      { mcpServers: ['', 42, null, { name: 'sdk' }] },
    ],
  ])('没有可用 server 名时是空操作：%s', async (_label, request) => {
    const harness = setup();
    await harness.run(request);
    expect(harness.registerSdkMcpClients).not.toHaveBeenCalled();
    expect(harness.sendMcpMessage).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('非字符串与空串条目被过滤，剩下的按声明顺序交给 manager', async () => {
    const harness = setup();
    await harness.run({ mcpServers: ['a', 42, '', 'b', null] });
    expect(harness.calls[0]!.serverNames).toEqual(['a', 'b']);
  });

  it.each([
    ['getter 返回 undefined', 'missing'],
    ['config 上没有 getter', 'absent'],
  ])(
    'mcpManager 取不到时只 warn、不注册也不抛：%s',
    async (_label, manager) => {
      const harness = setup({ manager: manager as 'missing' | 'absent' });
      await expect(
        harness.run({ mcpServers: ['sdk'] }),
      ).resolves.toBeUndefined();
      expect(harness.sendMcpMessage).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[thread-session] sdkMcpServers received but mcpManager is unavailable — skipping registration.',
      );
    },
  );

  it('注册抛错只 warn，不让一个连不上的 server 拖垮 initialize', async () => {
    const harness = setup();
    const failure = new Error('bridge down');
    harness.registerSdkMcpClients.mockRejectedValueOnce(failure);

    await expect(harness.run({ mcpServers: ['sdk'] })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      '[thread-session] Failed to register SDK MCP servers:',
      failure,
    );
  });

  it('注册结果按 connected / failed 两个列表落日志', async () => {
    const harness = setup({
      result: { connectedServers: ['a'], failedServers: ['b'] },
    });
    await harness.run({ mcpServers: ['a', 'b'] });
    expect(logSpy).toHaveBeenCalledWith(
      '[thread-session] Registered SDK MCP servers: connected=[a] failed=[b]',
    );
  });
});

describe('registerHostMcpServers: 工具级覆盖校验', () => {
  it('没有 mcpToolOverrides 字段时第三个参数是空对象', async () => {
    const harness = setup();
    await harness.run({ mcpServers: ['sdk'] });
    expect(harness.overrides()).toEqual({});
  });

  it('exposedName 与 alwaysLoad 原样透传', async () => {
    const harness = setup();
    await harness.run({
      mcpServers: ['sdk'],
      mcpToolOverrides: {
        sdk: { echo: { exposedName: 'sdk_echo', alwaysLoad: true } },
      },
    });
    expect(harness.overrides()).toEqual({
      sdk: { echo: { exposedName: 'sdk_echo', alwaysLoad: true } },
    });
  });

  it('alwaysLoad 非布尔时按缺失处理，exposedName 非字符串时同理', async () => {
    const harness = setup();
    await harness.run({
      mcpServers: ['sdk'],
      mcpToolOverrides: {
        sdk: {
          echo: { exposedName: 'sdk_echo', alwaysLoad: 'true' },
          ping: { exposedName: 42, alwaysLoad: true },
        },
      },
    });
    expect(harness.overrides()).toEqual({
      sdk: {
        echo: { exposedName: 'sdk_echo', alwaysLoad: undefined },
        ping: { exposedName: undefined, alwaysLoad: true },
      },
    });
  });

  it('两个字段都不可用时整条工具覆盖丢掉，server 下没有存活条目就连 server 键也不留', async () => {
    const harness = setup();
    await harness.run({
      mcpServers: ['sdk', 'other'],
      mcpToolOverrides: {
        sdk: { echo: { alwaysLoad: 'yes' }, ping: {} },
        other: { read: { exposedName: 'other_read', alwaysLoad: false } },
      },
    });
    expect(harness.overrides()).toEqual({
      other: { read: { exposedName: 'other_read', alwaysLoad: false } },
    });
    expect(Object.keys(harness.overrides())).toEqual(['other']);
  });

  it('未声明 server 的覆盖整条丢掉，已声明 server 的保留', async () => {
    const harness = setup();
    await harness.run({
      mcpServers: ['sdk'],
      mcpToolOverrides: {
        sdk: { echo: { alwaysLoad: true } },
        undeclared: { echo: { alwaysLoad: true } },
      },
    });
    expect(Object.keys(harness.overrides())).toEqual(['sdk']);
  });

  it.each([
    ['覆盖字段是数组', { mcpToolOverrides: [{ sdk: {} }] }],
    ['覆盖字段是字符串', { mcpToolOverrides: 'sdk' }],
    ['server 级是数组', { mcpToolOverrides: { sdk: [{ alwaysLoad: true }] } }],
    ['server 级是 null', { mcpToolOverrides: { sdk: null } }],
    [
      '工具级是数组',
      { mcpToolOverrides: { sdk: { echo: [{ alwaysLoad: true }] } } },
    ],
    ['工具级是字符串', { mcpToolOverrides: { sdk: { echo: 'always' } } }],
    ['工具级是 null', { mcpToolOverrides: { sdk: { echo: null } } }],
  ])('非对象形状的覆盖整段忽略，不影响注册本身：%s', async (_label, extra) => {
    const harness = setup();
    await harness.run({ mcpServers: ['sdk'], ...extra });
    expect(harness.calls[0]!.serverNames).toEqual(['sdk']);
    expect(harness.overrides()).toEqual({});
  });
});

describe('registerHostMcpServers: mcp_message 反向请求', () => {
  async function registered(request: Record<string, unknown> = {}) {
    const harness = setup();
    await harness.run({ mcpServers: ['sdk'], ...request });
    return harness;
  }

  it('负载是宿主契约：camelCase 的 serverName / message，回包拆出 mcp_response', async () => {
    const harness = await registered();
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' } as const;
    const pending = harness.send()('sdk', message);
    harness.replyLast({ mcp_response: { jsonrpc: '2.0', id: 1, result: {} } });

    expect(harness.lastCall().payload).toEqual({
      serverName: 'sdk',
      message,
    });
    await expect(pending).resolves.toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {},
    });
  });

  it('每次调用各发一次反向请求，回包各归各不串', async () => {
    const harness = await registered();
    // request_id 的唯一性与配对已归宿主的关联表，本层锁的是「每次调用各自 settle
    // 自己的回包」：两次在途时逐次回包，谁也不会认领别人的结果。
    const first = harness.send()('sdk', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    harness.replyLast({ mcp_response: { id: 1 } });
    const second = harness.send()('other', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
    });
    harness.replyLast({ mcp_response: { id: 2 } });

    await expect(first).resolves.toEqual({ id: 1 });
    await expect(second).resolves.toEqual({ id: 2 });
    expect(harness.hostCalls).toHaveLength(2);
    expect(harness.hostCalls.map((call) => call.payload.serverName)).toEqual([
      'sdk',
      'other',
    ]);
  });

  it('回包里显式的 null mcp_response 是合法的（通知类消息也要有回包）', async () => {
    const harness = await registered();
    const pending = harness.send()('sdk', {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    harness.replyLast({ mcp_response: null });

    await expect(pending).resolves.toBeNull();
  });

  it.each([
    ['回包里没有 mcp_response 键', { error: 'boom' }],
    ['回包是空对象', {}],
    ['回包是 null', null],
    ['回包是字符串', 'plain'],
    ['回包是 undefined', undefined],
  ])('非法回包抛与 worker 逐字一致的错误文本：%s', async (_label, payload) => {
    const harness = await registered();
    const pending = harness.send()('sdk', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    harness.replyLast(payload);

    await expect(pending).rejects.toThrow(
      'SDK returned malformed mcp_message response for "sdk": missing mcp_response',
    );
  });
});

describe('registerHostMcpServers: 与 core SDK bridge 的对接', () => {
  it('本模块产出的传输层闭包能撑起真实握手，工具以 mcp__<server>__<tool> 落地', async () => {
    const harness = setup({
      host: sdkHost([mcpTool('echo'), mcpTool('ping')]),
    });
    await harness.run({ mcpServers: ['sdk'] });

    const { tools } = await discover(harness);

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__sdk__echo',
      'mcp__sdk__ping',
    ]);
    const methods = harness.hostCalls.map(
      (call) => call.payload.message['method'],
    );
    expect(methods).toContain('initialize');
    expect(methods).toContain('tools/list');
    expect(
      harness.hostCalls.every((call) => call.payload.serverName === 'sdk'),
    ).toBe(true);
  });

  it('通过校验的覆盖改暴露名与常驻标记，缺 alwaysLoad 的覆盖让该工具从发现集里消失', async () => {
    const harness = setup({
      host: sdkHost([mcpTool('echo'), mcpTool('ping'), mcpTool('drop')]),
    });
    await harness.run({
      mcpServers: ['sdk'],
      mcpToolOverrides: {
        sdk: {
          echo: { exposedName: 'sdk_echo', alwaysLoad: true },
          ping: { exposedName: 'sdk_ping' },
        },
      },
    });

    const { tools, diagnostics } = await discover(harness);

    expect(tools.map((tool) => tool.name)).toEqual([
      'mcp__sdk__echo',
      'mcp__sdk__drop',
    ]);
    const echo = tools[0]!;
    expect(echo.exposedName).toBe('sdk_echo');
    expect(echo.alwaysLoad).toBe(true);
    expect(tools[1]!.exposedName).toBeUndefined();
    expect(diagnostics).toHaveBeenCalled();
  });
});

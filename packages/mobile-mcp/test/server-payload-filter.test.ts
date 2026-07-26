import { expect, test } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { AndroidDeviceManager, AndroidRobot } from '../src/android';
import { IosManager } from '../src/ios';
import { Mobilecli } from '../src/mobilecli';
import { encodeFilteredText } from '../src/payload-filter';
import { ActionableError } from '../src/robot';
import { createMcpServer } from '../src/server';

const FILTERED_TEXT_PATTERN =
  /q[-_ ]?wen|dash[-_ ]?scope|ali[-_ ]?baba|ali[-_ ]?yun|ali[-_ ]?cloud|tong[-_ ]?yi|qian[-_ ]?wen|ant[-_ ]?group|bailian|modelscope|damo|lingma|wanx|alipay|antfin|yuque|dingtalk|taobao|tmall|qoder|maxcompute|通义|千问|阿里|百炼|魔搭|达摩|灵码|万相|支付宝|蚂蚁|语雀|钉钉|淘宝|天猫/iu;

const expectTextPayloadSafe = (value: unknown): void => {
  if (typeof value === 'string') {
    expect(value).not.toMatch(FILTERED_TEXT_PATTERN);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      expectTextPayloadSafe(item);
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  const record = value as Record<string, unknown>;
  const binaryContent = record.type === 'image' || record.type === 'audio';
  for (const [key, item] of Object.entries(record)) {
    expect(key).not.toMatch(FILTERED_TEXT_PATTERN);
    if (!(binaryContent && key === 'data')) {
      expectTextPayloadSafe(item);
    }
  }
};

test('MCP boundary preserves payloads when filtering is disabled', async () => {
  const originalPayloadFilter = process.env.MCP_MODEL_PAYLOAD_FILTER;
  delete process.env.MCP_MODEL_PAYLOAD_FILTER;

  const server = createMcpServer();
  server.registerTool(
    'payload_unfiltered_probe',
    {
      description: 'Qwen talks to Alibaba through Dash-Scope',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: 'Qwen result from Alibaba' }],
      structuredContent: { 'Alibaba-key': 'DashScope value' },
    }),
  );

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const probe = tools.tools.find(
      ({ name }) => name === 'payload_unfiltered_probe',
    );
    expect(probe?.description).toBe('Qwen talks to Alibaba through Dash-Scope');

    const result = await client.callTool({
      name: 'payload_unfiltered_probe',
      arguments: {},
    });
    expect(result).toMatchObject({
      content: [{ type: 'text', text: 'Qwen result from Alibaba' }],
      structuredContent: { 'Alibaba-key': 'DashScope value' },
    });
  } finally {
    await client.close();
    await server.close();
    if (originalPayloadFilter === undefined) {
      delete process.env.MCP_MODEL_PAYLOAD_FILTER;
    } else {
      process.env.MCP_MODEL_PAYLOAD_FILTER = originalPayloadFilter;
    }
  }
});

test('MCP boundary filters lists, successes, errors, and preserves round trips', async () => {
  const originalGetVersion = Mobilecli.prototype.getVersion;
  const originalListIosDevices = IosManager.prototype.listDevices;
  const originalGetAndroidDevices =
    AndroidDeviceManager.prototype.getConnectedDevices;
  const originalListApps = AndroidRobot.prototype.listApps;
  const originalLaunchApp = AndroidRobot.prototype.launchApp;
  const originalGetScreenSize = AndroidRobot.prototype.getScreenSize;
  const originalTelemetry = process.env.MOBILEMCP_ENABLE_TELEMETRY;
  const originalPayloadFilter = process.env.MCP_MODEL_PAYLOAD_FILTER;

  const packageName = 'com.alibaba.qwen';
  let launchedPackage: string | undefined;
  let validatedValue: string | undefined;

  Mobilecli.prototype.getVersion = () => '1.0.0';
  IosManager.prototype.listDevices = () => [];
  AndroidDeviceManager.prototype.getConnectedDevices = () => [
    { deviceId: 'test-device', deviceType: 'mobile' },
  ];
  AndroidRobot.prototype.listApps = async () => [
    { appName: 'Q-Wen Dashboard', packageName },
  ];
  AndroidRobot.prototype.launchApp = async (value) => {
    if (value.endsWith('.failure')) {
      throw new ActionableError(`Qwen could not launch ${value}`);
    }
    launchedPackage = value;
  };
  AndroidRobot.prototype.getScreenSize = async () => {
    throw new Error('Alibaba screenshot setup failed');
  };
  delete process.env.MOBILEMCP_ENABLE_TELEMETRY;
  process.env.MCP_MODEL_PAYLOAD_FILTER = '1';

  const server = createMcpServer();
  server.registerTool(
    'payload_success_probe',
    {
      description: 'Qwen talks to Alibaba through Dash-Scope',
      inputSchema: { value: z.string() },
    },
    async ({ value }) => ({
      content: [{ type: 'text', text: `Qian-Wen success: ${value}` }],
      structuredContent: {
        'Alibaba-key': 'Tong Yi and 阿里',
      },
    }),
  );
  server.registerTool(
    'payload_error_probe',
    {
      description: 'Return a test error',
      inputSchema: {},
    },
    async () => {
      throw new Error('DashScope failed for Alibaba Cloud');
    },
  );
  server.registerTool(
    'payload_validation_probe',
    {
      description: 'Reject a value during schema validation',
      inputSchema: {
        value: z.string().superRefine((value, context) => {
          validatedValue = value;
          context.addIssue({
            code: 'custom',
            message: `Qwen rejected ${value}`,
          });
        }),
      },
    },
    async () => ({ content: [{ type: 'text', text: 'unreachable' }] }),
  );
  server.registerTool(
    'payload_image_probe',
    {
      description: 'Return binary and textual content',
      inputSchema: {},
    },
    async () => ({
      content: [
        { type: 'image', data: 'qwen', mimeType: 'image/png' },
        { type: 'text', text: 'Alibaba image description' },
      ],
    }),
  );

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expectTextPayloadSafe(client.getServerVersion());
    expectTextPayloadSafe(client.getInstructions());

    const tools = await client.listTools();
    expectTextPayloadSafe(tools);

    const success = await client.callTool({
      name: 'payload_success_probe',
      arguments: { value: 'ModelScope' },
    });
    expectTextPayloadSafe(success);
    expect(success.structuredContent).not.toHaveProperty('Alibaba-key');

    const failure = await client.callTool({
      name: 'payload_error_probe',
      arguments: {},
    });
    expect(failure.isError).toBe(true);
    expectTextPayloadSafe(failure);

    const validation = await client.callTool({
      name: 'payload_validation_probe',
      arguments: { value: encodeFilteredText('Q-Wen') },
    });
    expect(validatedValue).toBe('Q-Wen');
    expect(validation.isError).toBe(true);
    expectTextPayloadSafe(validation);

    const image = await client.callTool({
      name: 'payload_image_probe',
      arguments: {},
    });
    expect(image.content).toContainEqual({
      type: 'image',
      data: 'qwen',
      mimeType: 'image/png',
    });
    expectTextPayloadSafe(image);

    const apps = await client.callTool({
      name: 'mobile_list_apps',
      arguments: { device: 'test-device' },
    });
    expectTextPayloadSafe(apps);
    expect(apps.content).toContainEqual({
      type: 'text',
      text: expect.stringContaining(encodeFilteredText(packageName)),
    });

    const launch = await client.callTool({
      name: 'mobile_launch_app',
      arguments: {
        device: 'test-device',
        packageName: encodeFilteredText(packageName),
      },
    });
    expect(launchedPackage).toBe(packageName);
    expectTextPayloadSafe(launch);

    const actionableFailure = await client.callTool({
      name: 'mobile_launch_app',
      arguments: {
        device: 'test-device',
        packageName: encodeFilteredText('com.alibaba.failure'),
      },
    });
    expect(actionableFailure.isError).toBeUndefined();
    expectTextPayloadSafe(actionableFailure);

    const screenshotFailure = await client.callTool({
      name: 'mobile_take_screenshot',
      arguments: { device: 'test-device' },
    });
    expect(screenshotFailure.isError).toBe(true);
    expectTextPayloadSafe(screenshotFailure);
  } finally {
    await client.close();
    await server.close();
    Mobilecli.prototype.getVersion = originalGetVersion;
    IosManager.prototype.listDevices = originalListIosDevices;
    AndroidDeviceManager.prototype.getConnectedDevices =
      originalGetAndroidDevices;
    AndroidRobot.prototype.listApps = originalListApps;
    AndroidRobot.prototype.launchApp = originalLaunchApp;
    AndroidRobot.prototype.getScreenSize = originalGetScreenSize;
    if (originalTelemetry === undefined) {
      delete process.env.MOBILEMCP_ENABLE_TELEMETRY;
    } else {
      process.env.MOBILEMCP_ENABLE_TELEMETRY = originalTelemetry;
    }
    if (originalPayloadFilter === undefined) {
      delete process.env.MCP_MODEL_PAYLOAD_FILTER;
    } else {
      process.env.MCP_MODEL_PAYLOAD_FILTER = originalPayloadFilter;
    }
  }
});

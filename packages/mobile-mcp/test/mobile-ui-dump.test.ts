import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AndroidDeviceManager, AndroidRobot } from '../src/android';
import { createMcpServer } from '../src/server';

test('mobile_ui_dump preserves absolute bounds from UIAutomator', async () => {
  const originalGetConnectedDevices =
    AndroidDeviceManager.prototype.getConnectedDevices;
  const originalDumpUiHierarchy = AndroidRobot.prototype.dumpUiHierarchy;
  const originalCoordinateSpace = process.env.MOBILE_MCP_COORDINATE_SPACE;
  const xml =
    '<hierarchy><node text="OK" bounds="[12,34][1080,2160]"/></hierarchy>';
  const outputDirectory =
    process.platform === 'darwin' ? '/private/tmp' : os.tmpdir();
  const outputPath = path.join(
    outputDirectory,
    `mobile-ui-dump-${crypto.randomUUID()}.xml`,
  );

  AndroidDeviceManager.prototype.getConnectedDevices = () => [
    { deviceId: 'test-device', deviceType: 'mobile' },
  ];
  AndroidRobot.prototype.dumpUiHierarchy = async () => xml;
  delete process.env.MOBILE_MCP_COORDINATE_SPACE;

  const server = createMcpServer();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'mobile_ui_dump',
      arguments: { device: 'test-device' },
    });

    expect(result.content).toContainEqual({ type: 'text', text: xml });

    await client.callTool({
      name: 'mobile_ui_dump',
      arguments: { device: 'test-device', output_path: outputPath },
    });

    expect(fs.readFileSync(outputPath, 'utf-8')).toBe(xml);
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
    await client.close();
    await server.close();
    AndroidDeviceManager.prototype.getConnectedDevices =
      originalGetConnectedDevices;
    AndroidRobot.prototype.dumpUiHierarchy = originalDumpUiHierarchy;
    if (originalCoordinateSpace === undefined) {
      delete process.env.MOBILE_MCP_COORDINATE_SPACE;
    } else {
      process.env.MOBILE_MCP_COORDINATE_SPACE = originalCoordinateSpace;
    }
  }
});

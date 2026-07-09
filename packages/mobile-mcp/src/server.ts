import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ChildProcess } from 'node:child_process';

import { error, trace } from './logger';
import { AndroidRobot, AndroidDeviceManager } from './android';
import { ActionableError, Robot, InstallOptions } from './robot';
import { IosManager, IosRobot } from './ios';
import { PNG } from './png';
import { isScalingAvailable, Image } from './image-utils';
import { Mobilecli } from './mobilecli';
import { MobileDevice } from './mobile-device';
import { validateOutputPath, validateFileExtension } from './utils';
import {
  isNormalized,
  coordinateScale,
  denormalizeArgs,
  normalizeElementResult,
  normalizeScreenSizeResult,
  ingestScreenSizeFromResult,
  getCachedScreenSize,
  cacheScreenSize,
  invalidateScreenSize,
  rewriteDescription,
  coordParamDesc,
} from './coord-norm';

const ALLOWED_SCREENSHOT_EXTENSIONS = ['.png', '.jpg', '.jpeg'];
const ALLOWED_RECORDING_EXTENSIONS = ['.mp4'];

interface MobilecliDevice {
  id: string;
  name: string;
  platform: 'android' | 'ios';
  type: 'real' | 'emulator' | 'simulator';
  version: string;
  state: 'online' | 'offline';
}

interface MobilecliDevicesResponse {
  devices: MobilecliDevice[];
}

interface ActiveRecording {
  process: ChildProcess;
  outputPath: string;
  startedAt: number;
}

export const getAgentVersion = (): string => {
  const json = require('../package.json');
  return json.version;
};

export const createMcpServer = (): McpServer => {
  const server = new McpServer({
    name: 'mobile-mcp',
    version: getAgentVersion(),
  });

  const getClientName = (): string => {
    try {
      const clientInfo = server.server.getClientVersion();
      const clientName = clientInfo?.name || 'unknown';
      return clientName;
    } catch (error: any) {
      return 'unknown';
    }
  };

  type ZodSchemaShape = Record<string, z.ZodType>;

  interface ToolAnnotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  }

  const tool = (
    name: string,
    title: string,
    description: string,
    paramsSchema: ZodSchemaShape,
    annotations: ToolAnnotations,
    cb: (args: any) => Promise<string>,
  ) => {
    const finalDescription = isNormalized()
      ? rewriteDescription(description)
      : description;
    server.registerTool(
      name,
      {
        title,
        description: finalDescription,
        inputSchema: paramsSchema,
        annotations,
      },
      (async (args: any, _extra: any) => {
        try {
          trace(`Invoking ${name} with args: ${JSON.stringify(args)}`);

          // coord shim: denormalize input 0–scale → pixels
          if (isNormalized() && args.device) {
            const size = await ensureScreenSize(args.device);
            if (size) {
              denormalizeArgs(name, args, size.width, size.height);
            }
          }

          const start = +new Date();
          let response = await cb(args);
          const duration = +new Date() - start;

          // coord shim: ingest screen size from get_screen_size before normalizing
          if (name === 'mobile_get_screen_size' && args.device) {
            ingestScreenSizeFromResult(args.device, response);
          }

          // coord shim: normalize output pixels → 0–scale
          if (isNormalized() && args.device) {
            const size = getCachedScreenSize(args.device);
            if (size) {
              response = normalizeElementResult(
                name,
                response,
                size.width,
                size.height,
              );
            }
            response = normalizeScreenSizeResult(name, response);
          }

          trace(`=> ${response}`);
          posthog('tool_invoked', {
            ToolName: name,
            Duration: duration,
          }).then();
          return {
            content: [{ type: 'text', text: response }],
          };
        } catch (error: any) {
          posthog('tool_failed', { ToolName: name }).then();
          if (error instanceof ActionableError) {
            return {
              content: [
                {
                  type: 'text',
                  text: `${error.message}. Please fix the issue and try again.`,
                },
              ],
            };
          } else {
            // a real exception
            trace(
              `Tool '${description}' failed: ${error.message} stack: ${error.stack}`,
            );
            return {
              content: [{ type: 'text', text: `Error: ${error.message}` }],
              isError: true,
            };
          }
        }
      }) as any,
    );
  };

  const posthog = async (
    event: string,
    properties: Record<string, string | number>,
  ) => {
    // Telemetry disabled in @qwen-code/mobile-mcp fork.
    // Set MOBILEMCP_ENABLE_TELEMETRY=1 to re-enable upstream PostHog reporting.
    if (!process.env.MOBILEMCP_ENABLE_TELEMETRY) {
      return;
    }

    try {
      const url = 'https://us.i.posthog.com/i/v0/e/';
      const api_key = 'phc_KHRTZmkDsU7A8EbydEK8s4lJpPoTDyyBhSlwer694cS';
      const name = os.hostname() + process.execPath;
      const distinct_id = crypto
        .createHash('sha256')
        .update(name)
        .digest('hex');
      const systemProps: any = {
        Platform: os.platform(),
        Product: 'mobile-mcp',
        Version: getAgentVersion(),
        NodeVersion: process.version,
        CI: process.env.CI || '0',
      };

      const clientName = getClientName();
      if (clientName !== 'unknown') {
        systemProps.AgentName = clientName;
      }

      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          api_key,
          event,
          properties: {
            ...systemProps,
            ...properties,
          },
          distinct_id,
        }),
      });
    } catch (err: any) {
      // ignore
    }
  };

  const mobilecli = new Mobilecli();
  const activeRecordings = new Map<string, ActiveRecording>();
  const agentVerifiedSimulators = new Set<string>();
  posthog('launch', {}).then();

  const ensureMobilecliAvailable = (): void => {
    try {
      const version = mobilecli.getVersion();
      if (version.startsWith('failed')) {
        throw new Error('mobilecli version check failed');
      }
    } catch (error: any) {
      throw new ActionableError(
        `mobilecli is not available or not working properly. Please review the documentation at https://github.com/mobile-next/mobile-mcp/wiki for installation instructions`,
      );
    }
  };

  const getRobotFromDevice = (deviceId: string): Robot => {
    // from now on, we must have mobilecli working
    ensureMobilecliAvailable();

    // Check if it's an iOS device
    const iosManager = new IosManager();
    const iosDevices = iosManager.listDevices();
    const iosDevice = iosDevices.find((d) => d.deviceId === deviceId);
    if (iosDevice) {
      posthog('get_robot', {
        DevicePlatform: 'ios',
        DeviceType: 'real',
      }).then();
      return new IosRobot(deviceId);
    }

    // Check if it's an Android device
    const androidManager = new AndroidDeviceManager();
    const androidDevices = androidManager.getConnectedDevices();
    const androidDevice = androidDevices.find((d) => d.deviceId === deviceId);
    if (androidDevice) {
      posthog('get_robot', { DevicePlatform: 'android' }).then();
      return new AndroidRobot(deviceId);
    }

    // Check if it's a simulator (will later replace all other device types as well)
    const response = mobilecli.getDevices({
      platform: 'ios',
      type: 'simulator',
      includeOffline: false,
    });

    if (response.status === 'ok' && response.data && response.data.devices) {
      for (const device of response.data.devices) {
        if (device.id === deviceId) {
          if (!agentVerifiedSimulators.has(deviceId)) {
            const agentStatus = mobilecli.agentStatus(deviceId);
            if (agentStatus.status === 'fail') {
              mobilecli.agentInstall(deviceId);
            }

            agentVerifiedSimulators.add(deviceId);
          }

          posthog('get_robot', {
            DevicePlatform: 'ios',
            DeviceType: 'simulator',
          }).then();
          return new MobileDevice(deviceId);
        }
      }
    }

    throw new ActionableError(
      `Device "${deviceId}" not found. Use the mobile_list_available_devices tool to see available devices.`,
    );
  };

  const getAndroidRobotFromDevice = (
    deviceId: string,
    toolName: string,
  ): AndroidRobot => {
    const androidManager = new AndroidDeviceManager();
    const androidDevices = androidManager.getConnectedDevices();
    const androidDevice = androidDevices.find((d) => d.deviceId === deviceId);
    if (!androidDevice) {
      throw new ActionableError(
        `${toolName} is only supported on Android devices.`,
      );
    }
    return new AndroidRobot(deviceId);
  };

  async function ensureScreenSize(
    deviceId: string,
  ): Promise<{ width: number; height: number } | undefined> {
    let size = getCachedScreenSize(deviceId);
    if (size) return size;
    try {
      const robot = getRobotFromDevice(deviceId);
      const screenSize = await robot.getScreenSize();
      cacheScreenSize(deviceId, screenSize.width, screenSize.height);
      return { width: screenSize.width, height: screenSize.height };
    } catch (err: any) {
      trace(
        `[coord-norm] Failed to get screen size for ${deviceId}: ${err.message}. Coordinates will pass through without normalization.`,
      );
      return undefined;
    }
  }

  tool(
    'mobile_list_available_devices',
    'List Devices',
    'List all available devices. This includes both physical mobile devices and mobile simulators and emulators. It returns both Android and iOS devices.',
    {},
    { readOnlyHint: true },
    async ({}) => {
      // from today onward, we must have mobilecli working
      ensureMobilecliAvailable();

      const iosManager = new IosManager();
      const androidManager = new AndroidDeviceManager();
      const devices: MobilecliDevice[] = [];

      // Get Android devices with details
      const androidDevices = androidManager.getConnectedDevicesWithDetails();
      for (const device of androidDevices) {
        devices.push({
          id: device.deviceId,
          name: device.name,
          platform: 'android',
          type: 'emulator',
          version: device.version,
          state: 'online',
        });
      }

      // Get iOS physical devices with details
      try {
        const iosDevices = iosManager.listDevicesWithDetails();
        for (const device of iosDevices) {
          devices.push({
            id: device.deviceId,
            name: device.deviceName,
            platform: 'ios',
            type: 'real',
            version: device.version,
            state: 'online',
          });
        }
      } catch (error: any) {
        // If go-ios is not available, silently skip
      }

      // Get iOS simulators from mobilecli (excluding offline devices)
      const response = mobilecli.getDevices({
        platform: 'ios',
        type: 'simulator',
        includeOffline: false,
      });
      if (response.status === 'ok' && response.data && response.data.devices) {
        for (const device of response.data.devices) {
          devices.push({
            id: device.id,
            name: device.name,
            platform: device.platform,
            type: device.type,
            version: device.version,
            state: 'online',
          });
        }
      }

      const out: MobilecliDevicesResponse = { devices };
      return JSON.stringify(out);
    },
  );

  if (process.env.MOBILEFLEET_ENABLE === '1') {
    tool(
      'mobile_list_remote_devices',
      'List Remote Devices',
      'List devices available in the remote fleet',
      {},
      { readOnlyHint: true },
      async ({}) => {
        ensureMobilecliAvailable();
        const result = mobilecli.remoteListDevices();
        return result;
      },
    );

    tool(
      'mobile_allocate_remote_device',
      'Allocate Remote Device',
      'Reserve a device from the remote fleet',
      {
        platform: z
          .enum(['ios', 'android'])
          .describe('The platform to allocate a device for'),
      },
      { destructiveHint: true },
      async ({ platform }) => {
        ensureMobilecliAvailable();
        const result = mobilecli.remoteAllocate(platform);
        return result;
      },
    );

    tool(
      'mobile_release_remote_device',
      'Release Remote Device',
      'Release a device back to the remote fleet',
      {
        device: z
          .string()
          .describe(
            'The device identifier to release back to the remote fleet',
          ),
      },
      { destructiveHint: true },
      async ({ device }) => {
        ensureMobilecliAvailable();
        const result = mobilecli.remoteRelease(device);
        return result;
      },
    );
  }

  tool(
    'mobile_list_apps',
    'List Apps',
    'List all the installed apps on the device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
    },
    { readOnlyHint: true },
    async ({ device }) => {
      const robot = getRobotFromDevice(device);
      const result = await robot.listApps();
      return `Found these apps on device: ${result.map((app) => `${app.appName} (${app.packageName})`).join(', ')}`;
    },
  );

  tool(
    'mobile_launch_app',
    'Launch App',
    'Launch an app on mobile device. Use this to open a specific app. You can find the package name of the app by calling list_apps_on_device.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      packageName: z.string().describe('The package name of the app to launch'),
      locale: z
        .string()
        .optional()
        .describe(
          'Comma-separated BCP 47 locale tags to launch the app with (e.g., fr-FR,en-GB)',
        ),
    },
    { destructiveHint: true },
    async ({ device, packageName, locale }) => {
      const robot = getRobotFromDevice(device);
      await robot.launchApp(packageName, locale);
      return `Launched app ${packageName}`;
    },
  );

  tool(
    'mobile_terminate_app',
    'Terminate App',
    'Stop and terminate an app on mobile device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      packageName: z
        .string()
        .describe('The package name of the app to terminate'),
    },
    { destructiveHint: true },
    async ({ device, packageName }) => {
      const robot = getRobotFromDevice(device);
      await robot.terminateApp(packageName);
      return `Terminated app ${packageName}`;
    },
  );

  tool(
    'mobile_install_app',
    'Install App',
    'Install an app on mobile device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      path: z
        .string()
        .describe(
          'The path to the app file to install. For iOS simulators, provide a .zip file or a .app directory. For Android provide an .apk file. For iOS real devices provide an .ipa file',
        ),
      grant_permissions: z
        .boolean()
        .optional()
        .describe(
          '(Android only) Grant all runtime permissions on install (-g flag). Defaults to false.',
        ),
      replace: z
        .boolean()
        .optional()
        .describe(
          '(Android only) Replace existing application (-r flag). Defaults to true.',
        ),
      allow_downgrade: z
        .boolean()
        .optional()
        .describe(
          '(Android only) Allow version code downgrade (-d flag). Defaults to false.',
        ),
      allow_test: z
        .boolean()
        .optional()
        .describe(
          '(Android only) Allow test APKs (-t flag). Defaults to false.',
        ),
    },
    { destructiveHint: true },
    async ({
      device,
      path,
      grant_permissions,
      replace,
      allow_downgrade,
      allow_test,
    }) => {
      const robot = getRobotFromDevice(device);
      const options: InstallOptions = {
        grantPermissions: grant_permissions,
        replace: replace,
        allowDowngrade: allow_downgrade,
        allowTest: allow_test,
      };
      await robot.installApp(path, options);
      return `Installed app from ${path}`;
    },
  );

  tool(
    'mobile_uninstall_app',
    'Uninstall App',
    'Uninstall an app from mobile device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      bundle_id: z
        .string()
        .describe(
          'Bundle identifier (iOS) or package name (Android) of the app to be uninstalled',
        ),
    },
    { destructiveHint: true },
    async ({ device, bundle_id }) => {
      const robot = getRobotFromDevice(device);
      await robot.uninstallApp(bundle_id);
      return `Uninstalled app ${bundle_id}`;
    },
  );

  tool(
    'mobile_get_screen_size',
    'Get Screen Size',
    'Get the screen size of the mobile device in pixels',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
    },
    { readOnlyHint: true },
    async ({ device }) => {
      const robot = getRobotFromDevice(device);
      const screenSize = await robot.getScreenSize();
      return `Screen size is ${screenSize.width}x${screenSize.height} pixels`;
    },
  );

  tool(
    'mobile_click_on_screen_at_coordinates',
    'Click Screen',
    'Click on the screen at given x,y coordinates. If clicking on an element, use the list_elements_on_screen tool to find the coordinates.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      x: z.coerce
        .number()
        .describe(
          coordParamDesc('The x coordinate to click on the screen, in pixels'),
        ),
      y: z.coerce
        .number()
        .describe(
          coordParamDesc('The y coordinate to click on the screen, in pixels'),
        ),
    },
    { destructiveHint: true },
    async ({ device, x, y }) => {
      const robot = getRobotFromDevice(device);
      await robot.tap(x, y);
      return `Clicked on screen at coordinates: ${x}, ${y}`;
    },
  );

  tool(
    'mobile_double_tap_on_screen',
    'Double Tap Screen',
    'Double-tap on the screen at given x,y coordinates.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      x: z.coerce
        .number()
        .describe(coordParamDesc('The x coordinate to double-tap, in pixels')),
      y: z.coerce
        .number()
        .describe(coordParamDesc('The y coordinate to double-tap, in pixels')),
    },
    { destructiveHint: true },
    async ({ device, x, y }) => {
      const robot = getRobotFromDevice(device);
      await robot!.doubleTap(x, y);
      return `Double-tapped on screen at coordinates: ${x}, ${y}`;
    },
  );

  tool(
    'mobile_long_press_on_screen_at_coordinates',
    'Long Press Screen',
    'Long press on the screen at given x,y coordinates. If long pressing on an element, use the list_elements_on_screen tool to find the coordinates.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      x: z.coerce
        .number()
        .describe(
          coordParamDesc(
            'The x coordinate to long press on the screen, in pixels',
          ),
        ),
      y: z.coerce
        .number()
        .describe(
          coordParamDesc(
            'The y coordinate to long press on the screen, in pixels',
          ),
        ),
      duration: z.coerce
        .number()
        .min(1)
        .max(10000)
        .optional()
        .describe(
          'Duration of the long press in milliseconds. Defaults to 500ms.',
        ),
    },
    { destructiveHint: true },
    async ({ device, x, y, duration }) => {
      const robot = getRobotFromDevice(device);
      const pressDuration = duration ?? 500;
      await robot.longPress(x, y, pressDuration);
      return `Long pressed on screen at coordinates: ${x}, ${y} for ${pressDuration}ms`;
    },
  );

  tool(
    'mobile_list_elements_on_screen',
    'List Screen Elements',
    'List elements on screen and their coordinates, with display text or accessibility label. Do not cache this result.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
    },
    { readOnlyHint: true },
    async ({ device }) => {
      const robot = getRobotFromDevice(device);
      const elements = await robot.getElementsOnScreen();

      const result = elements.map((element) => {
        const out: any = {
          type: element.type,
          text: element.text,
          label: element.label,
          name: element.name,
          value: element.value,
          identifier: element.identifier,
          coordinates: {
            x: element.rect.x,
            y: element.rect.y,
            width: element.rect.width,
            height: element.rect.height,
          },
        };

        if (element.focused) {
          out.focused = true;
        }

        return out;
      });

      return `Found these elements on screen: ${JSON.stringify(result)}`;
    },
  );

  tool(
    'mobile_press_button',
    'Press Button',
    'Press a button on device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      button: z
        .string()
        .describe(
          'The button to press. Supported buttons: BACK (android only), HOME, VOLUME_UP, VOLUME_DOWN, ENTER, DPAD_CENTER (android tv only), DPAD_UP (android tv only), DPAD_DOWN (android tv only), DPAD_LEFT (android tv only), DPAD_RIGHT (android tv only)',
        ),
    },
    { destructiveHint: true },
    async ({ device, button }) => {
      const robot = getRobotFromDevice(device);
      await robot.pressButton(button);
      return `Pressed the button: ${button}`;
    },
  );

  tool(
    'mobile_open_url',
    'Open URL',
    'Open a URL in browser on device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      url: z.string().describe('The URL to open'),
    },
    { destructiveHint: true },
    async ({ device, url }) => {
      const allowUnsafeUrls = process.env.MOBILEMCP_ALLOW_UNSAFE_URLS === '1';
      if (
        !allowUnsafeUrls &&
        !url.startsWith('http://') &&
        !url.startsWith('https://')
      ) {
        throw new ActionableError(
          'Only http:// and https:// URLs are allowed. Set MOBILEMCP_ALLOW_UNSAFE_URLS=1 to allow other URL schemes.',
        );
      }

      const robot = getRobotFromDevice(device);
      await robot.openUrl(url);
      return `Opened URL: ${url}`;
    },
  );

  tool(
    'mobile_swipe_on_screen',
    'Swipe Screen',
    'Swipe on the screen',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .describe('The direction to swipe'),
      x: z.coerce
        .number()
        .optional()
        .describe(
          coordParamDesc(
            'The x coordinate to start the swipe from, in pixels. If not provided, uses center of screen',
          ),
        ),
      y: z.coerce
        .number()
        .optional()
        .describe(
          coordParamDesc(
            'The y coordinate to start the swipe from, in pixels. If not provided, uses center of screen',
          ),
        ),
      distance: z.coerce
        .number()
        .optional()
        .describe(
          coordParamDesc(
            'The distance to swipe in pixels. Defaults to 400 pixels for iOS or 30% of screen dimension for Android',
          ),
        ),
    },
    { destructiveHint: true },
    async ({ device, direction, x, y, distance }) => {
      const robot = getRobotFromDevice(device);

      if (x !== undefined && y !== undefined) {
        // Use coordinate-based swipe
        await robot.swipeFromCoordinate(x, y, direction, distance);
        const distanceText = distance ? ` ${distance} pixels` : '';
        return `Swiped ${direction}${distanceText} from coordinates: ${x}, ${y}`;
      } else {
        // Use center-based swipe
        await robot.swipe(direction);
        return `Swiped ${direction} on screen`;
      }
    },
  );

  tool(
    'mobile_type_keys',
    'Type Text',
    'Type text into the focused element',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      text: z.string().describe('The text to type'),
      submit: z
        .boolean()
        .describe(
          'Whether to submit the text. If true, the text will be submitted as if the user pressed the enter key.',
        ),
    },
    { destructiveHint: true },
    async ({ device, text, submit }) => {
      const robot = getRobotFromDevice(device);
      await robot.sendKeys(text);

      if (submit) {
        await robot.pressButton('ENTER');
      }

      return `Typed text: ${text}`;
    },
  );

  tool(
    'mobile_save_screenshot',
    'Save Screenshot',
    'Save a screenshot of the mobile device to a file',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      saveTo: z
        .string()
        .describe(
          'The path to save the screenshot to. Filename must end with .png, .jpg, or .jpeg',
        ),
    },
    { destructiveHint: true },
    async ({ device, saveTo }) => {
      validateFileExtension(
        saveTo,
        ALLOWED_SCREENSHOT_EXTENSIONS,
        'save_screenshot',
      );
      validateOutputPath(saveTo);

      const robot = getRobotFromDevice(device);

      const screenshot = await robot.getScreenshot();
      fs.writeFileSync(saveTo, screenshot);
      return `Screenshot saved to: ${saveTo}`;
    },
  );

  server.registerTool(
    'mobile_take_screenshot',
    {
      title: 'Take Screenshot',
      description:
        "Take a screenshot of the mobile device. Use this to understand what's on screen, if you need to press an element that is available through view hierarchy then you must list elements on screen instead. Do not cache this result.",
      inputSchema: {
        device: z
          .string()
          .describe(
            'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
          ),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ device }) => {
      try {
        const robot = getRobotFromDevice(device);
        const screenSize = await robot.getScreenSize();

        let screenshot = await robot.getScreenshot();
        let mimeType = 'image/png';

        // validate we received a png, will throw exception otherwise
        const image = new PNG(screenshot);
        const pngSize = image.getDimensions();
        if (pngSize.width <= 0 || pngSize.height <= 0) {
          throw new ActionableError('Screenshot is invalid. Please try again.');
        }

        if (isScalingAvailable()) {
          trace('Image scaling is available, resizing screenshot');
          const image = Image.fromBuffer(screenshot);
          const beforeSize = screenshot.length;
          screenshot = image
            .resize(Math.floor(pngSize.width / screenSize.scale))
            .jpeg({ quality: 75 })
            .toBuffer();

          const afterSize = screenshot.length;
          trace(
            `Screenshot resized from ${beforeSize} bytes to ${afterSize} bytes`,
          );

          mimeType = 'image/jpeg';
        }

        const screenshot64 = screenshot.toString('base64');
        trace(`Screenshot taken: ${screenshot.length} bytes`);
        posthog('tool_invoked', {
          ToolName: 'mobile_take_screenshot',
          ScreenshotFilesize: screenshot64.length,
          ScreenshotMimeType: mimeType,
          ScreenshotWidth: pngSize.width,
          ScreenshotHeight: pngSize.height,
        }).then();

        const content: any[] = [
          { type: 'image', data: screenshot64, mimeType },
        ];
        if (isNormalized()) {
          const scale = coordinateScale();
          content.push({
            type: 'text',
            text: `Screenshot dimensions: ${scale}x${scale} (normalized coordinate space)`,
          });
        }
        return { content };
      } catch (err: any) {
        error(`Error taking screenshot: ${err.message} ${err.stack}`);
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    },
  );

  tool(
    'mobile_set_orientation',
    'Set Orientation',
    'Change the screen orientation of the device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      orientation: z
        .enum(['portrait', 'landscape'])
        .describe('The desired orientation'),
    },
    { destructiveHint: true },
    async ({ device, orientation }) => {
      const robot = getRobotFromDevice(device);
      await robot.setOrientation(orientation);
      invalidateScreenSize(device);
      return `Changed device orientation to ${orientation}`;
    },
  );

  tool(
    'mobile_get_orientation',
    'Get Orientation',
    'Get the current screen orientation of the device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
    },
    { readOnlyHint: true },
    async ({ device }) => {
      const robot = getRobotFromDevice(device);
      const orientation = await robot.getOrientation();
      return `Current device orientation is ${orientation}`;
    },
  );

  tool(
    'mobile_start_screen_recording',
    'Start Screen Recording',
    'Start recording the screen of a mobile device. The recording runs in the background until stopped with mobile_stop_screen_recording. Returns the path where the recording will be saved.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      output: z
        .string()
        .optional()
        .describe(
          'The file path to save the recording to. Filename must end with .mp4. If not provided, a temporary path will be used.',
        ),
      timeLimit: z.coerce
        .number()
        .optional()
        .describe(
          'Maximum recording duration in seconds. The recording will stop automatically after this time.',
        ),
    },
    { destructiveHint: true },
    async ({ device, output, timeLimit }) => {
      if (output) {
        validateFileExtension(
          output,
          ALLOWED_RECORDING_EXTENSIONS,
          'start_screen_recording',
        );
        validateOutputPath(output);
      }

      getRobotFromDevice(device);

      if (activeRecordings.has(device)) {
        throw new ActionableError(
          `Device "${device}" is already being recorded. Stop the current recording first with mobile_stop_screen_recording.`,
        );
      }

      const outputPath =
        output || path.join(os.tmpdir(), `screen-recording-${Date.now()}.mp4`);

      const args = [
        'screenrecord',
        '--device',
        device,
        '--output',
        outputPath,
        '--silent',
      ];
      if (timeLimit !== undefined) {
        args.push('--time-limit', String(timeLimit));
      }

      const child = mobilecli.spawnCommand(args);

      const cleanup = () => {
        activeRecordings.delete(device);
      };

      child.on('error', cleanup);
      child.on('exit', cleanup);

      activeRecordings.set(device, {
        process: child,
        outputPath,
        startedAt: Date.now(),
      });

      return `Screen recording started. Output will be saved to: ${outputPath}`;
    },
  );

  tool(
    'mobile_stop_screen_recording',
    'Stop Screen Recording',
    'Stop an active screen recording on a mobile device. Returns the file path, size, and approximate duration of the recording.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
    },
    { destructiveHint: true },
    async ({ device }) => {
      const recording = activeRecordings.get(device);
      if (!recording) {
        throw new ActionableError(
          `No active recording found for device "${device}". Start a recording first with mobile_start_screen_recording.`,
        );
      }

      const { process: child, outputPath, startedAt } = recording;
      activeRecordings.delete(device);

      child.kill('SIGINT');

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(
          () => {
            child.kill('SIGKILL');
            resolve();
          },
          5 * 60 * 1000,
        );

        child.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      const durationSeconds = Math.round((Date.now() - startedAt) / 1000);

      if (!fs.existsSync(outputPath)) {
        return `Recording stopped after ~${durationSeconds}s but the output file was not found at: ${outputPath}`;
      }

      const stats = fs.statSync(outputPath);
      const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);

      return `Recording stopped. File: ${outputPath} (${fileSizeMB} MB, ~${durationSeconds}s)`;
    },
  );

  tool(
    'mobile_list_crashes',
    'List Crash Reports',
    'List crash reports available on the device',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
    },
    { readOnlyHint: true },
    async ({ device }) => {
      ensureMobilecliAvailable();
      const response = mobilecli.crashesList(device);
      return JSON.stringify(response.data);
    },
  );

  tool(
    'mobile_get_crash',
    'Get Crash Report',
    'Get the full content of a crash report by its ID. Use mobile_list_crashes to find available crash IDs.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      id: z.string().describe('The crash report ID to retrieve'),
    },
    { readOnlyHint: true },
    async ({ device, id }) => {
      ensureMobilecliAvailable();
      const response = mobilecli.crashesGet(device, id);
      return response.data.content;
    },
  );

  // --- Android-specific ADB tools ---

  tool(
    'mobile_ui_dump',
    'UI Hierarchy Dump',
    '(Android only) Dump the full UI hierarchy as raw XML using uiautomator. Unlike mobile_list_elements_on_screen which returns a filtered flat list of interactive elements as JSON, this returns the complete unfiltered XML tree preserving parent-child hierarchy and all node attributes (class, resource-id, bounds, clickable, scrollable, enabled, etc.). Use when you need the full view tree for debugging, or when mobile_list_elements_on_screen misses an element you can see on screen. Supports --compressed to reduce output size.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      compressed: z
        .boolean()
        .optional()
        .describe(
          'Whether to use --compressed flag to reduce XML output size. Defaults to false.',
        ),
      output_path: z
        .string()
        .optional()
        .describe(
          'If provided, save the XML to this local file path instead of returning it in the response.',
        ),
    },
    { readOnlyHint: true },
    async ({ device, compressed, output_path }) => {
      const robot = getAndroidRobotFromDevice(device, 'mobile_ui_dump');
      let xml = await robot.dumpUiHierarchy(compressed ?? false);
      xml = xml.replace(/ bounds="\[[0-9,]+\]\[[0-9,]+\]"/g, '');
      if (output_path) {
        validateOutputPath(output_path);
        fs.writeFileSync(output_path, xml, 'utf-8');
        return `UI hierarchy XML saved to: ${output_path}`;
      }
      return xml;
    },
  );

  tool(
    'mobile_adb_pull',
    'ADB Pull File',
    '(Android only) Pull (download) a file from the Android device to the local filesystem.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      remote_path: z
        .string()
        .describe('The file path on the Android device to pull from'),
      local_path: z
        .string()
        .describe('The local file path to save the pulled file to.'),
    },
    { destructiveHint: true },
    async ({ device, remote_path, local_path }) => {
      const robot = getAndroidRobotFromDevice(device, 'mobile_adb_pull');
      validateOutputPath(local_path);
      robot.pullFile(remote_path, local_path);
      return `Successfully pulled ${remote_path} to ${local_path}`;
    },
  );

  tool(
    'mobile_adb_push',
    'ADB Push File',
    '(Android only) Push (upload) a file from local filesystem to the Android device. By default only allows pushing to /sdcard/. Set force=true to push to other paths.',
    {
      device: z
        .string()
        .describe(
          'The device identifier to use. Use mobile_list_available_devices to find which devices are available to you.',
        ),
      local_path: z
        .string()
        .describe('The local file path to push to the device'),
      remote_path: z
        .string()
        .describe('The target file path on the Android device'),
      force: z
        .boolean()
        .optional()
        .describe(
          'Set to true to allow pushing to paths outside /sdcard/. Defaults to false.',
        ),
    },
    { destructiveHint: true },
    async ({ device, local_path, remote_path, force }) => {
      const robot = getAndroidRobotFromDevice(device, 'mobile_adb_push');
      if (!force) {
        const resolved = path.posix.resolve('/', remote_path);
        if (!resolved.startsWith('/sdcard/')) {
          throw new ActionableError(
            `Push target path must resolve under /sdcard/ for safety. Got: "${remote_path}" (resolved: "${resolved}"). Set force=true to override.`,
          );
        }
      }
      if (!fs.existsSync(local_path)) {
        throw new ActionableError(`Local file not found: "${local_path}"`);
      }
      robot.pushFile(local_path, remote_path);
      return `Successfully pushed ${local_path} to ${remote_path}`;
    },
  );

  return server;
};

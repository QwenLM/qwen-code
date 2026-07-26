import { test, expect } from '@playwright/test';

import { PNG } from '../src/png';
import { AndroidRobot, AndroidDeviceManager } from '../src/android';

const manager = new AndroidDeviceManager();
const devices = manager.getConnectedDevices();
const hasOneAndroidDevice = devices.length === 1;

test.describe('android', () => {
  const android = new AndroidRobot(devices?.[0]?.deviceId || '');

  test('should be able to get the screen size', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');
    const screenSize = await android.getScreenSize();
    expect(screenSize.width).toBeGreaterThan(1024);
    expect(screenSize.height).toBeGreaterThan(1024);
    expect(screenSize.scale).toBe(1);
    expect(
      Object.keys(screenSize).length,
      'screenSize should have exactly 3 properties',
    ).toBe(3);
  });

  test('should be able to take screenshot', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');

    const screenSize = await android.getScreenSize();
    const screenshot = await android.getScreenshot();
    expect(screenshot.length).toBeGreaterThan(64 * 1024);

    // must be a valid png image that matches the screen size
    const image = new PNG(screenshot);
    const pngSize = image.getDimensions();
    expect(pngSize.width).toBe(screenSize.width);
    expect(pngSize.height).toBe(screenSize.height);
  });

  test('should be able to list apps', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');
    const apps = await android.listApps();
    const packages = apps.map((app) => app.packageName);
    expect(packages).toContain('com.android.settings');
  });

  test('should be able to open a url', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');
    await android.adb('shell', 'input', 'keyevent', 'HOME');
    await android.openUrl('https://www.example.com');
  });

  test('should be able to list elements on screen', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');
    await android.terminateApp('com.android.chrome');
    await android.adb('shell', 'input', 'keyevent', 'HOME');
    await android.openUrl('https://www.example.com');
    const elements = await android.getElementsOnScreen();

    // make sure title (TextView) is present
    const foundTitle = elements.find(
      (element) =>
        element.type === 'android.widget.TextView' &&
        element.text?.startsWith(
          'This domain is for use in illustrative examples in documents',
        ),
    );
    expect(foundTitle, 'Title element not found').toBeTruthy();

    // make sure navbar (EditText) is present
    const foundNavbar = elements.find(
      (element) =>
        element.type === 'android.widget.EditText' &&
        element.label === 'Search or type URL' &&
        element.text === 'example.com',
    );
    expect(foundNavbar, 'Navbar element not found').toBeTruthy();

    // this is an icon, but has accessibility label
    const foundSecureIcon = elements.find(
      (element) =>
        element.type === 'android.widget.ImageButton' &&
        element.text === '' &&
        element.label === 'New tab',
    );
    expect(foundSecureIcon, 'New tab icon not found').toBeTruthy();
  });

  test('should be able to send keys and tap', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');
    await android.terminateApp('com.google.android.deskclock');
    await android.adb('shell', 'pm', 'clear', 'com.google.android.deskclock');
    await android.launchApp('com.google.android.deskclock');

    // We probably start at Clock tab
    await new Promise((resolve) => setTimeout(resolve, 3000));
    let elements = await android.getElementsOnScreen();
    const timerElement = elements.find(
      (e) => e.label === 'Timer' && e.type === 'android.widget.FrameLayout',
    );
    expect(timerElement).toBeDefined();
    await android.tap(timerElement.rect.x, timerElement.rect.y);

    // now we're in Timer tab
    await new Promise((resolve) => setTimeout(resolve, 3000));
    elements = await android.getElementsOnScreen();
    const currentTime = elements.find((e) => e.text === '00h 00m 00s');
    expect(currentTime, 'Expected time to be 00h 00m 00s').toBeDefined();
    await android.sendKeys('123456');

    // now the title has changed with new timer
    await new Promise((resolve) => setTimeout(resolve, 3000));
    elements = await android.getElementsOnScreen();
    const newTime = elements.find((e) => e.text === '12h 34m 56s');
    expect(newTime, 'Expected time to be 12h 34m 56s').toBeDefined();

    await android.terminateApp('com.google.android.deskclock');
  });

  test('should be able to launch and terminate an app', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');

    // kill if running
    await android.terminateApp('com.android.chrome');

    await android.launchApp('com.android.chrome');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const processes = await android.listRunningProcesses();
    expect(processes).toContain('com.android.chrome');

    await android.terminateApp('com.android.chrome');
    const processes2 = await android.listRunningProcesses();
    expect(processes2).not.toContain('com.android.chrome');
  });

  test('should handle orientation changes', async () => {
    test.skip(!hasOneAndroidDevice, 'requires exactly one android device');

    // assume we start in portrait
    const originalOrientation = await android.getOrientation();
    expect(originalOrientation).toBe('portrait');
    const screenSize1 = await android.getScreenSize();

    // set to landscape
    await android.setOrientation('landscape');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const orientation = await android.getOrientation();
    expect(orientation).toBe('landscape');
    const screenSize2 = await android.getScreenSize();

    // set to portrait
    await android.setOrientation('portrait');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const orientation2 = await android.getOrientation();
    expect(orientation2).toBe('portrait');

    // screen size should not have changed
    expect(screenSize1).toEqual(screenSize2);
  });
});

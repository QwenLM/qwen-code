import { test, expect } from "@playwright/test";

import { IosManager, IosRobot } from "../src/ios";
import { PNG } from "../src/png";

test.describe("ios", () => {

	let robot: IosRobot;
	let hasOneDevice = false;

	test.beforeAll(async () => {
		const manager = new IosManager();
		const devices = await manager.listDevices();
		hasOneDevice = devices.length === 1;
		robot = new IosRobot(devices?.[0]?.deviceId || "");
	});

	test("should be able to get screenshot", async () => {
		test.skip(!hasOneDevice, "requires exactly one ios device");
		const screenshot = await robot.getScreenshot();
		// an black screenshot (screen is off) still consumes over 30KB
		expect(screenshot.length).toBeGreaterThan(128 * 1024);

		// must be a valid png image that matches the screen size
		const image = new PNG(screenshot);
		const pngSize = image.getDimensions();
		const screenSize = await robot.getScreenSize();

		// wda returns screen size as points, round up
		expect(Math.ceil(pngSize.width / screenSize.scale)).toBe(screenSize.width);
		expect(Math.ceil(pngSize.height / screenSize.scale)).toBe(screenSize.height);
	});
});

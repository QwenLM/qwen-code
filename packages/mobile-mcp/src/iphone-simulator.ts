import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, extname } from "node:path";

import { trace } from "./logger";
import { WebDriverAgent } from "./webdriver-agent";
import { ActionableError, Button, InstalledApp, Robot, ScreenElement, ScreenSize, SwipeDirection, Orientation } from "./robot";
import { validatePackageName, validateLocale } from "./utils";

export interface Simulator {
	name: string;
	uuid: string;
	state: string;
}

interface AppInfo {
	ApplicationType: string;
	Bundle: string;
	CFBundleDisplayName: string;
	CFBundleExecutable: string;
	CFBundleIdentifier: string;
	CFBundleName: string;
	CFBundleVersion: string;
	DataContainer: string;
	Path: string;
}

const TIMEOUT = 30000;
const WDA_PORT = 8100;
const MAX_BUFFER_SIZE = 1024 * 1024 * 8;

export class Simctl implements Robot {

	constructor(private readonly simulatorUuid: string) {}

	private async isWdaInstalled(): Promise<boolean> {
		const apps = await this.listApps();
		return apps.map(app => app.packageName).includes("com.facebook.WebDriverAgentRunner.xctrunner");
	}

	private async startWda(): Promise<void> {
		if (!(await this.isWdaInstalled())) {
			// wda is not even installed, won't attempt to start it
			return;
		}

		trace("Starting WebDriverAgent");
		const webdriverPackageName = "com.facebook.WebDriverAgentRunner.xctrunner";
		this.simctl("launch", this.simulatorUuid, webdriverPackageName);

		// now we wait for wda to have a successful status
		const wda = new WebDriverAgent("localhost", WDA_PORT);

		// wait up to 10 seconds for wda to start
		const timeout = +new Date() + 10 * 1000;
		while (+new Date() < timeout) {
			// cross fingers and see if wda is already running
			if (await wda.isRunning()) {
				trace("WebDriverAgent is now running");
				return;
			}

			// wait 100ms before trying again
			await new Promise(resolve => setTimeout(resolve, 100));
		}

		trace("Could not start WebDriverAgent in time, giving up");
	}

	private async wda(): Promise<WebDriverAgent> {
		const wda = new WebDriverAgent("localhost", WDA_PORT);

		if (!(await wda.isRunning())) {
			await this.startWda();
			if (!(await wda.isRunning())) {
				throw new ActionableError("WebDriverAgent is not running on simulator, please see https://github.com/mobile-next/mobile-mcp/wiki/");
			}

			// was successfully started
		}

		return wda;
	}

	private simctl(...args: string[]): Buffer {
		return execFileSync("xcrun", ["simctl", ...args], {
			timeout: TIMEOUT,
			maxBuffer: MAX_BUFFER_SIZE,
		});
	}

	public async getScreenshot(): Promise<Buffer> {
		const wda = await this.wda();
		return await wda.getScreenshot();
		// alternative: return this.simctl("io", this.simulatorUuid, "screenshot", "-");
	}

	public async openUrl(url: string) {
		const wda = await this.wda();
		await wda.openUrl(url);
		// alternative: this.simctl("openurl", this.simulatorUuid, url);
	}

	public async launchApp(packageName: string, locale?: string) {
		validatePackageName(packageName);
		const args = ["launch", this.simulatorUuid, packageName];
		if (locale) {
			validateLocale(locale);
			const locales = locale.split(",").map(l => l.trim());
			args.push("-AppleLanguages", `(${locales.join(", ")})`);
			args.push("-AppleLocale", locales[0]);
		}

		this.simctl(...args);
	}

	public async terminateApp(packageName: string) {
		validatePackageName(packageName);
		this.simctl("terminate", this.simulatorUuid, packageName);
	}

	private findAppBundle(dir: string): string | null {
		const entries = readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.endsWith(".app")) {
				return join(dir, entry.name);
			}
		}

		return null;
	}

	private validateZipPaths(zipPath: string): void {
		const output = execFileSync("/usr/bin/zipinfo", ["-1", zipPath], {
			timeout: TIMEOUT,
			maxBuffer: MAX_BUFFER_SIZE,
		}).toString();

		const invalidPath = output
			.split("\n")
			.map(s => s.trim())
			.filter(s => s)
			.find(s => s.startsWith("/") || s.includes(".."));

		if (invalidPath) {
			throw new ActionableError(`Security violation: File path '${invalidPath}' contains invalid characters`);
		}
	}

	public async installApp(path: string): Promise<void> {
		let tempDir: string | null = null;
		let installPath = path;

		try {
			// zip files need to be extracted prior to installation
			if (extname(path).toLowerCase() === ".zip") {
				trace(`Detected .zip file, validating contents`);

				// before extracting, let's make sure there's no zip-slip bombs here
				this.validateZipPaths(path);

				tempDir = mkdtempSync(join(tmpdir(), "ios-app-"));

				try {
					execFileSync("unzip", ["-q", path, "-d", tempDir], {
						timeout: TIMEOUT,
					});
				} catch (error: any) {
					throw new ActionableError(`Failed to unzip file: ${error.message}`);
				}

				const appBundle = this.findAppBundle(tempDir);
				if (!appBundle) {
					throw new ActionableError("No .app bundle found in the .zip file, please visit wiki at https://github.com/mobile-next/mobile-mcp/wiki for assistance.");
				}

				installPath = appBundle;
				trace(`Found .app bundle at: ${basename(appBundle)}`);
			}

			// continue with installation
			this.simctl("install", this.simulatorUuid, installPath);

		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);

		} finally {
			// Clean up temporary directory if it was created
			if (tempDir) {
				try {
					trace(`Cleaning up temporary directory`);
					rmSync(tempDir, { recursive: true, force: true });
				} catch (cleanupError) {
					trace(`Warning: Failed to cleanup temporary directory: ${cleanupError}`);
				}
			}
		}
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		try {
			this.simctl("uninstall", this.simulatorUuid, bundleId);
		} catch (error: any) {
			const stdout = error.stdout ? error.stdout.toString() : "";
			const stderr = error.stderr ? error.stderr.toString() : "";
			const output = (stdout + stderr).trim();
			throw new ActionableError(output || error.message);
		}
	}

	public async listApps(): Promise<InstalledApp[]> {
		const text = this.simctl("listapps", this.simulatorUuid).toString();
		const result = execFileSync("plutil", ["-convert", "json", "-o", "-", "-r", "-"], {
			input: text,
		});

		const output = JSON.parse(result.toString()) as Record<string, AppInfo>;
		return Object.values(output).map(app => ({
			packageName: app.CFBundleIdentifier,
			appName: app.CFBundleDisplayName,
		}));
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const wda = await this.wda();
		return wda.getScreenSize();
	}

	public async sendKeys(keys: string) {
		const wda = await this.wda();
		return wda.sendKeys(keys);
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const wda = await this.wda();
		return wda.swipe(direction);
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const wda = await this.wda();
		return wda.swipeFromCoordinate(x, y, direction, distance);
	}

	public async tap(x: number, y: number) {
		const wda = await this.wda();
		return wda.tap(x, y);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		const wda = await this.wda();
		await wda.doubleTap(x, y);
	}

	public async longPress(x: number, y: number, duration: number) {
		const wda = await this.wda();
		return wda.longPress(x, y, duration);
	}

	public async pressButton(button: Button) {
		const wda = await this.wda();
		return wda.pressButton(button);
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const wda = await this.wda();
		return wda.getElementsOnScreen();
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		const wda = await this.wda();
		return wda.setOrientation(orientation);
	}

	public async getOrientation(): Promise<Orientation> {
		const wda = await this.wda();
		return wda.getOrientation();
	}
}

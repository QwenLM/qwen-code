import { Mobilecli } from "./mobilecli";
import { Button, InstalledApp, Orientation, Robot, ScreenElement, ScreenSize, SwipeDirection } from "./robot";

interface InstalledAppsResponse {
	status: "ok",
	data: Array<{
		packageName: string;
		appName?: string; // ios
		version?: string; // ios
	}>;
}

interface DeviceInfoResponse {
	status: "ok",
	data: {
		device: {
			id: string;
			name: string;
			platform: string;
			type: string;
			version: string;
			state: string;
			screenSize?: {
				width: number;
				height: number;
				scale: number;
			};
		};
	};
}

interface UIElementResponse {
	type: string;
	label?: string;
	text?: string;
	name?: string;
	value?: string;
	identifier?: string;
	rect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
	focused?: boolean;
}

interface DumpUIResponse {
	status: "ok",
	data: {
		elements: UIElementResponse[];
	};
}

interface OrientationResponse {
	status: "ok",
	data: {
		orientation: Orientation;
	};
}

export class MobileDevice implements Robot {

	private mobilecli: Mobilecli;

	public constructor(private deviceId: string) {
		this.mobilecli = new Mobilecli();
	}

	private runCommand(args: string[]): string {
		const fullArgs = [...args, "--device", this.deviceId];
		return this.mobilecli.executeCommand(fullArgs);
	}

	public async getScreenSize(): Promise<ScreenSize> {
		const response = JSON.parse(this.runCommand(["device", "info"])) as DeviceInfoResponse;
		if (response.data.device.screenSize) {
			return response.data.device.screenSize;
		}
		return { width: 0, height: 0, scale: 1.0 };
	}

	public async swipe(direction: SwipeDirection): Promise<void> {
		const screenSize = await this.getScreenSize();
		const centerX = Math.floor(screenSize.width / 2);
		const centerY = Math.floor(screenSize.height / 2);
		const distance = 400; // Default distance in pixels

		let startX = centerX;
		let startY = centerY;
		let endX = centerX;
		let endY = centerY;

		switch (direction) {
			case "up":
				startY = centerY + distance / 2;
				endY = centerY - distance / 2;
				break;
			case "down":
				startY = centerY - distance / 2;
				endY = centerY + distance / 2;
				break;
			case "left":
				startX = centerX + distance / 2;
				endX = centerX - distance / 2;
				break;
			case "right":
				startX = centerX - distance / 2;
				endX = centerX + distance / 2;
				break;
		}

		this.runCommand(["io", "swipe", `${startX},${startY},${endX},${endY}`]);
	}

	public async swipeFromCoordinate(x: number, y: number, direction: SwipeDirection, distance?: number): Promise<void> {
		const swipeDistance = distance || 400;
		let endX = x;
		let endY = y;

		switch (direction) {
			case "up":
				endY = y - swipeDistance;
				break;
			case "down":
				endY = y + swipeDistance;
				break;
			case "left":
				endX = x - swipeDistance;
				break;
			case "right":
				endX = x + swipeDistance;
				break;
		}

		this.runCommand(["io", "swipe", `${x},${y},${endX},${endY}`]);
	}

	public async getScreenshot(): Promise<Buffer> {
		const fullArgs = ["screenshot", "--device", this.deviceId, "--format", "png", "--output", "-"];
		return this.mobilecli.executeCommandBuffer(fullArgs);
	}

	public async listApps(): Promise<InstalledApp[]> {
		const response = JSON.parse(this.runCommand(["apps", "list"])) as InstalledAppsResponse;
		return response.data.map(app => ({
			appName: app.appName || app.packageName,
			packageName: app.packageName,
		})) as InstalledApp[];
	}

	public async launchApp(packageName: string, locale?: string): Promise<void> {
		const args = ["apps", "launch", packageName];
		if (locale) {
			args.push("--locale", locale);
		}

		this.runCommand(args);
	}

	public async terminateApp(packageName: string): Promise<void> {
		this.runCommand(["apps", "terminate", packageName]);
	}

	public async installApp(path: string): Promise<void> {
		this.runCommand(["apps", "install", path]);
	}

	public async uninstallApp(bundleId: string): Promise<void> {
		this.runCommand(["apps", "uninstall", bundleId]);
	}

	public async openUrl(url: string): Promise<void> {
		this.runCommand(["url", url]);
	}

	public async sendKeys(text: string): Promise<void> {
		this.runCommand(["io", "text", text]);
	}

	public async pressButton(button: Button): Promise<void> {
		this.runCommand(["io", "button", button]);
	}

	public async tap(x: number, y: number): Promise<void> {
		this.runCommand(["io", "tap", `${x},${y}`]);
	}

	public async doubleTap(x: number, y: number): Promise<void> {
		// TODO: should move into mobilecli itself as "io doubletap"
		await this.tap(x, y);
		await this.tap(x, y);
	}

	public async longPress(x: number, y: number, duration: number): Promise<void> {
		this.runCommand(["io", "longpress", `${x},${y}`, "--duration", `${duration}`]);
	}

	public async getElementsOnScreen(): Promise<ScreenElement[]> {
		const response = JSON.parse(this.runCommand(["dump", "ui"])) as DumpUIResponse;
		return response.data.elements.map(element => ({
			type: element.type,
			label: element.label,
			text: element.text,
			name: element.name,
			value: element.value,
			identifier: element.identifier,
			rect: element.rect,
			focused: element.focused,
		}));
	}

	public async setOrientation(orientation: Orientation): Promise<void> {
		this.runCommand(["device", "orientation", "set", orientation]);
	}

	public async getOrientation(): Promise<Orientation> {
		const response = JSON.parse(this.runCommand(["device", "orientation", "get"])) as OrientationResponse;
		return response.data.orientation;
	}
}

import { ComputerUseError } from "./index.js";
import { posix, win32 } from "node:path";

const appQueues = new WeakMap();

const MANAGED_OPTIONS = new Set([
  "pid", "windowId", "window_id", "elementToken", "element_token",
  "deliveryMode", "delivery_mode", "foreground", "background", "appContext",
]);

function optionsForApp(options = {}) {
  for (const key of Object.keys(options)) {
    if (MANAGED_OPTIONS.has(key)) {
      throw new ComputerUseError(`${key} is managed by the app handle`, {
        code: "app_option_managed",
      });
    }
  }
  return options;
}

function appPath(value) {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("/")) return posix.normalize(value).replace(/\/$/, "");
  if (win32.isAbsolute(value) && !value.startsWith("/")) {
    return win32.normalize(value).replace(/\\$/, "").toLocaleLowerCase();
  }
}

function hasWindowsLaunchCommand(app) {
  return typeof app.launch_path === "string" && app.launch_path &&
    typeof app.bundle_id === "string" && win32.isAbsolute(app.bundle_id) &&
    !app.bundle_id.startsWith("/") && app.launch_path !== app.bundle_id;
}

export function appIdentity(app) {
  // A Windows launcher can include case-sensitive arguments. It is an opaque
  // identity, not a filesystem path to normalize or a command to reconstruct.
  if (hasWindowsLaunchCommand(app)) {
    return app.launch_path;
  }
  return appPath(app.launch_path) || app.bundle_id || app.name;
}

export function resolveApp(apps, selector, { allowStopped = false } = {}) {
  if (typeof selector !== "string" || !selector.trim()) {
    throw new ComputerUseError("getApp requires an application name, identifier or path");
  }
  const path = appPath(selector);
  const needle = selector.trim().toLocaleLowerCase();
  const matches = apps.filter((app) => appIdentity(app) === selector || (path
    ? [hasWindowsLaunchCommand(app) ? undefined : app.launch_path, app.bundle_id].some((value) => appPath(value) === path)
    : [app.name, app.bundle_id].some((value) => typeof value === "string" && value.toLocaleLowerCase() === needle)));
  const running = matches.filter((app) =>
    app.running !== false && Number.isSafeInteger(app.pid) && app.pid > 0);
  const candidates = allowStopped ? matches : running;
  if (candidates.length !== 1) {
    throw new ComputerUseError(
      candidates.length > 1
        ? `Application ${JSON.stringify(selector)} is ambiguous; use a unique application path.`
        : `No running app matched ${JSON.stringify(selector)}. Open the app, then observe again.`,
      { code: candidates.length > 1 ? "app_ambiguous" : "app_not_running" },
    );
  }
  return candidates[0];
}

function currentWindow(windows, { allowNone = false } = {}) {
  const selected = windows.filter((window) => window.is_app_target === true &&
    Number.isSafeInteger(window.window_id ?? window.windowId));
  if (allowNone && selected.length === 0 && windows.every((window) => !window.title?.trim())) return undefined;
  if (selected.length !== 1) {
    throw new ComputerUseError("The native app window could not be determined. Open or select its window, then observe again.", {
      code: "app_window_unavailable",
    });
  }
  return selected[0];
}

async function isMacOS(computer, signal) {
  try {
    return await computer.getPlatform({ signal }) === "macos";
  } catch (error) {
    if (error.code === "driver_platform_unavailable") return false;
    throw error;
  }
}

function currentPopup(windows, target) {
  const targetBounds = target.bounds;
  return windows.filter((window) =>
    window.pid === target.pid && window.is_app_target === false &&
    Number.isSafeInteger(window.window_id ?? window.windowId) &&
    window.title === "" && window.layer === 0 && window.is_on_screen === true &&
    window.on_current_space !== false &&
    Number.isSafeInteger(target.z_index) && Number.isSafeInteger(window.z_index) &&
    window.z_index > target.z_index &&
    windows.every((candidate) => candidate.pid !== target.pid || candidate.z_index <= window.z_index) &&
    targetBounds && window.bounds &&
    window.bounds.width < targetBounds.width && window.bounds.height < targetBounds.height &&
    window.bounds.x >= targetBounds.x && window.bounds.y >= targetBounds.y &&
    window.bounds.x + window.bounds.width <= targetBounds.x + targetBounds.width &&
    window.bounds.y + window.bounds.height <= targetBounds.y + targetBounds.height)[0];
}

export class ComputerUseApp {
  #computer;
  #listApps;
  #launch;
  #identity;
  #pid;
  #window;
  #observation;
  #elements = new Map();
  #generation;

  constructor(computer, app, launch, listApps) {
    this.#launch = launch;
    this.#computer = computer;
    this.#listApps = listApps;
    this.#identity = appIdentity(app);
    this.#pid = app.pid;
    this.#generation = computer.connectionGeneration;
    Object.defineProperty(this, "name", { value: app.name || this.#identity, enumerable: true });
  }

  #serial(operation) {
    const next = (appQueues.get(this.#computer) ?? Promise.resolve()).then(operation);
    appQueues.set(this.#computer, next.catch(() => undefined));
    return next;
  }

  #invalidate() {
    this.#elements.clear();
    this.#observation = undefined;
    this.#window = undefined;
  }

  async #target(signal, { launch = false, allowNoWindow = false } = {}) {
    let app;
    try {
      app = resolveApp(await this.#listApps({ signal, runningOnly: true }), this.#identity);
    } catch (error) {
      if (!launch || error.code !== "app_not_running") throw error;
      this.#invalidate();
      await this.#launch(signal);
      app = resolveApp(await this.#listApps({ signal, runningOnly: true }), this.#identity);
    }
    if (app.pid !== this.#pid) this.#invalidate();
    this.#pid = app.pid;
    if (this.#generation !== this.#computer.connectionGeneration) {
      this.#invalidate();
      this.#generation = this.#computer.connectionGeneration;
    }
    const windows = await this.#computer.listWindows({ pid: this.#pid, onScreenOnly: false, appContext: true, signal });
    if (this.#generation !== this.#computer.connectionGeneration) {
      this.#invalidate();
      this.#generation = this.#computer.connectionGeneration;
    }
    const nativeWindow = currentWindow(windows, { allowNone: allowNoWindow });
    let window = nativeWindow;
    if (window && windows.some((candidate) => candidate.pid === window.pid &&
      candidate.window_id !== window.window_id && candidate.title === "" &&
      candidate.layer === 0 && candidate.is_on_screen === true) &&
      await isMacOS(this.#computer, signal)) {
      const visible = await this.#computer.listWindows({ pid: this.#pid, onScreenOnly: true, appContext: true, signal });
      const visibleTarget = visible.find((candidate) => candidate.is_app_target === true &&
        (candidate.window_id ?? candidate.windowId) === (window.window_id ?? window.windowId));
      window = currentPopup(visible, visibleTarget ?? window) ?? window;
    }
    if (!window) return { pid: this.#pid };
    return { window, pid: window.pid ?? this.#pid, windowId: window.window_id ?? window.windowId,
      nativeWindowId: nativeWindow.window_id ?? nativeWindow.windowId,
      key: `${window.pid ?? this.#pid}:${window.window_id ?? window.windowId}` };
  }

  async #observe(options = {}, resolved) {
    optionsForApp(options);
    if (options.includeScreenshot !== undefined && typeof options.includeScreenshot !== "boolean") {
      throw new ComputerUseError("includeScreenshot must be a boolean");
    }
    const exposeScreenshot = options.includeScreenshot === true;
    const target = resolved ?? await this.#target(options.signal, { launch: true, allowNoWindow: true });
    if (!target.window) {
      this.#invalidate();
      this.#generation = this.#computer.connectionGeneration;
      return { app: this.name, window: "", mode: "full", text: "No open application window." };
    }
    const changed = this.#window !== target.key;
    if (changed) this.#invalidate();
    let state;
    try {
      state = await this.#computer.observeWindow({
        ...options,
        includeScreenshot: true,
        pid: target.pid,
        windowId: target.windowId,
        appContext: true,
        ...(changed ? { disableDiff: true } : {}),
      });
    } catch (error) {
      this.#invalidate();
      throw error;
    }
    this.#window = target.key;
    this.#observation = state;
    this.#generation = this.#computer.connectionGeneration;
    this.#elements = new Map(state.elements.flatMap((element) => {
      const id = element.element_id ?? (state.diagnostics.revisionSupported ? undefined : element.element_index);
      return Number.isSafeInteger(id) && typeof element.element_token === "string"
        ? [[id, element]] : [];
    }));
    return {
      app: this.name,
      window: target.window.title ?? "",
      mode: state.mode,
      text: state.text,
      ...(exposeScreenshot && state.screenshot ? { screenshot: state.screenshot } : {}),
    };
  }

  getState(options = {}) {
    return this.#serial(async () => {
      try {
        return await this.#observe(options);
      } catch (error) {
        throw this.#publicError(error, true);
      }
    });
  }

  #address(point, target) {
    if (Number.isSafeInteger(point) && point >= 0) {
      const element = this.#elements.get(point);
      if (!element) {
        throw new ComputerUseError(`Element ${point} is not actionable in the current observation. Call app.getState().`, {
          code: "app_element_unavailable",
        });
      }
      return { pid: target.pid, windowId: target.windowId, elementToken: element.element_token };
    }
    optionsForApp(point);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new ComputerUseError("Provide a short element ID or screenshot coordinates { x, y }");
    }
    if (!this.#observation?.screenshot?.images.length || this.#observation.context.screenshotFrameValid === false) {
      throw new ComputerUseError("Coordinates require a current screenshot. Call app.getState({ includeScreenshot: true }).", {
        code: "app_screenshot_required",
      });
    }
    return { pid: target.pid, windowId: target.windowId, x: point.x, y: point.y };
  }

  #publicError(error, observing = false) {
    if (typeof error?.code === "string" && error.code.startsWith("app_")) return error;
    const operation = error?.details?.operation;
    if (error instanceof ComputerUseError &&
        (operation?.dispatched === false ||
          (operation === undefined && error.details === undefined))) {
      return error;
    }
    const refusalReason = !observing && error?.details?.effect === "refused"
      && error?.code === "off_space_or_ax_unresolved"
      ? "the target window could not be verified on the current desktop" : undefined;
    return new ComputerUseError(
      observing ? "The app state could not be read. Check that its window is available, then call app.getState() again." :
        (refusalReason ? `Native input refused (${error.code}): ${refusalReason}. ` : "") +
        "The app action could not be completed or confirmed. It may already have affected the app. " +
        "Call app.getState() before deciding whether to retry.",
      { code: error?.code, details: { operation: error?.details?.operation } },
    );
  }

  #act(method, point, options = {}, elementRequired = false) {
    optionsForApp(options);
    return this.#serial(async () => {
      try {
        const target = await this.#target(options.signal);
        if (this.#window !== target.key || !this.#observation) {
          this.#invalidate();
          if (point !== undefined || elementRequired || method === "drag") {
            throw new ComputerUseError("The app's window or session changed. Call app.getState() before using an element or coordinates.", {
              code: "app_observation_required",
            });
          }
          await this.#observe({ signal: options.signal }, target);
        }
        if (elementRequired && !Number.isSafeInteger(point)) {
          throw new ComputerUseError("This action requires a short element ID", { code: "app_element_required" });
        }
        const keyboard = ["pressKey", "hotkey", "typeText", "paste"].includes(method);
        let address = point === undefined
          ? { pid: target.pid, windowId: keyboard ? target.nativeWindowId : target.windowId }
          : this.#address(point, target);
        if (method === "drag") {
          if (![options.fromX, options.fromY, options.toX, options.toY].every(Number.isFinite)) {
            throw new ComputerUseError(
              "drag requires flat, finite fromX, fromY, toX and toY coordinates",
            );
          }
          this.#address({ x: options.fromX, y: options.fromY }, target);
          this.#address({ x: options.toX, y: options.toY }, target);
        }
        const semantic = ["setValue", "performSecondaryAction", "paste", "selectText"].includes(method);
        const popupClick = target.window.is_app_target === false &&
          ["click", "doubleClick", "rightClick"].includes(method);
        const pointerButton = method === "click" && Number.isSafeInteger(point) &&
          this.#elements.get(point)?.role === "AXButton" &&
          !this.#elements.get(point)?.actions?.length &&
          await isMacOS(this.#computer, options.signal);
        address = { ...options, ...address, ...(semantic ? {} : { deliveryMode: popupClick || pointerButton ? "background" : "foreground" }) };
        if (["click", "doubleClick", "rightClick", "drag", "scroll", "typeText", "paste"].includes(method)) address.appContext = true;
        const result = await this.#computer[method](address);
        const nativeEffects = ["confirmed", "partial", "unverifiable", "suspected_noop", "refused"];
        const nativeEffect = result.action?.effect;
        return { effect: result.effect ??
          (Number.isInteger(nativeEffect) ? nativeEffects[nativeEffect] : nativeEffect) ?? "unverifiable" };
      } catch (error) {
        throw this.#publicError(error);
      }
    });
  }

  click(point, options) { return this.#act("click", point, options); }
  doubleClick(point, options) { return this.#act("doubleClick", point, options); }
  rightClick(point, options) { return this.#act("rightClick", point, options); }
  scroll(point, options) { return this.#act("scroll", point, options); }
  drag(options) { return this.#act("drag", undefined, options); }
  setValue(element, value, options) { return this.#act("setValue", element, { ...options, value }, true); }
  performSecondaryAction(element, action, options) {
    return this.#act("performSecondaryAction", element, { ...options, action }, true);
  }
  typeText(text, options) { return this.#act("typeText", undefined, { ...options, text }); }
  paste(text, options) { return this.#act("paste", undefined, { ...options, text }); }
  selectText(element, text, options) { return this.#act("selectText", element, { ...options, text }, true); }
  pressKey(key, options) { return this.#act("pressKey", undefined, { ...options, key }); }
  hotkey(keys, options) { return this.#act("hotkey", undefined, { ...options, keys }); }
}

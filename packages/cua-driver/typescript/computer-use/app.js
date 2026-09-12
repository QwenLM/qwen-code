import { ComputerUseError } from "./index.js";
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";

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
  if (typeof value !== "string" || !isAbsolute(value)) return undefined;
  try { return realpathSync(value); } catch { return normalize(value).replace(/\/$/, ""); }
}

export function appIdentity(app) {
  return appPath(app.launch_path) || app.bundle_id || app.name;
}

export function resolveApp(apps, selector, { allowStopped = false } = {}) {
  if (typeof selector !== "string" || !selector.trim()) {
    throw new ComputerUseError("getApp requires an application name, identifier or path");
  }
  const path = appPath(selector);
  const needle = selector.trim().toLocaleLowerCase();
  const matches = apps.filter((app) => path
    ? appPath(app.launch_path) === path
    : [app.name, app.bundle_id].some((value) => typeof value === "string" && value.toLocaleLowerCase() === needle));
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

function currentWindow(windows) {
  const selected = windows.filter((window) => window.is_app_target === true &&
    Number.isSafeInteger(window.window_id ?? window.windowId));
  if (selected.length !== 1) {
    throw new ComputerUseError("The native app window could not be determined. Open or select its window, then observe again.", {
      code: "app_window_unavailable",
    });
  }
  return selected[0];
}

export class ComputerUseApp {
  #computer;
  #launch;
  #identity;
  #pid;
  #window;
  #observation;
  #elements = new Map();
  #generation;
  #queue = Promise.resolve();

  constructor(computer, app, launch) {
    this.#launch = launch;
    this.#computer = computer;
    this.#identity = appIdentity(app);
    this.#pid = app.pid;
    this.#generation = computer.connectionGeneration;
    Object.defineProperty(this, "name", { value: app.name || this.#identity, enumerable: true });
  }

  #serial(operation) {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #invalidate() {
    this.#elements.clear();
    this.#observation = undefined;
    this.#window = undefined;
  }

  async #target(signal, { launch = false } = {}) {
    let app;
    try {
      app = resolveApp(await this.#computer.listApps({ signal, runningOnly: true }), this.#identity);
    } catch (error) {
      if (!launch || error.code !== "app_not_running") throw error;
      this.#invalidate();
      await this.#launch(signal);
      app = resolveApp(await this.#computer.listApps({ signal, runningOnly: true }), this.#identity);
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
    const window = currentWindow(windows);
    return { window, pid: window.pid ?? this.#pid, windowId: window.window_id ?? window.windowId, key: `${window.pid ?? this.#pid}:${window.window_id ?? window.windowId}` };
  }

  async #observe(options = {}, resolved) {
    optionsForApp(options);
    const target = resolved ?? await this.#target(options.signal, { launch: true });
    const changed = this.#window !== target.key;
    if (changed) this.#invalidate();
    let state;
    try {
      state = await this.#computer.observeWindow({
        ...options,
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
      const id = element.element_id ?? element.element_index;
      return Number.isSafeInteger(id) && typeof element.element_token === "string"
        ? [[id, element]] : [];
    }));
    const text = state.diagnostics.captureComplete === false
      ? "Accessibility capture is incomplete. Observe again after the UI settles; element actions are unavailable.\n\n" +
        state.text.slice(state.text.indexOf("\n\n") + 2)
      : state.text;
    return {
      app: this.name,
      window: target.window.title ?? "",
      mode: state.mode,
      text,
      ...(state.screenshot ? { screenshot: state.screenshot } : {}),
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
    return new ComputerUseError(
      observing ? "The app state could not be read. Check that its window is available, then call app.getState() again." :
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
        let address = point === undefined
          ? { pid: target.pid, windowId: target.windowId }
          : this.#address(point, target);
        if (method === "drag") {
          this.#address({ x: options.fromX, y: options.fromY }, target);
          this.#address({ x: options.toX, y: options.toY }, target);
        }
        const semantic = method === "setValue" || method === "performSecondaryAction";
        address = { ...options, ...address, ...(semantic ? {} : { deliveryMode: "background" }) };
        if (method === "drag") address.appContext = true;
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
  pressKey(key, options) { return this.#act("pressKey", undefined, { ...options, key }); }
  hotkey(keys, options) { return this.#act("hotkey", undefined, { ...options, keys }); }
}

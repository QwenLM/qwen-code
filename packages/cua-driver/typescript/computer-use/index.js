/**
 * Standalone Computer Use facade over the typed @qwen-code/cua-sdk API.
 * The caller owns revision delivery state; CuaDriver owns native identity,
 * authorization, transport, and cleanup.
 */
import { randomUUID } from "node:crypto";

const OBSERVATION_REVISION_CAPABILITY = "accessibility.observation_revision.v1";
const ACCESSIBILITY_SERIALIZER_VERSION = "accessibility-render-v1";
const ACCESSIBILITY_PROJECTION_VERSION = "full-tree-v1";
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60;
const DEFAULT_IDLE_TTL_SECONDS = 5 * 60;

async function loadCuaDriver() {
  return import("@qwen-code/cua-sdk");
}

export class ComputerUseError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = "ComputerUseError";
    this.code = info.code;
    this.details = info.details;
  }
}

function unwrapToolResult(tool, result) {
  let structured;
  if (typeof result.structuredJson === "string" && result.structuredJson !== "") {
    try {
      structured = JSON.parse(result.structuredJson);
    } catch {
      structured = undefined;
    }
  }
  if (result.isError) {
    const code =
      (structured && typeof structured.code === "string" && structured.code) ||
      result.errorCode ||
      undefined;
    throw new ComputerUseError(result.text || `${tool} failed`, {
      code,
      details: structured,
    });
  }
  return { text: result.text, structured, images: result.images ?? [] };
}

function requirePositiveInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ComputerUseError(`${name} must be a positive integer`);
  }
  return value;
}

function requireIntegerRange(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ComputerUseError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requirePid(value) {
  return requireIntegerRange("pid", value, 1, 0xffffffff);
}

function requireStringList(name, value) {
  if (!Array.isArray(value)) throw new ComputerUseError(`${name} must be an array`);
  return value.map((entry, index) =>
    requireNonEmptyString(`${name}[${index}]`, entry),
  );
}

function requireNonEmptyString(name, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ComputerUseError(`${name} must be a non-empty string`);
  }
  return value;
}

function optionalWindowId(value) {
  return value === undefined ? undefined : BigInt(requirePositiveInteger("windowId", value));
}

function exactWindow(pid, windowId) {
  return {
    pid: requirePid(pid),
    windowId: BigInt(requirePositiveInteger("windowId", windowId)),
  };
}

function sessionOptions(sdk, options) {
  const ttlSeconds = requirePositiveInteger(
    "sessionTtlSeconds",
    options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS,
  );
  const idleTtlSeconds = requirePositiveInteger(
    "idleTtlSeconds",
    options.idleTtlSeconds ?? DEFAULT_IDLE_TTL_SECONDS,
  );
  if (idleTtlSeconds > ttlSeconds) {
    throw new ComputerUseError("idleTtlSeconds cannot exceed sessionTtlSeconds");
  }
  const publicSession =
    options.session ?? `computer-use-${process.pid}-${randomUUID().slice(0, 8)}`;
  requireNonEmptyString("session", publicSession);
  return {
    publicSession,
    mode: sdk.SessionPermissionMode.Standard,
    ttlSeconds: BigInt(ttlSeconds),
    idleTtlSeconds: BigInt(idleTtlSeconds),
    capabilityManifestPath: undefined,
    boundedManifestPath: undefined,
  };
}

function configuredDriverOptions(sdk, options) {
  const session = sessionOptions(sdk, options);
  return {
    session,
    driver: {
      claudeCodeCompatibility: false,
      authorization: {
        allowedModes: [sdk.SessionPermissionMode.Standard],
        compatibilityMode: sdk.SessionPermissionMode.Standard,
        compatibilityCapabilityManifestPath: undefined,
        compatibilityBoundedManifestPath: undefined,
        unrestrictedAcknowledged: false,
        maxSessionTtlSeconds: session.ttlSeconds,
        maxIdleTtlSeconds: session.idleTtlSeconds,
      },
    },
  };
}

async function destroyOwner(owner) {
  let failure;
  if (typeof owner?.shutdown === "function") {
    try {
      await owner.shutdown();
    } catch (error) {
      failure = error;
    }
  }
  if (typeof owner?.uniffiDestroy === "function") {
    try {
      owner.uniffiDestroy();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

export class ComputerUse {
  #driver;
  #owner;
  #sdk;
  #ownsSession;
  #publicSession;
  #closed = false;
  #revisionSupport;

  /** Internal injection seam for hermetic tests. Use create/connect in applications. */
  constructor(
    driver,
    { owner = driver, sdk = {}, ownsSession = false, publicSession } = {},
  ) {
    if (!driver || typeof driver.getWindowState !== "function") {
      throw new ComputerUseError("ComputerUse requires a typed driver session");
    }
    this.#driver = driver;
    this.#owner = owner;
    this.#sdk = sdk;
    this.#ownsSession = ownsSession;
    this.#publicSession = publicSession;
  }

  /** Create a same-process configured runtime and one bound standard session. */
  static async create(options = {}) {
    const sdk = await loadCuaDriver();
    const configured = configuredDriverOptions(sdk, options);
    const owner = sdk.CuaDriver.createConfigured(configured.driver);
    try {
      const session = sdk.createTrustedSession(owner, configured.session);
      return new ComputerUse(session, {
        owner,
        sdk,
        ownsSession: true,
        publicSession: configured.session.publicSession,
      });
    } catch (error) {
      await destroyOwner(owner);
      throw error;
    }
  }

  /** Connect to a caller-selected daemon and bind a transport-owned session. */
  static async connect(options = {}) {
    const sdk = await loadCuaDriver();
    const configured = configuredDriverOptions(sdk, options);
    const owner = sdk.CuaDriver.connect(options.socketPath);
    try {
      const session = sdk.createTrustedSession(owner, configured.session);
      return new ComputerUse(session, {
        owner,
        sdk,
        ownsSession: true,
        publicSession: configured.session.publicSession,
      });
    } catch (error) {
      await destroyOwner(owner);
      throw error;
    }
  }

  #requireOpen() {
    if (this.#closed) throw new ComputerUseError("ComputerUse instance is closed");
  }

  async #invoke(method, input) {
    this.#requireOpen();
    const call = this.#driver[method];
    if (typeof call !== "function") {
      throw new ComputerUseError(`typed CuaDriver method ${method} is unavailable`, {
        code: "typed_sdk_method_unavailable",
      });
    }
    const result = await call.call(this.#driver, input);
    return unwrapToolResult(method, result);
  }

  #clickButton(value) {
    if (value === undefined) return undefined;
    const normalized = requireNonEmptyString("button", value).toLowerCase();
    const values = {
      left: this.#sdk.ClickButton?.Left ?? "left",
      right: this.#sdk.ClickButton?.Right ?? "right",
      middle: this.#sdk.ClickButton?.Middle ?? "middle",
    };
    if (!(normalized in values)) throw new ComputerUseError(`unsupported button: ${value}`);
    return values[normalized];
  }

  #deliveryMode(value) {
    if (value === undefined) return undefined;
    const normalized = requireNonEmptyString("deliveryMode", value).toLowerCase();
    const values = {
      background: this.#sdk.DeliveryMode?.Background ?? "background",
      foreground: this.#sdk.DeliveryMode?.Foreground ?? "foreground",
    };
    if (!(normalized in values)) {
      throw new ComputerUseError(`unsupported deliveryMode: ${value}`);
    }
    return values[normalized];
  }

  #scrollDirection(value) {
    const normalized = requireNonEmptyString("direction", value).toLowerCase();
    const values = {
      up: this.#sdk.ScrollDirection?.Up ?? "up",
      down: this.#sdk.ScrollDirection?.Down ?? "down",
      left: this.#sdk.ScrollDirection?.Left ?? "left",
      right: this.#sdk.ScrollDirection?.Right ?? "right",
    };
    if (!(normalized in values)) throw new ComputerUseError(`unsupported direction: ${value}`);
    return values[normalized];
  }

  #scrollBy(value) {
    if (value === undefined) return undefined;
    const normalized = requireNonEmptyString("by", value).toLowerCase();
    const values = {
      line: this.#sdk.ScrollBy?.Line ?? "line",
      page: this.#sdk.ScrollBy?.Page ?? "page",
    };
    if (!(normalized in values)) throw new ComputerUseError(`unsupported scroll unit: ${value}`);
    return values[normalized];
  }

  #windowAddress(options, { coordinates = true, tokenRequired = false } = {}) {
    const { pid, windowId, elementToken, x, y } = options ?? {};
    const input = {
      pid: requirePid(pid),
      windowId: optionalWindowId(windowId),
    };
    if (elementToken !== undefined) {
      input.elementToken = requireNonEmptyString("elementToken", elementToken);
      if (x !== undefined || y !== undefined) {
        throw new ComputerUseError("elementToken cannot be combined with x/y");
      }
      return input;
    }
    if (tokenRequired) throw new ComputerUseError("elementToken is required");
    if (!coordinates) {
      if (input.windowId === undefined) {
        throw new ComputerUseError("provide elementToken or windowId");
      }
      return input;
    }
    if (x === undefined || y === undefined) {
      throw new ComputerUseError("provide elementToken or both x and y");
    }
    if (input.windowId === undefined) {
      throw new ComputerUseError("windowId is required for window-local coordinates");
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ComputerUseError("x and y must be finite numbers");
    }
    input.x = x;
    input.y = y;
    return input;
  }

  async supportsObservationRevision() {
    this.#requireOpen();
    if (this.#revisionSupport === undefined) {
      let advertised = false;
      if (typeof this.#owner.listToolsJson === "function") {
        try {
          const listing = JSON.parse(await this.#owner.listToolsJson());
          const tools = Array.isArray(listing?.tools) ? listing.tools : [];
          const entry = tools.find((tool) => tool?.name === "get_window_state");
          advertised =
            Array.isArray(entry?.capabilities) &&
            entry.capabilities.includes(OBSERVATION_REVISION_CAPABILITY);
        } catch {
          advertised = false;
        }
      }
      this.#revisionSupport = advertised;
    }
    return this.#revisionSupport;
  }

  async listApps() {
    const { structured } = await this.#invoke("listApps", {});
    return structured?.apps ?? structured ?? [];
  }

  async listWindows({ pid, onScreenOnly } = {}) {
    const input = {};
    if (pid !== undefined) input.pid = requirePid(pid);
    if (onScreenOnly !== undefined) input.onScreenOnly = Boolean(onScreenOnly);
    const { structured } = await this.#invoke("listWindows", input);
    return structured?.windows ?? structured ?? [];
  }

  async getWindow({ pid, windowId }) {
    const target = exactWindow(pid, windowId);
    const windows = await this.listWindows({ pid: target.pid });
    const found = windows.find(
      (window) =>
        String(window.window_id ?? window.windowId) === String(target.windowId),
    );
    if (!found) {
      throw new ComputerUseError(`window ${windowId} for pid ${pid} was not found`, {
        code: "window_not_found",
      });
    }
    return found;
  }

  async observeWindow(options) {
    const {
      pid,
      windowId,
      baseRevisionId,
      forceFull,
      includeScreenshot = false,
      screenshotOutFile,
      maxElements,
      maxDepth,
    } = options ?? {};
    const target = exactWindow(pid, windowId);
    const input = {
      pid: target.pid,
      windowId: target.windowId,
      includeScreenshot,
    };
    if (screenshotOutFile !== undefined) input.screenshotOutFile = screenshotOutFile;
    if (maxElements !== undefined) {
      input.maxElements = requirePositiveInteger("maxElements", maxElements);
    }
    if (maxDepth !== undefined) input.maxDepth = requirePositiveInteger("maxDepth", maxDepth);
    if (await this.supportsObservationRevision()) {
      input.observationRevision = {
        version: 1,
        serializerVersion: ACCESSIBILITY_SERIALIZER_VERSION,
        projectionVersion: ACCESSIBILITY_PROJECTION_VERSION,
      };
      if (baseRevisionId !== undefined) {
        input.observationRevision.baseRevisionId = requireNonEmptyString(
          "baseRevisionId",
          baseRevisionId,
        );
      }
      if (forceFull !== undefined) input.observationRevision.forceFull = Boolean(forceFull);
    }
    const { text, structured, images } = await this.#invoke("getWindowState", input);
    const envelope = structured?.observation_revision;
    return {
      pid,
      windowId,
      revisionSupported: Boolean(envelope),
      mode: envelope?.mode ?? "full",
      revisionId: envelope?.revision_id,
      lineageId: envelope?.lineage_id,
      baseRevisionId: envelope?.base_revision_id ?? undefined,
      serializerVersion: envelope?.serializer_version,
      projectionVersion: envelope?.projection_version,
      resyncReason: envelope?.resync_reason ?? undefined,
      stableElementIds: envelope?.stable_element_ids === true,
      selectedBytes: envelope?.selected_bytes,
      fullBytes: envelope?.full_bytes,
      estimatedTokens: envelope?.estimated_tokens,
      serializerDurationUs: envelope?.serializer_duration_us,
      cacheEstimateBytes: envelope?.cache_estimate_bytes,
      text: structured?.tree_markdown ?? text,
      elements: structured?.elements ?? [],
      screenshot:
        structured?.screenshot_width !== undefined || structured?.screenshot_file_path
          ? {
              width: structured?.screenshot_width,
              height: structured?.screenshot_height,
              mimeType: structured?.screenshot_mime_type,
              filePath: structured?.screenshot_file_path,
              images,
            }
          : undefined,
      structured,
    };
  }

  async verifyState(options) {
    const { pid, windowId, expect, timeoutMs, stableSamples, includeScreenshot } =
      options ?? {};
    const target = exactWindow(pid, windowId);
    if (!Array.isArray(expect) || expect.length === 0) {
      throw new ComputerUseError("expect must contain at least one predicate");
    }
    const input = { pid: BigInt(target.pid), windowId: target.windowId, expect };
    if (timeoutMs !== undefined) {
      input.timeoutMs = BigInt(requireIntegerRange("timeoutMs", timeoutMs, 0, 10000));
    }
    if (stableSamples !== undefined) {
      input.stableSamples = BigInt(
        requireIntegerRange("stableSamples", stableSamples, 1, 5),
      );
    }
    if (includeScreenshot !== undefined) input.includeScreenshot = includeScreenshot;
    const { structured } = await this.#invoke("verifyState", input);
    return structured;
  }

  async click(options) {
    const input = this.#windowAddress(options);
    const { button, count } = options ?? {};
    if (button !== undefined) input.button = this.#clickButton(button);
    if (count !== undefined) input.count = requireIntegerRange("count", count, 1, 3);
    const { structured, text } = await this.#invoke("windowClick", input);
    return structured ?? { text };
  }

  async doubleClick(options) {
    const { structured, text } = await this.#invoke(
      "doubleClick",
      this.#windowAddress(options),
    );
    return structured ?? { text };
  }

  async rightClick(options) {
    const input = this.#windowAddress(options);
    if (options?.modifier !== undefined) {
      input.modifier = requireStringList("modifier", options.modifier);
    }
    const { structured, text } = await this.#invoke("rightClick", input);
    return structured ?? { text };
  }

  async drag(options) {
    const {
      pid,
      windowId,
      fromX,
      fromY,
      toX,
      toY,
      durationMs,
      steps,
      deliveryMode,
      button,
      modifier,
    } = options ?? {};
    const target = exactWindow(pid, windowId);
    for (const [name, value] of Object.entries({ fromX, fromY, toX, toY })) {
      if (!Number.isFinite(value)) throw new ComputerUseError(`${name} must be a finite number`);
    }
    const input = {
      fromX,
      fromY,
      toX,
      toY,
      pid: target.pid,
      windowId: target.windowId,
    };
    if (durationMs !== undefined) {
      input.durationMs = BigInt(
        requireIntegerRange("durationMs", durationMs, 0, 10000),
      );
    }
    if (steps !== undefined) {
      input.steps = BigInt(requireIntegerRange("steps", steps, 1, 200));
    }
    if (deliveryMode !== undefined) input.deliveryMode = this.#deliveryMode(deliveryMode);
    if (button !== undefined) input.button = this.#clickButton(button);
    if (modifier !== undefined) input.modifier = requireStringList("modifier", modifier);
    const { structured, text } = await this.#invoke("windowDrag", input);
    return structured ?? { text };
  }

  async scroll(options) {
    const input = this.#windowAddress(options);
    input.direction = this.#scrollDirection(options?.direction);
    if (options?.amount !== undefined) {
      input.amount = BigInt(requireIntegerRange("amount", options.amount, 1, 50));
    }
    if (options?.by !== undefined) input.by = this.#scrollBy(options.by);
    const { structured, text } = await this.#invoke("windowScroll", input);
    return structured ?? { text };
  }

  async setValue(options) {
    const input = this.#windowAddress(options, { coordinates: false, tokenRequired: true });
    input.value = typeof options?.value === "string" ? options.value : undefined;
    if (input.value === undefined) throw new ComputerUseError("value must be a string");
    const { structured, text } = await this.#invoke("setValue", input);
    return structured ?? { text };
  }

  async typeText(options) {
    const input = this.#windowAddress(options, { coordinates: false });
    if (typeof options?.text !== "string") throw new ComputerUseError("text must be a string");
    input.text = options.text;
    if (options.delayMs !== undefined) {
      input.delayMs = BigInt(
        requireIntegerRange("delayMs", options.delayMs, 0, Number.MAX_SAFE_INTEGER),
      );
    }
    const { structured, text } = await this.#invoke("windowTypeText", input);
    return structured ?? { text };
  }

  async pressKey(options) {
    const input = this.#windowAddress(options, { coordinates: false });
    input.key = requireNonEmptyString("key", options?.key);
    if (options?.modifiers !== undefined) {
      input.modifiers = requireStringList("modifiers", options.modifiers);
    }
    const { structured, text } = await this.#invoke("windowPressKey", input);
    return structured ?? { text };
  }

  async hotkey(options) {
    const input = this.#windowAddress(options, { coordinates: false });
    if (!Array.isArray(options?.keys) || options.keys.length < 2) {
      throw new ComputerUseError("keys must list modifiers plus one key");
    }
    input.keys = requireStringList("keys", options.keys);
    const { structured, text } = await this.#invoke("windowHotkey", input);
    return structured ?? { text };
  }

  async performSecondaryAction(options) {
    const input = this.#windowAddress(options, { coordinates: false, tokenRequired: true });
    input.action = requireNonEmptyString("action", options?.action);
    const { structured, text } = await this.#invoke("performSecondaryAction", input);
    return structured ?? { text };
  }

  /** Close the bound session, then the owning runtime/client handle. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    let failure;
    if (this.#ownsSession && typeof this.#driver.endSession === "function") {
      try {
        await this.#driver.endSession({ session: this.#publicSession });
      } catch (error) {
        failure = error;
      }
    }
    if (this.#ownsSession && typeof this.#driver.close === "function") {
      try {
        this.#driver.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (this.#ownsSession && typeof this.#driver.uniffiDestroy === "function") {
      try {
        this.#driver.uniffiDestroy();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      await destroyOwner(this.#owner);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }
}

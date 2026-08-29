/**
 * Standalone Computer Use facade over the typed @qwen-code/cua-sdk API.
 * The caller owns revision delivery state; CuaDriver owns native identity,
 * authorization, transport, and cleanup.
 */
import { randomUUID } from "node:crypto";

const OBSERVATION_REVISION_CAPABILITY = "accessibility.observation_revision.v1";
const ACCESSIBILITY_SERIALIZER_VERSION = "accessibility-render-v1";
const ACCESSIBILITY_PROJECTION_VERSION = "full-tree-v1";
const DEFAULT_EXPLICIT_SESSION_TTL_SECONDS = 60 * 60;
const DEFAULT_EXPLICIT_IDLE_TTL_SECONDS = 5 * 60;
const DEFAULT_CALL_TIMEOUT_MS = 25_000;
const MAX_CALL_TIMEOUT_MS = 29_000;
const RECONNECTABLE_SESSION_CODES = new Set([
  "authorization_context_expired",
  "session_unavailable",
]);

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
      (structured &&
        typeof structured.refusal?.code === "string" &&
        structured.refusal.code) ||
      result.errorCode ||
      undefined;
    throw new ComputerUseError(result.text || `${tool} failed`, {
      code,
      details: structured,
    });
  }
  return {
    text: result.text,
    structured,
    images: result.images ?? [],
    action: result.action,
    verification: result.verification,
    degraded: result.degraded === true,
    rawJson: result.rawJson,
  };
}

function actionResult(result) {
  const value = result.structured ?? { text: result.text };
  return result.action === undefined ? value : { ...value, action: result.action };
}

function verificationResult(result) {
  const value = result.structured ?? { status: "unknown", stable: false };
  return result.verification === undefined
    ? value
    : { ...value, verification: result.verification };
}

function requirePositiveInteger(name, value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ComputerUseError(
      `${name} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return value;
}

function requireIntegerRange(name, value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ComputerUseError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function requireCallTimeoutMs(value) {
  return requireIntegerRange("callTimeoutMs", value, 1, MAX_CALL_TIMEOUT_MS);
}

async function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason;
  let cancel;
  const cancelled = new Promise((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function runWithCallDeadline(
  method,
  { signal, callTimeoutMs },
  operation,
) {
  const timeoutMs = requireCallTimeoutMs(callTimeoutMs);
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new ComputerUseError("signal must be an AbortSignal");
  }
  if (signal?.aborted) {
    throw new ComputerUseError(`${method} was cancelled before dispatch`, {
      code: "call_cancelled",
      details: { method },
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${method} exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref?.();
  try {
    return await operation(controller.signal, timeoutMs);
  } catch (error) {
    if (timedOut) {
      throw new ComputerUseError(
        `${method} exceeded the ${timeoutMs}ms native deadline`,
        {
          code: "call_timeout",
          details: { method, timeoutMs },
        },
      );
    }
    if (signal?.aborted) {
      throw new ComputerUseError(`${method} was cancelled`, {
        code: "call_cancelled",
        details: { method },
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

function createTrustedSessionAsync(sdk, owner, options, signal) {
  if (typeof sdk.createTrustedSessionAsync !== "function") {
    throw new ComputerUseError(
      "typed CUA SDK lacks asynchronous session binding",
      {
        code: "typed_sdk_method_unavailable",
      },
    );
  }
  return waitWithSignal(
    sdk.createTrustedSessionAsync(owner, options, { signal }),
    signal,
  );
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
  const finiteLifetimeRequested =
    options.sessionTtlSeconds !== undefined ||
    options.idleTtlSeconds !== undefined;
  const ttlSeconds = requirePositiveInteger(
    "sessionTtlSeconds",
    finiteLifetimeRequested
      ? (options.sessionTtlSeconds ?? DEFAULT_EXPLICIT_SESSION_TTL_SECONDS)
      : 0,
    { allowZero: !finiteLifetimeRequested },
  );
  const idleTtlSeconds = requirePositiveInteger(
    "idleTtlSeconds",
    finiteLifetimeRequested
      ? (options.idleTtlSeconds ?? DEFAULT_EXPLICIT_IDLE_TTL_SECONDS)
      : 0,
    { allowZero: !finiteLifetimeRequested },
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

async function destroySessionHandle(session, signal) {
  let failure;
  if (typeof session?.closeAsync === "function") {
    try {
      const closeSignal = signal ?? new AbortController().signal;
      const close = session.closeAsync({ signal: closeSignal });
      await waitWithSignal(close, signal);
    } catch (error) {
      failure = error;
    }
  } else if (typeof session?.close === "function") {
    try {
      session.close();
    } catch (error) {
      failure = error;
    }
  }
  if (typeof session?.uniffiDestroy === "function") {
    try {
      session.uniffiDestroy();
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
  #sessionFactory;
  #callTimeoutMs;
  #reconnectPromise;
  #connectionGeneration = 1;
  #forceFullObservation = false;
  #closed = false;
  #revisionSupport;

  /** Internal injection seam for hermetic tests. Use create/connect in applications. */
  constructor(
    driver,
    {
      owner = driver,
      sdk = {},
      ownsSession = false,
      publicSession,
      sessionFactory,
      callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    } = {},
  ) {
    if (!driver || typeof driver.getWindowState !== "function") {
      throw new ComputerUseError("ComputerUse requires a typed driver session");
    }
    this.#driver = driver;
    this.#owner = owner;
    this.#sdk = sdk;
    this.#ownsSession = ownsSession;
    this.#publicSession = publicSession;
    this.#sessionFactory = sessionFactory;
    this.#callTimeoutMs = requireCallTimeoutMs(callTimeoutMs);
  }

  /** Create a same-process configured runtime and one bound standard session. */
  static async create(options = {}) {
    const callTimeoutMs = requireCallTimeoutMs(
      options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
    const sdk = await loadCuaDriver();
    const configured = configuredDriverOptions(sdk, options);
    const owner = sdk.CuaDriver.createConfigured(configured.driver);
    try {
      const session = await runWithCallDeadline(
        "createTrustedSession",
        { callTimeoutMs },
        (signal) =>
          createTrustedSessionAsync(sdk, owner, configured.session, signal),
      );
      return new ComputerUse(session, {
        owner,
        sdk,
        ownsSession: true,
        publicSession: configured.session.publicSession,
        sessionFactory: (signal, publicSession) =>
          createTrustedSessionAsync(
            sdk,
            owner,
            { ...configured.session, publicSession },
            signal,
          ),
        callTimeoutMs,
      });
    } catch (error) {
      await destroyOwner(owner);
      throw error;
    }
  }

  /** Connect to a caller-selected daemon and bind a transport-owned session. */
  static async connect(options = {}) {
    const callTimeoutMs = requireCallTimeoutMs(
      options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
    );
    const sdk = await loadCuaDriver();
    const configured = configuredDriverOptions(sdk, options);
    const owner = sdk.CuaDriver.connect(options.socketPath);
    try {
      const session = await runWithCallDeadline(
        "createTrustedSession",
        { callTimeoutMs },
        (signal) =>
          createTrustedSessionAsync(sdk, owner, configured.session, signal),
      );
      return new ComputerUse(session, {
        owner,
        sdk,
        ownsSession: true,
        publicSession: configured.session.publicSession,
        sessionFactory: (signal, publicSession) =>
          createTrustedSessionAsync(
            sdk,
            owner,
            { ...configured.session, publicSession },
            signal,
          ),
        callTimeoutMs,
      });
    } catch (error) {
      await destroyOwner(owner);
      throw error;
    }
  }

  #requireOpen() {
    if (this.#closed) throw new ComputerUseError("ComputerUse instance is closed");
  }

  async #withCallDeadline(
    method,
    { signal, callTimeoutMs = this.#callTimeoutMs } = {},
    operation,
  ) {
    this.#requireOpen();
    return runWithCallDeadline(method, { signal, callTimeoutMs }, operation);
  }

  async #call(
    method,
    input,
    { signal, callTimeoutMs, onDispatch } = {},
  ) {
    return this.#withCallDeadline(
      method,
      { signal, callTimeoutMs },
      async (activeSignal) => {
        const reconnect = this.#reconnectPromise;
        if (reconnect) await waitWithSignal(reconnect, activeSignal);
        this.#requireOpen();
        if (!this.#driver && typeof this.#sessionFactory === "function") {
          await this.#reconnect(this.#connectionGeneration, {
            signal: activeSignal,
            callTimeoutMs,
          });
        }
        const driver = this.#driver;
        const call = driver?.[method];
        if (typeof call !== "function") {
          throw new ComputerUseError(`typed CuaDriver method ${method} is unavailable`, {
            code: "typed_sdk_method_unavailable",
          });
        }
        onDispatch?.(this.#connectionGeneration);
        return call.call(driver, input, { signal: activeSignal });
      },
    );
  }

  async #invoke(
    method,
    input,
    {
      readOnly = false,
      afterReconnect,
      signal,
      callTimeoutMs,
      onDispatch,
    } = {},
  ) {
    return this.#withCallDeadline(
      method,
      { signal, callTimeoutMs },
      async (operationSignal, timeoutMs) => {
        let activeInput = input;
        let retried = false;
        while (true) {
          let dispatchedGeneration;
          try {
            const result = await this.#call(method, activeInput, {
              signal: operationSignal,
              callTimeoutMs: timeoutMs,
              onDispatch: (generation) => {
                dispatchedGeneration = generation;
                onDispatch?.(generation);
              },
            });
            return unwrapToolResult(method, result);
          } catch (error) {
            if (
              !readOnly ||
              retried ||
              !RECONNECTABLE_SESSION_CODES.has(error?.code) ||
              typeof this.#sessionFactory !== "function"
            ) {
              throw error;
            }
            await this.#reconnect(dispatchedGeneration, {
              signal: operationSignal,
              callTimeoutMs: timeoutMs,
            });
            activeInput = afterReconnect ? await afterReconnect() : input;
            retried = true;
          }
        }
      },
    );
  }

  get connectionGeneration() {
    return this.#connectionGeneration;
  }

  async sessionInfo(options = {}) {
    return this.#call("getSession", {}, options);
  }

  async reconnect() {
    this.#requireOpen();
    if (!this.#ownsSession || typeof this.#sessionFactory !== "function") {
      throw new ComputerUseError("this ComputerUse instance cannot reconnect", {
        code: "reconnect_unavailable",
      });
    }
    return this.#reconnect(this.#connectionGeneration, {
      callTimeoutMs: this.#callTimeoutMs,
    });
  }

  async #reconnect(expectedGeneration, { signal, callTimeoutMs } = {}) {
    this.#requireOpen();
    if (expectedGeneration !== this.#connectionGeneration) {
      return { connectionGeneration: this.#connectionGeneration };
    }
    if (this.#reconnectPromise) {
      return signal
        ? waitWithSignal(this.#reconnectPromise, signal)
        : this.#reconnectPromise;
    }

    const previous = this.#driver;
    const operation = this.#withCallDeadline(
      "reconnect",
      { signal, callTimeoutMs: callTimeoutMs ?? this.#callTimeoutMs },
      async (reconnectSignal) => {
        await destroySessionHandle(previous, reconnectSignal);
        this.#driver = undefined;
        let replacement;
        const replacementPublicSession =
          this.#publicSession === undefined ? undefined : randomUUID();
        try {
          replacement = await this.#sessionFactory(
            reconnectSignal,
            replacementPublicSession,
          );
        } catch (error) {
          if (this.#closed) throw new ComputerUseError("ComputerUse instance is closed");
          if (error?.code === "call_timeout" || reconnectSignal.aborted) throw error;
          throw new ComputerUseError(
            "failed to create a replacement CUA session",
            {
              code: "reconnect_failed",
              details: { cause: error },
            },
          );
        }

        if (this.#closed || expectedGeneration !== this.#connectionGeneration) {
          await destroySessionHandle(replacement, reconnectSignal);
          if (this.#closed) throw new ComputerUseError("ComputerUse instance is closed");
          return { connectionGeneration: this.#connectionGeneration };
        }
        this.#driver = replacement;
        if (replacementPublicSession !== undefined) {
          this.#publicSession = replacementPublicSession;
        }
        this.#connectionGeneration += 1;
        this.#revisionSupport = undefined;
        this.#forceFullObservation = true;
        return { connectionGeneration: this.#connectionGeneration };
      },
    );
    this.#reconnectPromise = operation;
    const clearReconnect = () => {
      if (this.#reconnectPromise === operation) this.#reconnectPromise = undefined;
    };
    void operation.then(clearReconnect, clearReconnect);
    return signal ? waitWithSignal(operation, signal) : operation;
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

  async #supportsObservationRevision(options) {
    this.#requireOpen();
    if (this.#revisionSupport === undefined) {
      let advertised = false;
      const owner = this.#owner;
      const listTools = owner?.listToolsJson;
      if (typeof listTools === "function") {
        try {
          const listing = JSON.parse(
            await this.#withCallDeadline(
              "listToolsJson",
              options,
              (signal) => listTools.call(owner, { signal }),
            ),
          );
          const tools = Array.isArray(listing?.tools) ? listing.tools : [];
          const entry = tools.find((tool) => tool?.name === "get_window_state");
          advertised =
            Array.isArray(entry?.capabilities) &&
            entry.capabilities.includes(OBSERVATION_REVISION_CAPABILITY);
        } catch (error) {
          if (error?.code === "call_timeout" || error?.code === "call_cancelled") {
            throw error;
          }
          advertised = false;
        }
      }
      this.#revisionSupport = advertised;
    }
    return this.#revisionSupport;
  }

  async supportsObservationRevision() {
    return this.#supportsObservationRevision({});
  }

  async listApps(options = {}) {
    const { structured } = await this.#invoke("listApps", {}, {
      readOnly: true,
      signal: options.signal,
      callTimeoutMs: options.callTimeoutMs,
    });
    return structured?.apps ?? structured ?? [];
  }

  async listWindows({ pid, onScreenOnly, signal, callTimeoutMs } = {}) {
    const input = {};
    if (pid !== undefined) input.pid = requirePid(pid);
    if (onScreenOnly !== undefined) input.onScreenOnly = Boolean(onScreenOnly);
    const { structured } = await this.#invoke("listWindows", input, {
      readOnly: true,
      signal,
      callTimeoutMs,
    });
    return structured?.windows ?? structured ?? [];
  }

  async getWindow({ pid, windowId, signal, callTimeoutMs }) {
    const target = exactWindow(pid, windowId);
    const windows = await this.listWindows({ pid: target.pid, signal, callTimeoutMs });
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
      signal,
      callTimeoutMs,
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
    return this.#withCallDeadline(
      "getWindowState",
      { signal, callTimeoutMs },
      async (operationSignal, timeoutMs) => {
        if (
          await this.#supportsObservationRevision({
            signal: operationSignal,
            callTimeoutMs: timeoutMs,
          })
        ) {
          input.observationRevision = {
            version: 1,
            serializerVersion: ACCESSIBILITY_SERIALIZER_VERSION,
            projectionVersion: ACCESSIBILITY_PROJECTION_VERSION,
          };
          if (baseRevisionId !== undefined && !this.#forceFullObservation) {
            input.observationRevision.baseRevisionId = requireNonEmptyString(
              "baseRevisionId",
              baseRevisionId,
            );
          }
          if (forceFull !== undefined || this.#forceFullObservation) {
            input.observationRevision.forceFull =
              this.#forceFullObservation || Boolean(forceFull);
          }
        }
        let observedGeneration;
        const { text, structured, images } = await this.#invoke(
          "getWindowState",
          input,
          {
            readOnly: true,
            signal: operationSignal,
            callTimeoutMs: timeoutMs,
            afterReconnect: () => {
              if (!input.observationRevision) return input;
              return {
                ...input,
                observationRevision: {
                  ...input.observationRevision,
                  baseRevisionId: undefined,
                  forceFull: true,
                },
              };
            },
            onDispatch: (generation) => {
              observedGeneration = generation;
            },
          },
        );
        if (observedGeneration === this.#connectionGeneration) {
          this.#forceFullObservation = false;
        }
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
            structured?.screenshot_width !== undefined ||
            structured?.screenshot_file_path
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
      },
    );
  }

  async verifyState(options) {
    const {
      pid,
      windowId,
      expect,
      timeoutMs,
      stableSamples,
      includeScreenshot,
      signal,
      callTimeoutMs,
    } = options ?? {};
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
    const result = await this.#invoke("verifyState", input, {
      readOnly: true,
      signal,
      callTimeoutMs,
    });
    return verificationResult(result);
  }

  async click(options) {
    const input = this.#windowAddress(options);
    const { button, count, deliveryMode, signal, callTimeoutMs } = options ?? {};
    if (button !== undefined) input.button = this.#clickButton(button);
    if (count !== undefined) input.count = requireIntegerRange("count", count, 1, 3);
    if (deliveryMode !== undefined) input.deliveryMode = this.#deliveryMode(deliveryMode);
    return actionResult(
      await this.#invoke("windowClick", input, { signal, callTimeoutMs }),
    );
  }

  async doubleClick(options) {
    const input = this.#windowAddress(options);
    if (options?.deliveryMode !== undefined) {
      input.deliveryMode = this.#deliveryMode(options.deliveryMode);
    }
    return actionResult(
      await this.#invoke("doubleClick", input, {
        signal: options?.signal,
        callTimeoutMs: options?.callTimeoutMs,
      }),
    );
  }

  async rightClick(options) {
    const input = this.#windowAddress(options);
    if (options?.modifier !== undefined) {
      input.modifier = requireStringList("modifier", options.modifier);
    }
    if (options?.deliveryMode !== undefined) {
      input.deliveryMode = this.#deliveryMode(options.deliveryMode);
    }
    return actionResult(
      await this.#invoke("rightClick", input, {
        signal: options?.signal,
        callTimeoutMs: options?.callTimeoutMs,
      }),
    );
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
      signal,
      callTimeoutMs,
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
    return actionResult(
      await this.#invoke("windowDrag", input, { signal, callTimeoutMs }),
    );
  }

  async scroll(options) {
    const input = this.#windowAddress(options);
    input.direction = this.#scrollDirection(options?.direction);
    if (options?.amount !== undefined) {
      input.amount = BigInt(requireIntegerRange("amount", options.amount, 1, 50));
    }
    if (options?.by !== undefined) input.by = this.#scrollBy(options.by);
    if (options?.deliveryMode !== undefined) {
      input.deliveryMode = this.#deliveryMode(options.deliveryMode);
    }
    return actionResult(
      await this.#invoke("windowScroll", input, {
        signal: options?.signal,
        callTimeoutMs: options?.callTimeoutMs,
      }),
    );
  }

  async setValue(options) {
    const input = this.#windowAddress(options, { coordinates: false, tokenRequired: true });
    input.value = typeof options?.value === "string" ? options.value : undefined;
    if (input.value === undefined) throw new ComputerUseError("value must be a string");
    return actionResult(
      await this.#invoke("setValue", input, {
        signal: options?.signal,
        callTimeoutMs: options?.callTimeoutMs,
      }),
    );
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
    if (options.deliveryMode !== undefined) {
      input.deliveryMode = this.#deliveryMode(options.deliveryMode);
    }
    return actionResult(
      await this.#invoke("windowTypeText", input, {
        signal: options.signal,
        callTimeoutMs: options.callTimeoutMs,
      }),
    );
  }

  async pressKey(options) {
    const input = this.#windowAddress(options, { coordinates: false });
    input.key = requireNonEmptyString("key", options?.key);
    if (options?.modifiers !== undefined) {
      input.modifiers = requireStringList("modifiers", options.modifiers);
    }
    if (options?.deliveryMode !== undefined) {
      input.deliveryMode = this.#deliveryMode(options.deliveryMode);
    }
    return actionResult(
      await this.#invoke("windowPressKey", input, {
        signal: options?.signal,
        callTimeoutMs: options?.callTimeoutMs,
      }),
    );
  }

  async hotkey(options) {
    const input = this.#windowAddress(options, { coordinates: false });
    if (!Array.isArray(options?.keys) || options.keys.length < 2) {
      throw new ComputerUseError("keys must list modifiers plus one key");
    }
    input.keys = requireStringList("keys", options.keys);
    if (options?.deliveryMode !== undefined) {
      input.deliveryMode = this.#deliveryMode(options.deliveryMode);
    }
    return actionResult(
      await this.#invoke("windowHotkey", input, {
        signal: options?.signal,
        callTimeoutMs: options?.callTimeoutMs,
      }),
    );
  }

  async performSecondaryAction(options) {
    const input = this.#windowAddress(options, { coordinates: false, tokenRequired: true });
    input.action = requireNonEmptyString("action", options?.action);
    return actionResult(
      await this.#invoke("performSecondaryAction", input, {
        signal: options?.signal,
        callTimeoutMs: options?.callTimeoutMs,
      }),
    );
  }

  async actAndVerify({ action, verify } = {}) {
    if (typeof action !== "function" || typeof verify !== "function") {
      throw new ComputerUseError("actAndVerify requires action and verify functions");
    }
    const actionOutcome = await action();
    const verification = await verify(actionOutcome);
    const admissibleEffect = ["confirmed", "partial", "unverifiable"].includes(
      actionOutcome?.effect,
    );
    const verified =
      verification?.status === "satisfied" && verification?.stable === true;
    if (!admissibleEffect || !verified) {
      throw new ComputerUseError("the action postcondition was not stably satisfied", {
        code: "postcondition_not_satisfied",
        details: { action: actionOutcome, verification },
      });
    }
    return { action: actionOutcome, verification };
  }

  /** Close the bound session, then the owning runtime/client handle. */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    let failure;
    if (this.#ownsSession && typeof this.#driver?.endSession === "function") {
      try {
        await this.#driver.endSession({ session: this.#publicSession });
      } catch (error) {
        failure = error;
      }
    }
    if (this.#ownsSession) {
      try {
        await destroySessionHandle(this.#driver);
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

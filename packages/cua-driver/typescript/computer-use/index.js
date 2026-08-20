/**
 * @qwen-code/computer-use — thin Computer Use wrapper over the typed
 * `@trycua/cua-driver` TypeScript SDK.
 *
 * An ordinary Node.js program imports this package directly; nothing here
 * depends on Qwen Code, a Node REPL, or a Skill. The wrapper:
 *
 * - connects through the public SDK runtime (same-process embedded runtime or
 *   the installed daemon) without exposing raw `CuaDriver` constructors or an
 *   arbitrary `callTool` surface;
 * - observes exact windows through `accessibility.observation_revision.v1`:
 *   the caller owns the base-revision state and passes `baseRevisionId`
 *   explicitly on the next observation — the wrapper never guesses which
 *   revision was delivered downstream and never computes its own diff;
 * - dispatches actions against the opaque element tokens the driver returned.
 *
 * Support for the versioned revision protocol is discovered from the driver's
 * advertised tool capabilities. Drivers without the capability keep the legacy
 * full-snapshot behavior and observations report `revisionSupported: false`.
 */
const OBSERVATION_REVISION_CAPABILITY = "accessibility.observation_revision.v1";

/**
 * The SDK (and its native library) is loaded lazily so that importing this
 * module stays side-effect free; only `create` / `connect` touch the driver.
 */
async function loadCuaDriver() {
  const sdk = await import("@trycua/cua-driver");
  return sdk.CuaDriver;
}

export class ComputerUseError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, details?: unknown }} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "ComputerUseError";
    this.code = info.code;
    this.details = info.details;
  }
}

/**
 * Parse one SDK `ToolResult`, throwing a `ComputerUseError` for refusals and
 * failures and returning `{ text, structured, images }` for successes.
 */
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
  if (!Number.isInteger(value) || value <= 0) {
    throw new ComputerUseError(`${name} must be a positive integer`);
  }
  return value;
}

/** Build the exact-target argument pair shared by every window action. */
function windowTargetArgs({ pid, windowId }) {
  const args = { pid: requirePositiveInteger("pid", pid) };
  if (windowId !== undefined) {
    args.window_id = requirePositiveInteger("windowId", windowId);
  }
  return args;
}

export class ComputerUse {
  #driver;
  #session;
  #closed = false;
  /** @type {boolean | undefined} */
  #revisionSupport;

  /**
   * Internal. Use {@link ComputerUse.create} or {@link ComputerUse.connect}.
   * The `driver` handle is accepted here so tests can substitute a fake; the
   * raw SDK type is intentionally not re-exported.
   */
  constructor(driver, { session } = {}) {
    if (!driver || typeof driver.callTool !== "function") {
      throw new ComputerUseError("ComputerUse requires a driver handle");
    }
    this.#driver = driver;
    this.#session = session;
  }

  /**
   * Same-process driver runtime. Never launches or contacts a daemon. On
   * macOS the observing process itself needs the Accessibility / Screen
   * Recording grants.
   *
   * @param {{ session?: string }} [options]
   */
  static async create(options = {}) {
    const CuaDriver = await loadCuaDriver();
    return new ComputerUse(CuaDriver.create(undefined), options);
  }

  /**
   * Connect to an already-running cua-driver daemon. With no `socketPath`
   * this resolves the installed `qwen-cua-driver` socket.
   *
   * @param {{ socketPath?: string, session?: string }} [options]
   */
  static async connect(options = {}) {
    const CuaDriver = await loadCuaDriver();
    return new ComputerUse(CuaDriver.connect(options.socketPath), options);
  }

  #requireOpen() {
    if (this.#closed) {
      throw new ComputerUseError("ComputerUse instance is closed");
    }
  }

  async #call(tool, args) {
    this.#requireOpen();
    const merged = { ...args };
    if (this.#session !== undefined && merged.session === undefined) {
      merged.session = this.#session;
    }
    const result = await this.#driver.callTool(tool, JSON.stringify(merged));
    return unwrapToolResult(tool, result);
  }

  /**
   * Whether the connected driver advertises
   * `accessibility.observation_revision.v1` on `get_window_state`.
   */
  async supportsObservationRevision() {
    this.#requireOpen();
    if (this.#revisionSupport === undefined) {
      let advertised = false;
      if (typeof this.#driver.listToolsJson === "function") {
        try {
          const listing = JSON.parse(await this.#driver.listToolsJson());
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

  /** Running applications, as reported by the driver. */
  async listApps() {
    const { structured } = await this.#call("list_apps", {});
    return structured?.apps ?? structured ?? [];
  }

  /**
   * Top-level windows, optionally filtered to one process.
   *
   * @param {{ pid?: number }} [options]
   */
  async listWindows({ pid } = {}) {
    const args = pid === undefined ? {} : { pid: requirePositiveInteger("pid", pid) };
    const { structured } = await this.#call("list_windows", args);
    return structured?.windows ?? structured ?? [];
  }

  /**
   * Observe one exact window.
   *
   * When the driver supports the versioned revision protocol the observation
   * is requested as `accessibility.observation_revision.v1`; pass the
   * `revisionId` this method returned — once its text has actually been
   * consumed downstream — as `baseRevisionId` on the next call to receive a
   * validated `diff` / `no_change` response instead of a full tree.
   *
   * @param {{
   *   pid: number,
   *   windowId: number,
   *   baseRevisionId?: string,
   *   forceFull?: boolean,
   *   includeScreenshot?: boolean,
   *   screenshotOutFile?: string,
   *   maxElements?: number,
   *   maxDepth?: number,
   * }} options
   */
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
    const args = {
      ...windowTargetArgs({ pid, windowId }),
      include_screenshot: includeScreenshot,
    };
    if (screenshotOutFile !== undefined) args.screenshot_out_file = screenshotOutFile;
    if (maxElements !== undefined) {
      args.max_elements = requirePositiveInteger("maxElements", maxElements);
    }
    if (maxDepth !== undefined) {
      args.max_depth = requirePositiveInteger("maxDepth", maxDepth);
    }
    const revisionSupported = await this.supportsObservationRevision();
    if (revisionSupported) {
      args.observation_revision = { version: 1 };
      if (baseRevisionId !== undefined) {
        args.observation_revision.base_revision_id = baseRevisionId;
      }
      if (forceFull !== undefined) args.observation_revision.force_full = forceFull;
    }
    const { text, structured, images } = await this.#call("get_window_state", args);
    const envelope = structured?.observation_revision;
    return {
      pid,
      windowId,
      revisionSupported: Boolean(envelope),
      mode: envelope?.mode ?? "full",
      revisionId: envelope?.revision_id,
      lineageId: envelope?.lineage_id,
      baseRevisionId: envelope?.base_revision_id ?? undefined,
      resyncReason: envelope?.resync_reason ?? undefined,
      stableElementIds: envelope?.stable_element_ids === true,
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

  /**
   * Verify an expected UI state (element / window predicates) instead of
   * re-reading and re-parsing a full observation.
   */
  async verifyState(args) {
    const { structured } = await this.#call("verify_state", args ?? {});
    return structured;
  }

  async #elementAction(tool, options, extra = {}) {
    const { pid, windowId, elementToken, x, y } = options ?? {};
    const args = { ...windowTargetArgs({ pid, windowId }), ...extra };
    if (elementToken !== undefined) {
      if (typeof elementToken !== "string" || elementToken === "") {
        throw new ComputerUseError("elementToken must be a non-empty string");
      }
      args.element_token = elementToken;
    }
    if (x !== undefined) args.x = x;
    if (y !== undefined) args.y = y;
    const { text, structured } = await this.#call(tool, args);
    return structured ?? { text };
  }

  /** Click an element token (preferred) or window-local pixel point. */
  async click(options) {
    const { button, count } = options ?? {};
    const extra = {};
    if (button !== undefined) extra.button = button;
    if (count !== undefined) extra.count = count;
    return this.#elementAction("click", options, extra);
  }

  async doubleClick(options) {
    return this.#elementAction("double_click", options);
  }

  async rightClick(options) {
    return this.#elementAction("right_click", options);
  }

  /**
   * Press-drag-release between two window-local points.
   *
   * @param {{
   *   pid: number, windowId?: number,
   *   fromX: number, fromY: number, toX: number, toY: number,
   *   durationMs?: number, steps?: number, button?: string, modifier?: string[],
   * }} options
   */
  async drag(options) {
    const { pid, windowId, fromX, fromY, toX, toY, durationMs, steps, button, modifier } =
      options ?? {};
    const args = {
      ...windowTargetArgs({ pid, windowId }),
      from_x: fromX,
      from_y: fromY,
      to_x: toX,
      to_y: toY,
    };
    if (durationMs !== undefined) args.duration_ms = durationMs;
    if (steps !== undefined) args.steps = steps;
    if (button !== undefined) args.button = button;
    if (modifier !== undefined) args.modifier = modifier;
    const { structured, text } = await this.#call("drag", args);
    return structured ?? { text };
  }

  /**
   * @param {{
   *   pid: number, windowId?: number, elementToken?: string,
   *   direction: string, amount?: number, by?: string,
   * }} options
   */
  async scroll(options) {
    const { direction, amount, by } = options ?? {};
    if (typeof direction !== "string" || direction === "") {
      throw new ComputerUseError("direction is required");
    }
    const extra = { direction };
    if (amount !== undefined) extra.amount = amount;
    if (by !== undefined) extra.by = by;
    return this.#elementAction("scroll", options, extra);
  }

  /** Set a control's value through the platform accessibility API. */
  async setValue(options) {
    const { value } = options ?? {};
    if (typeof value !== "string") {
      throw new ComputerUseError("value must be a string");
    }
    return this.#elementAction("set_value", options, { value });
  }

  /** Insert text, optionally into one exact element. */
  async typeText(options) {
    const { text, delayMs } = options ?? {};
    if (typeof text !== "string") {
      throw new ComputerUseError("text must be a string");
    }
    const extra = { text };
    if (delayMs !== undefined) extra.delay_ms = delayMs;
    return this.#elementAction("type_text", options, extra);
  }

  /** Press and release a single key, optionally with modifiers. */
  async pressKey(options) {
    const { key, modifiers } = options ?? {};
    if (typeof key !== "string" || key === "") {
      throw new ComputerUseError("key is required");
    }
    const extra = { key };
    if (modifiers !== undefined) extra.modifiers = modifiers;
    return this.#elementAction("press_key", options, extra);
  }

  /** Press a modifier combination, e.g. `["cmd", "c"]`. */
  async hotkey(options) {
    const { keys } = options ?? {};
    if (!Array.isArray(keys) || keys.length < 2) {
      throw new ComputerUseError("keys must list modifiers plus one key");
    }
    return this.#elementAction("hotkey", options, { keys });
  }

  /**
   * Release the underlying driver handle. Idempotent; daemon-compatibility
   * connections do not stop the shared daemon.
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (typeof this.#driver.shutdown === "function") {
      await this.#driver.shutdown();
    }
  }
}

import type {
  ActionResult as NativeActionResult,
  SessionOutput as NativeSessionOutput,
  VerifyStateOutput as NativeVerifyStateOutput,
} from "../dist/index.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ComputerUseOptions {
  session?: string;
  /** Opt into a finite session lifetime. Omit both TTL fields for owner-lifetime persistence. */
  sessionTtlSeconds?: number;
  /** Opt into a finite idle lifetime. Omit both TTL fields for owner-lifetime persistence. */
  idleTtlSeconds?: number;
  signal?: AbortSignal;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface DeliveryOptions {
  deliveryMode?: "background" | "foreground";
}

export interface ComputerUseConnectOptions extends ComputerUseOptions {
  socketPath?: string;
}

export interface WindowRef {
  pid: number;
  windowId: number;
}

export interface ElementRef {
  pid: number;
  elementToken: string;
  windowId?: number;
  x?: never;
  y?: never;
}

export interface CoordinateRef extends WindowRef {
  x: number;
  y: number;
  elementToken?: never;
}

export type PointOrElementRef = CoordinateRef | ElementRef;
export type ExactActionRef = (WindowRef & { elementToken?: never }) | ElementRef;

export interface ComputerUseElement {
  [key: string]: unknown;
  element_index?: number;
  element_id?: number;
  element_token?: string;
  role?: string;
  label?: string;
  value?: JsonValue;
  enabled?: boolean;
  actions?: string[];
  selected?: boolean;
}

export interface ComputerUseScreenshot {
  width?: number;
  height?: number;
  mimeType?: string;
  filePath?: string;
  images: unknown[];
}

export interface ObserveWindowOptions extends WindowRef, CallOptions {
  baseRevisionId?: string;
  forceFull?: boolean;
  includeScreenshot?: boolean;
  screenshotOutFile?: string;
  maxElements?: number;
  maxDepth?: number;
}

export interface WindowObservation {
  pid: number;
  windowId: number;
  revisionSupported: boolean;
  mode: "full" | "diff" | "no_change";
  revisionId?: string;
  lineageId?: string;
  baseRevisionId?: string;
  serializerVersion?: string;
  projectionVersion?: string;
  resyncReason?: string;
  stableElementIds: boolean;
  selectedBytes?: number;
  fullBytes?: number;
  estimatedTokens?: number;
  serializerDurationUs?: number;
  cacheEstimateBytes?: number;
  text: string;
  elements: ComputerUseElement[];
  screenshot?: ComputerUseScreenshot;
  structured?: JsonObject;
}

export interface VerifyStateOptions extends WindowRef, CallOptions {
  expect: JsonObject[];
  timeoutMs?: number;
  stableSamples?: number;
  includeScreenshot?: boolean;
}

export type ClickOptions = PointOrElementRef &
  CallOptions &
  DeliveryOptions & {
    button?: "left" | "right" | "middle";
    count?: number;
  };

export type RightClickOptions = PointOrElementRef &
  CallOptions &
  DeliveryOptions & {
    modifier?: string[];
  };

export interface DragOptions extends WindowRef, CallOptions, DeliveryOptions {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number;
  steps?: number;
  button?: "left" | "right" | "middle";
  modifier?: string[];
}

export type ScrollOptions = PointOrElementRef &
  CallOptions &
  DeliveryOptions & {
    direction: "up" | "down" | "left" | "right";
    by?: "line" | "page";
    amount?: number;
  };

export interface ElementValueOptions extends ElementRef, CallOptions {
  value: string;
}

export type TextOptions = ExactActionRef &
  CallOptions &
  DeliveryOptions & {
    text: string;
    delayMs?: number;
  };

export type KeyOptions = ExactActionRef &
  CallOptions &
  DeliveryOptions & {
    key: string;
    modifiers?: string[];
  };

export type HotkeyOptions = ExactActionRef &
  CallOptions &
  DeliveryOptions & {
    keys: string[];
  };

export interface SecondaryActionOptions extends ElementRef, CallOptions {
  action: string;
}

export type ActionEffect = "confirmed" | "partial" | "unverifiable" | "suspected_noop" | "refused";
export type ActionRoute =
  | "accessibility"
  | "synthetic_events"
  | "global_input"
  | "system_api"
  | "dom"
  | "trusted_input";

export interface ComputerUseOperationResult {
  id: string;
  state: "accepted" | "dispatched" | "committed" | "completed";
  dispatched: boolean;
  committed: boolean;
  cancellationRequested: boolean;
}

export interface ComputerUseActionResult {
  effect: ActionEffect;
  route: ActionRoute;
  delivery?: {
    mode: "background" | "foreground" | "not_applicable" | "unknown";
    delivered_count?: number;
  };
  evidence?: Array<{ kind: "value_readback" | "window_change" }>;
  escalation?: {
    target: "pixel" | "foreground" | "page" | "session";
    reason:
      | "route_unavailable"
      | "delivery_failed"
      | "effect_unconfirmed"
      | "suspected_noop"
      | "permission_required";
  };
  /** Terminal lifecycle evidence for the one native action dispatch. */
  operation: ComputerUseOperationResult;
  /** The generated UniFFI record returned alongside the JSON projection. */
  action?: NativeActionResult;
}

export type VerificationStatus = "satisfied" | "unsatisfied" | "unknown";
export interface ComputerUseVerificationResult {
  status: VerificationStatus;
  stable: boolean;
  elapsed_ms: number;
  samples: number;
  predicates: Array<{
    index: number;
    status: VerificationStatus;
    unknown_reason?:
      | "invalid_predicate"
      | "unsupported_predicate"
      | "untrusted_source"
      | "multi_match"
      | "target_missing"
      | "observation_unavailable"
      | "stability_unproven"
      | null;
    observed_json?: string | null;
  }>;
  /** The generated UniFFI record returned alongside the JSON projection. */
  verification?: NativeVerifyStateOutput;
}

export interface ActAndVerifyOptions {
  action: () => Promise<ComputerUseActionResult>;
  verify: (action: ComputerUseActionResult) => Promise<ComputerUseVerificationResult>;
}

export interface ActAndVerifyResult {
  action: ComputerUseActionResult;
  verification: ComputerUseVerificationResult;
}

export class ComputerUseError extends Error {
  readonly code?: string;
  readonly details?: unknown;
}

export class ComputerUse {
  private constructor();

  static create(options?: ComputerUseOptions): Promise<ComputerUse>;
  static connect(options?: ComputerUseConnectOptions): Promise<ComputerUse>;

  readonly connectionGeneration: number;

  supportsObservationRevision(): Promise<boolean>;
  sessionInfo(options?: CallOptions): Promise<NativeSessionOutput>;
  reconnect(options?: CallOptions): Promise<{
    connectionGeneration: number;
    operation?: ComputerUseOperationResult;
  }>;
  listApps(options?: CallOptions): Promise<JsonObject[]>;
  listWindows(
    options?: CallOptions & {
      pid?: number;
      onScreenOnly?: boolean;
    },
  ): Promise<JsonObject[]>;
  getWindow(options: WindowRef & CallOptions): Promise<JsonObject>;
  observeWindow(options: ObserveWindowOptions): Promise<WindowObservation>;
  verifyState(options: VerifyStateOptions): Promise<ComputerUseVerificationResult>;
  click(options: ClickOptions): Promise<ComputerUseActionResult>;
  doubleClick(
    options: PointOrElementRef & CallOptions & DeliveryOptions,
  ): Promise<ComputerUseActionResult>;
  rightClick(options: RightClickOptions): Promise<ComputerUseActionResult>;
  drag(options: DragOptions): Promise<ComputerUseActionResult>;
  scroll(options: ScrollOptions): Promise<ComputerUseActionResult>;
  setValue(options: ElementValueOptions): Promise<ComputerUseActionResult>;
  typeText(options: TextOptions): Promise<ComputerUseActionResult>;
  pressKey(options: KeyOptions): Promise<ComputerUseActionResult>;
  hotkey(options: HotkeyOptions): Promise<ComputerUseActionResult>;
  performSecondaryAction(options: SecondaryActionOptions): Promise<ComputerUseActionResult>;
  actAndVerify(options: ActAndVerifyOptions): Promise<ActAndVerifyResult>;
  close(): Promise<void>;
}

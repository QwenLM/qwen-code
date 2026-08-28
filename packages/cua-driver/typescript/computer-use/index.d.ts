export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export interface ComputerUseOptions {
  session?: string;
  sessionTtlSeconds?: number;
  idleTtlSeconds?: number;
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
export type ExactActionRef =
  | (WindowRef & { elementToken?: never })
  | ElementRef;

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

export interface ObserveWindowOptions extends WindowRef {
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

export interface VerifyStateOptions extends WindowRef {
  expect: JsonObject[];
  timeoutMs?: number;
  stableSamples?: number;
  includeScreenshot?: boolean;
}

export type ClickOptions = PointOrElementRef & {
  button?: "left" | "right" | "middle";
  count?: number;
};

export type RightClickOptions = PointOrElementRef & {
  modifier?: string[];
};

export interface DragOptions extends WindowRef {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  durationMs?: number;
  steps?: number;
  deliveryMode?: "background" | "foreground";
  button?: "left" | "right" | "middle";
  modifier?: string[];
}

export type ScrollOptions = PointOrElementRef & {
  direction: "up" | "down" | "left" | "right";
  by?: "line" | "page";
  amount?: number;
};

export interface ElementValueOptions extends ElementRef {
  value: string;
}

export type TextOptions = ExactActionRef & {
  text: string;
  delayMs?: number;
};

export type KeyOptions = ExactActionRef & {
  key: string;
  modifiers?: string[];
};

export type HotkeyOptions = ExactActionRef & {
  keys: string[];
};

export interface SecondaryActionOptions extends ElementRef {
  action: string;
}

export class ComputerUseError extends Error {
  readonly code?: string;
  readonly details?: unknown;
}

export class ComputerUse {
  private constructor();

  static create(options?: ComputerUseOptions): Promise<ComputerUse>;
  static connect(options?: ComputerUseConnectOptions): Promise<ComputerUse>;

  supportsObservationRevision(): Promise<boolean>;
  listApps(): Promise<JsonObject[]>;
  listWindows(options?: {
    pid?: number;
    onScreenOnly?: boolean;
  }): Promise<JsonObject[]>;
  getWindow(options: WindowRef): Promise<JsonObject>;
  observeWindow(options: ObserveWindowOptions): Promise<WindowObservation>;
  verifyState(options: VerifyStateOptions): Promise<JsonObject | undefined>;
  click(options: ClickOptions): Promise<JsonObject>;
  doubleClick(options: PointOrElementRef): Promise<JsonObject>;
  rightClick(options: RightClickOptions): Promise<JsonObject>;
  drag(options: DragOptions): Promise<JsonObject>;
  scroll(options: ScrollOptions): Promise<JsonObject>;
  setValue(options: ElementValueOptions): Promise<JsonObject>;
  typeText(options: TextOptions): Promise<JsonObject>;
  pressKey(options: KeyOptions): Promise<JsonObject>;
  hotkey(options: HotkeyOptions): Promise<JsonObject>;
  performSecondaryAction(options: SecondaryActionOptions): Promise<JsonObject>;
  close(): Promise<void>;
}

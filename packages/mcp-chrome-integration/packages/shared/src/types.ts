export enum NativeMessageType {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  PROCESS_DATA = 'process_data',
  PROCESS_DATA_RESPONSE = 'process_data_response',
  CALL_TOOL = 'call_tool',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  // Additional message types used in Chrome extension
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  CONNECT_NATIVE = 'connectNative',
  ENSURE_NATIVE = 'ensure_native',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
}

export interface NativeMessage<P = any, E = any> {
  type?: NativeMessageType;
  responseToRequestId?: string;
  payload?: P;
  error?: E;
}

// ============================================================
// Element Picker Types (chrome_request_element_selection)
// ============================================================

/**
 * A single element selection request from the AI.
 */
export interface ElementPickerRequest {
  /**
   * Optional stable request id. If omitted, the extension will generate one.
   */
  id?: string;
  /**
   * Short label shown to the user (e.g., "Login button").
   */
  name: string;
  /**
   * Optional longer instruction shown to the user.
   */
  description?: string;
}

/**
 * Bounding rectangle of a picked element.
 */
export interface PickedElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Center point of a picked element.
 */
export interface PickedElementPoint {
  x: number;
  y: number;
}

/**
 * A picked element that can be used with other tools (click, fill, etc.).
 */
export interface PickedElement {
  /**
   * Element ref written into window.__claudeElementMap (frame-local).
   * Can be used directly with chrome_click_element, chrome_fill_or_select, etc.
   */
  ref: string;
  /**
   * Best-effort stable CSS selector.
   */
  selector: string;
  /**
   * Selector type (currently CSS only).
   */
  selectorType: 'css';
  /**
   * Bounding rect in the element's frame viewport coordinates.
   */
  rect: PickedElementRect;
  /**
   * Center point in the element's frame viewport coordinates.
   * Can be used as coordinates for chrome_computer.
   */
  center: PickedElementPoint;
  /**
   * Optional text snippet to help verify the selection.
   */
  text?: string;
  /**
   * Lowercased tag name.
   */
  tagName?: string;
  /**
   * Chrome frameId for iframe targeting.
   * Pass this to chrome_click_element/chrome_fill_or_select for cross-frame support.
   */
  frameId: number;
}

/**
 * Result for a single element selection request.
 */
export interface ElementPickerResultItem {
  /**
   * The request id (matches the input request).
   */
  id: string;
  /**
   * The request name (for reference).
   */
  name: string;
  /**
   * The picked element, or null if not selected.
   */
  element: PickedElement | null;
  /**
   * Error message if selection failed for this request.
   */
  error?: string;
}

/**
 * Result of the chrome_request_element_selection tool.
 */
export interface ElementPickerResult {
  /**
   * True if the user confirmed all selections.
   */
  success: boolean;
  /**
   * Session identifier for this picker session.
   */
  sessionId: string;
  /**
   * Timeout value used for this session.
   */
  timeoutMs: number;
  /**
   * True if the user cancelled the selection.
   */
  cancelled?: boolean;
  /**
   * True if the selection timed out.
   */
  timedOut?: boolean;
  /**
   * List of request IDs that were not selected (for debugging).
   */
  missingRequestIds?: string[];
  /**
   * Results for each requested element.
   */
  results: ElementPickerResultItem[];
}

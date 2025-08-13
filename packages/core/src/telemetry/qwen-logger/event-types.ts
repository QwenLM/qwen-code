// RUM Protocol Data Structures
export interface RumApp {
  id: string;
  env: string;
  version: string;
  type: 'cli' | 'extension';
}

export interface RumUser {
  id: string;
}

export interface RumSession {
  id: string;
}

export interface RumView {
  id: string;
  name: string;
}

export interface RumEvent {
  timestamp?: number;
  event_type?: 'view' | 'action' | 'exception' | 'resource';
  type: string; // Event type
  name: string; // Event name
  snapshots?: string; // JSON string of event snapshots
  properties?: Record<string, unknown>;
  // [key: string]: unknown;
}

export interface RumViewEvent extends RumEvent {
  view_type?: string; // View rendering type
  time_spent?: number; // Time spent on current view in ms
}

export interface RumActionEvent extends RumEvent {
  target_name?: string; // Element user interacted with (for auto-collected actions only)
  duration?: number; // Action duration in ms
  method_info?: string; // Action callback, e.g.: onClick()
}

export interface RumExceptionEvent extends RumEvent {
  source?: string; // Error source, e.g.: console, event
  file?: string; // Error file
  subtype?: string; // Secondary classification of error type
  message?: string; // Concise, readable message explaining the event
  stack?: string; // Stack trace or supplemental information about the error
  caused_by?: string; // Exception cause
  line?: number; // Line number where exception occurred
  column?: number; // Column number where exception occurred
  thread_id?: string; // Thread ID
  binary_images?: string; // Error source
}

export interface RumResourceEvent extends RumEvent {
  method?: string; // HTTP request method: POST, GET, etc.
  status_code?: string; // Resource status code
  message?: string; // Error message content, corresponds to resource.error_msg
  url?: string; // Resource URL
  provider_type?: string; // Resource provider type: first-party, cdn, ad, analytics
  trace_id?: string; // Resource request TraceID
  success?: number; // Resource loading success: 1 (default) success, 0 failure
  duration?: number; // Total time spent loading resource in ms (responseEnd - redirectStart)
  size?: number; // Resource size in bytes, corresponds to decodedBodySize
  connect_duration?: number; // Time spent establishing connection to server in ms (connectEnd - connectStart)
  ssl_duration?: number; // Time spent on TLS handshake in ms (connectEnd - secureConnectionStart), 0 if no SSL
  dns_duration?: number; // Time spent resolving DNS name in ms (domainLookupEnd - domainLookupStart)
  redirect_duration?: number; // Time spent on HTTP redirects in ms (redirectEnd - redirectStart)
  first_byte_duration?: number; // Time waiting for first byte of response in ms (responseStart - requestStart)
  download_duration?: number; // Time spent downloading response in ms (responseEnd - responseStart)
  timing_data?: string; // JSON string of PerformanceResourceTiming
  trace_data?: string; // Trace information snapshot JSON string
}

export interface RumPayload {
  app: RumApp;
  user: RumUser;
  session: RumSession;
  view: RumView;
  events: RumEvent[];
  _v: string;
}

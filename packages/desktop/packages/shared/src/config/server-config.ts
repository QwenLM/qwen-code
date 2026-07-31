/**
 * Server mode configuration — controls whether the Electron app
 * accepts remote connections from other machines.
 *
 * When enabled, the app binds to 0.0.0.0 on a fixed port instead of
 * localhost on a random port, allowing thin clients to connect.
 */

export interface ServerConfig {
  /** Whether remote server mode is active (bind 0.0.0.0 vs 127.0.0.1) */
  enabled: boolean
  /** Fixed port to listen on (default 9100) */
  port: number
  /** Path to PEM certificate file (enables TLS / wss://) */
  tlsCertPath?: string
  /** Path to PEM private key file (required when cert is set) */
  tlsKeyPath?: string
  /** Stable auth token for remote clients (auto-generated on first enable) */
  token?: string
}

export interface ServerStatus {
  /** Whether the server is currently running */
  running: boolean
  /** Current bind address */
  host: string
  /** Current port */
  port: number
  /** Whether TLS is active */
  tls: boolean
  /** Full connection URL (ws:// or wss://) */
  url: string
  /** Current auth token */
  token: string
  /** Whether saved config differs from running config (restart needed) */
  needsRestart: boolean
  /** True when server is bound to a network address without TLS */
  insecureWarning: boolean
}

export const DEFAULT_SERVER_CONFIG: ServerConfig = {
  enabled: false,
  port: 9100,
}

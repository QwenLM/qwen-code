/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opt-in transport surface: `@qwen-code/sdk/daemon/transports`.
 *
 * The default `@qwen-code/sdk/daemon` barrel deliberately ships only the
 * `DaemonTransport` interface and the lightweight `RestSseTransport` *type*
 * so its browser bundle stays under budget (see `scripts/build.js`
 * `MAX_DAEMON_BROWSER_BUNDLE_BYTES`). The concrete ACP transports —
 * `AcpHttpTransport` (native `supportsReplay` + `Last-Event-ID` resume),
 * `AcpWsTransport`, the `AutoReconnectTransport` wrapper, and the
 * `negotiateTransport` factory — pull in their own framing/SSE code, so
 * they live behind this separate subpath. Consumers that only need REST
 * never pay for them; consumers that want resumable ACP-over-HTTP opt in
 * with one import:
 *
 * ```ts
 * import {
 *   negotiateTransport,
 *   AcpHttpTransport,
 * } from '@qwen-code/sdk/daemon/transports';
 *
 * const transport = await negotiateTransport(baseUrl, token);
 * const client = new DaemonClient({ baseUrl, token, transport });
 * ```
 */

export { AcpHttpTransport } from './AcpHttpTransport.js';
export { AcpWsTransport } from './AcpWsTransport.js';
export {
  AutoReconnectTransport,
  type TransportFactory,
} from './AutoReconnectTransport.js';
export { RestSseTransport } from './RestSseTransport.js';
export {
  negotiateTransport,
  type NegotiateTransportOptions,
} from './negotiateTransport.js';

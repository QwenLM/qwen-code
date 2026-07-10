/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import { RC_PROTOCOL_VERSION } from '../mdns/advert.js';

/**
 * Version-check middleware: reads the `X-RC-Version` request header. If the
 * header is absent the request passes through unchanged. If it is present and
 * does not match {@link RC_PROTOCOL_VERSION}, the middleware short-circuits
 * with `426 Upgrade Required` and a JSON body of the form:
 *
 * ```json
 * { "error": "upgrade_required", "supportedVersions": [<version>] }
 * ```
 *
 * Mount this after auth so authenticated callers receive the upgrade signal
 * rather than a generic 401, but the pairing/public routes that run before
 * the global bearer middleware are unaffected.
 */
export const versionCheckMiddleware: RequestHandler = (req, res, next) => {
  const header = req.headers['x-rc-version'];
  if (header === undefined) {
    next();
    return;
  }
  // Parse as a number; an unparseable header (NaN) will never equal the int
  // version constant and will correctly yield 426.
  const requested = Number(header);
  if (requested === RC_PROTOCOL_VERSION) {
    next();
    return;
  }
  res.status(426).json({
    error: 'upgrade_required',
    supportedVersions: [RC_PROTOCOL_VERSION],
  });
};

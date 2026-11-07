/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  describeModsToolMiddleware,
  terminalCases,
} from './mods-tool-middleware.suite.js';

describeModsToolMiddleware(terminalCases.slice(0, 9));

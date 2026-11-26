/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CustomRequest } from '../../request/customRequest.js';
import type { CustomResponse } from '../../response/customResponse.js';
import type { ProxyInstance } from '../../proxy/proxyInstance.js';
import { BaseValve } from './valve.js';

/**
 * Selects and applies a proxy route before passing the input to the next stage.
 *
 * The instance is never constructed here: the composition root owns it and
 * passes the same one to every pipeline it assembles. `undefined` means this
 * pipeline leaves routing to the process-wide fetch default.
 *
 * ProxyInstance resolves process-level configuration; origin is used only for
 * target-specific bypass evaluation.
 */
export class ProxyValve extends BaseValve {
  constructor(private readonly proxyInstance: ProxyInstance | undefined) {
    super();
  }

  async invoke(input: CustomRequest, output: CustomResponse): Promise<void> {
    const origin = input.origin;
    const proxyUrl = this.proxyInstance?.resolve();
    if (
      origin !== undefined &&
      proxyUrl !== undefined &&
      !this.proxyInstance?.bypass(origin)
    ) {
      input.setProxy(proxyUrl);
    }
    await this.getNext()!.invoke(input, output);
  }
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { afterAll } from 'vitest';

// Teardown witness for the QWEN_HOME pin created in test-setup.ts. This file
// is listed BEFORE test-setup.ts in setupFiles, and vitest runs root-level
// afterAll hooks in reverse registration order (measured on this repo's
// vitest), so this hook is the last teardown of every test file and observes
// the pin after every other hook ran. A teardown sweep of the live pin —
// reintroduced anywhere in test-setup.ts — turns every file red here: the
// pin must outlive the process because un-awaited extension-store work can
// still be reading it when the hooks run (the required ubuntu check went red
// on ENOENT in extension-store/transactions). A test-file afterAll cannot
// witness this: it runs BEFORE the setup file's root afterAll.
//
// No static import of test-setup.ts: it would evaluate that module from this
// file and register its hooks before this one, inverting the order.
afterAll(async () => {
  const { suiteQwenHome } = await import('./test-setup.js');
  if (!fs.existsSync(suiteQwenHome)) {
    throw new Error(
      `QWEN_HOME pin ${suiteQwenHome} was deleted during the test file run; ` +
        'the pin must stay alive for the process lifetime (see test-setup.ts).',
    );
  }
});

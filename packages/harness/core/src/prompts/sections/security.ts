/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PromptSectionDescriptor } from '../types.js';

const SECURITY_AUTHORIZED_USE = `IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`;

export const SECURITY_SECTIONS: readonly PromptSectionDescriptor[] = [
  {
    id: 'security.authorized_use',
    version: 1,
    systemBlock: 'stable',
    order: 30,
    mandatory: true,
    render: () => SECURITY_AUTHORIZED_USE,
  },
];

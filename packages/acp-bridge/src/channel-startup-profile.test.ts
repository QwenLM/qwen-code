/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  CHANNEL_STARTUP_PROFILE_META_KEY,
  type ChannelStartupProfileV1,
} from './bridgeTypes.js';
import {
  formatChannelStartupProfileLine,
  getChannelStartupProfileAttributes,
} from './channel-startup-profile.js';

function makeProfile(): ChannelStartupProfileV1 {
  return {
    v: 1,
    complete: true,
    responseBuiltAtEpochMs: 1_000,
    processToResponseMs: 900,
    phases: {
      processToProfilerReadyMs: 100,
      geminiImportMs: 200,
      argsParseMs: 10,
      settingsLoadMs: 20,
      configConstructionMs: 30,
      appInitializationMs: 40,
      acpImportMs: 50,
      bootstrapConfigInitializationMs: 300,
      transportSetupMs: 10,
      initializeHandlerMs: 1,
      unattributedMs: 139,
    },
    config: {
      extensionsInitialMs: 20,
      hooksMs: 30,
      skillsMs: 40,
      extensionsFinalMs: 20,
      hierarchicalMemoryMs: 30,
      toolRegistryMs: 80,
      ripgrepProbeMs: 50,
      toolWarmupMs: 20,
      otherMs: 60,
    },
  };
}

function makeResponse(profile: unknown): Record<string, unknown> {
  return {
    _meta: {
      [CHANNEL_STARTUP_PROFILE_META_KEY]: profile,
    },
  };
}

describe('channel startup profile parsing', () => {
  it('maps a valid profile to fixed span attributes', () => {
    const attributes = getChannelStartupProfileAttributes(
      makeResponse(makeProfile()),
      1_007,
      10_000,
    );

    expect(attributes).toMatchObject({
      'qwen-code.daemon.acp_startup.profile.version': 1,
      'qwen-code.daemon.acp_startup.profile.complete': true,
      'qwen-code.daemon.acp_startup.child.process_to_response_ms': 900,
      'qwen-code.daemon.acp_startup.child.unattributed_ms': 139,
      'qwen-code.daemon.acp_startup.phase.gemini_import_ms': 200,
      'qwen-code.daemon.acp_startup.config.ripgrep_probe_ms': 50,
      'qwen-code.daemon.acp_startup.response_transport_ms': 7,
    });
  });

  it('ignores missing and unsupported profiles', () => {
    expect(
      getChannelStartupProfileAttributes({}, 1_000, 10_000),
    ).toBeUndefined();
    expect(
      getChannelStartupProfileAttributes(
        makeResponse({ ...makeProfile(), v: 2 }),
        1_000,
        10_000,
      ),
    ).toBeUndefined();
  });

  it('omits invalid values and marks a partial profile incomplete', () => {
    const profile = makeProfile();
    profile.phases.geminiImportMs = Number.NaN;
    profile.phases.argsParseMs = Number.POSITIVE_INFINITY;
    profile.config.toolRegistryMs = -1;
    profile.config.toolWarmupMs = 600_001;

    const attributes = getChannelStartupProfileAttributes(
      makeResponse({ ...profile, extra: 'ignored' }),
      1_007,
      10_000,
    );

    expect(attributes?.['qwen-code.daemon.acp_startup.profile.complete']).toBe(
      false,
    );
    expect(attributes).not.toHaveProperty(
      'qwen-code.daemon.acp_startup.phase.gemini_import_ms',
    );
    expect(attributes).not.toHaveProperty(
      'qwen-code.daemon.acp_startup.phase.args_parse_ms',
    );
    expect(attributes).not.toHaveProperty(
      'qwen-code.daemon.acp_startup.config.tool_registry_ms',
    );
    expect(attributes).not.toHaveProperty(
      'qwen-code.daemon.acp_startup.config.tool_warmup_ms',
    );
  });

  it('omits an invalid cross-process transport estimate', () => {
    const profile = makeProfile();
    profile.responseBuiltAtEpochMs = 2_000;

    const attributes = getChannelStartupProfileAttributes(
      makeResponse(profile),
      1_000,
      10_000,
    );

    expect(attributes).not.toHaveProperty(
      'qwen-code.daemon.acp_startup.response_transport_ms',
    );
  });
});

describe('channel startup profile line', () => {
  it('renders the total and per-phase durations in one grep-able line', () => {
    // The timeout line says a startup exceeded its budget; only this line can
    // say which phase spent it.
    const line = formatChannelStartupProfileLine(
      makeResponse(makeProfile()),
      1_007,
      10_000,
      1_234,
    );

    expect(line).toContain('channel startup');
    expect(line).toContain('total_ms=1234');
    expect(line).toContain('profile_complete=true');
    expect(line).toContain('phase.settings_load_ms=20');
    expect(line).toContain('config.tool_warmup_ms=20');
    expect(line).toContain('response_transport_ms=7');
  });

  it('returns undefined when the child reported no profile', () => {
    expect(
      formatChannelStartupProfileLine({ _meta: {} }, 1_007, 10_000, 1_234),
    ).toBeUndefined();
  });

  it('marks a truncated profile incomplete instead of claiming completeness', () => {
    const partial = {
      ...makeProfile(),
      phases: { processToProfilerReadyMs: 100 },
    };

    const line = formatChannelStartupProfileLine(
      makeResponse(partial),
      1_007,
      10_000,
      1_234,
    );

    expect(line).toContain('profile_complete=false');
    expect(line).toContain('phase.process_to_profiler_ready_ms=100');
  });
});

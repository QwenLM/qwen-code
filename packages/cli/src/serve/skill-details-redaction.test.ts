// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@qwen-code/acp-bridge/eventBus';
import {
  omitSkillDetailsForSdkSurface,
  omitSkillDetailsFromReplayArrays,
} from './skill-details-redaction.js';

interface CommandsData {
  sessionUpdate: string;
  availableCommands: Array<{ name: string; description: string }>;
  _meta?: Record<string, unknown>;
}
interface WrappedEvent extends BridgeEvent {
  data: { sessionId: string; update: CommandsData };
}
interface FlatEvent extends BridgeEvent {
  data: CommandsData;
}

function wrappedCommandsEvent(): WrappedEvent {
  return {
    id: 1,
    v: 1,
    type: 'session_update',
    data: {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'help', description: 'Help' }],
        _meta: {
          availableSkills: ['bugfix'],
          availableSkillDetails: [{ name: 'bugfix', body: 'skill body' }],
          other: 'kept',
        },
      },
    },
  };
}

function flatCommandsEvent(): FlatEvent {
  return {
    id: 2,
    v: 1,
    type: 'session_update',
    data: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'help', description: 'Help' }],
      _meta: {
        availableSkills: ['bugfix'],
        availableSkillDetails: [{ name: 'bugfix', body: 'skill body' }],
      },
    },
  };
}

describe('omitSkillDetailsForSdkSurface', () => {
  it('strips availableSkillDetails from wrapped frames, keeping the rest', () => {
    const shaped = omitSkillDetailsForSdkSurface(wrappedCommandsEvent());
    expect(shaped).toEqual({
      id: 1,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'help', description: 'Help' }],
          _meta: { availableSkills: ['bugfix'], other: 'kept' },
        },
      },
    });
  });

  it('strips availableSkillDetails from flat persisted-transcript frames', () => {
    const shaped = omitSkillDetailsForSdkSurface(flatCommandsEvent());
    expect(shaped).toEqual({
      id: 2,
      v: 1,
      type: 'session_update',
      data: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'help', description: 'Help' }],
        _meta: { availableSkills: ['bugfix'] },
      },
    });
  });

  it('drops _meta entirely when stripping leaves it empty', () => {
    const event = wrappedCommandsEvent();
    event.data.update._meta = {
      availableSkillDetails: [{ name: 'bugfix', body: 'skill body' }],
    };
    const shaped = omitSkillDetailsForSdkSurface(event);
    expect(shaped.data.update).not.toHaveProperty('_meta');
  });

  it('passes through non-available_commands_update events unchanged', () => {
    const event: BridgeEvent = {
      id: 3,
      v: 1,
      type: 'session_update',
      data: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hi' },
        },
      },
    };
    expect(omitSkillDetailsForSdkSurface(event)).toBe(event);
  });

  it('passes through commands frames without availableSkillDetails unchanged', () => {
    const event = wrappedCommandsEvent();
    event.data.update._meta = { availableSkills: ['bugfix'] };
    expect(omitSkillDetailsForSdkSurface(event)).toBe(event);
  });

  it('never mutates the source event', () => {
    const event = wrappedCommandsEvent();
    omitSkillDetailsForSdkSurface(event);
    expect(event.data.update._meta?.['availableSkillDetails']).toEqual([
      { name: 'bugfix', body: 'skill body' },
    ]);
  });
});

describe('omitSkillDetailsFromReplayArrays', () => {
  it('redacts both arrays when both are present', () => {
    const shaped = omitSkillDetailsFromReplayArrays({
      sessionId: 'sess-1',
      compactedReplay: [wrappedCommandsEvent()],
      liveJournal: [flatCommandsEvent()],
    });
    expect(shaped.sessionId).toBe('sess-1');
    expect(shaped.compactedReplay[0].data.update._meta).not.toHaveProperty(
      'availableSkillDetails',
    );
    expect(shaped.liveJournal[0].data._meta).not.toHaveProperty(
      'availableSkillDetails',
    );
  });

  it('redacts a single present array', () => {
    const shaped = omitSkillDetailsFromReplayArrays({
      sessionId: 'sess-1',
      liveJournal: [wrappedCommandsEvent()],
    });
    expect(shaped.liveJournal[0].data.update._meta).toEqual({
      availableSkills: ['bugfix'],
      other: 'kept',
    });
  });

  it('returns its input unchanged when no replay arrays are present', () => {
    const session = {
      sessionId: 'sess-1',
      displayName: 'Branch',
      compactedReplay: undefined,
    };
    expect(omitSkillDetailsFromReplayArrays(session)).toBe(session);
  });
});

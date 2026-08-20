/**
 * Tests for SessionLifecycleManager
 *
 * Tests the session state tracking and abort handling
 * used by backend agents.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  SessionLifecycleManager,
  AbortReason,
  createSessionLifecycleManager,
} from '../session-lifecycle.ts';

describe('SessionLifecycleManager', () => {
  let manager: SessionLifecycleManager;

  beforeEach(() => {
    manager = new SessionLifecycleManager({
      sessionId: 'test-session-123',
    });
  });

  describe('Session State', () => {
    it('should initialize with correct default state', () => {
      const state = manager.getState();
      expect(state.sessionId).toBe('test-session-123');
      expect(state.isActive).toBe(true);
      expect(state.messageCount).toBe(0);
      expect(state.hasReceivedContent).toBe(false);
    });

    it('should return the session ID', () => {
      expect(manager.getSessionId()).toBe('test-session-123');
    });

    it('should detect first message', () => {
      expect(manager.isFirstMessage()).toBe(true);
      manager.recordMessageComplete();
      expect(manager.isFirstMessage()).toBe(false);
    });
  });

  describe('Message Tracking', () => {
    it('should track message completion', () => {
      expect(manager.getState().messageCount).toBe(0);
      manager.recordMessageComplete();
      expect(manager.getState().messageCount).toBe(1);
      manager.recordMessageComplete();
      expect(manager.getState().messageCount).toBe(2);
    });

    it('should track content received', () => {
      expect(manager.getState().hasReceivedContent).toBe(false);
      manager.recordContentReceived();
      expect(manager.getState().hasReceivedContent).toBe(true);
    });

    it('should update lastActivityAt on message events', () => {
      const initialState = manager.getState();
      const initialTimestamp = initialState.lastActivityAt;

      // Small delay to ensure timestamp changes
      manager.recordMessageStart();
      expect(manager.getState().lastActivityAt).toBeGreaterThanOrEqual(initialTimestamp);
    });
  });

  describe('Abort Reason Management', () => {
    it('should start with no abort reason', () => {
      expect(manager.getAbortReason()).toBe(null);
    });

    it('should set and get abort reason', () => {
      manager.setAbortReason(AbortReason.UserStop);
      expect(manager.getAbortReason()).toBe(AbortReason.UserStop);
    });

    it('should return previous abort reason when setting new one', () => {
      manager.setAbortReason(AbortReason.UserStop);
      const previous = manager.setAbortReason(AbortReason.PlanSubmitted);
      expect(previous).toBe(AbortReason.UserStop);
    });

    it('should consume and clear abort reason', () => {
      manager.setAbortReason(AbortReason.AuthRequest);
      const consumed = manager.consumeAbortReason();
      expect(consumed).toBe(AbortReason.AuthRequest);
      expect(manager.getAbortReason()).toBe(null);
    });

    it('should detect user abort', () => {
      expect(manager.wasUserAbort()).toBe(false);
      manager.setAbortReason(AbortReason.UserStop);
      expect(manager.wasUserAbort()).toBe(true);
      manager.setAbortReason(AbortReason.PlanSubmitted);
      expect(manager.wasUserAbort()).toBe(false);
    });
  });

  describe('Session Cleanup Logic', () => {
    it('should indicate session should be cleared when aborted before content on first message', () => {
      // First message, no content received
      expect(manager.shouldClearSessionOnAbort()).toBe(true);
    });

    it('should not clear session when content has been received', () => {
      manager.recordContentReceived();
      expect(manager.shouldClearSessionOnAbort()).toBe(false);
    });

    it('should not clear session after first message completes', () => {
      manager.recordMessageComplete();
      expect(manager.shouldClearSessionOnAbort()).toBe(false);
    });
  });

  describe('Session Lifecycle', () => {
    it('should deactivate session', () => {
      expect(manager.getState().isActive).toBe(true);
      manager.deactivate();
      expect(manager.getState().isActive).toBe(false);
    });

    it('should clear abort reason on deactivate', () => {
      manager.setAbortReason(AbortReason.UserStop);
      manager.deactivate();
      expect(manager.getAbortReason()).toBe(null);
    });

    it('should reset session state', () => {
      // Build up some state
      manager.recordMessageComplete();
      manager.recordMessageComplete();
      manager.recordContentReceived();
      manager.setAbortReason(AbortReason.UserStop);

      // Reset
      manager.reset();

      const state = manager.getState();
      expect(state.messageCount).toBe(0);
      expect(state.hasReceivedContent).toBe(false);
      expect(state.isActive).toBe(true);
      expect(manager.getAbortReason()).toBe(null);
    });
  });

  describe('State Change Callbacks', () => {
    it('should call onStateChange when message completes', () => {
      const stateChanges: any[] = [];
      const managerWithCallback = new SessionLifecycleManager({
        sessionId: 'test',
        onStateChange: (state) => stateChanges.push(state),
      });

      managerWithCallback.recordMessageComplete();
      expect(stateChanges.length).toBe(1);
      expect(stateChanges[0].messageCount).toBe(1);
    });

    it('should call onStateChange when content received (first time only)', () => {
      const stateChanges: any[] = [];
      const managerWithCallback = new SessionLifecycleManager({
        sessionId: 'test',
        onStateChange: (state) => stateChanges.push(state),
      });

      managerWithCallback.recordContentReceived();
      expect(stateChanges.length).toBe(1);

      // Second call should not trigger another callback
      managerWithCallback.recordContentReceived();
      expect(stateChanges.length).toBe(1);
    });
  });

  describe('Factory Function', () => {
    it('should create manager via factory function', () => {
      const factoryManager = createSessionLifecycleManager({
        sessionId: 'factory-test',
      });
      expect(factoryManager.getSessionId()).toBe('factory-test');
    });
  });
});

describe('AbortReason enum', () => {
  it('should have expected values', () => {
    expect(AbortReason.UserStop as string).toBe('user_stop');
    expect(AbortReason.PlanSubmitted as string).toBe('plan_submitted');
    expect(AbortReason.AuthRequest as string).toBe('auth_request');
    expect(AbortReason.Redirect as string).toBe('redirect');
    expect(AbortReason.SourceActivated as string).toBe('source_activated');
    expect(AbortReason.Timeout as string).toBe('timeout');
    expect(AbortReason.InternalError as string).toBe('internal_error');
  });
});

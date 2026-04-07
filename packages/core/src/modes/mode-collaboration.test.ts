/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import {
  ModeCollaborationManager,
  type CollaborationSession,
} from './mode-collaboration.js';

describe('ModeCollaborationManager', () => {
  let manager: ModeCollaborationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new ModeCollaborationManager();
  });

  describe('createSession', () => {
    it('should create a session with correct initial state', () => {
      const session = manager.createSession(
        'Feature Implementation',
        'Implement user authentication',
        'user-1',
      );

      expect(session.name).toBe('Feature Implementation');
      expect(session.description).toBe('Implement user authentication');
      expect(session.createdBy).toBe('user-1');
      expect(session.roles).toEqual([]);
      expect(session.communicationLog).toEqual([]);
      expect(session.sharedArtifacts).toEqual([]);
      expect(session.status).toBe('active');
      expect(session.id).toMatch(/^collab-/);
    });

    it('should emit session:created event', () => {
      const listener = vi.fn();
      manager.on('session:created', listener);

      const session = manager.createSession('Test', 'Description', 'user-1');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].id).toBe(session.id);
    });
  });

  describe('addCollaborator', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
    });

    it('should add a collaborator to the session', () => {
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', [
        'Implement auth endpoints',
      ]);

      expect(session.roles).toHaveLength(1);
      const role = session.roles[0];
      expect(role.userId).toBe('user-2');
      expect(role.userName).toBe('Alice');
      expect(role.mode).toBe('developer');
      expect(role.responsibilities).toEqual(['Implement auth endpoints']);
      expect(role.status).toBe('active');
      expect(role.joinedAt).toBeInstanceOf(Date);
    });

    it('should emit collaborator:added event', () => {
      const listener = vi.fn();
      manager.on('collaborator:added', listener);

      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', [
        'Task',
      ]);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(session.id);
      expect(listener.mock.calls[0][1].userId).toBe('user-2');
    });

    it('should throw error for non-existent session', () => {
      expect(() =>
        manager.addCollaborator(
          'nonexistent',
          'user-2',
          'Alice',
          'developer',
          [],
        ),
      ).toThrow('Session not found: nonexistent');
    });

    it('should throw error for duplicate user', () => {
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', []);

      expect(() =>
        manager.addCollaborator(session.id, 'user-2', 'Alice', 'reviewer', []),
      ).toThrow('is already in this session');
    });

    it('should throw error when session is not active', () => {
      manager.completeSession(session.id);

      expect(() =>
        manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', []),
      ).toThrow('Session is not active');
    });
  });

  describe('removeCollaborator', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', []);
    });

    it('should remove a collaborator from the session', () => {
      manager.removeCollaborator(session.id, 'user-2');

      expect(session.roles).toHaveLength(0);
    });

    it('should emit collaborator:removed event', () => {
      const listener = vi.fn();
      manager.on('collaborator:removed', listener);

      manager.removeCollaborator(session.id, 'user-2');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(session.id);
      expect(listener.mock.calls[0][1]).toBe('user-2');
    });

    it('should throw error for non-existent session', () => {
      expect(() => manager.removeCollaborator('nonexistent', 'user-2')).toThrow(
        'Session not found: nonexistent',
      );
    });

    it('should throw error for user not in session', () => {
      expect(() =>
        manager.removeCollaborator(session.id, 'nonexistent-user'),
      ).toThrow('not found in session');
    });
  });

  describe('updateCollaboratorStatus', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', []);
    });

    it('should update collaborator status to away', () => {
      manager.updateCollaboratorStatus(session.id, 'user-2', 'away');

      const role = session.roles.find((r) => r.userId === 'user-2');
      expect(role!.status).toBe('away');
    });

    it('should update collaborator status to offline', () => {
      manager.updateCollaboratorStatus(session.id, 'user-2', 'offline');

      const role = session.roles.find((r) => r.userId === 'user-2');
      expect(role!.status).toBe('offline');
    });

    it('should emit collaborator:status-changed event', () => {
      const listener = vi.fn();
      manager.on('collaborator:status-changed', listener);

      manager.updateCollaboratorStatus(session.id, 'user-2', 'away');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(session.id);
      expect(listener.mock.calls[0][1]).toBe('user-2');
      expect(listener.mock.calls[0][2]).toBe('away');
    });

    it('should throw error for non-existent session', () => {
      expect(() =>
        manager.updateCollaboratorStatus('nonexistent', 'user-2', 'away'),
      ).toThrow('Session not found: nonexistent');
    });

    it('should throw error for user not in session', () => {
      expect(() =>
        manager.updateCollaboratorStatus(session.id, 'nonexistent', 'away'),
      ).toThrow('not found in session');
    });
  });

  describe('logMessage', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
    });

    it('should log a message to the communication log', () => {
      manager.logMessage(
        session.id,
        'user-1',
        'user-2',
        'Ready for review',
        'update',
      );

      expect(session.communicationLog).toHaveLength(1);
      const entry = session.communicationLog[0];
      expect(entry.from).toBe('user-1');
      expect(entry.to).toBe('user-2');
      expect(entry.message).toBe('Ready for review');
      expect(entry.type).toBe('update');
      expect(entry.timestamp).toBeInstanceOf(Date);
    });

    it('should emit message:logged event', () => {
      const listener = vi.fn();
      manager.on('message:logged', listener);

      manager.logMessage(session.id, 'user-1', 'user-2', 'Hello', 'update');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(session.id);
      expect(listener.mock.calls[0][1].from).toBe('user-1');
    });

    it('should log a broadcast message', () => {
      manager.logMessage(session.id, 'user-1', '*', 'Announcement', 'update');

      expect(session.communicationLog[0].to).toBe('*');
    });

    it('should throw error for non-existent session', () => {
      expect(() =>
        manager.logMessage(
          'nonexistent',
          'user-1',
          'user-2',
          'Hello',
          'update',
        ),
      ).toThrow('Session not found: nonexistent');
    });
  });

  describe('handoff', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', []);
      manager.addCollaborator(session.id, 'user-3', 'Bob', 'reviewer', []);
    });

    it('should log a handoff communication entry', () => {
      manager.handoff(
        session.id,
        'user-2',
        'user-3',
        'Auth implementation complete',
      );

      expect(session.communicationLog).toHaveLength(1);
      const entry = session.communicationLog[0];
      expect(entry.from).toBe('user-2');
      expect(entry.to).toBe('user-3');
      expect(entry.message).toBe('Handoff: Auth implementation complete');
      expect(entry.type).toBe('handoff');
    });

    it('should emit handoff:complete event', () => {
      const listener = vi.fn();
      manager.on('handoff:complete', listener);

      manager.handoff(session.id, 'user-2', 'user-3', 'Done');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(session.id);
      expect(listener.mock.calls[0][1]).toBe('user-2');
      expect(listener.mock.calls[0][2]).toBe('user-3');
    });

    it('should throw error for non-existent session', () => {
      expect(() =>
        manager.handoff('nonexistent', 'user-2', 'user-3', 'Done'),
      ).toThrow('Session not found: nonexistent');
    });

    it('should throw error for non-existent sender', () => {
      expect(() =>
        manager.handoff(session.id, 'nonexistent', 'user-3', 'Done'),
      ).toThrow('Sender nonexistent not found in session');
    });

    it('should throw error for non-existent recipient', () => {
      expect(() =>
        manager.handoff(session.id, 'user-2', 'nonexistent', 'Done'),
      ).toThrow('Recipient nonexistent not found in session');
    });
  });

  describe('getSessionStatus', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', []);
      manager.addCollaborator(session.id, 'user-3', 'Bob', 'reviewer', []);
      manager.logMessage(session.id, 'user-2', 'user-3', 'Ready', 'update');
      manager.handoff(session.id, 'user-2', 'user-3', 'Done');
    });

    it('should return session status summary', () => {
      const status = manager.getSessionStatus(session.id);

      expect(status.activeRoles).toBe(2);
      expect(status.totalMessages).toBe(2);
      expect(status.completedHandoffs).toBe(1);
      expect(status.sharedArtifacts).toBe(0);
      expect(status.session).toBe(session);
    });

    it('should throw error for non-existent session', () => {
      expect(() => manager.getSessionStatus('nonexistent')).toThrow(
        'Session not found: nonexistent',
      );
    });
  });

  describe('listActiveSessions', () => {
    it('should return only active sessions', () => {
      const s1 = manager.createSession('Session 1', 'Test', 'user-1');
      const s2 = manager.createSession('Session 2', 'Test', 'user-1');
      manager.completeSession(s2.id);

      const active = manager.listActiveSessions();

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(s1.id);
    });

    it('should return empty array when no active sessions', () => {
      const active = manager.listActiveSessions();
      expect(active).toEqual([]);
    });

    it('should sort by creation time (newest first)', () => {
      const s1 = manager.createSession('Session 1', 'Test', 'user-1');
      // Ensure different timestamps
      const start = Date.now();
      while (Date.now() === start) {
        /* spin */
      }
      const s2 = manager.createSession('Session 2', 'Test', 'user-1');

      const active = manager.listActiveSessions();

      expect(active[0].id).toBe(s2.id);
      expect(active[1].id).toBe(s1.id);
    });
  });

  describe('completeSession', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', []);
    });

    it('should mark session as completed', () => {
      manager.completeSession(session.id);

      expect(session.status).toBe('completed');
    });

    it('should set all collaborators to offline', () => {
      manager.completeSession(session.id);

      session.roles.forEach((role) => {
        expect(role.status).toBe('offline');
      });
    });

    it('should emit session:completed event', () => {
      const listener = vi.fn();
      manager.on('session:completed', listener);

      manager.completeSession(session.id);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(session.id);
    });

    it('should throw error for non-existent session', () => {
      expect(() => manager.completeSession('nonexistent')).toThrow(
        'Session not found: nonexistent',
      );
    });
  });

  describe('cancelSession', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession('Test Session', 'Test', 'user-1');
    });

    it('should mark session as cancelled', () => {
      manager.cancelSession(session.id);

      expect(session.status).toBe('cancelled');
    });

    it('should emit session:cancelled event', () => {
      const listener = vi.fn();
      manager.on('session:cancelled', listener);

      manager.cancelSession(session.id);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0]).toBe(session.id);
    });

    it('should throw error for non-existent session', () => {
      expect(() => manager.cancelSession('nonexistent')).toThrow(
        'Session not found: nonexistent',
      );
    });
  });

  describe('exportSessionSummary', () => {
    let session: CollaborationSession;

    beforeEach(() => {
      session = manager.createSession(
        'Feature Implementation',
        'Implement auth',
        'user-1',
      );
      manager.addCollaborator(session.id, 'user-2', 'Alice', 'developer', [
        'Implement endpoints',
      ]);
      manager.addCollaborator(session.id, 'user-3', 'Bob', 'reviewer', [
        'Review code',
      ]);
      manager.logMessage(
        session.id,
        'user-2',
        'user-3',
        'Ready for review',
        'update',
      );
      manager.handoff(
        session.id,
        'user-2',
        'user-3',
        'Implementation complete',
      );
    });

    it('should export formatted session summary', () => {
      const summary = manager.exportSessionSummary(session.id);

      expect(summary).toContain('Feature Implementation');
      expect(summary).toContain('Implement auth');
      expect(summary).toContain('Alice');
      expect(summary).toContain('Bob');
      expect(summary).toContain('developer');
      expect(summary).toContain('reviewer');
      expect(summary).toContain('Implement endpoints');
      expect(summary).toContain('Review code');
      expect(summary).toContain('Ready for review');
      expect(summary).toContain('Handoff');
    });

    it('should throw error for non-existent session', () => {
      expect(() => manager.exportSessionSummary('nonexistent')).toThrow(
        'Session not found: nonexistent',
      );
    });
  });

  describe('getStats', () => {
    it('should return statistics for empty manager', () => {
      const stats = manager.getStats();

      expect(stats.totalSessions).toBe(0);
      expect(stats.activeSessions).toBe(0);
      expect(stats.completedSessions).toBe(0);
      expect(stats.cancelledSessions).toBe(0);
      expect(stats.totalCollaborators).toBe(0);
      expect(stats.totalMessages).toBe(0);
      expect(stats.totalHandoffs).toBe(0);
    });

    it('should return correct statistics with sessions', () => {
      const s1 = manager.createSession('Session 1', 'Test', 'user-1');
      const s2 = manager.createSession('Session 2', 'Test', 'user-1');

      manager.addCollaborator(s1.id, 'user-2', 'Alice', 'developer', []);
      manager.addCollaborator(s1.id, 'user-3', 'Bob', 'reviewer', []);

      manager.logMessage(s1.id, 'user-2', 'user-3', 'Hello', 'update');
      manager.handoff(s1.id, 'user-2', 'user-3', 'Done');

      manager.completeSession(s2.id);

      const stats = manager.getStats();

      expect(stats.totalSessions).toBe(2);
      expect(stats.activeSessions).toBe(1);
      expect(stats.completedSessions).toBe(1);
      expect(stats.cancelledSessions).toBe(0);
      expect(stats.totalCollaborators).toBe(2);
      expect(stats.totalMessages).toBe(2);
      expect(stats.totalHandoffs).toBe(1);
    });
  });
});

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Mode Collaboration — enables multiple developers to work together
 * with different mode roles in a shared session.
 *
 * The ModeCollaborationManager manages collaboration sessions, tracks roles,
 * logs communication between collaborators, and supports handoffs between modes.
 */

import { EventEmitter } from 'node:events';

import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODE_COLLABORATION');

/**
 * Represents a collaborator's role within a session.
 */
export interface CollaboratorRole {
  /** Unique user identifier */
  userId: string;

  /** Display name of the user */
  userName: string;

  /** Mode this collaborator is working in */
  mode: string;

  /** Responsibilities assigned to this collaborator */
  responsibilities: string[];

  /** Tasks assigned to this collaborator */
  assignedTasks: string[];

  /** When the collaborator joined the session */
  joinedAt: Date;

  /** Current status of the collaborator */
  status: 'active' | 'away' | 'offline';
}

/**
 * A communication message between collaborators.
 */
export interface CommunicationEntry {
  /** Sender user ID */
  from: string;

  /** Recipient user ID (or '*' for broadcast) */
  to: string;

  /** Message content */
  message: string;

  /** When the message was sent */
  timestamp: Date;

  /** Type of communication */
  type: 'update' | 'question' | 'review-comment' | 'handoff';
}

/**
 * A collaboration session with multiple participants.
 */
export interface CollaborationSession {
  /** Unique session identifier */
  id: string;

  /** Human-readable session name */
  name: string;

  /** Session description */
  description: string;

  /** All collaborator roles in this session */
  roles: CollaboratorRole[];

  /** When the session was created */
  createdAt: Date;

  /** User ID of the session creator */
  createdBy: string;

  /** Shared artifacts produced during the session */
  sharedArtifacts: string[];

  /** Communication log between collaborators */
  communicationLog: CommunicationEntry[];

  /** Current session status */
  status: 'active' | 'completed' | 'cancelled';
}

/**
 * Event types emitted by the collaboration manager.
 */
export type ModeCollaborationEvents = {
  'session:created': [session: CollaborationSession];
  'session:completed': [sessionId: string];
  'session:cancelled': [sessionId: string];
  'collaborator:added': [sessionId: string, role: CollaboratorRole];
  'collaborator:removed': [sessionId: string, userId: string];
  'collaborator:status-changed': [sessionId: string, userId: string, status: string];
  'message:logged': [sessionId: string, entry: CommunicationEntry];
  'handoff:complete': [sessionId: string, from: string, to: string];
};

/**
 * Session ID counter for generating unique IDs.
 */
let sessionIdCounter = 0;

/**
 * Generates a unique session ID.
 */
function generateSessionId(): string {
  sessionIdCounter++;
  return `collab-${Date.now()}-${sessionIdCounter}`;
}

/**
 * Finds a collaborator role by user ID within a session.
 */
function findRoleByUserId(
  session: CollaborationSession,
  userId: string,
): CollaboratorRole | undefined {
  return session.roles.find((r) => r.userId === userId);
}

/**
 * Finds a collaborator role by user name within a session.
 */
function findRoleByUserName(
  session: CollaborationSession,
  userName: string,
): CollaboratorRole | undefined {
  return session.roles.find((r) => r.userName === userName);
}

/**
 * Format a date to a readable string.
 */
function formatDate(date: Date): string {
  return date.toLocaleString();
}

/**
 * Manages multi-user mode collaboration sessions, enabling teams to
 * coordinate work across different mode roles.
 */
export class ModeCollaborationManager extends EventEmitter {
  private activeSessions: Map<string, CollaborationSession> = new Map();

  constructor() {
    super();
  }

  /**
   * Create a collaboration session.
   *
   * @param name - Session name
   * @param description - Session description
   * @param createdBy - User ID of the creator
   * @returns The created session
   */
  createSession(
    name: string,
    description: string,
    createdBy: string,
  ): CollaborationSession {
    const session: CollaborationSession = {
      id: generateSessionId(),
      name,
      description,
      roles: [],
      createdAt: new Date(),
      createdBy,
      sharedArtifacts: [],
      communicationLog: [],
      status: 'active',
    };

    this.activeSessions.set(session.id, session);

    this.emit('session:created', session);
    debugLogger.debug(
      `Created collaboration session: "${name}" by ${createdBy}`,
    );

    return session;
  }

  /**
   * Add a collaborator with a mode role.
   *
   * @param sessionId - Session identifier
   * @param userId - Unique user identifier
   * @param userName - Display name
   * @param mode - Mode this collaborator works in
   * @param responsibilities - List of responsibilities
   * @throws Error if session not found or user already in session
   */
  addCollaborator(
    sessionId: string,
    userId: string,
    userName: string,
    mode: string,
    responsibilities: string[],
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== 'active') {
      throw new Error(
        `Session is not active: current status is "${session.status}"`,
      );
    }

    const existing = findRoleByUserId(session, userId);
    if (existing) {
      throw new Error(
        `User "${userName}" (${userId}) is already in this session`,
      );
    }

    const role: CollaboratorRole = {
      userId,
      userName,
      mode,
      responsibilities,
      assignedTasks: [],
      joinedAt: new Date(),
      status: 'active',
    };

    session.roles.push(role);

    this.emit('collaborator:added', sessionId, role);
    debugLogger.debug(
      `Added collaborator: ${userName} (${userId}) as ${mode} in session "${session.name}"`,
    );
  }

  /**
   * Remove a collaborator from a session.
   *
   * @param sessionId - Session identifier
   * @param userId - User ID to remove
   * @throws Error if session not found or user not in session
   */
  removeCollaborator(sessionId: string, userId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const roleIndex = session.roles.findIndex((r) => r.userId === userId);
    if (roleIndex === -1) {
      throw new Error(`User ${userId} not found in session`);
    }

    const removed = session.roles[roleIndex];
    session.roles.splice(roleIndex, 1);

    this.emit('collaborator:removed', sessionId, userId);
    debugLogger.debug(
      `Removed collaborator: ${removed.userName} (${userId}) from session "${session.name}"`,
    );
  }

  /**
   * Update a collaborator's status.
   *
   * @param sessionId - Session identifier
   * @param userId - User ID
   * @param status - New status
   */
  updateCollaboratorStatus(
    sessionId: string,
    userId: string,
    status: 'active' | 'away' | 'offline',
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const role = findRoleByUserId(session, userId);
    if (!role) {
      throw new Error(`User ${userId} not found in session`);
    }

    role.status = status;

    this.emit('collaborator:status-changed', sessionId, userId, status);
    debugLogger.debug(
      `Updated status for ${userId} to "${status}" in session "${session.name}"`,
    );
  }

  /**
   * Assign a task to a collaborator.
   *
   * @param sessionId - Session identifier
   * @param userId - User ID
   * @param task - Task description
   */
  assignTask(sessionId: string, userId: string, task: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const role = findRoleByUserId(session, userId);
    if (!role) {
      throw new Error(`User ${userId} not found in session`);
    }

    role.assignedTasks.push(task);

    debugLogger.debug(
      `Assigned task to ${userId} in session "${session.name}": ${task}`,
    );
  }

  /**
   * Add a shared artifact to the session.
   *
   * @param sessionId - Session identifier
   * @param artifact - Artifact name or path
   */
  addSharedArtifact(sessionId: string, artifact: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.sharedArtifacts.includes(artifact)) {
      session.sharedArtifacts.push(artifact);
      debugLogger.debug(
        `Added shared artifact to session "${session.name}": ${artifact}`,
      );
    }
  }

  /**
   * Log a communication between collaborators.
   *
   * @param sessionId - Session identifier
   * @param from - Sender user ID
   * @param to - Recipient user ID
   * @param message - Message content
   * @param type - Message type
   * @throws Error if session not found
   */
  logMessage(
    sessionId: string,
    from: string,
    to: string,
    message: string,
    type: 'update' | 'question' | 'review-comment' | 'handoff',
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const entry: CommunicationEntry = {
      from,
      to,
      message,
      timestamp: new Date(),
      type,
    };

    session.communicationLog.push(entry);

    this.emit('message:logged', sessionId, entry);
    debugLogger.debug(
      `Logged message in session "${session.name}": ${from} -> ${to} [${type}]`,
    );
  }

  /**
   * Hand off work from one role to another.
   *
   * @param sessionId - Session identifier
   * @param from - Sender user ID
   * @param to - Recipient user ID
   * @param context - Handoff context / summary
   * @throws Error if session or users not found
   */
  handoff(sessionId: string, from: string, to: string, context: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const fromRole = findRoleByUserId(session, from);
    if (!fromRole) {
      throw new Error(`Sender ${from} not found in session`);
    }

    const toRole = findRoleByUserId(session, to);
    if (!toRole) {
      throw new Error(`Recipient ${to} not found in session`);
    }

    // Log the handoff as a communication entry
    const entry: CommunicationEntry = {
      from,
      to,
      message: `Handoff: ${context}`,
      timestamp: new Date(),
      type: 'handoff',
    };
    session.communicationLog.push(entry);

    this.emit('handoff:complete', sessionId, from, to);
    debugLogger.debug(
      `Handoff complete in session "${session.name}": ${fromRole.userName} (${fromRole.mode}) -> ${toRole.userName} (${toRole.mode})`,
    );
  }

  /**
   * Get session status.
   *
   * @param sessionId - Session identifier
   * @returns Session status summary
   * @throws Error if session not found
   */
  getSessionStatus(sessionId: string): {
    activeRoles: number;
    totalMessages: number;
    completedHandoffs: number;
    sharedArtifacts: number;
    session: CollaborationSession;
  } {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const activeRoles = session.roles.filter((r) => r.status === 'active').length;
    const totalMessages = session.communicationLog.length;
    const completedHandoffs = session.communicationLog.filter(
      (e) => e.type === 'handoff',
    ).length;

    return {
      activeRoles,
      totalMessages,
      completedHandoffs,
      sharedArtifacts: session.sharedArtifacts.length,
      session,
    };
  }

  /**
   * Export session summary as a formatted string.
   *
   * @param sessionId - Session identifier
   * @returns Formatted session summary
   * @throws Error if session not found
   */
  exportSessionSummary(sessionId: string): string {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const lines: string[] = [
      `# Collaboration Session: ${session.name}`,
      '',
      `**ID:** ${session.id}`,
      `**Description:** ${session.description}`,
      `**Status:** ${session.status}`,
      `**Created:** ${formatDate(session.createdAt)}`,
      `**Created by:** ${session.createdBy}`,
      '',
      '## Collaborators',
      '',
    ];

    for (const role of session.roles) {
      lines.push(
        `- **${role.userName}** (\`${role.mode}\`) — ${role.status}`,
      );
      if (role.responsibilities.length > 0) {
        lines.push(`  - Responsibilities: ${role.responsibilities.join(', ')}`);
      }
      if (role.assignedTasks.length > 0) {
        lines.push(`  - Tasks: ${role.assignedTasks.join(', ')}`);
      }
      lines.push(`  - Joined: ${formatDate(role.joinedAt)}`);
      lines.push('');
    }

    lines.push('## Shared Artifacts');
    lines.push('');
    if (session.sharedArtifacts.length > 0) {
      for (const artifact of session.sharedArtifacts) {
        lines.push(`- ${artifact}`);
      }
    } else {
      lines.push('No shared artifacts yet.');
    }
    lines.push('');

    lines.push('## Communication Log');
    lines.push('');
    if (session.communicationLog.length > 0) {
      for (const entry of session.communicationLog) {
        const fromName =
          findRoleByUserId(session, entry.from)?.userName || entry.from;
        const toName =
          entry.to === '*'
            ? 'all'
            : findRoleByUserId(session, entry.to)?.userName || entry.to;

        lines.push(
          `[${formatDate(entry.timestamp)}] **${fromName}** -> **${toName}** [${entry.type}]: ${entry.message}`,
        );
      }
    } else {
      lines.push('No communication logged yet.');
    }
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    const handoffCount = session.communicationLog.filter(
      (e) => e.type === 'handoff',
    ).length;
    lines.push(
      `- Total messages: ${session.communicationLog.length}`,
    );
    lines.push(`- Handoffs: ${handoffCount}`);
    lines.push(`- Artifacts: ${session.sharedArtifacts.length}`);

    return lines.join('\n');
  }

  /**
   * List active sessions.
   *
   * @returns Array of active sessions
   */
  listActiveSessions(): CollaborationSession[] {
    const active: CollaborationSession[] = [];

    for (const session of this.activeSessions.values()) {
      if (session.status === 'active') {
        active.push(session);
      }
    }

    // Sort by creation time (newest first)
    active.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    return active;
  }

  /**
   * Get all sessions (including completed and cancelled).
   *
   * @returns Array of all sessions
   */
  getAllSessions(): CollaborationSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Get a session by ID.
   *
   * @param sessionId - Session identifier
   * @returns Session or undefined if not found
   */
  getSession(sessionId: string): CollaborationSession | undefined {
    return this.activeSessions.get(sessionId);
  }

  /**
   * Complete a session (mark as completed).
   *
   * @param sessionId - Session identifier
   * @throws Error if session not found
   */
  completeSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = 'completed';

    // Set all collaborators to offline
    for (const role of session.roles) {
      role.status = 'offline';
    }

    this.emit('session:completed', sessionId);
    debugLogger.debug(
      `Completed session: "${session.name}"`,
    );
  }

  /**
   * Cancel a session.
   *
   * @param sessionId - Session identifier
   * @throws Error if session not found
   */
  cancelSession(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.status = 'cancelled';

    this.emit('session:cancelled', sessionId);
    debugLogger.debug(
      `Cancelled session: "${session.name}"`,
    );
  }

  /**
   * Remove a completed or cancelled session from active tracking.
   *
   * @param sessionId - Session identifier
   */
  archiveSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    debugLogger.debug(`Archived session: ${sessionId}`);
  }

  /**
   * Get collaboration statistics.
   *
   * @returns Collaboration statistics
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    completedSessions: number;
    cancelledSessions: number;
    totalCollaborators: number;
    totalMessages: number;
    totalHandoffs: number;
  } {
    let activeSessions = 0;
    let completedSessions = 0;
    let cancelledSessions = 0;
    let totalCollaborators = 0;
    let totalMessages = 0;
    let totalHandoffs = 0;

    for (const session of this.activeSessions.values()) {
      switch (session.status) {
        case 'active':
          activeSessions++;
          break;
        case 'completed':
          completedSessions++;
          break;
        case 'cancelled':
          cancelledSessions++;
          break;
      }

      totalCollaborators += session.roles.length;
      totalMessages += session.communicationLog.length;
      totalHandoffs += session.communicationLog.filter(
        (e) => e.type === 'handoff',
      ).length;
    }

    return {
      totalSessions: this.activeSessions.size,
      activeSessions,
      completedSessions,
      cancelledSessions,
      totalCollaborators,
      totalMessages,
      totalHandoffs,
    };
  }

  /**
   * Clear all sessions.
   */
  clear(): void {
    this.activeSessions.clear();
    debugLogger.debug('All collaboration sessions cleared');
  }
}

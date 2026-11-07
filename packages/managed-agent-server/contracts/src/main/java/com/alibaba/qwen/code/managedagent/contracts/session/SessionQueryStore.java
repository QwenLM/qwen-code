package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellLifecycleOperation;
import com.alibaba.qwen.code.managedagent.model.SessionPrincipal;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.repository.SessionWorktreeStore;

import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * Session and Turn reads: pages, summaries, worktree descriptors and
 * lifecycle-operation views.
 */
public interface SessionQueryStore {
    default Optional<SessionRecord> findSession(String tenantId, String sessionId) {
        return findSessionById(sessionId).filter(session -> tenantId.equals(session.tenantId()));
    }

    public default SessionWorktreeStore.Descriptor findSessionWorktree(
            String tenantId, String sessionId) {
        return null;
    }

    public default Map<String, SessionWorktreeStore.Descriptor> findSessionWorktrees(
            String tenantId, List<String> sessionIds) {
        return Map.of();
    }

    public Optional<SessionRecord> findSessionById(String sessionId);

    public SessionPage listSessions(String tenantId, String actorId,
            Long beforeCreatedAt,
            String beforeSessionId, int limit);

    public SessionPage listSessions(String tenantId, String actorId, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState);

    public SessionPage listSessions(String tenantId, String actorId, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState, String titleQuery);

    /**
     * A page whose ownership filter runs before the cursor and limit. Bound
     * Sessions retain Workspace grants; unbound Sessions require an exact
     * principal match and legacy rows without an ownership row stay hidden.
     */
    public default SessionPage listSessions(String tenantId,
            SessionPrincipal principal, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState,
            String titleQuery) {
        throw new UnsupportedOperationException(
                "Ownership-filtered Session pages are unavailable");
    }

    /** A page restricted to Sessions owned by the principal. */
    public default SessionPage listOwnedSessions(String tenantId,
            SessionPrincipal principal, Long beforeCreatedAt,
            String beforeSessionId, int limit, String archiveState,
            String titleQuery) {
        throw new UnsupportedOperationException(
                "Owner-only Session pages are unavailable");
    }

    public Map<String, WebShellLifecycleOperation> findLatestLifecycleOperations(String tenantId, List<String> sessionIds);

    public Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId);

    /** The active Turn of each given Session, in one round trip. */
    public Map<String, TurnSummary> findActiveTurns(String tenantId,
            List<String> sessionIds);

    /** The latest Turn of each given Session, in one round trip. */
    public Map<String, TurnSummary> findLatestTurns(String tenantId,
            List<String> sessionIds);

    /**
     * A page of a Session's Turns, newest first: by creation time, then by
     * Turn ID, both descending. A position excludes the Turn it names and
     * every newer one.
     */
    public TurnPage listTurns(String tenantId, String sessionId,
            Long beforeCreatedAt, String beforeTurnId, int limit);

    public Optional<TurnSummary> findTurnSummary(String tenantId, String sessionId,
            String turnId);

    public SessionRecord requireSession(String tenantId, String sessionId);

    public Optional<String> findLastVisibleStatusBeforeDelete(String tenantId,
            String sessionId);
}

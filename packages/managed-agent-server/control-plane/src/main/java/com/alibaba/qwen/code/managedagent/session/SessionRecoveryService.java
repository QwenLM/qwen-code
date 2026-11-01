package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.RecoveryStatus;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionQueryStore;
import com.alibaba.qwen.code.managedagent.contracts.session.TurnExecutionStore;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionRecovery;
import com.alibaba.qwen.code.managedagent.model.ApiModels.SessionRecoveryActions;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.repository.SessionRecoveryRepository;
import com.alibaba.qwen.code.managedagent.repository.SessionRecoveryRepository.HeadRecovery;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Set;

@Service
public class SessionRecoveryService {
    private static final Set<String> ACTIVE = Set.of("ACCEPTED", "RUNNING", "CANCELLING");
    private static final Set<String> TERMINAL = Set.of("COMPLETED", "FAILED", "CANCELLED");
    private static final Set<String> STATES = Set.of("recovering", "awaiting_evidence",
            "cleanup_pending", "ready", "operator_required");
    private final ManagedAgentService sessions;
    private final SessionQueryStore store;
    private final HarnessCoordinator coordinator;
    private final HarnessConnector harness;
    private final SessionRecoveryRepository recovery;
    private final ManagedSessionStore journals;

    public SessionRecoveryService(ManagedAgentService sessions, SessionQueryStore store,
            HarnessCoordinator coordinator, HarnessConnector harness, SessionRecoveryRepository recovery, ManagedSessionStore journals) {
        this.sessions = sessions;
        this.store = store;
        this.coordinator = coordinator;
        this.harness = harness;
        this.recovery = recovery;
        this.journals = journals;
    }

    public SessionRecovery query(String tenantId, String actorId, String sessionId) {
        SessionRecord session = sessions.requireReadableSession(tenantId, actorId, sessionId);
        return inspect(session, actorId);
    }

    SessionRecovery projection(SessionRecord session, String actorId) {
        SessionRecovery recovery = inspect(session, actorId);
        return "turn_active".equals(recovery.reasonCode()) ? null : recovery;
    }

    public SessionRecovery recheck(String tenantId, String actorId,
            String sessionId, String turnId) {
        SessionRecord session = sessions.requireReadableSession(tenantId, actorId, sessionId);
        sessions.requireRecoveryOperator(session, actorId);
        TurnRecord turn = latest(session);
        if (turn == null || !turn.turnId().equals(turnId)) {
            throw new ManagedAgentException(409,
                    "recovery_target_changed", "The Session's recovery Turn has changed.");
        }
        SessionRecovery recovery = targetRecovery(session, actorId, turnId);
        if ("ready".equals(recovery.state())) {
            return recovery;
        }
        if (!recovery.actions().recheck()) {
            throw new ManagedAgentException(409,
                    "recovery_recheck_unavailable", "This recovery has no existing work to recheck.");
        }
        boolean rechecked;
        if (TERMINAL.contains(turn.status())) {
            rechecked = harness.recheckRecoveryCleanup(tenantId, sessionId, turn.promptId());
        } else {
            rechecked = coordinator.recheckRecovery(tenantId, sessionId, turnId);
            if (!rechecked) {
                recovery = targetRecovery(session, actorId, turnId);
                if ("ready".equals(recovery.state())) {
                    return recovery;
                }
                RecoveryStatus evidence = recovery.actions().recheck() ? evidence(session, turn) : null;
                rechecked = evidence != null && evidence.inputSettled()
                        && "cleanup_pending".equals(evidence.state())
                        && harness.recheckRecoveryCleanup(tenantId, sessionId, turn.promptId());
            }
        }
        recovery = targetRecovery(session, actorId, turnId);
        if (!rechecked && !"ready".equals(recovery.state())) {
            throw new ManagedAgentException(409,
                    "recovery_recheck_unavailable", "The original recovery work is not available.");
        }
        return recovery;
    }

    private SessionRecovery targetRecovery(SessionRecord session, String actorId, String turnId) {
        SessionRecovery recovery = query(session.tenantId(), actorId, session.sessionId());
        if (!turnId.equals(recovery.turnId())) {
            throw new ManagedAgentException(409,
                    "recovery_target_changed", "The Session's recovery Turn has changed.");
        }
        return recovery;
    }

    private SessionRecovery inspect(SessionRecord session, String actorId) {
        TurnRecord turn = latest(session);
        boolean operator = operator(session, actorId);
        boolean active = turn != null && ACTIVE.contains(turn.status());
        boolean cancel = operator && active && !"CANCELLING".equals(turn.status());
        List<HeadRecovery> heads = recovery.heads(session.tenantId(), session.sessionId());
        if (!"ACTIVE".equals(session.status())) {
            return view("operator_required", "session_not_active", turn, false, false, false);
        }
        if (heads.isEmpty() && (session.harnessBootId() != null || session.harnessEventEpoch() != null)) {
            return view("operator_required", "recovery_evidence_unavailable", turn, false, false, cancel);
        }
        if (!heads.isEmpty() && !"READY".equals(heads.getFirst().state())) {
            String reason = heads.getFirst().reasonCode();
            return view("operator_required", reason == null ? "recovery_blocked" : reason,
                    turn, false, false, cancel);
        }
        boolean initial = turn == null || "CANCELLED".equals(turn.status()) && !turn.submissionAttempted()
                && turn.harnessEventEpoch() == null && recovery.nonInitialTurns(session.tenantId(), session.sessionId()) == 0;
        if (initial && (heads.isEmpty() || journals.hasPristineInitialJournal(session.tenantId(),
                session.sessionId(), session.workspace() == null ? null : session.workspace().getWorkspaceId()))) {
            return view("ready", "ready", turn, true, false, false);
        }
        if (active && !recoveryIntent(turn)) {
            return view("recovering", "turn_active", turn, false, false, cancel);
        }
        RecoveryStatus evidence = evidence(session, turn);
        if (evidence == null || "recovery_evidence_unavailable".equals(evidence.reasonCode())) {
            return view(active ? "awaiting_evidence" : "operator_required",
                    "recovery_evidence_unavailable", turn, false,
                    operator && (recheckIntent(turn)
                            || turn != null && TERMINAL.contains(turn.status())), cancel);
        }
        if ("ready".equals(evidence.state()) && evidence.nextTurnAllowed() && evidence.inputSettled()
                && evidence.continuationReady() && !active) {
            return view("ready", "ready", turn, true, false, false);
        }
        String state = evidence.state() != null && STATES.contains(evidence.state())
                ? evidence.state() : "awaiting_evidence";
        boolean settlementPending = "ready".equals(state) && active;
        if ("ready".equals(state)) {
            state = active ? "recovering" : "awaiting_evidence";
        }
        boolean cleanup = evidence.inputSettled() && "cleanup_pending".equals(state);
        boolean recheck = operator && !"operator_required".equals(state)
                && (recheckIntent(turn) || cleanup);
        if (!active && !evidence.inputSettled() && !cleanup) {
            state = "operator_required";
            recheck = false;
        }
        return view(state, settlementPending ? "turn_settlement_pending"
                        : "turn_active".equals(evidence.reasonCode()) ? "harness_work_active"
                        : evidence.reasonCode() == null ? "inputs_unsettled" : evidence.reasonCode(),
                turn, false, recheck, cancel);
    }

    private RecoveryStatus evidence(SessionRecord session, TurnRecord turn) {
        try {
            RecoveryStatus status = harness.inspectRecovery(session.tenantId(),
                    session.sessionId(), turn == null ? null : turn.promptId());
            return status != null && (turn == null
                    || turn.promptId().equals(status.promptId())) ? status : null;
        } catch (RuntimeException unavailable) {
            return null;
        }
    }

    private TurnRecord latest(SessionRecord session) {
        TurnSummary latest = store.findLatestTurns(session.tenantId(),
                List.of(session.sessionId())).get(session.sessionId());
        return latest == null ? null : store.findTurn(session.tenantId(),
                session.sessionId(), latest.turnId()).orElseThrow(() ->
                        new ManagedAgentException(503,
                                "recovery_evidence_unavailable", "The recovery evidence is unavailable."));
    }

    private boolean operator(SessionRecord session, String actorId) {
        try {
            sessions.requireRecoveryOperator(session, actorId);
            return "ACTIVE".equals(session.status());
        } catch (ManagedAgentException forbidden) {
            return false;
        }
    }

    private static boolean recoveryIntent(TurnRecord turn) {
        return turn != null && ACTIVE.contains(turn.status())
                && ("CANCELLING".equals(turn.status())
                        || TurnExecutionStore.RUNTIME_RECOVERY_BLOCKED.equals(turn.errorCode())
                        || TurnExecutionStore.WORKFLOW_RECOVERY_BLOCKED.equals(turn.errorCode()));
    }

    private static boolean recheckIntent(TurnRecord turn) {
        return turn != null && ACTIVE.contains(turn.status())
                && ("CANCELLING".equals(turn.status())
                        || TurnExecutionStore.RUNTIME_RECOVERY_BLOCKED.equals(turn.errorCode()));
    }

    private static SessionRecovery view(String state, String reason, TurnRecord turn,
            boolean nextTurnAllowed, boolean recheck, boolean cancel) {
        return new SessionRecovery(state, reason, turn == null ? null : turn.turnId(),
                nextTurnAllowed, new SessionRecoveryActions(recheck, cancel, !nextTurnAllowed),
                recheck && turn != null && ACTIVE.contains(turn.status()) ? turn.retryAfter() : null);
    }
}

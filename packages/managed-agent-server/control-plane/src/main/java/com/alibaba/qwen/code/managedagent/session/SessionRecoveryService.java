package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.RecoveryStatus;
import com.alibaba.qwen.code.managedagent.contracts.harness.HostedHarnessRecoveryDeclinedException;
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
import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Set;

@Service
public class SessionRecoveryService {
    private static final Logger LOG = LoggerFactory.getLogger(SessionRecoveryService.class);
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
            if (cancelledBeforeAdmission(turn)) {
                RecoveryStatus evidence = evidence(session, turn);
                rechecked = hasCleanupTarget(evidence)
                        && recheckCleanup(tenantId, sessionId, evidence.promptId());
            } else {
                rechecked = recheckCleanup(tenantId, sessionId, turn.promptId());
            }
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
                        && recheckCleanup(tenantId, sessionId, turn.promptId());
            }
        }
        recovery = targetRecovery(session, actorId, turnId);
        if (!rechecked && !"ready".equals(recovery.state())) {
            throw new ManagedAgentException(409,
                    "recovery_recheck_unavailable", "The original recovery work is not available.");
        }
        return recovery;
    }

    // #17543: a cleanup recheck needs a Harness that can open the Session.
    // When none can, say so, instead of failing with an uncoded error or the
    // ineligible-work refusal that never changes.
    private boolean recheckCleanup(String tenantId, String sessionId, String promptId) {
        try {
            return harness.recheckRecoveryCleanup(tenantId, sessionId, promptId);
        } catch (ManagedAgentException refusal) {
            throw refusal;
        } catch (HostedHarnessRecoveryDeclinedException decline) {
            // A typed decline is terminal: the retriable 503 below would
            // invite clients to retry a refusal that never changes.
            throw new ManagedAgentException(409, HostedHarnessRecoveryDeclinedException.CODE,
                    "The Hosted Harness declined this recovery cleanup: " + decline.getReason(),
                    decline);
        } catch (RuntimeException unavailable) {
            // The API maps a ManagedAgentException without logging its cause.
            LOG.warn("Managed recovery cleanup recheck unavailable tenant={} session={}",
                    tenantId, sessionId, unavailable);
            throw new ManagedAgentException(503, "recovery_runtime_unavailable",
                    "No Hosted Harness can open this Session to recheck its recovery.", unavailable);
        }
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
        boolean localCancellation = cancelledBeforeAdmission(turn);
        boolean initial = turn == null || localCancellation
                && recovery.nonInitialTurns(session.tenantId(), session.sessionId()) == 0;
        if (initial && (heads.isEmpty() || journals.hasPristineInitialJournal(session.tenantId(),
                session.sessionId(), session.workspace() == null ? null : session.workspace().getWorkspaceId()))) {
            return view("ready", "ready", turn, true, false, false);
        }
        if (active && !recoveryIntent(turn)) {
            return view("recovering", "turn_active", turn, false, false, cancel);
        }
        // The persistent suspension proof (docs/design/2026-11-18-managed-
        // suspension-recovery-view.md): the view follows durable state, never
        // the presence or absence of a Harness cache entry. A sealed head is
        // necessary but NOT sufficient — a load that refuses also closes the
        // writer it just acquired, leaving the same sealed, released,
        // current-projection head. So `ready` additionally requires the wake
        // projection to have proved this exact revision carries no pending
        // input, and no durable obligation to survive. Anything less falls
        // through to the evidence-driven arms below, which stay conservative.
        HeadRecovery head = heads.isEmpty() ? null : heads.getFirst();
        if (!active && head != null && "SEALED".equals(head.journalState())) {
            boolean projectionCurrent = head.activationHeadRevision() != null
                    && head.activationHeadRevision().equals(head.journalRevision());
            if (!projectionCurrent) {
                return view("awaiting_evidence", "activation_projection_lagging",
                        turn, false, false, cancel);
            }
            boolean wakeProven = !head.wakePending()
                    && head.wakeHeadRevision() != null
                    && head.wakeHeadRevision().equals(head.journalRevision());
            // A clean suspension stamped this revision after proving every
            // pending wake input unattempted (docs/design/2026-11-19-managed-
            // control-plane-wake-seal-stamp.md §3.3). Any acquisition clears
            // the stamp, so a refused load's seal never inherits it.
            boolean sealStamped = head.journalRevision() != null
                    && head.journalRevision().equals(head.wakeSealRevision());
            // A suspension that certified its background holds may leave a
            // live projected run and an owed cleanup behind: those ARE the
            // certified work, and the pull plus the next drain-only load
            // converge them. Only the seal at this exact revision proves it.
            boolean backgroundCertified = sealStamped && head.wakeSealBackground();
            if ("released".equals(head.activationPhase()) && (wakeProven || sealStamped)
                    && !recovery.hasUnsettledWork(session.tenantId(), session.sessionId(),
                            backgroundCertified)) {
                return view("ready", "ready", turn, true, false, false);
            }
        }
        RecoveryStatus evidence = evidence(session, turn);
        // #17538: the Harness answers status only to the client that loaded
        // the Session, so a replica without that attachment reads nothing,
        // and that absence proves nothing. A live head whose latest Turn
        // carries the Harness's own journaled terminal and owes no durable
        // work is ready from every replica. The cached-attachment guard keeps
        // a failed or foreign-prompt status read on the owning replica from
        // masquerading as that absence: unreadable evidence is not no evidence.
        if (evidence == null && !active && turn != null && head != null
                && "ACTIVE".equals(head.journalState())
                && harness.cachedRecoveryAttachment(session.tenantId(), session.sessionId()) == null
                && recovery.hasNativeTerminal(session.tenantId(), session.sessionId(), turn.turnId())
                && !recovery.hasUnsettledWork(session.tenantId(), session.sessionId())) {
            return view("ready", "ready", turn, true, false, false);
        }
        if (evidence == null || "recovery_evidence_unavailable".equals(evidence.reasonCode())) {
            return view(active ? "awaiting_evidence" : "operator_required",
                    "recovery_evidence_unavailable", turn, false,
                    operator && (recheckIntent(turn)
                            || turn != null && TERMINAL.contains(turn.status()) && !localCancellation), cancel);
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
                && (recheckIntent(turn) || cleanup && (!localCancellation || hasCleanupTarget(evidence)));
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
        boolean localCancellation = cancelledBeforeAdmission(turn);
        // With no prompt target, the Harness checks its last accepted input.
        String target = turn == null || localCancellation ? null : turn.promptId();
        try {
            RecoveryStatus status = harness.inspectRecovery(session.tenantId(),
                    session.sessionId(), target);
            // A null target lets the Harness name its last accepted input,
            // and that answer is authoritative even when it names this
            // Turn's own prompt: a withdrawn submission mark does not
            // prove non-admission (R10-4).
            if (status == null || target != null && !target.equals(status.promptId())) {
                return null;
            }
            return status;
        } catch (RuntimeException unavailable) {
            return null;
        }
    }

    private static boolean hasCleanupTarget(RecoveryStatus evidence) {
        return evidence != null && "cleanup_pending".equals(evidence.state())
                && evidence.inputSettled() && evidence.continuationReady()
                && StringUtils.isNotBlank(evidence.promptId());
    }

    private static boolean cancelledBeforeAdmission(TurnRecord turn) {
        return turn != null && "CANCELLED".equals(turn.status())
                && !turn.submissionAttempted() && turn.harnessEventEpoch() == null;
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
                        || TurnExecutionStore.HARNESS_RECOVERY_BLOCKED.equals(turn.errorCode())
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

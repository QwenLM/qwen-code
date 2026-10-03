package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.service.SessionLifecycleCoordinator;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.CwdChangeOutcome;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.AbstractExecutorService;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * The W2 controlled cwd change: store admission, durable settlement,
 * coordinator delivery and recovery, on real SQL. The probe target is a
 * warmer stub here; the production probe's directory rule is covered by
 * {@code WorkspaceRuntimeInstallProbeTest} and the public route by the
 * hosted integration suites.
 */
class ManagedCwdChangeOperationTest {
    private static final String ACTOR = "actor-a";
    private static final String ACTOR_DIGEST = "digest-of-" + ACTOR;
    private static final String WS = "ws-a";
    private static final String STORAGE = "storage-a";
    private final AtomicLong now = new AtomicLong(1_000_000);

    @Test
    void admissionAcceptsReplaysAndConflictsByDigest() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        OperationAdmission first = begin(fixture, sessionId, "key-1",
                "digest-1", "services/b", 1);
        assertThat(first.replayed()).isFalse();
        OperationRecord operation = first.operation();
        assertThat(operation.kind()).isEqualTo(OperationKind.CWD_CHANGE);
        assertThat(operation.state()).isEqualTo("PENDING");
        assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(operation.deliveryState()).isEqualTo("PENDING");
        assertThat(operation.targetCwdRelative()).isEqualTo("services/b");
        assertThat(operation.expectedContextRevision()).isEqualTo(1);
        assertThat(operation.sessionStatusBefore()).isEqualTo("ACTIVE");

        OperationAdmission replay = begin(fixture, sessionId, "key-1",
                "digest-1", "services/b", 1);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().operationId())
                .isEqualTo(operation.operationId());
        assertThatThrownBy(() -> begin(fixture, sessionId, "key-1",
                "digest-2", "services/b", 1))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus())
                            .isEqualTo(HttpStatus.CONFLICT);
                    assertThat(error.getCode())
                            .isEqualTo("idempotency_conflict");
                });
    }

    // A retry after the settlement replays the completed operation even
    // though the revision CAS could never pass again.
    @Test
    void replayOutlivesItsRevisionCheck() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        OperationAdmission first = begin(fixture, sessionId, "key-1",
                "digest-1", "services/b", 1);
        OperationRecord claimed = claim(fixture, sessionId,
                first.operation().operationId(), "owner");
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                sessionId, claimed.operationId(), "owner",
                claimed.claimGeneration()).completed()).isTrue();
        OperationAdmission replay = begin(fixture, sessionId, "key-1",
                "digest-1", "services/b", 1);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().state()).isEqualTo("COMPLETED");
        assertThat(replay.operation().resultContextRevision()).isEqualTo(2);
    }

    @Test
    void admissionRejectsMissingUnboundDeletedAndInactiveSessions() {
        Fixture fixture = fixture(true);
        assertThatThrownBy(() -> begin(fixture, "missing", "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));
        String legacyId = fixture.store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null,
                null, List.of(), null).sessionId();
        assertThatThrownBy(() -> begin(fixture, legacyId, "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error,
                                HttpStatus.BAD_REQUEST,
                                "unsupported_feature"));
        String deletedId = fixture.createBoundSession(TENANT, WS);
        fixture.jdbc.update("UPDATE managed_agent_session SET status ="
                        + " 'DELETED', deleted_at = ? WHERE tenant_id = ?"
                        + " AND session_id = ?", now.get(), TENANT,
                deletedId);
        assertThatThrownBy(() -> begin(fixture, deletedId, "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));
        String archivedId = fixture.createBoundSession(TENANT, WS);
        fixture.jdbc.update("UPDATE managed_agent_session SET status ="
                        + " 'ARCHIVED' WHERE tenant_id = ? AND"
                        + " session_id = ?", TENANT, archivedId);
        assertThatThrownBy(() -> begin(fixture, archivedId, "key",
                "digest", "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_state_conflict"));
    }

    @Test
    void admissionRequiresTheOptInAndTheCreatorGrant() {
        Fixture disabled = fixture(false);
        String gatedId = disabled.createBoundSession(TENANT, WS);
        assertThatThrownBy(() -> begin(disabled, gatedId, "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "workspace_unavailable"));

        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        // A stranger (no read grant) is invisible; a readable grantee who
        // is not the creator gets the sibling operations' 403; a creator
        // whose grant was revoked fails the shared Registry-fact gate that
        // the settlement re-verifies the same way.
        assertThatThrownBy(() -> begin(fixture, sessionId, "key", "digest",
                "a", 1, "stranger", "digest-stranger"))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));
        fixture.grant(TENANT, WS, "colleague", true, true);
        assertThatThrownBy(() -> begin(fixture, sessionId, "key", "digest",
                "a", 1, "colleague", "digest-colleague"))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.FORBIDDEN,
                                "session_operation_forbidden"));
        fixture.jdbc.update("UPDATE managed_workspace_access SET"
                        + " can_create = FALSE WHERE tenant_id = ? AND"
                        + " workspace_id = ?", TENANT, WS);
        assertThatThrownBy(() -> begin(fixture, sessionId, "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "workspace_unavailable"));
    }

    @Test
    void admissionChecksRegistryFactsAndTheExpectedRevision() {
        Fixture fixture = fixture(true);
        String drainedId = fixture.createBoundSession(TENANT, WS);
        fixture.jdbc.update("UPDATE managed_workspace_registry SET"
                        + " workspace_generation = 2 WHERE tenant_id = ?"
                        + " AND workspace_id = ?", TENANT, WS);
        assertThatThrownBy(() -> begin(fixture, drainedId, "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "workspace_unavailable"));
        fixture.jdbc.update("UPDATE managed_workspace_registry SET"
                        + " workspace_generation = 1, state = 'DRAINING'"
                        + " WHERE tenant_id = ? AND workspace_id = ?",
                TENANT, WS);
        assertThatThrownBy(() -> begin(fixture, drainedId, "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "workspace_unavailable"));
        fixture.jdbc.update("UPDATE managed_workspace_registry SET"
                        + " state = 'ACTIVE' WHERE tenant_id = ? AND"
                        + " workspace_id = ?", TENANT, WS);
        assertThatThrownBy(() -> begin(fixture, drainedId, "key", "digest",
                "a", 2))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "context_revision_conflict"));
    }

    @Test
    void admissionRejectsAnActiveTurnAndAnOpenOperation() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        fixture.insertTurn(sessionId, "turn-a", "ACCEPTED");
        assertThatThrownBy(() -> begin(fixture, sessionId, "key-a",
                "digest-a", "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_context_busy"));
        fixture.jdbc.update("UPDATE managed_agent_turn SET status ="
                        + " 'COMPLETED' WHERE tenant_id = ? AND"
                        + " session_id = ?", TENANT, sessionId);
        OperationAdmission first = begin(fixture, sessionId, "key-a",
                "digest-a", "a", 1);
        assertThat(first.replayed()).isFalse();
        assertThatThrownBy(() -> begin(fixture, sessionId, "key-b",
                "digest-b", "b", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_context_busy"));

        // A pending mutation command is the same barrier.
        String secondId = fixture.createBoundSession(TENANT, WS);
        fixture.jdbc.update("INSERT INTO managed_agent_command (tenant_id,"
                        + " operation, idempotency_key, request_digest,"
                        + " session_id, command_status, created_at,"
                        + " updated_at) VALUES (?, 'RENAME', 'rename',"
                        + " 'digest', ?, 'PENDING', 0, 0)", TENANT,
                secondId);
        assertThatThrownBy(() -> begin(fixture, secondId, "key", "digest",
                "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_context_busy"));
    }

    @Test
    void admissionRaceAdmitsExactlyOneSide() throws Exception {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        TransactionTemplate competition = new TransactionTemplate(
                new DataSourceTransactionManager(
                        fixture.jdbc.getDataSource()));
        CyclicBarrier barrier = new CyclicBarrier(2);
        ConcurrentLinkedQueue<String> outcomes = new ConcurrentLinkedQueue<>();
        for (String key : List.of("key-x", "key-y")) {
            Thread thread = new Thread(() -> {
                try {
                    barrier.await(5, TimeUnit.SECONDS);
                    competition.executeWithoutResult(ignored -> begin(
                            fixture, sessionId, key, "digest-" + key, "a",
                            1));
                    outcomes.add("admitted");
                } catch (ApiException error) {
                    outcomes.add(error.getCode());
                } catch (Exception error) {
                    outcomes.add(error.getClass().getSimpleName());
                }
            });
            thread.setDaemon(true);
            thread.start();
        }
        long deadline = System.currentTimeMillis() + 30_000;
        while (outcomes.size() < 2
                && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
        assertThat(outcomes).containsExactlyInAnyOrder("admitted",
                "session_context_busy");
    }

    @Test
    void settlementCommitsTheBindingTheOutcomeAndTheEvent() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        OperationAdmission admission = begin(fixture, sessionId, "key",
                "digest", "services/b", 1);
        OperationRecord claimed = claim(fixture, sessionId,
                admission.operation().operationId(), "owner");
        CwdChangeOutcome outcome = fixture.store
                .completeCwdChangeOperation(TENANT, sessionId,
                        claimed.operationId(), "owner",
                        claimed.claimGeneration());
        assertThat(outcome.completed()).isTrue();
        assertThat(outcome.resultContextRevision()).isEqualTo(2);

        var session = fixture.store.requireSession(TENANT, sessionId);
        assertThat(session.workspace().getCwdRelative())
                .isEqualTo("services/b");
        assertThat(session.workspace().getContextRevision()).isEqualTo(2);
        OperationRecord operation = fixture.store.findOperation(TENANT,
                sessionId, claimed.operationId()).orElseThrow();
        assertThat(operation.state()).isEqualTo("COMPLETED");
        assertThat(operation.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(operation.receiptId()).startsWith("rcpt_");
        assertThat(operation.resultContextRevision()).isEqualTo(2);
        assertThat(operation.leaseOwner()).isNull();

        List<Map<String, Object>> events = fixture.events(sessionId);
        assertThat(events).hasSize(2);
        JsonNode changed = fixture.event(events.get(1));
        assertThat(changed.path("type").asText())
                .isEqualTo("session.context.changed");
        assertThat(changed.path("data").path("workspaceId").asText())
                .isEqualTo(WS);
        assertThat(changed.path("data").path("cwdRelative").asText())
                .isEqualTo("services/b");
        assertThat(changed.path("data").path("contextRevision").asLong())
                .isEqualTo(2);
        assertThat(changed.path("data").path("operationId").asText())
                .isEqualTo(claimed.operationId());
        assertThat(changed.path("sourceKey").asText())
                .isEqualTo("operation:" + claimed.operationId()
                        + ":completed");

        // A second change walks the CAS forward and completes again.
        OperationAdmission next = begin(fixture, sessionId, "key-2",
                "digest-2", ".", 2);
        OperationRecord second = claim(fixture, sessionId,
                next.operation().operationId(), "owner");
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                sessionId, second.operationId(), "owner",
                second.claimGeneration()).resultContextRevision())
                .isEqualTo(3);
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getCwdRelative()).isEqualTo(".");
        assertThat(fixture.events(sessionId)).hasSize(3);
    }

    @Test
    void settlementFailsWithTypedCodesWhenFactsMove() {
        Fixture fixture = fixture(true);
        String movedId = fixture.createBoundSession(TENANT, WS);
        String movedOp = begin(fixture, movedId, "key",
                "digest", "a", 1).operation().operationId();
        OperationRecord movedClaim = claim(fixture, movedId, movedOp,
                "owner");
        fixture.jdbc.update("UPDATE managed_agent_session SET"
                        + " context_revision = 9 WHERE tenant_id = ? AND"
                        + " session_id = ?", TENANT, movedId);
        CwdChangeOutcome moved = fixture.store.completeCwdChangeOperation(
                TENANT, movedId, movedOp, "owner",
                movedClaim.claimGeneration());
        assertThat(moved.completed()).isFalse();
        assertThat(moved.failureCode())
                .isEqualTo("context_revision_conflict");
        assertFailed(fixture, movedId, movedOp,
                "context_revision_conflict");
        assertThat(fixture.store.requireSession(TENANT, movedId)
                .workspace().getContextRevision()).isEqualTo(9);
        assertThat(fixture.events(movedId)).hasSize(1);

        String busyId = fixture.createBoundSession(TENANT, WS);
        String busyOp = begin(fixture, busyId, "key",
                "digest", "a", 1).operation().operationId();
        OperationRecord busyClaim = claim(fixture, busyId, busyOp, "owner");
        fixture.insertTurn(busyId, "turn-late", "RUNNING");
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                busyId, busyOp, "owner",
                busyClaim.claimGeneration()).failureCode())
                .isEqualTo("session_context_busy");
        assertFailed(fixture, busyId, busyOp, "session_context_busy");

        String revokedId = fixture.createBoundSession(TENANT, WS);
        String revokedOp = begin(fixture, revokedId, "key",
                "digest", "a", 1).operation().operationId();
        OperationRecord revokedClaim = claim(fixture, revokedId, revokedOp,
                "owner");
        fixture.jdbc.update("UPDATE managed_workspace_access SET"
                        + " can_create = FALSE WHERE tenant_id = ? AND"
                        + " workspace_id = ?", TENANT, WS);
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                revokedId, revokedOp, "owner",
                revokedClaim.claimGeneration()).failureCode())
                .isEqualTo("workspace_unavailable");
        assertFailed(fixture, revokedId, revokedOp, "workspace_unavailable");
    }

    @Test
    void settlementHonoursTheClaimAndTheKind() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "a", 1).operation().operationId();
        OperationRecord claimed = claim(fixture, sessionId, operationId,
                "owner");
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                sessionId, operationId, "other",
                claimed.claimGeneration())).isNull();
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                sessionId, operationId, "owner",
                claimed.claimGeneration() + 1)).isNull();
        // The contested attempts left the claim and the operation intact:
        // the rightful claimant still settles.
        CwdChangeOutcome settled = fixture.store
                .completeCwdChangeOperation(TENANT, sessionId, operationId,
                        "owner", claimed.claimGeneration());
        assertThat(settled.completed()).isTrue();
        assertThat(settled.resultContextRevision()).isEqualTo(2);

        String legacyId = fixture.store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null,
                null, List.of(), null).sessionId();
        String closeId = fixture.store.beginOperation(TENANT, legacyId,
                OperationKind.CLOSE, "", "close", "digest").operation()
                .operationId();
        OperationRecord closeClaim = claim(fixture, legacyId, closeId,
                "owner");
        assertThatThrownBy(() -> fixture.store.completeCwdChangeOperation(
                TENANT, legacyId, closeId, "owner",
                closeClaim.claimGeneration()))
                .isInstanceOf(IllegalStateException.class);
    }

    // A target equal to the current directory is admitted and completes,
    // raising the revision: a legal re-validation transition.
    @Test
    void aSameDirectoryChangeCompletesAndBumpsTheRevision() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        OperationAdmission admission = begin(fixture, sessionId, "key",
                "digest", "services/api", 1);
        OperationRecord claimed = claim(fixture, sessionId,
                admission.operation().operationId(), "owner");
        CwdChangeOutcome outcome = fixture.store
                .completeCwdChangeOperation(TENANT, sessionId,
                        claimed.operationId(), "owner",
                        claimed.claimGeneration());
        assertThat(outcome.completed()).isTrue();
        assertThat(outcome.resultContextRevision()).isEqualTo(2);
        var session = fixture.store.requireSession(TENANT, sessionId);
        assertThat(session.workspace().getCwdRelative())
                .isEqualTo("services/api");
        assertThat(session.workspace().getContextRevision()).isEqualTo(2);
        assertThat(fixture.events(sessionId).stream()
                .map(fixture::event)
                .filter(event -> "session.context.changed"
                        .equals(event.path("type").asText()))
                .count()).isEqualTo(1);
    }

    // The tenant-scoped predicates close every cwd admission path before
    // the binding is even consulted: another tenant's Session is unreadable.
    @Test
    void admissionIsInvisibleAcrossTenants() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        assertThatThrownBy(() -> fixture.store.beginCwdChangeOperation(
                "tenant-b", sessionId, ACTOR, ACTOR_DIGEST, "key",
                "digest", "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));
    }

    // The refusal order is the design's post-precondition answer: a caller
    // outside the actor's scope never learns the state or the revision, and
    // a readable non-creator sees the sibling 403 before the state checks.
    @Test
    void actorRefusalPrecedesTheStateAndRevisionChecks() {
        Fixture fixture = fixture(true);
        String archivedId = fixture.createBoundSession(TENANT, WS);
        fixture.jdbc.update("UPDATE managed_agent_session SET status ="
                        + " 'ARCHIVED' WHERE tenant_id = ? AND"
                        + " session_id = ?", TENANT, archivedId);
        assertThatThrownBy(() -> begin(fixture, archivedId, "key",
                "digest", "a", 1, "stranger", "digest-stranger"))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));
        fixture.grant(TENANT, WS, "colleague", true, true);
        assertThatThrownBy(() -> begin(fixture, archivedId, "key",
                "digest", "a", 1, "colleague", "digest-colleague"))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.FORBIDDEN,
                                "session_operation_forbidden"));
        String activeId = fixture.createBoundSession(TENANT, WS);
        assertThatThrownBy(() -> begin(fixture, activeId, "key", "digest",
                "a", 7, "stranger", "digest-stranger"))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));
    }

    // A settled operation is final: a stale owner's claim-flipping write is
    // guarded by (LEASED, owner, generation), on both terminal shapes.
    @Test
    void aStaleOwnersFailureCannotRewriteASettledOperation() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        OperationRecord dead = fixture.store.claimOperation(TENANT,
                sessionId, operationId, "dead-owner",
                Duration.ofMillis(100)).orElseThrow();
        // The lease gates run on database time; expire the dead claim
        // directly instead of advancing the fixture clock.
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " lease_until = 0 WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_id = ?", TENANT, sessionId, operationId);
        OperationRecord alive = fixture.store.claimOperation(TENANT,
                sessionId, operationId, "owner", Duration.ofMillis(60_000))
                .orElseThrow();
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                sessionId, operationId, "owner",
                alive.claimGeneration()).completed()).isTrue();
        fixture.store.failCwdChangeOperation(TENANT, sessionId, operationId,
                "dead-owner", dead.claimGeneration(), "workspace_unavailable");
        OperationRecord settled = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(settled.state()).isEqualTo("COMPLETED");
        assertThat(settled.failureCode()).isNull();
        assertThat(settled.resultContextRevision()).isEqualTo(2);

        String secondId = fixture.createBoundSession(TENANT, WS);
        String secondOp = begin(fixture, secondId, "key", "digest", "a",
                1).operation().operationId();
        OperationRecord secondDead = fixture.store.claimOperation(TENANT,
                secondId, secondOp, "dead-owner", Duration.ofMillis(100))
                .orElseThrow();
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " lease_until = 0 WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_id = ?", TENANT, secondId, secondOp);
        OperationRecord secondAlive = fixture.store.claimOperation(TENANT,
                secondId, secondOp, "owner", Duration.ofMillis(60_000))
                .orElseThrow();
        fixture.store.failCwdChangeOperation(TENANT, secondId, secondOp,
                "owner", secondAlive.claimGeneration(),
                "workspace_unavailable");
        fixture.store.failCwdChangeOperation(TENANT, secondId, secondOp,
                "dead-owner", secondDead.claimGeneration(),
                "context_revision_conflict");
        assertThat(fixture.store.findOperation(TENANT, secondId, secondOp)
                .orElseThrow().failureCode())
                .isEqualTo("workspace_unavailable");
    }

    // The #13112 handshake from the W2 side: an open cwd operation is a
    // busy barrier for a bound later Turn, exactly as it is for another
    // operation; once the change settles, the Turn path is free again.
    @Test
    void anOpenOperationBlocksABoundLaterTurn() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        assertThatThrownBy(() -> fixture.store.insertTurnCommand(TENANT,
                "SUBMIT", "turn", "digest", sessionId, List.of(),
                "payload"))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_context_busy"));

        OperationRecord claimed = claim(fixture, sessionId, operationId,
                "owner");
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                sessionId, operationId, "owner",
                claimed.claimGeneration()).completed()).isTrue();
        var admitted = fixture.store.insertTurnCommand(TENANT, "SUBMIT",
                "turn", "digest", sessionId, List.of(), "payload");
        assertThat(admitted.turnId()).isNotBlank();
    }

    // A warmer with no Workspace Runtime cannot answer the probe: the
    // interface default refuses terminally, never loops the operation.
    @Test
    void coordinatorFailsTerminallyWithoutAWorkspaceRuntime() {
        Fixture fixture = fixture(true);
        SessionLifecycleCoordinator coordinator = fixture.coordinator(
                new RuntimeWarmer() {
                    @Override
                    public boolean isEnabled() {
                        return false;
                    }

                    @Override
                    public CompletionStage<Void> warm(String sessionId) {
                        return CompletableFuture.completedFuture(null);
                    }

                    @Override
                    public CompletionStage<Void> drain(String sessionId) {
                        return CompletableFuture.completedFuture(null);
                    }
                });
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        coordinator.dispatch(TENANT, sessionId, operationId);
        OperationRecord settled = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(settled.state()).isEqualTo("FAILED");
        assertThat(settled.failureCode()).isEqualTo("workspace_unavailable");
        assertThat(settled.attemptCount()).isEqualTo(0);
        assertThat(fixture.store.findDeliverableOperations(now.get(), 10))
                .isEmpty();
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getContextRevision()).isEqualTo(1);
    }

    // A terminal failure replays its original record: the wire contract for
    // a refused change is a new idempotency key, not a re-admission.
    @Test
    void terminalFailureReplaysItsOriginalRecord() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "a", 1).operation().operationId();
        OperationRecord claimed = claim(fixture, sessionId, operationId,
                "owner");
        fixture.jdbc.update("UPDATE managed_agent_session SET"
                        + " context_revision = 9 WHERE tenant_id = ? AND"
                        + " session_id = ?", TENANT, sessionId);
        assertThat(fixture.store.completeCwdChangeOperation(TENANT,
                sessionId, operationId, "owner",
                claimed.claimGeneration()).failureCode())
                .isEqualTo("context_revision_conflict");
        OperationAdmission replay = begin(fixture, sessionId, "key",
                "digest", "a", 1);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().state()).isEqualTo("FAILED");
        assertThat(replay.operation().failureCode())
                .isEqualTo("context_revision_conflict");
        assertThatThrownBy(() -> begin(fixture, sessionId, "key",
                "digest-other", "a", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "idempotency_conflict"));
    }

    @Test
    void coordinatorSettlesFailsTerminallyAndRetriesTransientErrors() {
        Fixture fixture = fixture(true);
        StubWarmer warmer = new StubWarmer();
        SessionLifecycleCoordinator coordinator = fixture.coordinator(
                warmer);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String first = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        coordinator.dispatch(TENANT, sessionId, first);
        assertThat(fixture.store.findOperation(TENANT, sessionId, first)
                .orElseThrow().state()).isEqualTo("COMPLETED");
        assertThat(warmer.verified).containsExactly("services/b");

        warmer.refuse(WorkspaceExecutionProbe.unavailable());
        String secondId = fixture.createBoundSession(TENANT, WS);
        String second = begin(fixture, secondId, "key", "digest", "gone",
                1).operation().operationId();
        coordinator.dispatch(TENANT, secondId, second);
        OperationRecord failed = fixture.store.findOperation(TENANT,
                secondId, second).orElseThrow();
        assertThat(failed.state()).isEqualTo("FAILED");
        assertThat(failed.failureCode()).isEqualTo("workspace_unavailable");
        assertThat(failed.attemptCount()).isEqualTo(0);
        assertThat(fixture.store.requireSession(TENANT, secondId)
                .workspace().getContextRevision()).isEqualTo(1);
        assertThat(fixture.store.findDeliverableOperations(now.get(), 10))
                .isEmpty();

        warmer.refuse(new IllegalStateException("transient"));
        String thirdId = fixture.createBoundSession(TENANT, WS);
        String third = begin(fixture, thirdId, "key", "digest", "c",
                1).operation().operationId();
        coordinator.dispatch(TENANT, thirdId, third);
        OperationRecord waiting = fixture.store.findOperation(TENANT,
                thirdId, third).orElseThrow();
        assertThat(waiting.state()).isEqualTo("RUNNING");
        assertThat(waiting.deliveryState()).isEqualTo("PENDING");
        assertThat(waiting.attemptCount()).isEqualTo(1);
        // The claim gate reads database time; make the backoff elapsed
        // instead of advancing the fixture clock.
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " available_at = 0 WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_id = ?", TENANT, thirdId, third);
        coordinator.dispatch(TENANT, thirdId, third);
        assertThat(fixture.store.findOperation(TENANT, thirdId, third)
                .orElseThrow().state()).isEqualTo("COMPLETED");
        assertThat(fixture.store.requireSession(TENANT, thirdId)
                .workspace().getContextRevision()).isEqualTo(2);
    }

    @Test
    void coordinatorReclaimsADeadOwnersClaimExactlyOnce() {
        Fixture fixture = fixture(true);
        SessionLifecycleCoordinator coordinator = fixture.coordinator(
                new StubWarmer());
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        OperationRecord dead = fixture.store.claimOperation(TENANT,
                sessionId, operationId, "dead-owner",
                Duration.ofMillis(100)).orElseThrow();
        assertThat(dead.deliveryState()).isEqualTo("LEASED");
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " lease_until = 0 WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_id = ?", TENANT, sessionId, operationId);
        coordinator.dispatch(TENANT, sessionId, operationId);
        OperationRecord settled = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(settled.state()).isEqualTo("COMPLETED");
        assertThat(settled.resultContextRevision()).isEqualTo(2);
        // A later scan sees nothing and the event was appended once.
        assertThat(fixture.store.findDeliverableOperations(now.get(), 10))
                .isEmpty();
        coordinator.dispatch(TENANT, sessionId, operationId);
        assertThat(fixture.events(sessionId).stream()
                .map(fixture::event)
                .filter(event -> "session.context.changed"
                        .equals(event.path("type").asText()))
                .count()).isEqualTo(1);
    }

    private static final String TENANT = "cwd-tenant";

    private static void assertRefusal(ApiException error, HttpStatus status,
            String code) {
        assertThat(error.getStatus()).isEqualTo(status);
        assertThat(error.getCode()).isEqualTo(code);
    }

    private static void assertFailed(Fixture fixture, String sessionId,
            String operationId, String code) {
        OperationRecord operation = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(operation.state()).isEqualTo("FAILED");
        assertThat(operation.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(operation.failureCode()).isEqualTo(code);
    }

    private OperationAdmission begin(Fixture fixture, String sessionId,
            String key, String digest, String target, long expected) {
        return begin(fixture, sessionId, key, digest, target, expected,
                ACTOR, ACTOR_DIGEST);
    }

    private OperationAdmission begin(Fixture fixture, String sessionId,
            String key, String digest, String target, long expected,
            String actor, String actorDigest) {
        return fixture.store.beginCwdChangeOperation(TENANT, sessionId,
                actor, actorDigest, key, digest, target, expected);
    }

    private OperationRecord claim(Fixture fixture, String sessionId,
            String operationId, String owner) {
        return fixture.store.claimOperation(TENANT, sessionId, operationId,
                owner, Duration.ofMillis(60_000)).orElseThrow();
    }

    private Fixture fixture(boolean workspaceFilesEnabled) {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:cwd-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness()
                .setWorkspaceFilesEnabled(workspaceFilesEnabled);
        Clock clock = new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return Instant.ofEpochMilli(now.get());
            }
        };
        ObjectMapper mapper = new ObjectMapper();
        ManagedAgentStore store = new ManagedAgentStore(jdbc, mapper, clock,
                ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc), properties);
        return new Fixture(store, jdbc, mapper, properties, clock);
    }

    private final class Fixture {
        private final ManagedAgentStore store;
        private final JdbcTemplate jdbc;
        private final ObjectMapper mapper;
        private final ManagedAgentProperties properties;
        private final Clock clock;

        Fixture(ManagedAgentStore store, JdbcTemplate jdbc,
                ObjectMapper mapper, ManagedAgentProperties properties,
                Clock clock) {
            this.store = store;
            this.jdbc = jdbc;
            this.mapper = mapper;
            this.properties = properties;
            this.clock = clock;
        }

        String createBoundSession(String tenant, String workspaceId) {
            return new TransactionTemplate(
                    new DataSourceTransactionManager(jdbc.getDataSource()))
                    .execute(status -> {
                        jdbc.update("INSERT INTO"
                                + " managed_workspace_registry (tenant_id,"
                                + " workspace_id, workspace_generation,"
                                + " storage_id, display_name, config_ref,"
                                + " policy_ref, state) VALUES (?, ?, 1, ?,"
                                + " ?, 'config', 'policy', 'ACTIVE') ON"
                                + " DUPLICATE KEY UPDATE workspace_id ="
                                + " workspace_id", tenant, workspaceId,
                                STORAGE, workspaceId);
                        grant(tenant, workspaceId, ACTOR, true, true);
                        return store.insertWorkspaceSessionCommand(tenant,
                                ACTOR, "create-" + UUID.randomUUID(),
                                "create-digest", "qwen-code", null, null,
                                List.of(), null, new WorkspaceSelection(
                                        workspaceId, "services/api"))
                                .sessionId();
                    });
        }

        void grant(String tenant, String workspaceId, String actor,
                boolean read, boolean create) {
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                            + " workspace_id, actor_id, can_read,"
                            + " can_create) VALUES (?, ?, ?, ?, ?)"
                            + " ON DUPLICATE KEY UPDATE actor_id = actor_id",
                    tenant, workspaceId, actor.getBytes(java.nio.charset
                            .StandardCharsets.UTF_8), read, create);
        }

        void insertTurn(String sessionId, String turnId, String status) {
            jdbc.update("INSERT INTO managed_agent_turn (tenant_id,"
                            + " session_id, turn_id, prompt_id, input_json,"
                            + " payload_digest, status, created_at,"
                            + " updated_at) VALUES (?, ?, ?, ?, '[]',"
                            + " 'digest', ?, 0, 0)", TENANT, sessionId,
                    turnId, UUID.randomUUID().toString(), status);
        }

        List<Map<String, Object>> events(String sessionId) {
            return jdbc.queryForList("SELECT data_json, event_type,"
                            + " source_key FROM managed_agent_event WHERE"
                            + " tenant_id = ? AND session_id = ? ORDER BY"
                            + " sequence_id", TENANT, sessionId);
        }

        JsonNode event(Map<String, Object> row) {
            try {
                var node = mapper.readTree(
                        (String) row.get("data_json"));
                var envelope = mapper.createObjectNode();
                envelope.set("data", node);
                envelope.put("type", (String) row.get("event_type"));
                envelope.put("sourceKey", (String) row.get("source_key"));
                return envelope;
            } catch (Exception error) {
                throw new IllegalStateException(error);
            }
        }

        SessionLifecycleCoordinator coordinator(RuntimeWarmer warmer) {
            return new SessionLifecycleCoordinator(store, null, null,
                    warmer, new AbstractExecutorService() {
                        @Override
                        public void shutdown() {
                        }

                        @Override
                        public List<Runnable> shutdownNow() {
                            return List.of();
                        }

                        @Override
                        public boolean isShutdown() {
                            return false;
                        }

                        @Override
                        public boolean isTerminated() {
                            return false;
                        }

                        @Override
                        public boolean awaitTermination(long timeout,
                                TimeUnit unit) {
                            return true;
                        }

                        @Override
                        public void execute(Runnable command) {
                            command.run();
                        }
                    }, clock, properties);
        }
    }

    private static final class StubWarmer implements RuntimeWarmer {
        private final java.util.Queue<RuntimeException> behaviors =
                new ConcurrentLinkedQueue<>();
        private final List<String> verified = new CopyOnWriteArrayList<>();

        @Override
        public boolean isEnabled() {
            return true;
        }

        @Override
        public CompletionStage<Void> warm(String sessionId) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Void> drain(String sessionId) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public void verifyWorkspaceCwdTarget(ContextBinding binding,
                String targetCwdRelative) {
            verified.add(targetCwdRelative);
            RuntimeException behavior = behaviors.poll();
            if (behavior != null) {
                throw behavior;
            }
        }

        void refuse(RuntimeException error) {
            behaviors.add(error);
        }
    }

    private static final class WorkspaceExecutionProbe {
        private static RuntimeBrokerException unavailable() {
            return new RuntimeBrokerException(409, "workspace_unavailable",
                    "workspace", false);
        }
    }
}

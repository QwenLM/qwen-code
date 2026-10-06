package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.service.SessionLifecycleCoordinator;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.CwdChangeOutcome;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
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
        assertThat(settle(fixture,
                sessionId, claimed.operationId(), "owner",
                claimed.claimGeneration()).completed()).isTrue();
        OperationAdmission replay = begin(fixture, sessionId, "key-1",
                "digest-1", "services/b", 1);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().state()).isEqualTo("COMPLETED");
        assertThat(replay.operation().resultContextRevision()).isEqualTo(2);
    }

    @Test
    void migrationFenceRefusesFreshCwdChangesButPreservesReceiptsAndOtherStorage() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String other = fixture.createBoundSession(TENANT, "ws-other");
        fixture.jdbc.update("UPDATE managed_workspace_registry SET storage_id = 'other-storage'"
                + " WHERE workspace_id = 'ws-other'");
        fixture.jdbc.update("UPDATE managed_agent_session SET workspace_storage_id = 'other-storage'"
                + " WHERE session_id = ?", other);
        OperationAdmission first = begin(fixture, sessionId, "old", "digest", "services/b", 1);
        OperationRecord claimed = claim(fixture, sessionId, first.operation().operationId(), "owner");
        assertThat(settle(fixture, sessionId, claimed.operationId(), "owner", claimed.claimGeneration()).completed()).isTrue();
        var binding = fixture.store.findSession(TENANT, sessionId).orElseThrow().workspace();
        installMigrationFence(fixture);
        OperationAdmission replay = begin(fixture, sessionId, "old", "digest", "services/b", 1);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().operationId()).isEqualTo(first.operation().operationId());
        assertThatThrownBy(() -> begin(fixture, sessionId, "fresh", "digest", "services/c", 2))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isFalse();
                });
        assertThat(fixture.store.findSession(TENANT, sessionId).orElseThrow().workspace()).isEqualTo(binding);
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_operation WHERE session_id = ?",
                Integer.class, sessionId)).isEqualTo(1);
        OperationRecord otherClaim = claim(fixture, other,
                begin(fixture, other, "fresh", "digest", "services/b", 1).operation().operationId(), "other-owner");
        assertThat(settle(fixture, other, otherClaim.operationId(), "other-owner", otherClaim.claimGeneration()).completed()).isTrue();
    }

    @Test
    void fenceInstalledAfterProbeFailsSettlementWithoutChangingTheBinding() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        var binding = fixture.store.findSession(TENANT, sessionId).orElseThrow().workspace();
        OperationRecord claimed = claim(fixture, sessionId,
                begin(fixture, sessionId, "key", "digest", "services/b", 1).operation().operationId(), "owner");
        installMigrationFence(fixture);
        CwdChangeOutcome outcome = settle(fixture, sessionId, claimed.operationId(), "owner", claimed.claimGeneration());
        assertThat(outcome.completed()).isFalse();
        assertThat(outcome.failureCode()).isEqualTo("workspace_unavailable");
        assertFailed(fixture, sessionId, claimed.operationId(), "workspace_unavailable");
        assertThat(fixture.store.findOperation(TENANT, sessionId, claimed.operationId()).orElseThrow().leaseOwner()).isNull();
        assertThat(fixture.store.findSession(TENANT, sessionId).orElseThrow().workspace()).isEqualTo(binding);
        assertThat(fixture.events(sessionId).stream().map(fixture::event)
                .filter(event -> "session.context.changed".equals(event.path("type").asText()))).isEmpty();
    }

    private void installMigrationFence(Fixture fixture) {
        fixture.jdbc.update("INSERT INTO qwen_runtime_storage_fence VALUES (?, ?, ?, ?, ?)",
                JdbcRuntimeBindingRepository.storageFenceKey(TENANT), JdbcRuntimeBindingRepository.storageFenceKey(STORAGE),
                TENANT, STORAGE, UUID.randomUUID().toString());
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
        // The deployment gate opens only after the actor check: a stranger
        // must not read the flag from its refusal either.
        assertThatThrownBy(() -> begin(disabled, gatedId, "key", "digest",
                "a", 1, "stranger", "digest-stranger"))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));

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

    // A revoked read grant must also close the replay path: the actor
    // lookup precedes the idempotency replay, so a caller whose grants are
    // gone learns nothing about a key or an operation it once knew.
    @Test
    void aRevokedReadGrantMakesTheReplayInvisible() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        OperationAdmission admitted = begin(fixture, sessionId, "key",
                "digest", "services/b", 1);
        assertThat(admitted.replayed()).isFalse();
        fixture.jdbc.update("UPDATE managed_workspace_access SET"
                + " can_read = FALSE WHERE tenant_id = ? AND"
                + " workspace_id = ? AND actor_id = ?", TENANT, WS,
                ACTOR.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertThatThrownBy(() -> begin(fixture, sessionId, "key", "digest",
                "services/b", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.NOT_FOUND,
                                "session_not_found"));
    }

    // The idempotency contract outranks a later flag flip: a lost 202
    // resolves through the original operation even with execution disabled
    // meanwhile, while a fresh key still hits the deployment gate.
    @Test
    void replayOutranksALaterDeploymentFlagFlip() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        OperationAdmission first = begin(fixture, sessionId, "key",
                "digest", "services/b", 1);
        ManagedAgentProperties disabled = new ManagedAgentProperties();
        disabled.getHarness().setWorkspaceFilesEnabled(false);
        disabled.getRuntimeBroker().setProvisioner("local-process");
        disabled.getRuntimeBroker().setIsolationClass("session");
        ManagedAgentStore gated = new ManagedAgentStore(fixture.jdbc,
                fixture.mapper, fixture.clock, ignored -> {
                }, new ManagedWorkspaceRegistry(fixture.jdbc), disabled);
        OperationAdmission replay = gated.beginCwdChangeOperation(TENANT,
                sessionId, ACTOR, ACTOR_DIGEST, "key", "digest",
                "services/b", 1);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().operationId())
                .isEqualTo(first.operation().operationId());
        assertThatThrownBy(() -> gated.beginCwdChangeOperation(TENANT,
                sessionId, ACTOR, ACTOR_DIGEST, "key-2", "digest-2",
                "services/b", 1))
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
        CwdChangeOutcome outcome = settle(fixture, sessionId,
                claimed.operationId(), "owner", claimed.claimGeneration());
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
        assertThat(settle(fixture,
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
        CwdChangeOutcome moved = settle(fixture, movedId, movedOp, "owner",
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
        assertThat(settle(fixture,
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
        assertThat(settle(fixture,
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
        assertThat(settle(fixture,
                sessionId, operationId, "other",
                claimed.claimGeneration())).isNull();
        assertThat(settle(fixture,
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
        assertThatThrownBy(() -> settle(fixture, legacyId, closeId, "owner",
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

    // The busy barrier is symmetric: an open cwd operation refuses a
    // lifecycle admission the way an open lifecycle operation refuses cwd.
    @Test
    void anOpenOperationBlocksALifecycleAdmission() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        begin(fixture, sessionId, "key", "digest", "services/b", 1);
        assertThatThrownBy(() -> fixture.store.beginWorkspaceLifecycle(TENANT,
                sessionId, OperationKind.CLOSE, ACTOR, ACTOR_DIGEST, "close",
                "close-digest", true))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_operation_active"));
    }

    // A settled operation is final on both terminal shapes, and each of
    // failCwdChangeOperation's four fence conjuncts — delivery state,
    // owner, generation, live lease — refuses the stale write alone.
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
        assertThat(settle(fixture,
                sessionId, operationId, "owner",
                alive.claimGeneration()).completed()).isTrue();
        // A CONFIRMED row laughs at a stale owner's write: the delivery
        // conjunct alone refuses it.
        assertThat(fixture.store.failCwdChangeOperation(TENANT, sessionId,
                operationId, "dead-owner", dead.claimGeneration(),
                "context_revision_conflict")).isFalse();
        OperationRecord settled = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(settled.state()).isEqualTo("COMPLETED");
        assertThat(settled.failureCode()).isNull();
        assertThat(settled.resultContextRevision()).isEqualTo(2);

        // On a live, unsettled row, owner and generation each refuse alone.
        String secondId = fixture.createBoundSession(TENANT, WS);
        String secondOp = begin(fixture, secondId, "key", "digest", "a",
                1).operation().operationId();
        OperationRecord live = fixture.store.claimOperation(TENANT,
                secondId, secondOp, "owner", Duration.ofMillis(60_000))
                .orElseThrow();
        assertThat(fixture.store.failCwdChangeOperation(TENANT, secondId,
                secondOp, "other", live.claimGeneration(),
                "context_revision_conflict")).isFalse();
        assertThat(fixture.store.failCwdChangeOperation(TENANT, secondId,
                secondOp, "owner", live.claimGeneration() + 1,
                "context_revision_conflict")).isFalse();
        // Neither refusal touched the claim: the rightful owner settles.
        assertThat(fixture.store.failCwdChangeOperation(TENANT, secondId,
                secondOp, "owner", live.claimGeneration(),
                "workspace_unavailable")).isTrue();
        assertThat(fixture.store.findOperation(TENANT, secondId, secondOp)
                .orElseThrow().failureCode())
                .isEqualTo("workspace_unavailable");

        // An expired lease alone refuses, until a fresh claimant arrives.
        String thirdId = fixture.createBoundSession(TENANT, WS);
        String thirdOp = begin(fixture, thirdId, "key", "digest", "a",
                1).operation().operationId();
        OperationRecord expiring = fixture.store.claimOperation(TENANT,
                thirdId, thirdOp, "owner", Duration.ofMillis(60_000))
                .orElseThrow();
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " lease_until = 0 WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_id = ?", TENANT, thirdId, thirdOp);
        assertThat(fixture.store.failCwdChangeOperation(TENANT, thirdId,
                thirdOp, "owner", expiring.claimGeneration(),
                "workspace_unavailable")).isFalse();

        // The delivery conjunct alone: a live lease parked in a non-LEASED
        // delivery state cannot be flipped, and flipping back releases it.
        String fourthId = fixture.createBoundSession(TENANT, WS);
        String fourthOp = begin(fixture, fourthId, "key", "digest", "a",
                1).operation().operationId();
        OperationRecord parked = fixture.store.claimOperation(TENANT,
                fourthId, fourthOp, "owner", Duration.ofMillis(60_000))
                .orElseThrow();
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " delivery_state = 'BLOCKED' WHERE tenant_id = ? AND"
                + " session_id = ? AND operation_id = ?", TENANT, fourthId,
                fourthOp);
        assertThat(fixture.store.failCwdChangeOperation(TENANT, fourthId,
                fourthOp, "owner", parked.claimGeneration(),
                "workspace_unavailable")).isFalse();
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " delivery_state = 'LEASED' WHERE tenant_id = ? AND"
                + " session_id = ? AND operation_id = ?", TENANT, fourthId,
                fourthOp);
        assertThat(fixture.store.failCwdChangeOperation(TENANT, fourthId,
                fourthOp, "owner", parked.claimGeneration(),
                "workspace_unavailable")).isTrue();
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
        // A cancel is still admitted while the operation is open — it
        // carries no completed-command wedge and does not disturb the
        // in-flight settlement.
        fixture.insertTurn(sessionId, "turn-completed", "COMPLETED");
        assertThat(fixture.store.insertCancelCommand(TENANT, "CANCEL",
                "cancel-key", "digest", sessionId, "turn-completed"))
                .isNotNull();

        OperationRecord claimed = claim(fixture, sessionId, operationId,
                "owner");
        assertThat(settle(fixture,
                sessionId, operationId, "owner",
                claimed.claimGeneration()).completed()).isTrue();
        var admitted = fixture.store.insertTurnCommand(TENANT, "SUBMIT",
                "turn", "digest", sessionId, List.of(), "payload");
        assertThat(admitted.turnId()).isNotBlank();
    }

    // The later-Turn barrier counts context-changing operations only: a
    // stuck display mutation (a killed rename) and an in-flight permission
    // Action must not wedge Turn admission.
    @Test
    void theTurnBarrierIgnoresMutationsAndActions() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        fixture.store.beginSessionMutation(TENANT, "rename", "rename-key",
                "rename-digest", sessionId, SessionMutationKind.RENAME);
        var afterMutation = fixture.store.insertTurnCommand(TENANT,
                "SUBMIT", "turn-mutation", "digest", sessionId, List.of(),
                "payload");
        assertThat(afterMutation.turnId()).isNotBlank();

        String secondId = fixture.createBoundSession(TENANT, WS);
        fixture.jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                + " session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state,"
                + " admission_stage, delivery_state, session_status_before,"
                + " available_at, created_at, updated_at) VALUES (?, ?, ?,"
                + " 'ACTION_RESPONSE', 'actor', 'action-key', 'digest',"
                + " 'RUNNING', 'JAVA_DURABLE', 'PENDING', 'ACTIVE', 0, 0,"
                + " 0)", TENANT, secondId, "action-op");
        var afterAction = fixture.store.insertTurnCommand(TENANT, "SUBMIT",
                "turn-action", "digest", secondId, List.of(), "payload");
        assertThat(afterAction.turnId()).isNotBlank();
    }

    // The legacy Turn route keeps its pre-W2 behavior: the workspace gate
    // keeps the new barrier off unbound Sessions even with an in-flight
    // ACTION_RESPONSE operation open.
    @Test
    void theTurnBarrierLeavesTheLegacyRouteUntouched() {
        Fixture fixture = fixture(true);
        String legacyId = fixture.store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null,
                null, List.of(), null).sessionId();
        fixture.jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                + " session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state,"
                + " admission_stage, delivery_state, session_status_before,"
                + " available_at, created_at, updated_at) VALUES (?, ?, ?,"
                + " 'ACTION_RESPONSE', 'actor', 'action-key', 'digest',"
                + " 'RUNNING', 'JAVA_DURABLE', 'PENDING', 'ACTIVE', 0, 0,"
                + " 0)", TENANT, legacyId, "action-op");
        var admitted = fixture.store.insertTurnCommand(TENANT, "SUBMIT",
                "turn", "digest", legacyId, List.of(), "payload");
        assertThat(admitted.turnId()).isNotBlank();

        // The workspace==null gate is load-bearing: with a non-action
        // open operation on the unbound Session, a Turn is still admitted.
        String olderId = fixture.store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create-2", "digest-2", "qwen-code",
                null, null, List.of(), null).sessionId();
        fixture.jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                + " session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state,"
                + " admission_stage, delivery_state, session_status_before,"
                + " available_at, created_at, updated_at) VALUES (?, ?, ?,"
                + " 'CLOSE', 'actor', 'close-key', 'digest',"
                + " 'PENDING', 'JAVA_DURABLE', 'PENDING', 'ACTIVE', 0, 0,"
                + " 0)", TENANT, olderId, "close-op");
        var second = fixture.store.insertTurnCommand(TENANT, "SUBMIT",
                "turn-2", "digest-2", olderId, List.of(), "payload-2");
        assertThat(second.turnId()).isNotBlank();
    }

    // A terminally failed operation releases both admission surfaces: the
    // lifecycle barrier is free again, and a bound later Turn is free
    // again — a failed change must never wedge the Session.
    @Test
    void aFailedSettlementReleasesBothAdmissionSurfaces() {
        Fixture fixture = fixture(true);
        String lifecycleId = fixture.createBoundSession(TENANT, WS);
        String failingOp = begin(fixture, lifecycleId, "key", "digest",
                "services/b", 1).operation().operationId();
        OperationRecord failingClaim = claim(fixture, lifecycleId,
                failingOp, "owner");
        fixture.jdbc.update("UPDATE managed_agent_session SET"
                + " context_revision = 9 WHERE tenant_id = ? AND"
                + " session_id = ?", TENANT, lifecycleId);
        assertThat(settle(fixture, lifecycleId, failingOp, "owner",
                failingClaim.claimGeneration()).failureCode())
                .isEqualTo("context_revision_conflict");
        assertFailed(fixture, lifecycleId, failingOp,
                "context_revision_conflict");
        var close = fixture.store.beginWorkspaceLifecycle(TENANT,
                lifecycleId, OperationKind.CLOSE, ACTOR, ACTOR_DIGEST,
                "close", "close-digest", true);
        assertThat(close.operation().state()).isEqualTo("PENDING");

        String turnId = fixture.createBoundSession(TENANT, WS);
        String otherOp = begin(fixture, turnId, "key", "digest",
                "services/b", 1).operation().operationId();
        OperationRecord otherClaim = claim(fixture, turnId, otherOp,
                "owner");
        fixture.jdbc.update("UPDATE managed_agent_session SET"
                + " context_revision = 9 WHERE tenant_id = ? AND"
                + " session_id = ?", TENANT, turnId);
        assertThat(settle(fixture, turnId, otherOp, "owner",
                otherClaim.claimGeneration()).failureCode())
                .isEqualTo("context_revision_conflict");
        assertFailed(fixture, turnId, otherOp, "context_revision_conflict");
        var admitted = fixture.store.insertTurnCommand(TENANT, "SUBMIT",
                "turn", "digest", turnId, List.of(), "payload");
        assertThat(admitted.turnId()).isNotBlank();
    }

    // A requested permission Action holds the Session busy at admission
    // (exactly like the sibling lifecycle's 409 turn_active) and at the
    // settlement re-check; an answered-or-expired one releases it.
    @Test
    void aRequestedActionBlocksAdmissionAndSettlement() {
        Fixture fixture = fixture(true);
        // First the conjunct alone: a requested Action with no op and no
        // Turn refuses admission all by itself.
        String isolated = fixture.createBoundSession(TENANT, WS);
        long future = System.currentTimeMillis() + 86_400_000L;
        fixture.insertAction(isolated, "approval-iso", future);
        assertThatThrownBy(() -> begin(fixture, isolated, "key-iso",
                "digest-iso", "services/b", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_context_busy"));
        fixture.jdbc.update("DELETE FROM managed_agent_action WHERE"
                + " action_id = 'approval-iso'");
        String sessionId = fixture.createBoundSession(TENANT, WS);
        begin(fixture, sessionId, "key", "digest", "services/b", 1);
        fixture.insertAction(sessionId, "approval-1", future);
        assertThatThrownBy(() -> begin(fixture, sessionId, "key-2",
                "digest-2", "services/c", 1))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertRefusal(error, HttpStatus.CONFLICT,
                                "session_context_busy"));

        String secondId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, secondId, "key", "digest",
                "services/b", 1).operation().operationId();
        OperationRecord claimed = claim(fixture, secondId, operationId,
                "owner");
        fixture.insertAction(secondId, "approval-2", future);
        assertThat(settle(fixture, secondId, operationId, "owner",
                claimed.claimGeneration()).failureCode())
                .isEqualTo("session_context_busy");
        assertThat(fixture.store.requireSession(TENANT, secondId)
                .workspace().getContextRevision()).isEqualTo(1);

        fixture.jdbc.update("DELETE FROM managed_agent_action WHERE"
                + " action_id = 'approval-2'");
        // The typed failure is terminal for that row; a re-issue over the
        // same Session settles now that the Action is gone.
        String reissued = begin(fixture, secondId, "key-r", "digest-r",
                "services/b", 1).operation().operationId();
        OperationRecord released = claim(fixture, secondId, reissued,
                "owner");
        assertThat(settle(fixture, secondId, reissued, "owner",
                released.claimGeneration()).completed()).isTrue();
        assertThat(fixture.store.requireSession(TENANT, secondId)
                .workspace().getContextRevision()).isEqualTo(2);
    }

    // A binding detached between claim and commit is workspace_unavailable,
    // not context_revision_conflict: the Session has no Workspace at all.
    @Test
    void settlementFailsWorkspaceUnavailableWhenTheBindingDisappears() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        OperationRecord claimed = claim(fixture, sessionId, operationId,
                "owner");
        fixture.jdbc.update("UPDATE managed_agent_session SET"
                + " workspace_id = NULL, workspace_generation = NULL,"
                + " workspace_storage_id = NULL, cwd_relative = NULL,"
                + " context_config_ref = NULL, context_revision = NULL,"
                + " workspace_config_ref = NULL, workspace_policy_ref ="
                + " NULL WHERE tenant_id = ? AND session_id = ?", TENANT,
                sessionId);
        assertThat(settle(fixture, sessionId, operationId, "owner",
                claimed.claimGeneration()).failureCode())
                .isEqualTo("workspace_unavailable");
        assertFailed(fixture, sessionId, operationId,
                "workspace_unavailable");
    }

    // The settlement's wide busy barrier also counts a second open
    // operation — a permission-action response here cannot ride underneath
    // a committed directory change either.
    @Test
    void settlementBlocksOnAnotherOpenOperation() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        fixture.jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                + " session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, request_digest, state,"
                + " admission_stage, delivery_state, session_status_before,"
                + " available_at, created_at, updated_at) VALUES (?, ?, ?,"
                + " 'ACTION_RESPONSE', 'actor', 'action-key', 'digest',"
                + " 'PENDING', 'JAVA_DURABLE', 'PENDING', 'ACTIVE', 0, 0, 0)",
                TENANT, sessionId, "action-op");
        OperationRecord claimed = claim(fixture, sessionId, operationId,
                "owner");
        assertThat(settle(fixture, sessionId, operationId, "owner",
                claimed.claimGeneration()).failureCode())
                .isEqualTo("session_context_busy");
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getContextRevision()).isEqualTo(1);
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getCwdRelative()).isEqualTo("services/api");
    }

    // A Session that stopped being ACTIVE between claim and commit fails
    // terminally and never moves: the status re-check is the first line of
    // the commit transaction's fact verification.
    @Test
    void settlementRefusesAnInactiveSession() {
        Fixture fixture = fixture(true);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        OperationRecord claimed = claim(fixture, sessionId, operationId,
                "owner");
        fixture.jdbc.update("UPDATE managed_agent_session SET status ="
                + " 'CLOSED' WHERE tenant_id = ? AND session_id = ?",
                TENANT, sessionId);
        assertThat(settle(fixture, sessionId, operationId, "owner",
                claimed.claimGeneration()).failureCode())
                .isEqualTo("workspace_unavailable");
        assertFailed(fixture, sessionId, operationId,
                "workspace_unavailable");
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getContextRevision()).isEqualTo(1);
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getCwdRelative()).isEqualTo("services/api");
    }

    // A Workspace detached between admission and settlement is a typed
    // terminal refusal — the coordinator's null-binding guard converts it
    // to workspace_unavailable instead of an NPE retry loop.
    @Test
    void settlementFailsTerminallyWhenTheBindingDisappears() {
        Fixture fixture = fixture(true);
        SessionLifecycleCoordinator coordinator = fixture.coordinator(
                new StubWarmer());
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        fixture.jdbc.update("UPDATE managed_agent_session SET"
                + " workspace_id = NULL, workspace_generation = NULL,"
                + " workspace_storage_id = NULL, cwd_relative = NULL,"
                + " context_config_ref = NULL, context_revision = NULL,"
                + " workspace_config_ref = NULL, workspace_policy_ref ="
                + " NULL WHERE tenant_id = ? AND session_id = ?", TENANT,
                sessionId);
        coordinator.dispatch(TENANT, sessionId, operationId);
        assertFailed(fixture, sessionId, operationId,
                "workspace_unavailable");
        OperationRecord failed = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(failed.attemptCount()).isZero();
        assertThat(fixture.store.findDeliverableOperations(System.currentTimeMillis(), 10)).isEmpty();
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
        assertThat(fixture.store.findDeliverableOperations(System.currentTimeMillis(), 10))
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
        assertThat(settle(fixture,
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
        assertThat(warmer.bindings.get(0).getWorkspaceId()).isEqualTo(WS);

        warmer.refuse(WorkspaceExecutionStore.unavailable());
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
        assertThat(fixture.store.findDeliverableOperations(System.currentTimeMillis(), 10))
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
        // instead of advancing the fixture clock, and let the recovery scan
        // — not a manual dispatch — rediscover the retried operation.
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " available_at = 0 WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_id = ?", TENANT, thirdId, third);
        coordinator.recoverOperations();
        assertThat(fixture.store.findOperation(TENANT, thirdId, third)
                .orElseThrow().state()).isEqualTo("COMPLETED");
        assertThat(fixture.store.requireSession(TENANT, thirdId)
                .workspace().getContextRevision()).isEqualTo(2);
    }

    // The delivery machine consults isRetryable() on the probe's broker
    // refusal: a momentary mount failure (ESTALE/EIO class) re-enters the
    // backoff instead of certifying a permanent failure. Removing the
    // consult (if (false ...)) must turn this block's RUNNING line red —
    // the round-4 observable-split finding was that nothing could.
    @Test
    void coordinatorRetriesARetryableProbeRefusalThenSettles() {
        Fixture fixture = fixture(true);
        StubWarmer warmer = new StubWarmer();
        SessionLifecycleCoordinator coordinator = fixture.coordinator(
                warmer);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        warmer.refuse(WorkspaceExecutionStore.unavailableTransient(
                new java.io.IOException("stale mount handle")));
        coordinator.dispatch(TENANT, sessionId, operationId);
        OperationRecord waiting = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(waiting.state()).isEqualTo("RUNNING");
        assertThat(waiting.deliveryState()).isEqualTo("PENDING");
        assertThat(waiting.attemptCount()).isEqualTo(1);
        assertThat(waiting.failureCode()).isNull();
        fixture.jdbc.update("UPDATE managed_agent_operation SET"
                + " available_at = 0 WHERE tenant_id = ? AND session_id = ?"
                + " AND operation_id = ?", TENANT, sessionId, operationId);
        coordinator.recoverOperations();
        assertThat(fixture.store.findOperation(TENANT, sessionId, operationId)
                .orElseThrow().state()).isEqualTo("COMPLETED");
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getContextRevision()).isEqualTo(2);
    }

    // The budget bounds the wedge: a probe that never stops failing
    // transiently settles with the typed terminal failure after the attempt
    // budget runs out — the row leaves the deliverable set and BOTH
    // admission barriers re-open, so a retired NFS/FUSE export never
    // strands a Session behind session_context_busy /
    // session_operation_active with only database surgery as a way out.
    // Removing the budget turns this red: the operation would stay RUNNING
    // past 8 attempts. (8 must equal the coordinator's attempt budget.)
    @Test
    void coordinatorFailsTerminallyWhenTheProbeBudgetIsExhausted() {
        Fixture fixture = fixture(true);
        StubWarmer warmer = new StubWarmer();
        SessionLifecycleCoordinator coordinator = fixture.coordinator(
                warmer);
        String sessionId = fixture.createBoundSession(TENANT, WS);
        String operationId = begin(fixture, sessionId, "key", "digest",
                "services/b", 1).operation().operationId();
        warmer.refuseAlways(WorkspaceExecutionStore.unavailableTransient(
                new java.io.IOException("stale mount handle")));
        coordinator.dispatch(TENANT, sessionId, operationId);
        for (int attempts = 2; attempts <= 8; attempts++) {
            OperationRecord waiting = fixture.store.findOperation(TENANT,
                    sessionId, operationId).orElseThrow();
            assertThat(waiting.state()).isEqualTo("RUNNING");
            fixture.jdbc.update("UPDATE managed_agent_operation SET"
                    + " available_at = 0 WHERE tenant_id = ? AND"
                    + " session_id = ? AND operation_id = ?", TENANT,
                    sessionId, operationId);
            coordinator.recoverOperations();
        }
        OperationRecord failed = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(failed.state()).isEqualTo("FAILED");
        assertThat(failed.failureCode()).isEqualTo("workspace_unavailable");
        // The 8th attempt exhausts the budget and writes the terminal row
        // instead of scheduling retry number 8 — attempts stay at 7.
        assertThat(failed.attemptCount()).isEqualTo(7);
        assertThat(fixture.store.findDeliverableOperations(
                System.currentTimeMillis(), 10)).isEmpty();
        // The Session row itself never moved.
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getContextRevision()).isEqualTo(1);
        assertThat(fixture.store.requireSession(TENANT, sessionId)
                .workspace().getCwdRelative()).isEqualTo("services/api");
        // Both admission barriers re-open: a fresh change admits with a
        // new key and settles, then the later-Turn route answers again.
        warmer.clearRefusals();
        String retry = begin(fixture, sessionId, "key-after",
                "digest-after", "services/c", 1).operation().operationId();
        OperationRecord reClaimed = claim(fixture, sessionId, retry,
                "owner");
        assertThat(settle(fixture, sessionId, retry, "owner",
                reClaimed.claimGeneration()).completed()).isTrue();
        var admitted = fixture.store.insertTurnCommand(TENANT, "SUBMIT",
                "turn-after", "digest", sessionId, List.of(), "payload");
        assertThat(admitted.turnId()).isNotBlank();
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
        // The recovery scan itself must see an expired cwd claim: a row it
        // cannot see would strand the Session behind session_context_busy
        // and session_operation_active forever.
        coordinator.recoverOperations();
        OperationRecord settled = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(settled.state()).isEqualTo("COMPLETED");
        assertThat(settled.resultContextRevision()).isEqualTo(2);
        // A later scan sees nothing and the event was appended once.
        assertThat(fixture.store.findDeliverableOperations(System.currentTimeMillis(), 10))
                .isEmpty();
        coordinator.dispatch(TENANT, sessionId, operationId);
        OperationRecord after = fixture.store.findOperation(TENANT,
                sessionId, operationId).orElseThrow();
        assertThat(after.state()).isEqualTo("COMPLETED");
        assertThat(after.resultContextRevision()).isEqualTo(2);
        assertThat(after.failureCode()).isNull();
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

    // Settles through an explicit transaction, as production's Spring
    // proxy runs the annotated store method.
    private CwdChangeOutcome settle(Fixture fixture, String sessionId,
            String operationId, String owner, long claimGeneration) {
        return fixture.tx(() -> fixture.store.completeCwdChangeOperation(
                TENANT, sessionId, operationId, owner, claimGeneration));
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

        // Runs the settlement the way production's Spring proxy does — in
        // one transaction, not one auto-commit per write.
        <T> T tx(java.util.function.Supplier<T> call) {
            return new TransactionTemplate(
                    new DataSourceTransactionManager(jdbc.getDataSource()))
                    .execute(status -> call.get());
        }

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

        void insertAction(String sessionId, String actionId,
                long expiresAtMillis) {
            jdbc.update("INSERT INTO managed_agent_action (tenant_id,"
                            + " session_id, action_id, state, options_json,"
                            + " created_at) VALUES (?, ?, ?, 'requested', ?,"
                            + " 0)", TENANT, sessionId, actionId,
                    mapper.valueToTree(java.util.Map.of("expiresAt",
                            expiresAtMillis)).toString());
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
        private volatile RuntimeException sticky;
        private final List<String> verified = new CopyOnWriteArrayList<>();
        private final List<ContextBinding> bindings =
                new CopyOnWriteArrayList<>();

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
            bindings.add(binding);
            RuntimeException behavior = sticky != null ? sticky
                    : behaviors.poll();
            if (behavior != null) {
                throw behavior;
            }
        }

        void refuse(RuntimeException error) {
            behaviors.add(error);
        }

        void refuseAlways(RuntimeException error) {
            sticky = error;
        }

        void clearRefusals() {
            sticky = null;
            behaviors.clear();
        }
    }

}

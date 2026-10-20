package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ResidentWorkspaceRetirementStoreTest {
    private ResidentRetirementFixture fixture;

    protected DataSource dataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:resident-retirement-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @BeforeEach
    void setUp() {
        fixture = new ResidentRetirementFixture(dataSource());
        fixture.ready();
    }

    @Test
    void beginPersistsOneFenceAndInspectReplaysItWithoutChangingStorageOrBinding() {
        var before = fixture.storage.inspect(fixture.mapping.registration());
        assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("NOT_STARTED");
        var first = fixture.store().begin(fixture.request);
        var sealed = fixture.bindings.findById(first.bindingId());
        assertThat(first.state()).isEqualTo("DRAINING");
        assertThat(first.bindingId()).isEqualTo(fixture.original.getBindingId());
        assertThat(first.runtimeGeneration()).isEqualTo(1);
        assertThat(first.attempts()).isEmpty();
        assertThat(sealed.getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
        assertThat(sealed.isDrainRequested()).isTrue();
        assertThat(sealed.getOperationOwner()).isNull();
        assertThat(fixture.store().begin(fixture.request)).isEqualTo(first);
        assertThat(fixture.store().inspect(fixture.request)).isEqualTo(first);
        assertThat(fixture.bindings.findById(first.bindingId()).getVersion()).isEqualTo(sealed.getVersion());
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_workspace", String.class)).isEqualTo("DRAINING");
        assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class)).isEqualTo(first.bindingId());
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'",
                Long.class)).isEqualTo(1);
        assertThat(fixture.storage.inspect(fixture.mapping.registration())).isEqualTo(before);
        assertThatThrownBy(() -> fixture.create("after-retirement")).isInstanceOf(RuntimeException.class);
    }

    @Test
    void aMaintenanceClaimReplacedBeforeTheTransactionCannotInstallAFence() {
        var starts = new AtomicInteger();
        var replacement = new AtomicReference<RuntimeBindingRecord>();
        var reservation = fixture.storage.inspect(fixture.mapping.registration());
        var manager = new DataSourceTransactionManager(fixture.source) {
            @Override
            protected void doBegin(Object transaction, TransactionDefinition definition) {
                if (starts.incrementAndGet() == 2) {
                    fixture.jdbc.update("UPDATE ma_runtime_binding SET operation_lease_until = 0 WHERE binding_id = ?",
                            fixture.original.getBindingId());
                    replacement.set(fixture.bindings.claimOperation(fixture.original.getBindingId(), "new-broker", Duration.ofMinutes(1)));
                    assertThat(replacement.get()).isNotNull();
                }
                super.doBegin(transaction, definition);
            }
        };
        var store = new ResidentWorkspaceRetirementStore(fixture.jdbc, manager, fixture.bindings,
                List.of(fixture.mapping), new ObjectMapper());
        assertThatThrownBy(() -> store.begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        var current = fixture.bindings.findById(fixture.original.getBindingId());
        assertThat(current.getState()).isEqualTo(RuntimeBindingRecord.State.READY);
        assertThat(current.isDrainRequested()).isFalse();
        assertThat(current.getOperationOwner()).isEqualTo("new-broker");
        assertThat(current.getOperationGeneration()).isEqualTo(replacement.get().getOperationGeneration());
        assertThat(current.getOperationLeaseUntil()).isEqualTo(replacement.get().getOperationLeaseUntil());
        assertThat(current.getVersion()).isEqualTo(replacement.get().getVersion());
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_workspace", String.class)).isEqualTo("ACTIVE");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'",
                Long.class)).isZero();
        assertThat(fixture.storage.inspect(fixture.mapping.registration())).isEqualTo(reservation);
        assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class))
                .isEqualTo(fixture.original.getBindingId());
    }

    @Test
    void foreignIdentityAndNonOwnerCannotBeginOrReplaceAPlan() {
        for (var request : List.of(request("foreign", "workspace", 1, "owner", fixture.request.retirementId()),
                request("tenant", "workspace", 2, "owner", fixture.request.retirementId()),
                request("tenant", "workspace", 1, "foreign", fixture.request.retirementId()))) {
            assertThatThrownBy(() -> fixture.store().begin(request)).isInstanceOf(RuntimeBrokerException.class);
        }
        fixture.jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR'");
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        fixture.jdbc.update("UPDATE ma_workspace_access SET role = 'OWNER'");
        var status = fixture.store().begin(fixture.request);
        assertThatThrownBy(() -> fixture.store().begin(request("tenant", "workspace", 1, "owner", UUID.randomUUID().toString())))
                .isInstanceOf(RuntimeBrokerException.class);
        fixture.jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OWNER')", ManagedWorkspaceRegistry.actorKey("tenant", "other-owner"));
        assertThatThrownBy(() -> fixture.store().inspect(request("tenant", "workspace", 1, "other-owner", fixture.request.retirementId())))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(fixture.store().inspect(fixture.request)).isEqualTo(status);
    }

    @Test
    void anUnfinishedPublicSessionRefusesRetirementWithoutInstallingAFence() {
        var session = fixture.create("active").sessionId();
        for (String state : List.of("ACTIVE", "CLOSING", "DELETING")) {
            fixture.jdbc.update("UPDATE ma_session SET status = ? WHERE session_id = ?", state, session);
            assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
            assertOpen();
        }
        fixture.jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id = ?", session);
        assertThat(fixture.store().begin(fixture.request).state()).isEqualTo("DRAINING");
    }

    @Test
    void changedOriginalSlotOrReservationRefusesRetirementWithoutSavingAPlan() {
        fixture.jdbc.update("UPDATE ma_runtime_slot SET active_binding_id = 'foreign'");
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(IllegalStateException.class);
        fixture.jdbc.update("UPDATE ma_runtime_slot SET active_binding_id = ?", fixture.original.getBindingId());
        fixture.jdbc.update("UPDATE ma_storage_owner SET csi_registration_revision = 2");
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        assertOpen();
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'",
                Long.class)).isZero();
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RESERVED");
    }

    @Test
    void malformedSavedPlanCannotAuthorizeInspectionOrDelete() {
        fixture.store().begin(fixture.request);
        fixture.jdbc.update("UPDATE ma_operation SET request_json = '{}' WHERE operation_kind = 'WORKSPACE_RETIREMENT'");
        assertThatThrownBy(() -> fixture.store().inspect(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        var api = fixture.api();
        assertThatThrownBy(() -> fixture.store().deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
        verify(api, never()).deletePod(anyString(), anyString(), any(byte[].class));
    }

    @Test
    void aTerminalPublicSessionWithAnUnsealedOrLiveWriterStillRefusesRetirement() {
        var session = fixture.create("writer").sessionId();
        fixture.jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id = ?", session);
        fixture.jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, workspace_id, session_id,"
                + " harness_session_id, head_kind, storage_version, journal_revision, committed_sequence, writer_generation,"
                + " activation_epoch, state, gmt_create, gmt_modified) VALUES (?, ?, 'tenant', 'workspace', ?, ?,"
                + " 'MANAGED_SESSION', 1, 0, 0, 1, 0, NULL, 0, 0)", ManagedSchemaKeys.key("tenant"), ManagedSchemaKeys.key(session), session, session);
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        fixture.jdbc.update("UPDATE ma_session_head SET state = 'SEALED', writer_lease_until = ?", System.currentTimeMillis() + 300_000);
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        fixture.jdbc.update("UPDATE ma_session_head SET writer_lease_until = NULL");
        assertThat(fixture.store().begin(fixture.request).state()).isEqualTo("DRAINING");
    }

    @Test
    void aPermanentlyDeletedJournalDoesNotKeepAnIdleWorkspaceBusy() {
        var session = fixture.create("deleted-history").sessionId();
        fixture.jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id = ?", session);
        fixture.jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, tenant_id, workspace_id, session_id,"
                + " harness_session_id, head_kind, storage_version, journal_revision, committed_sequence, writer_generation,"
                + " activation_epoch, state, recovery_status, gmt_create, gmt_modified) VALUES (?, ?, 'tenant', 'workspace', ?, ?,"
                + " 'MANAGED_SESSION', 1, 0, 0, 1, 0, 'SEALED', 'READY', 0, 0)",
                ManagedSchemaKeys.key("tenant"), ManagedSchemaKeys.key(session), session, session);
        new TransactionTemplate(fixture.manager).executeWithoutResult(status -> {
            ToolPublicationRetentionStore.lockDeletion(fixture.jdbc, "tenant", session);
            ToolPublicationRetentionStore.retire(fixture.jdbc, "tenant", session, "delete-history");
            fixture.jdbc.update("UPDATE ma_session SET status = 'DELETED' WHERE session_id = ?", session);
        });
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_session_head", String.class)).isEqualTo("DELETED");
        assertThat(fixture.jdbc.queryForMap("SELECT writer_id, writer_lease_until FROM ma_session_head"))
                .containsEntry("writer_id", null).containsEntry("writer_lease_until", null);
        fixture.jdbc.update("UPDATE ma_session_head SET writer_id = 'unknown-writer'");
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        fixture.jdbc.update("UPDATE ma_session_head SET writer_id = NULL");
        for (long lease : List.of(0L, System.currentTimeMillis() + 300_000)) {
            fixture.jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?", lease);
            assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        }
        fixture.jdbc.update("UPDATE ma_session_head SET writer_lease_until = NULL");
        assertThat(fixture.store().begin(fixture.request).state()).isEqualTo("DRAINING");
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RESERVED");
    }

    @Test
    void anUnreleasedRuntimeSessionAndUnsettledExecutionRefuseRetirement() {
        var sessions = new JdbcRuntimeSessionRepository(fixture.source);
        var session = sessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "runtime", "bootstrap",
                fixture.runtimeRequest.getScope()), fixture.original.getBindingId(), 1, RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        sessions.compareAndSet(session, session.withState(RuntimeSessionRecord.State.RELEASED, Instant.now()));
        var executions = new JdbcToolExecutionRepository(fixture.source, fixture.bindings);
        executions.findOrCreate(ToolExecutionRecord.prepared("execution", "execution-key", fixture.original.getBindingId(), 1,
                "harness", "runtime", "turn", "call", "digest", Map.of("sessionId", "runtime", "promptId", "turn",
                        "callId", "call", "argsDigest", "digest")));
        assertThatThrownBy(() -> fixture.store().begin(fixture.request)).isInstanceOf(RuntimeBrokerException.class);
        assertOpen();
    }

    @Test
    @Timeout(30)
    void publicCreationAndRetirementHaveExactlyOneAdmissionWinner() throws Exception {
        var barrier = new CyclicBarrier(2);
        try (var pool = Executors.newVirtualThreadPerTaskExecutor()) {
            var creating = pool.submit(() -> race(barrier, () -> fixture.create("race")));
            var retiring = pool.submit(() -> race(barrier, () -> fixture.store().begin(fixture.request)));
            assertThat(List.of(creating.get(15, TimeUnit.SECONDS), retiring.get(15, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(true, false);
        }
        long publicSessions = fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE session_kind = 'PUBLIC'", Long.class);
        String state = fixture.jdbc.queryForObject("SELECT state FROM ma_workspace", String.class);
        assertThat(publicSessions).isEqualTo("ACTIVE".equals(state) ? 1 : 0);
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RESERVED");
    }

    @Test
    void deleteRetainsActualRepliesAndExactNormalDeletePreconditions() throws Exception {
        fixture.store().begin(fixture.request);
        var before = fixture.storage.inspect(fixture.mapping.registration());
        var api = fixture.api();
        for (int code : List.of(200, 202, 404, 409, 503)) {
            String version = "version-" + code;
            fixture.resourceVersion(version);
            byte[] reply = ("{\"code\":" + code + "}").getBytes(StandardCharsets.UTF_8);
            when(api.deletePod(anyString(), anyString(), any(byte[].class))).thenReturn(
                    CompletableFuture.completedFuture(new KubernetesHttpRuntimeClient.DeleteResponse(code, reply, true)));
            var status = fixture.store().deletePod(fixture.request, version, api);
            assertThat(status.attempts().getLast().httpStatus()).isEqualTo(code);
            assertThat(status.attempts().getLast().state()).isEqualTo("RETURNED");
            var saved = fixture.attempts().stream().filter(value -> version.equals(value.get("resourceVersion"))).findFirst().orElseThrow();
            assertThat(Base64.getDecoder().decode((String) saved.get("responseBase64"))).isEqualTo(reply);
            assertThat(saved.get("responseSha256")).isEqualTo(org.apache.commons.codec.digest.DigestUtils.sha256Hex(reply));
        }
        var sent = ArgumentCaptor.forClass(byte[].class);
        verify(api, times(5)).deletePod(anyString(), anyString(), sent.capture());
        var options = new ObjectMapper().readTree(sent.getValue());
        assertThat(options.path("gracePeriodSeconds").asInt()).isEqualTo(30);
        assertThat(options.path("propagationPolicy").asText()).isEqualTo("Background");
        assertThat(options.path("preconditions").path("uid").asText())
                .isEqualTo(map(fixture.objects.get("pods").get("metadata")).get("uid"));
        assertThat(options.path("preconditions").path("resourceVersion").asText()).isEqualTo("version-503");
        assertThat(fixture.storage.inspect(fixture.mapping.registration())).isEqualTo(before);
    }

    @Test
    void aLostReplyStaysUnknownAcrossRestartAndTheSameVersionIsNeverResent() {
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        when(api.deletePod(anyString(), anyString(), any(byte[].class))).thenReturn(CompletableFuture.failedFuture(new IOException("reply lost")));
        assertThat(fixture.store().deletePod(fixture.request, "10", api).attempts().getFirst().state()).isEqualTo("UNKNOWN");
        assertThat(fixture.store().deletePod(fixture.request, "10", api).attempts()).hasSize(1);
        verify(api, times(1)).deletePod(anyString(), anyString(), any(byte[].class));
        fixture.resourceVersion("11");
        assertThat(fixture.store().deletePod(fixture.request, "11", api).attempts()).hasSize(2);
        verify(api, times(2)).deletePod(anyString(), anyString(), any(byte[].class));
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RESERVED");
    }

    @Test
    void eightDurableAttemptsExhaustTheBudgetAcrossStoreInstances() {
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        for (int ordinal = 1; ordinal <= 8; ordinal++) {
            String version = "version-" + ordinal;
            fixture.resourceVersion(version);
            assertThat(fixture.store().deletePod(fixture.request, version, api).attempts()).hasSize(ordinal);
        }
        fixture.resourceVersion("version-9");
        assertThatThrownBy(() -> fixture.store().deletePod(fixture.request, "version-9", api)).isInstanceOf(RuntimeBrokerException.class);
        verify(api, times(8)).deletePod(anyString(), anyString(), any(byte[].class));
        assertThat(fixture.store().inspect(fixture.request).attempts()).hasSize(8);
    }

    @Test
    void aSupersededSenderCannotWriteAReplyOrClearTheNewClaim() {
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        when(api.deletePod(anyString(), anyString(), any(byte[].class))).thenAnswer(call -> {
            fixture.jdbc.update("UPDATE ma_operation SET claim_generation = claim_generation + 1, claim_owner = 'new-owner'"
                    + " WHERE operation_kind = 'WORKSPACE_RETIREMENT'");
            return CompletableFuture.completedFuture(new KubernetesHttpRuntimeClient.DeleteResponse(200, new byte[] {1, 2}, true));
        });
        assertThatThrownBy(() -> fixture.store().deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(fixture.store().inspect(fixture.request).attempts().getFirst().state()).isEqualTo("UNKNOWN");
        assertThat(fixture.attempts().getFirst()).doesNotContainKey("responseBase64");
        assertThat(fixture.jdbc.queryForObject("SELECT claim_owner FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'",
                String.class)).isEqualTo("new-owner");
    }

    @Test
    void revokedOwnerChangedPodAndMissingPodCannotSendDelete() {
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        fixture.jdbc.update("UPDATE ma_workspace_access SET role = 'READER'");
        assertThatThrownBy(() -> fixture.store().deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
        fixture.jdbc.update("UPDATE ma_workspace_access SET role = 'OWNER'");
        var pod = fixture.objects.get("pods");
        map(pod.get("metadata")).put("uid", UUID.randomUUID().toString());
        assertThatThrownBy(() -> fixture.store().deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
        fixture.objects.remove("pods");
        assertThatThrownBy(() -> fixture.store().deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
        verify(api, never()).deletePod(anyString(), anyString(), any(byte[].class));
        assertThat(fixture.store().inspect(fixture.request).attempts()).isEmpty();
    }

    private void assertOpen() {
        assertThat(fixture.jdbc.queryForObject("SELECT state FROM ma_workspace", String.class)).isEqualTo("ACTIVE");
        var original = fixture.bindings.findById(fixture.original.getBindingId());
        assertThat(original.getState()).isEqualTo(RuntimeBindingRecord.State.READY);
        assertThat(original.isDrainRequested()).isFalse();
        assertThat(original.getOperationOwner()).isNull();
    }

    private static boolean race(CyclicBarrier barrier, Runnable operation) throws Exception {
        barrier.await(10, TimeUnit.SECONDS);
        try {
            operation.run();
            return true;
        } catch (RuntimeException refusal) {
            assertThat(refusal).isInstanceOfAny(RuntimeBrokerException.class,
                    com.alibaba.qwen.code.managedagent.exception.ManagedAgentException.class);
            return false;
        }
    }

    private static ResidentWorkspaceRetirementStore.Request request(String tenant, String workspace, long generation,
            String actor, String id) {
        return new ResidentWorkspaceRetirementStore.Request(tenant, workspace, generation, actor, id);
    }
}

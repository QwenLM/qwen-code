package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.KubernetesHttpRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
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
                + " VALUES ('tenant', 'workspace', ?, 'OWNER')", com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "other-owner"));
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
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
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
            var status = new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, version, api);
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
        assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "10", api).attempts().getFirst().state()).isEqualTo("UNKNOWN");
        assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "10", api).attempts()).hasSize(1);
        verify(api, times(1)).deletePod(anyString(), anyString(), any(byte[].class));
        fixture.resourceVersion("11");
        assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "11", api).attempts()).hasSize(2);
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
            assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, version, api).attempts()).hasSize(ordinal);
        }
        fixture.resourceVersion("version-9");
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "version-9", api)).isInstanceOf(RuntimeBrokerException.class);
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
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
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
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
        fixture.jdbc.update("UPDATE ma_workspace_access SET role = 'OWNER'");
        var pod = fixture.objects.get("pods");
        map(pod.get("metadata")).put("uid", UUID.randomUUID().toString());
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
        fixture.objects.remove("pods");
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "10", api)).isInstanceOf(RuntimeBrokerException.class);
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

    @Test
    void originalCleanupAtomicallyReleasesAndThreeHandoffsKeepTerminalReadback() {
        var current = fixture;
        var historical = new java.util.ArrayList<ResidentWorkspaceRetirementStore.Request>();
        var receipts = new java.util.ArrayList<ResidentWorkspaceRetirementStore.Completion>();
        for (int cycle = 0; cycle < 3; cycle++) {
            var cycleFixture = current;
            assertThat(current.storage.inspect(current.mapping.registration()).revision()).isEqualTo(cycle * 2L + 1);
            var api = prepared(current);
            assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(cycleFixture.store()).reclaim(cycleFixture.request, api)).isInstanceOf(RuntimeBrokerException.class);
            current.completePlatform();
            var terminal = new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(current.store()).reclaim(current.request, api);
            assertThat(terminal.state()).isEqualTo("RELEASED");
            assertThat(terminal.completion().releasedRevision()).isEqualTo(cycle * 2L + 2);
            assertThat(terminal.completion().dataPolicy()).isEqualTo(com.alibaba.qwen.code.managedagent.contracts.workspace.ResidentReclamation.DATA_POLICY);
            historical.add(current.request);
            receipts.add(terminal.completion());
            assertThat(current.bindings.findById(current.original.getBindingId()).getState()).isEqualTo(RuntimeBindingRecord.State.RELEASED);
            assertThat(current.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot WHERE request_key = ?",
                    String.class, current.runtimeRequest.requestKey())).isNull();
            assertThat(current.jdbc.queryForObject("SELECT tenant_id FROM ma_storage_owner", String.class)).isEqualTo("tenant");
            assertThatThrownBy(() -> cycleFixture.bindings.findOrCreate(cycleFixture.runtimeRequest))
                    .isInstanceOf(RuntimeBrokerException.class);
            var next = new ResidentRetirementFixture(fixture.source, "next-" + cycle);
            next.ready();
            var reader = new ResidentWorkspaceRetirementStore(next.jdbc, next.manager, next.bindings,
                    List.of(next.mapping), new ObjectMapper());
            for (int index = 0; index < historical.size(); index++) {
                assertThat(reader.inspect(historical.get(index)).completion()).isEqualTo(receipts.get(index));
            }
            current = next;
        }
        assertThat(current.storage.inspect(current.mapping.registration()).revision()).isEqualTo(7);
    }

    @Test
    void physicalReleasePreservesTenantAndRefusesAForeignAlias() {
        var api = prepared(fixture);
        fixture.completePlatform();
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api);
        var original = fixture.mapping.registration();
        var foreign = new WorkspaceCsiRegistration("foreign", "foreign-storage", original.clusterDomain(), original.namespace(),
                original.pvcName(), original.pvcUid(), original.pvName(), original.pvUid(), original.driver(), original.volumeHandle(),
                original.backendDomain(), original.diskSerial(), original.mountRoot(), original.revision());
        var before = fixture.storage.inspect(original);
        assertThatThrownBy(() -> fixture.storage.register(foreign)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(fixture.storage.inspect(original)).isEqualTo(before);
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage", Long.class)).isEqualTo(1);
    }

    @Test
    void aLegacyDeletionOnlyPlanStaysReadableWithoutGainingReleaseAuthority() throws Exception {
        fixture.store().begin(fixture.request);
        var json = new ObjectMapper();
        var plan = (com.fasterxml.jackson.databind.node.ObjectNode) json.readTree(fixture.jdbc.queryForObject(
                "SELECT request_json FROM ma_operation WHERE operation_kind = 'WORKSPACE_RETIREMENT'", String.class));
        plan.put("version", 1);
        plan.remove("mapping");
        fixture.jdbc.update("UPDATE ma_operation SET request_json = ?, request_digest = ? WHERE operation_kind = 'WORKSPACE_RETIREMENT'",
                json.writeValueAsString(plan), com.alibaba.qwen.code.runtimebroker.WorkspaceCsiRuntimeIdentity.digest(plan));
        assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("DRAINING");
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", fixture.api())).isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, fixture.api())).isInstanceOf(RuntimeBrokerException.class);
        assertThat(fixture.storage.inspect(fixture.mapping.registration()).phase()).isEqualTo("RESERVED");
    }

    @ParameterizedTest
    @ValueSource(strings = {"missing-pod", "node-uid", "node-boot", "stale-lease", "lease-owner", "stale-heartbeat",
            "container", "attachment", "pv-alias", "other-pod", "api-unavailable", "foreign-finalizer"})
    void uncertainPlatformCompletionNeverReleases(String defect) {
        var api = prepared(fixture);
        var attachment = fixture.attachments.getFirst();
        fixture.completePlatform();
        switch (defect) {
            case "missing-pod" -> fixture.objects.remove("pods");
            case "node-uid" -> map(fixture.objects.get("nodes").get("metadata")).put("uid", "replacement");
            case "node-boot" -> map(map(fixture.objects.get("nodes").get("status")).get("nodeInfo")).put("bootID", "new-boot");
            case "stale-lease" -> map(fixture.objects.get("leases").get("spec")).put("renewTime", Instant.now().minusSeconds(120).toString());
            case "lease-owner" -> map(fixture.objects.get("leases").get("metadata")).put("ownerReferences", List.of());
            case "stale-heartbeat" -> map(fixture.objects.get("nodes").get("status")).put("conditions", List.of(
                    Map.of("type", "Ready", "status", "True", "lastHeartbeatTime", Instant.now().minusSeconds(120).toString())));
            case "container" -> map(((List<?>) map(fixture.objects.get("pods").get("status")).get("containerStatuses")).getFirst())
                    .put("containerID", "replacement");
            case "attachment" -> fixture.attachments.add(attachment);
            case "pv-alias" -> when(api.listPersistentVolumes()).thenReturn(CompletableFuture.completedFuture(
                    List.of(fixture.objects.get("persistentvolumes"), fixture.objects.get("persistentvolumes"))));
            case "other-pod" -> when(api.listPods(anyString())).thenReturn(CompletableFuture.completedFuture(
                    List.of(fixture.objects.get("pods"), fixture.objects.get("pods"))));
            case "api-unavailable" -> when(api.getCluster(org.mockito.ArgumentMatchers.eq("nodes"), anyString()))
                    .thenReturn(CompletableFuture.failedFuture(new IOException("unavailable")));
            case "foreign-finalizer" -> map(fixture.objects.get("pods").get("metadata")).put("finalizers", List.of("foreign/finalizer"));
            default -> throw new AssertionError(defect);
        }
        var held = fixture.storage.inspect(fixture.mapping.registration());
        assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api)).isInstanceOf(RuntimeException.class);
        assertThat(fixture.storage.inspect(fixture.mapping.registration())).isEqualTo(held);
        assertThat(fixture.bindings.findById(fixture.original.getBindingId()).getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
        assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("DRAINING");
    }

    @Test
    void freshReadAllowsBoundedMetadataRetryWithoutErasingUnknown() {
        fixture.preparePlatform();
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        var patches = new AtomicInteger();
        var delegate = fixture.api();
        when(api.patchPodFinalizers(anyString(), anyString(), any(byte[].class))).thenAnswer(call -> patches.incrementAndGet() == 1
                ? CompletableFuture.failedFuture(new IOException("reply lost before effect"))
                : delegate.patchPodFinalizers(call.getArgument(0), call.getArgument(1), call.getArgument(2)));
        var first = new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", api);
        assertThat(first.finalizerAttempts().getFirst().state()).isEqualTo("UNKNOWN");
        var second = new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", api);
        assertThat(second.finalizerAttempts()).hasSize(2);
        assertThat(second.finalizerAttempts().getFirst().state()).isEqualTo("UNKNOWN");
        assertThat(second.finalizerAttempts().getLast().state()).isEqualTo("RETURNED");
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "11", api);
        assertThat(patches).hasValue(2);
    }

    @Test
    void independentCleanupReceiptDoesNotRewriteALostDeleteResponse() {
        fixture.preparePlatform();
        fixture.store().begin(fixture.request);
        var api = fixture.api();
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).prepareReclamation(fixture.request, "10", api);
        when(api.deletePod(anyString(), anyString(), any(byte[].class)))
                .thenReturn(CompletableFuture.failedFuture(new IOException("reply lost")));
        assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).deletePod(fixture.request, "11", api).attempts().getFirst().state()).isEqualTo("UNKNOWN");
        fixture.completePlatform();
        var result = new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api);
        assertThat(result.state()).isEqualTo("RELEASED");
        assertThat(result.attempts().getFirst().state()).isEqualTo("UNKNOWN");
        verify(api, times(1)).deletePod(anyString(), anyString(), any(byte[].class));
    }

    @Test
    void everyReleaseWriteRollsBackTogetherAndCanResumeAfterPodCleanup() {
        var api = prepared(fixture);
        fixture.completePlatform();
        var held = fixture.storage.inspect(fixture.mapping.registration());
        for (String cut : List.of("owner", "operation", "claim")) {
            var failing = new ManagedSchemaJdbcTemplate(fixture.source) {
                @Override
                public int update(String sql, Object... args) {
                    if (cut.equals("owner") && sql.startsWith("UPDATE ma_storage_owner SET csi_phase = 'RELEASED'")
                            || cut.equals("operation") && sql.startsWith("UPDATE ma_operation SET state") && "RELEASED".equals(args[0])
                            || cut.equals("claim") && sql.startsWith("UPDATE ma_operation SET claim_owner = NULL, claim_until = NULL, claim_generation")) {
                        throw new IllegalStateException("release cut");
                    }
                    return super.update(sql, args);
                }
            };
            var store = new ResidentWorkspaceRetirementStore(failing, fixture.manager, fixture.bindings,
                    List.of(fixture.mapping), new ObjectMapper());
            assertThatThrownBy(() -> new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(store).reclaim(fixture.request, api)).isInstanceOf(IllegalStateException.class).hasMessage("release cut");
            assertThat(fixture.storage.inspect(fixture.mapping.registration())).isEqualTo(held);
            assertThat(fixture.bindings.findById(fixture.original.getBindingId()).getState()).isEqualTo(RuntimeBindingRecord.State.DRAINING);
            assertThat(fixture.jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class)).isEqualTo(fixture.original.getBindingId());
            assertThat(fixture.store().inspect(fixture.request).state()).isEqualTo("PLATFORM_CLEANED");
        }
        var released = new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api);
        assertThat(new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(fixture.store()).reclaim(fixture.request, api)).isEqualTo(released);
    }

    private static KubernetesHttpRuntimeClient prepared(ResidentRetirementFixture current) {
        current.preparePlatform();
        current.store().begin(current.request);
        var api = current.api();
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(current.store()).prepareReclamation(current.request, "10", api);
        new com.alibaba.qwen.code.managedagent.workspace.runtime.ResidentWorkspaceRetirementService(current.store()).deletePod(current.request, "11", api);
        return api;
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

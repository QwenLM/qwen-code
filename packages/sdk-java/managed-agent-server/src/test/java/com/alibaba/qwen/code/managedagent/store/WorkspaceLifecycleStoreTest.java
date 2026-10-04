package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceLifecycleStoreTest {
    @ParameterizedTest
    @ValueSource(strings = {"{", "[]", "null", "{\"n\":1e999}", "{\"a\":1,\"a\":2}"})
    void lifecycleJournalValidationRejectsInvalidRecordsAndRollsBack(String line) throws Exception {
        for (String mode : List.of("ordinary", "authority", "settlement")) {
            var fixture = fixture();
            var journal = new ManagedSessionStore(fixture.jdbc);
            var writer = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                    "w".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 60_000L)));
            var operation = "ordinary".equals(mode) ? null : fixture.admit(OperationKind.DELETE);
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            var resource = new ManagedSessionStoreModels.CommitResource("candidate", "managed-message", 1, body.length,
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body)), Base64.getEncoder().encodeToString(body));
            byte[] bytes = (line + "\n{}\n").getBytes(StandardCharsets.UTF_8);
            var request = new ManagedSessionStoreModels.CommitTransactionRequest("workspace", "original", writer.writerGeneration(),
                    0, 0, "transaction", "session.create", "command", "a".repeat(64), 0, 0, 0, null, null, null, 0, null, 2,
                    Base64.getEncoder().encodeToString(bytes), HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                    List.of(resource));
            assertThatThrownBy(() -> fixture.transactions.execute(ignored -> journal.commit("tenant", fixture.session, "w".repeat(32),
                    request, "authority".equals(mode) ? WorkspaceLifecycleStore.authority(operation) : null)))
                    .isInstanceOfSatisfying(ApiException.class, error -> {
                        assertThat(error.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
                        assertThat(error.getCode()).isEqualTo(ManagedSessionStoreModels.ERROR_INVALID_REQUEST);
                    });
            assertThat(fixture.jdbc.queryForObject("SELECT journal_revision FROM qwen_managed_session_journal_head", Long.class)).isZero();
            assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx", Integer.class)).isZero();
            assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource", Integer.class)).isZero();
        }
    }

    @Test
    void detachOnlyAuthorizationAcceptsOriginalExpiredOrSealedWriterAfterEffects() throws Exception {
        var fixture = fixture();
        var journal = new ManagedSessionStore(fixture.jdbc);
        var writer = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                "w".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 60_000L)));
        byte[] definition = "{\"toolProfile\":\"hosted-workspace-files/1\"}".getBytes(StandardCharsets.UTF_8);
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(definition));
        var header = new ObjectMapper().createObjectNode().put("subtype", "managed_session_header_v1");
        header.putObject("managedSession").putObject("definitionRef").put("resourceId", "definition")
                .put("kind", "managed-session-definition").put("schemaVersion", 1).put("byteLength", definition.length).put("digest", digest);
        byte[] bytes = (header + "\n{}\n").getBytes(StandardCharsets.UTF_8);
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest("workspace", "original", writer.writerGeneration(),
                0, 0, "transaction", "session.create", "command", "a".repeat(64), 0, 0, 0, null, null, null, 0, null, 2,
                Base64.getEncoder().encodeToString(bytes), HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                List.of(new ManagedSessionStoreModels.CommitResource("definition", "managed-session-definition", 1,
                        definition.length, digest, Base64.getEncoder().encodeToString(definition))));
        fixture.transactions.execute(ignored -> journal.commit("tenant", fixture.session, "w".repeat(32), commit));
        var operation = fixture.admit(OperationKind.DELETE);
        var authority = WorkspaceLifecycleStore.authority(operation);
        var cleanup = new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration());
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle(
                "tenant", fixture.session, "w".repeat(32), cleanup, authority))).hasMessageContaining("blocked");
        assertThat(fixture.transactions.<com.fasterxml.jackson.databind.JsonNode>execute(ignored -> fixture.lifecycle.recoverEffects(operation)))
                .isNotNull();
        fixture.jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = ?", new java.sql.Timestamp(0));
        assertThat(journal.hasLiveWriter("tenant", fixture.session)).isFalse();
        fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle("tenant", fixture.session, "w".repeat(32), cleanup, authority));
        var dispatch = new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration(), "delete");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle(
                "tenant", fixture.session, "w".repeat(32), dispatch, authority))).hasMessageContaining("writer");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.renewWriter("tenant", fixture.session, "w".repeat(32),
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "original", writer.writerGeneration(), 60_000L), authority)))
                .hasMessageContaining("writer");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle(
                "tenant", fixture.session, "x".repeat(32), cleanup, authority))).hasMessageContaining("writer");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle("tenant", fixture.session,
                "w".repeat(32), new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration() + 1),
                authority))).hasMessageContaining("writer");
        fixture.transactions.executeWithoutResult(ignored -> journal.sealWriter("tenant", fixture.session, "w".repeat(32),
                new ManagedSessionStoreModels.SealWriterRequest("workspace", "original", writer.writerGeneration()), authority));
        fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle("tenant", fixture.session, "w".repeat(32), cleanup, authority));
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle(
                "tenant", fixture.session, "w".repeat(32), dispatch, authority))).hasMessageContaining("writer");
        fixture.jdbc.update("UPDATE managed_agent_operation SET lease_until = 0");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle(
                "tenant", fixture.session, "w".repeat(32), cleanup, authority))).hasMessageContaining("blocked");
    }

    @Test
    void legacyCloseKeepsItsOriginalHookPathButCannotAdmitOrdinaryWork() {
        var fixture = fixture();
        var journal = new ManagedSessionStore(fixture.jdbc);
        var writer = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                "w".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 60_000L)));
        String id = fixture.transactions.execute(ignored -> fixture.store.beginWorkspaceLifecycle("tenant", fixture.session,
                OperationKind.CLOSE, "owner", "a".repeat(64), "legacy", "digest", true).operation().operationId());
        var operation = fixture.transactions.execute(ignored -> fixture.store.claimOperation("tenant", fixture.session, id,
                "worker", Duration.ofSeconds(30)).orElseThrow());
        fixture.bindings.requestHarnessDrain("tenant", fixture.session);
        assertThat(operation.lifecycleProtocolVersion()).isZero();
        var ordinary = new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration());
        var legacy = new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration(), "legacy-close");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeOrdinary("tenant", fixture.session,
                "w".repeat(32), ordinary))).hasMessageContaining("admission is closed");
        fixture.transactions.executeWithoutResult(ignored -> journal.authorizeOrdinary("tenant", fixture.session, "w".repeat(32), legacy));
        fixture.bindings.requireHookAdmission(fixture.scope(), fixture.session, null);
        assertThatThrownBy(() -> fixture.bindings.requireHarnessAdmission(fixture.scope(), fixture.session, null))
                .hasMessageContaining("closed");
        var execution = new WorkspaceExecutionStore(fixture.jdbc, new DataSourceTransactionManager(fixture.jdbc.getDataSource()));
        execution.authorizeLegacyClose(fixture.store.requireSession("tenant", fixture.session));
        fixture.jdbc.update("UPDATE managed_workspace_access SET can_create = FALSE");
        assertThatThrownBy(() -> execution.authorizeLegacyClose(fixture.store.requireSession("tenant", fixture.session)))
                .hasMessageContaining("unavailable");
        fixture.jdbc.update("UPDATE managed_workspace_access SET can_create = TRUE");
        execution.authorizeLegacyClose(fixture.store.requireSession("tenant", fixture.session));
        fixture.jdbc.update("UPDATE managed_agent_operation SET lease_until = 0");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeOrdinary("tenant", fixture.session,
                "w".repeat(32), legacy))).hasMessageContaining("admission is closed");
    }

    @Test
    void l3FenceCannotUseTheLegacyCloseException() {
        var fixture = fixture();
        var journal = new ManagedSessionStore(fixture.jdbc);
        var writer = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                "w".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 60_000L)));
        fixture.admit(OperationKind.CLOSE);
        var legacy = new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration(), "legacy-close");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeOrdinary("tenant", fixture.session,
                "w".repeat(32), legacy))).hasMessageContaining("admission is closed");
        assertThatThrownBy(() -> fixture.bindings.requireHookAdmission(fixture.scope(), fixture.session, null)).hasMessageContaining("closed");
        fixture.bindings.requestHarnessDrain("tenant", fixture.session);
        assertThatThrownBy(() -> fixture.bindings.requireHookAdmission(fixture.scope(), fixture.session, null)).hasMessageContaining("closed");
    }
    @Test
    void lifecycleAttachmentCannotDetachBeforeEffectsAreSaved() {
        var fixture = fixture();
        var journal = new ManagedSessionStore(fixture.jdbc);
        var writer = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                "w".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 60_000L)));
        var operation = fixture.admit(OperationKind.DELETE);
        var unverified = new ObjectMapper().createObjectNode().put("protocolVersion", 1)
                .put("operationId", operation.operationId()).put("kind", "delete").put("neverInitialized", true);
        unverified.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", fixture.session);
        unverified.putArray("effects");
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> fixture.lifecycle.saveEffects(operation, unverified)))
                .hasMessageContaining("blocked");
        var request = new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration());
        fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle("tenant", fixture.session,
                "w".repeat(32), new ManagedSessionStoreModels.AuthorizeLifecycleRequest("workspace", "original", writer.writerGeneration(), "delete"),
                WorkspaceLifecycleStore.authority(operation)));
        assertThatThrownBy(() -> fixture.transactions.executeWithoutResult(ignored -> journal.authorizeLifecycle("tenant", fixture.session,
                "w".repeat(32), request, WorkspaceLifecycleStore.authority(operation)))).hasMessageContaining("blocked");
        assertThat(journal.hasLiveWriter("tenant", fixture.session)).isTrue();
        assertThat(fixture.jdbc.queryForObject("SELECT phase FROM qwen_runtime_harness_drain", String.class)).isEqualTo("LIFECYCLE_ONLY");
    }

    @Test
    void completedBootstrapWithoutTheOriginalHeaderIsNotNeverInitializedEvidence() {
        var fixture = fixture();
        var operation = fixture.admit(OperationKind.DELETE);
        fixture.jdbc.update("UPDATE managed_agent_session SET harness_boot_id = 'original-boot'");
        assertThat(fixture.transactions.<com.fasterxml.jackson.databind.JsonNode>execute(ignored -> fixture.lifecycle.recoverEffects(operation))).isNull();
        assertThat(fixture.jdbc.queryForObject("SELECT lifecycle_effects_receipt_json FROM managed_agent_operation", String.class)).isNull();
        assertThat(fixture.jdbc.queryForObject("SELECT phase FROM qwen_runtime_harness_drain", String.class)).isEqualTo("LIFECYCLE_ONLY");
    }

    @Test
    void emptySessionCompletesAtomicallyOnlyAfterEffectsAndPermanentFence() {
        var fixture = fixture();
        OperationRecord operation = fixture.admit(OperationKind.DELETE);
        assertThat(fixture.jdbc.queryForObject("SELECT phase FROM qwen_runtime_harness_drain", String.class))
                .isEqualTo("LIFECYCLE_ONLY");
        assertThatThrownBy(() -> fixture.transactions.execute(ignored -> fixture.store.completeOperation(
                "tenant", fixture.session, operation.operationId(), "worker", operation.claimGeneration(), true)))
                .hasMessageContaining("blocked");
        var effects = fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(operation));
        assertThat(effects.path("neverInitialized").asBoolean()).isTrue();
        assertThat(fixture.jdbc.queryForObject("SELECT receipt_id FROM managed_agent_operation", String.class)).isNull();
        assertThat(fixture.jdbc.queryForObject("SELECT phase FROM qwen_runtime_harness_drain", String.class))
                .isEqualTo("DRAINING");
        assertThat(fixture.transactions.<Boolean>execute(ignored -> fixture.store.completeOperation(
                "tenant", fixture.session, operation.operationId(), "worker", operation.claimGeneration(), true))).isTrue();
        assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("DELETED");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isOne();
        assertThat(fixture.store.findOperation("tenant", fixture.session, operation.operationId()).orElseThrow().receiptId()).isNotNull();
    }

    @Test
    void expiredClaimCannotSaveEffectsOrAdmitRuntimeAndTakeoverKeepsOperationIdentity() {
        var fixture = fixture();
        OperationRecord first = fixture.admit(OperationKind.DELETE);
        RuntimeScope scope = fixture.scope();
        fixture.bindings.requireHarnessAdmission(scope, fixture.session, WorkspaceLifecycleStore.authority(first));
        assertThatThrownBy(() -> fixture.bindings.requireHarnessAdmission(scope, fixture.session, null))
                .hasMessageContaining("closed");
        fixture.jdbc.update("UPDATE managed_agent_operation SET lease_until = 0");
        OperationRecord second = fixture.transactions.execute(ignored -> fixture.store.claimOperation(
                "tenant", fixture.session, first.operationId(), "second", Duration.ofSeconds(30)).orElseThrow());
        assertThat(second.claimGeneration()).isGreaterThan(first.claimGeneration());
        assertThatThrownBy(() -> fixture.bindings.requireHarnessAdmission(scope, fixture.session, WorkspaceLifecycleStore.authority(first)))
                .hasMessageContaining("closed");
        assertThatThrownBy(() -> fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(first)))
                .hasMessageContaining("blocked");
        fixture.bindings.requireHarnessAdmission(scope, fixture.session, WorkspaceLifecycleStore.authority(second));
        assertThat(fixture.transactions.<com.fasterxml.jackson.databind.JsonNode>execute(ignored -> fixture.lifecycle.recoverEffects(second))).isNotNull();
        assertThat(fixture.transactions.<Boolean>execute(ignored -> fixture.store.completeOperation(
                "tenant", fixture.session, first.operationId(), "worker", first.claimGeneration(), true))).isFalse();
    }

    @Test
    void releasedBindingWithoutOriginalStopProofCannotComplete() {
        var fixture = fixture();
        var binding = fixture.bindings.findOrCreate(new RuntimeProvisionRequest(fixture.scope(), fixture.session));
        fixture.jdbc.update("UPDATE qwen_runtime_binding SET binding_state = 'RELEASED' WHERE binding_id = ?", binding.getBindingId());
        OperationRecord operation = fixture.admit(OperationKind.DELETE);
        fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(operation));
        assertThatThrownBy(() -> fixture.transactions.execute(ignored -> fixture.store.completeOperation(
                "tenant", fixture.session, operation.operationId(), "worker", operation.claimGeneration(), true)))
                .hasMessageContaining("proof");
        assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("DELETING");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isZero();
    }

    Fixture fixture() {
        return new Fixture();
    }

    static final class Fixture {
        final JdbcTemplate jdbc;
        final TransactionTemplate transactions;
        final ManagedAgentStore store;
        final WorkspaceLifecycleStore lifecycle;
        final JdbcRuntimeBindingRepository bindings;
        final String session;

        Fixture() {
            this(h2());
        }

        private static javax.sql.DataSource h2() {
            var source = new JdbcDataSource();
            source.setURL("jdbc:h2:mem:l3-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
            return source;
        }

        Fixture(javax.sql.DataSource source) {
            Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
            jdbc = new JdbcTemplate(source);
            transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
            var json = new ObjectMapper();
            var properties = new ManagedAgentProperties();
            properties.getHarness().setWorkspaceFilesEnabled(true);
            store = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
            var beans = new DefaultListableBeanFactory();
            beans.registerSingleton("bindings", bindings);
            lifecycle = new WorkspaceLifecycleStore(jdbc, json, beans.getBeanProvider(RuntimeBindingRepository.class));
            store.setWorkspaceLifecycleStore(lifecycle);
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id,"
                    + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                    WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES ('tenant', 'workspace', ?, TRUE, TRUE)", "owner".getBytes(StandardCharsets.UTF_8));
            session = transactions.execute(ignored -> store.insertWorkspaceSessionCommand("tenant", "owner", "create", "digest", "qwen-code",
                    null, null, List.of(), null, new WorkspaceSelection("workspace", ".")).sessionId());
        }

        RuntimeScope scope() {
            return new RuntimeScope("tenant", "workspace", "1", "/workspace", "digest", "session");
        }

        OperationRecord admit(OperationKind kind) {
            String id = transactions.execute(ignored -> store.beginWorkspaceLifecycle("tenant", session, kind, "owner", "a".repeat(64),
                    "operation", "digest", true, 1).operation().operationId());
            return transactions.execute(ignored -> store.claimOperation("tenant", session, id, "worker", Duration.ofSeconds(30)).orElseThrow());
        }
    }
}

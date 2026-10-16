package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.managedagent.ManagedHookRecordContractTest;
import com.alibaba.qwen.code.managedagent.PublicationJournalFixture;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceProfileLifecycleTest {
    WorkspaceLifecycleStoreTest.Fixture fixture() {
        return new WorkspaceLifecycleStoreTest.Fixture();
    }

    OperationRecord admit(WorkspaceLifecycleStoreTest.Fixture f, String profile, OperationKind kind) {
        f.jdbc.update("UPDATE ma_session SET tool_profile = ?", profile);
        String id = f.transactions.execute(ignored -> f.store.beginWorkspaceLifecycle("tenant", f.session, kind,
                "owner", "a".repeat(64), "operation", "digest", true, 2).operation().operationId());
        return f.transactions.execute(ignored -> f.store.claimOperation("tenant", f.session, id, "server-1", Duration.ofSeconds(30)).orElseThrow());
    }

    @ParameterizedTest
    @ValueSource(strings = {WorkspaceToolProfiles.SHELL, WorkspaceToolProfiles.MCP})
    void closesWithoutResourcesAndDeletesAtomicallyWithPrivateRetirement(String profile) {
        var f = fixture();
        var op = admit(f, profile, OperationKind.DELETE);
        assertThat(op.lifecycleProtocolVersion()).isEqualTo(2);
        var receipt = f.transactions.execute(ignored -> f.lifecycle.recoverEffects(op));
        assertThat(receipt.path("protocolVersion").asInt()).isEqualTo(2);
        assertThat(receipt.path("effects").size()).isZero();
        assertThat(f.jdbc.queryForObject("SELECT phase FROM ma_session_head", String.class)).isEqualTo("DRAINING");
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.verifyResources(op));
        assertThat(f.transactions.<Boolean>execute(ignored -> f.store.completeOperation("tenant", f.session, op.operationId(),
                op.leaseOwner(), op.claimGeneration(), true))).isTrue();
        assertThat(f.store.requireSession("tenant", f.session).status()).isEqualTo("DELETED");
        assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL", Integer.class)).isEqualTo(1);
        assertThat(f.jdbc.queryForObject("SELECT state FROM ma_workspace", String.class)).isEqualTo("ACTIVE");
    }

    @Test
    void drainingTakeoverAllowsOnlyTheCurrentCleanupWriterAndBrokerClaim() {
        var f = fixture();
        var first = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(first));
        f.jdbc.update("UPDATE ma_operation SET claim_until = 946684800000 WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')");
        var next = f.transactions.execute(ignored -> f.store.claimOperation("tenant", f.session, first.operationId(),
                "server-2", Duration.ofSeconds(30)).orElseThrow());
        var current = WorkspaceLifecycleStore.authority(next);
        assertThat(f.bindings.requireHarnessRecovery(f.scope(), f.session, current)).isTrue();
        assertThatThrownBy(() -> f.bindings.requireHarnessRecovery(f.scope(), f.session, null)).hasMessageContaining("closed");
        assertThatThrownBy(() -> f.bindings.requireHarnessRecovery(f.scope(), f.session, WorkspaceLifecycleStore.authority(first))).hasMessageContaining("closed");
        assertThatThrownBy(() -> f.bindings.requireHookAdmission(f.scope(), f.session, current)).hasMessageContaining("closed");
        var journal = new ManagedSessionStore(f.jdbc);
        var request = new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "cleanup", 60_000L);
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, "w".repeat(32), request)))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, "w".repeat(32), request,
                WorkspaceLifecycleStore.authority(first)))).isInstanceOf(ApiException.class);
        var writer = f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, "w".repeat(32), request, current));
        assertThat(writer.writerGeneration()).isPositive();
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, "w".repeat(32),
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "cleanup", writer.writerGeneration(), 60_000L))))
                .isInstanceOf(ApiException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {WorkspaceToolProfiles.SHELL, WorkspaceToolProfiles.MCP})
    void expiredResidentWriterRenewsOnlyUnderTheCurrentResourceClaim(String profile) {
        var f = fixture();
        var journal = new ManagedSessionStore(f.jdbc);
        String token = "w".repeat(32);
        var writer = f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "resident", 60_000L)));
        var first = admit(f, profile, OperationKind.DELETE);
        var renew = new ManagedSessionStoreModels.RenewWriterRequest("workspace", "resident", writer.writerGeneration(), 60_000L);
        f.jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?",
                java.sql.Timestamp.from(java.time.Instant.parse("2000-01-01T00:00:00Z")));
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, token,
                renew, WorkspaceLifecycleStore.authority(first))))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("managed_session_writer_conflict"));
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(first));
        f.jdbc.update("UPDATE ma_operation SET claim_until = 946684800000 WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')");
        var current = f.transactions.execute(ignored -> f.store.claimOperation("tenant", f.session, first.operationId(),
                "server-2", Duration.ofSeconds(30)).orElseThrow());
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, token, renew)))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_lifecycle_claim_fenced"));
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, token,
                renew, WorkspaceLifecycleStore.authority(first))))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_lifecycle_claim_fenced"));
        var renewed = f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, token,
                renew, WorkspaceLifecycleStore.authority(current)));
        assertThat(renewed.writerGeneration()).isEqualTo(writer.writerGeneration());
        assertThat(journal.hasLiveWriter("tenant", f.session)).isTrue();
        f.jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?",
                java.sql.Timestamp.from(java.time.Instant.parse("2000-01-01T00:00:00Z")));
        var replacement = f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, "r".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "recovery", 60_000L),
                WorkspaceLifecycleStore.authority(current)));
        assertThat(replacement.writerGeneration()).isGreaterThan(writer.writerGeneration());
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, token,
                renew, WorkspaceLifecycleStore.authority(current))))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("managed_session_writer_conflict"));
    }

    @Test
    void filesV1DrainingStillRejectsAnExpiredWriter() {
        var f = fixture();
        var journal = new ManagedSessionStore(f.jdbc);
        var writer = f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, "w".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "resident", 60_000L)));
        String id = f.transactions.execute(ignored -> f.store.beginWorkspaceLifecycle("tenant", f.session, OperationKind.CLOSE,
                "owner", "a".repeat(64), "close", "digest", true, 1).operation().operationId());
        var operation = f.transactions.execute(ignored -> f.store.claimOperation("tenant", f.session, id,
                "server-1", Duration.ofSeconds(30)).orElseThrow());
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(operation));
        f.jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?",
                java.sql.Timestamp.from(java.time.Instant.parse("2000-01-01T00:00:00Z")));
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, "w".repeat(32),
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "resident", writer.writerGeneration(), 60_000L),
                WorkspaceLifecycleStore.authority(operation))))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("managed_session_writer_conflict"));
    }

    @ParameterizedTest
    @ValueSource(strings = {WorkspaceToolProfiles.SHELL, WorkspaceToolProfiles.MCP})
    void sealedCleanupWriterCanBeReacquiredOnlyWithTheCurrentResourceClaim(String profile) {
        var f = fixture();
        var journal = new ManagedSessionStore(f.jdbc);
        String token = "w".repeat(32);
        var original = f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 60_000L)));
        var operation = admit(f, profile, OperationKind.DELETE);
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(operation));
        var authority = WorkspaceLifecycleStore.authority(operation);
        f.transactions.execute(ignored -> journal.sealWriter("tenant", f.session, token,
                new ManagedSessionStoreModels.SealWriterRequest("workspace", "original", original.writerGeneration()), authority));
        var recovery = new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "cleanup", 60_000L);
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, token, recovery)))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, token, recovery,
                new RuntimeLifecycleAuthority(operation.operationId(), operation.claimGeneration() + 1))))
                .isInstanceOf(ApiException.class);
        var next = f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, token, recovery, authority));
        assertThat(next.writerGeneration()).isEqualTo(original.writerGeneration() + 1);
        assertThat(next.journalRevision()).isEqualTo(original.journalRevision());
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, token,
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "original", original.writerGeneration(), 60_000L), authority)))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("managed_session_writer_conflict"));
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.renewWriter("tenant", f.session, token,
                new ManagedSessionStoreModels.RenewWriterRequest("workspace", "cleanup", next.writerGeneration(), 60_000L))))
                .isInstanceOf(ApiException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {WorkspaceToolProfiles.SHELL, WorkspaceToolProfiles.MCP})
    void cleanupAdmissionDoesNotRequireTheNewExecutionSwitch(String profile) {
        var f = fixture();
        f.jdbc.update("UPDATE ma_session SET tool_profile = ?", profile);
        var disabled = new ManagedAgentProperties();
        var store = new ManagedAgentStore(f.jdbc, f.json, Clock.systemUTC(), ignored -> {}, new ManagedWorkspaceRegistry(f.jdbc), disabled);
        var admission = f.transactions.execute(ignored -> store.beginWorkspaceLifecycle("tenant", f.session, OperationKind.CLOSE,
                "owner", "a".repeat(64), "cleanup", "digest", true, 2));
        assertThat(admission.operation().lifecycleProtocolVersion()).isEqualTo(2);
        assertThat(f.transactions.execute(ignored -> store.beginWorkspaceLifecycle("tenant", f.session, OperationKind.CLOSE,
                "owner", "a".repeat(64), "cleanup", "digest", false, 2)).operation().operationId()).isEqualTo(admission.operation().operationId());
    }

    @Test
    void cannotInventNeverInitializedOrClearAnUnknownBusinessEffect() {
        var f = fixture();
        var binding = f.bindings.findOrCreate(new RuntimeProvisionRequest(f.scope(), f.session));
        var ledger = new JdbcToolExecutionRepository(f.jdbc.getDataSource());
        ledger.findOrCreate(ToolExecutionRecord.prepared("call-1", "call-1", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "tool-1", "a".repeat(64), Map.of("sessionId", "original-owner", "promptId", "turn-1", "callId", "tool-1", "argsDigest", "a".repeat(64))));
        var op = admit(f, WorkspaceToolProfiles.MCP, OperationKind.DELETE);
        assertThat(f.transactions.<com.fasterxml.jackson.databind.JsonNode>execute(ignored -> f.lifecycle.recoverEffects(op))).isNull();
        assertThatThrownBy(() -> f.transactions.executeWithoutResult(ignored -> f.lifecycle.requireSettledExecutions(op)))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_close_execution_unsettled"));
        assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM ma_session WHERE retired_at IS NOT NULL", Integer.class)).isZero();
    }

    @Test
    void aSettledExecutionWithoutItsOutputReceiptStillBlocksShellResources() {
        var f = fixture();
        var binding = f.bindings.findOrCreate(new RuntimeProvisionRequest(f.scope(), f.session));
        var ledger = new JdbcToolExecutionRepository(f.jdbc.getDataSource());
        var execution = ledger.findOrCreate(ToolExecutionRecord.prepared("call-1", "call-1", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "tool-1", "a".repeat(64), Map.of("sessionId", "original-owner", "promptId", "turn-1", "callId", "tool-1", "argsDigest", "a".repeat(64))));
        ledger.settlePrepared(execution, Map.of("executionStatus", "success"), java.time.Instant.now());
        var operation = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        var beans = new org.springframework.beans.factory.support.DefaultListableBeanFactory();
        var verifier = new WorkspaceProfileLifecycleVerifier(f.jdbc, beans.getBeanProvider(ToolPublicationDataStore.class),
                beans.getBeanProvider(ManagedToolResultStore.class));
        assertThatThrownBy(() -> f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation,
                java.util.List.of(binding), WorkspaceToolProfiles.SHELL)))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_lifecycle_resources_unsettled"));
        assertThat(f.store.requireSession("tenant", f.session).status()).isEqualTo("CLOSING");
    }

    @ParameterizedTest
    @ValueSource(strings = {"read_file", "write_file", "edit", "glob", "wrong_digest", "wrong_runtime", "wrong_harness",
            "shell", "v3", "publication", "unreferenced", "corrupt", "unsettled"})
    void shellProfileNativeFileInputsRequireOriginalIdentityAndKnownSettlement(String mode) throws Exception {
        var f = fixture();
        var binding = f.bindings.findOrCreate(new RuntimeProvisionRequest(f.scope(), f.session));
        String tool = java.util.List.of("read_file", "write_file", "edit", "glob").contains(mode) ? mode
                : "shell".equals(mode) ? "run_shell_command" : "read_file";
        String payload = f.json.writeValueAsString(Map.of("toolName", tool, "input", Map.of("file_path", "proof.txt")));
        String requestDigest = "sha256:" + ("wrong_digest".equals(mode) ? "a".repeat(64)
                : ToolPublicationContract.sha256(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        var reference = new java.util.HashMap<String, Object>(Map.of("sessionId", "original-owner", "promptId", "turn-1",
                "callId", "tool-1", "argsDigest", requestDigest, "dispatchMode", "deferred"));
        if ("v3".equals(mode)) {
            reference.put("runtimeProtocol", 3);
        }
        if ("publication".equals(mode)) {
            reference.put("publicationId", "pub-1");
        }
        var ledger = new JdbcToolExecutionRepository(f.jdbc.getDataSource());
        var execution = ledger.findOrCreate(ToolExecutionRecord.prepared("call-1", "call-1", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "tool-1", requestDigest, reference));
        if (!"unsettled".equals(mode)) {
            ledger.settlePrepared(execution, Map.of("executionStatus", "success"), java.time.Instant.now());
        }
        f.resource("native-input", "managed-tool-input", f.json.createObjectNode()
                .put("harnessSessionId", "wrong_harness".equals(mode) ? "other-session" : f.session)
                .put("runtimeSessionId", "wrong_runtime".equals(mode) ? "other-owner" : "original-owner")
                .put("payloadJson", payload));
        if ("unreferenced".equals(mode)) {
            f.jdbc.update("UPDATE ma_resource SET state = 'PUBLISHED'");
        }
        if ("corrupt".equals(mode)) {
            f.jdbc.update("UPDATE ma_resource SET sha256 = ?", "f".repeat(64));
        }
        var operation = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        var beans = new org.springframework.beans.factory.support.DefaultListableBeanFactory();
        var verifier = new WorkspaceProfileLifecycleVerifier(f.jdbc, beans.getBeanProvider(ToolPublicationDataStore.class),
                beans.getBeanProvider(ManagedToolResultStore.class));
        Runnable verify = () -> f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation,
                java.util.List.of(binding), WorkspaceToolProfiles.SHELL));
        if (java.util.List.of("read_file", "write_file", "edit", "glob").contains(mode)) {
            verify.run();
        } else {
            assertThatThrownBy(verify::run).isInstanceOf(ApiException.class);
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"not_started", "pre_dispatch_cancel"})
    void closesOnlyAuthoritativelyUnusedPublicationsForTheOriginalExecution(String status) {
        var f = fixture();
        var publication = PublicationJournalFixture.createSessionIsolated(f.jdbc.getDataSource());
        publication.reserve();
        var original = publication.executions.findByExecutionCallId("execution-1");
        if ("pre_dispatch_cancel".equals(status)) {
            publication.executions.requestCancel(original.getExecutionCallId(), original.getVersion());
        } else {
            var dispatched = publication.executions.claimDispatch("execution-1", "dispatcher", Duration.ofSeconds(30));
            var result = new java.util.HashMap<String, Object>();
            result.put("executionStatus", "not_started");
            result.put("capture", null);
            assertThat(publication.executions.compareAndSet(dispatched,
                    dispatched.withResult(result, 0, java.time.Instant.now()), "dispatcher", dispatched.getDispatchGeneration())).isNotNull();
        }
        var settled = publication.executions.findByExecutionCallId("execution-1");
        assertThat(settled.isSettled()).isTrue();
        assertThat(settled.getExecutionStatus()).isEqualTo("not_started");
        assertThat(settled.getDispatchGeneration()).isEqualTo("pre_dispatch_cancel".equals(status) ? 0 : 1);
        var envelope = f.json.createObjectNode().put("executionStatus", settled.getExecutionStatus()).putNull("capture");
        envelope.putArray("responseParts");
        var outcome = f.json.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
        outcome.set("envelope", envelope);
        var outcomeRef = PublicationJournalFixture.ref("unused-outcome", "managed-tool-outcome", outcome);
        var receipt = f.json.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", publication.sequence + 1).putNull("resultRef");
        receipt.set("toolOutcomeRef", outcomeRef);
        receipt.putArray("resources");
        var event = PublicationJournalFixture.eventNode(publication.sequence + 1, "tool.receipt", receipt, publication.binding.path("sessionKey"), 1);
        publication.append("recordToolResult", publication.event(publication.sequence + 1, "tool.receipt", receipt)
                + PublicationJournalFixture.COMMIT_MARKER, 1, java.util.List.of(PublicationJournalFixture.resource(outcomeRef, outcome)), null);
        var results = new ManagedToolResultStore(f.jdbc, publication.manager, f.store);
        results.captureEvents("tenant-1", "workspace-1", "session-1", publication.revision, java.util.List.of(event));
        var beans = new org.springframework.beans.factory.support.DefaultListableBeanFactory();
        beans.registerSingleton("results", results);
        var verifier = new WorkspaceProfileLifecycleVerifier(f.jdbc, beans.getBeanProvider(ToolPublicationDataStore.class),
                beans.getBeanProvider(ManagedToolResultStore.class));
        var operation = new OperationRecord("tenant-1", "session-1", "close", OperationKind.CLOSE,
                "digest", "RUNNING", "ACCEPTED", "PENDING", "ACTIVE", null, "server", 1, 1, null, 2);
        Runnable verifyPublications = () -> f.transactions.executeWithoutResult(ignored -> verifier.verifyPublications(operation));
        Runnable verifyResources = () -> f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation,
                java.util.List.of(publication.bindings.findById("binding-1")), WorkspaceToolProfiles.SHELL));
        assertThatThrownBy(verifyPublications::run).isInstanceOf(ApiException.class);
        assertThatThrownBy(verifyResources::run).isInstanceOf(ApiException.class);
        assertThat(publication.store.apply(publication.request("close_not_started"), PublicationJournalFixture.WRITER_TOKEN, null)
                .path("state").asText()).isEqualTo("NOT_STARTED");
        assertThat(f.jdbc.queryForObject("SELECT producer_phase FROM ma_output_capture WHERE tenant_id = ?", String.class, "tenant-1")).isEqualTo("OPEN");
        verifyPublications.run();
        verifyResources.run();
        for (String mutation : java.util.List.of("state = 'FENCED'", "producer_phase = 'FINISHING'", "quarantined = TRUE", "terminal_resource_id = 'unexpected'")) {
            f.jdbc.update("UPDATE ma_output_capture SET " + mutation + " WHERE tenant_id = ?", "tenant-1");
            assertThatThrownBy(verifyPublications::run).isInstanceOf(ApiException.class);
            assertThatThrownBy(verifyResources::run).isInstanceOf(ApiException.class);
            f.jdbc.update("UPDATE ma_output_capture SET state = 'NOT_STARTED', producer_phase = 'OPEN', quarantined = FALSE, terminal_resource_id = NULL WHERE tenant_id = ?", "tenant-1");
        }
        var conflicting = publication.binding.deepCopy().put("runtimeBindingId", "other-binding");
        f.jdbc.update("UPDATE ma_output_capture SET binding_json = ?, binding_digest = ? WHERE tenant_id = ?",
                conflicting.toString(), ToolPublicationContract.bindingDigest(conflicting), "tenant-1");
        assertThatThrownBy(verifyPublications::run).isInstanceOf(ApiException.class);
        assertThatThrownBy(verifyResources::run).isInstanceOf(ApiException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"complete", "capture_failed", "wrong_identity", "missing_seal", "open", "receipt", "publication",
            "deferred_v3", "deferred_v3_input", "wrong_digest", "missing_input_digest", "invalid_input_digest"})
    void verifiesPublishedForegroundCaptureAndRejectsMissingOrChangedEvidence(String mode) throws Exception {
        boolean captureFailed = "capture_failed".equals(mode);
        boolean publication = "publication".equals(mode);
        boolean legacy = !publication && !mode.startsWith("deferred_v3");
        var f = fixture();
        var binding = f.bindings.findOrCreate(new RuntimeProvisionRequest(f.scope(), f.session));
        var ledger = new JdbcToolExecutionRepository(f.jdbc.getDataSource());
        var reference = new java.util.HashMap<String, Object>(Map.of("sessionId", "original-owner", "promptId", "turn-1", "callId", "runtime-call", "argsDigest", "sha256:" + "a".repeat(64)));
        reference.put("dispatchMode", legacy ? "deferred" : "deferred_v3");
        if (legacy) {
            reference.put("runtimeProtocol", 3);
            if (!"missing_input_digest".equals(mode)) {
                reference.put("inputDigest", "invalid_input_digest".equals(mode) ? "invalid" : "b".repeat(64));
            }
        } else {
            reference.put("payloadDigest", "sha256:" + "c".repeat(64));
            if ("deferred_v3_input".equals(mode)) {
                reference.put("inputDigest", "b".repeat(64));
            }
        }
        if (publication) {
            reference.put("publicationId", "pub-1");
        }
        ledger.findOrCreate(ToolExecutionRecord.prepared("call-1", "call-1", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "runtime-call", "sha256:" + (legacy ? "a" : "c").repeat(64),
                reference));
        var execution = ledger.claimDispatch("call-1", "dispatcher", Duration.ofSeconds(30));
        ledger.compareAndSet(execution, execution.withResult(Map.of("executionStatus", "success"), 0, java.time.Instant.now()),
                "dispatcher", execution.getDispatchGeneration());
        var manifest = f.json.createObjectNode().put("toolResult", "managed-tool-result/1").put("type", "manifest")
                .put("tenantId", "tenant").put("sessionId", f.session).put("turnId", "turn-1").put("executionCallId", "call-1")
                .put("callId", "runtime-call").put("invocationDigest", legacy && !"wrong_digest".equals(mode) ? "b".repeat(64) : "sha256:" + "a".repeat(64)).put("bindingGeneration", "1")
                .put("captureId", "capture-1").put("revision", 1).put("executionStatus", "success")
                .put("captureScope", "process_pipes").put("capturePolicy", "complete_required")
                .put("captureStatus", captureFailed ? "unavailable" : "complete")
                .put("captureReason", captureFailed ? "storage_failed" : null).put("upstreamTruncated", false)
                .put("exitCode", 0).putNull("signal");
        var contents = manifest.putArray("contents");
        for (String stream : java.util.List.of("stdout", "stderr")) {
            String segmentId = ToolPublicationContract.sha256(f.json.writeValueAsBytes(java.util.List.of("capture-1", stream, 0)));
            var ref = f.resource(segmentId, "managed-tool-result-content", f.json.getNodeFactory().textNode("real output"));
            var content = contents.addObject().put("streamId", stream).put("role", stream).put("mimeType", "application/octet-stream")
                    .put("state", captureFailed ? "incomplete" : "sealed").put("byteLength", captureFailed ? 0 : ref.path("byteLength").asLong())
                    .put("digest", captureFailed ? ToolPublicationContract.sha256(new byte[0]) : ref.path("digest").asText());
            content.putArray("missingRanges");
            var pages = content.putObject("body").putArray("pages");
            if (!captureFailed) {
                var page = f.json.createObjectNode().put("toolResult", "managed-tool-result/1").put("type", "page")
                        .put("captureId", "capture-1").put("streamId", stream).put("firstOrdinal", 0).put("offset", 0);
                page.putArray("segments").addObject().put("byteLength", ref.path("byteLength").asLong()).put("digest", ref.path("digest").asText());
                var pageRef = f.resource(stream + "-page", "managed-tool-result-page", page);
                pages.addObject().put("segmentCount", 1).put("byteLength", ref.path("byteLength").asLong()).set("ref", pageRef);
                String sealId = ToolPublicationContract.sha256(f.json.writeValueAsBytes(java.util.List.of("capture-1", stream, "seal")));
                f.resource(sealId, "managed-tool-result-content", f.json.createObjectNode().put("segmentCount", 1)
                        .put("byteLength", ref.path("byteLength").asLong()).put("digest", ref.path("digest").asText()));
            }
        }
        if ("open".equals(mode)) {
            ((com.fasterxml.jackson.databind.node.ObjectNode) contents.get(0)).put("state", "open");
            manifest.put("captureStatus", "pending").putNull("captureReason");
        }
        ToolPublicationContract.parseToolResult("manifest", f.json.writeValueAsBytes(manifest), 64 * 1024);
        var manifestRef = f.resource("manifest", "managed-tool-result-manifest", manifest);
        f.jdbc.update("UPDATE ma_resource SET state = 'PUBLISHED' WHERE resource_id <> X'6f7574636f6d65'");
        boolean committed = !captureFailed && !"open".equals(mode);
        var outcome = f.json.createObjectNode().put("version", 1).put("decision", committed ? "committed" : "blocked");
        var identity = outcome.putObject("identity");
        for (String field : java.util.List.of("tenantId", "sessionId", "turnId", "executionCallId", "callId", "invocationDigest", "bindingGeneration", "captureId", "revision")) {
            identity.set(field, manifest.path(field));
        }
        if ("wrong_identity".equals(mode)) {
            identity.put("bindingGeneration", "2");
        }
        var envelope = outcome.putObject("envelope").put("executionStatus", "success");
        envelope.putArray("responseParts");
        envelope.putObject("capture").put("captureStatus", "open".equals(mode) ? "partial" : manifest.path("captureStatus").asText())
                .put("captureReason", committed ? null : "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", committed ? "committed" : "blocked").set("manifest", manifestRef);
        ToolPublicationContract.parseToolResult("result", f.json.writeValueAsBytes(envelope), 64 * 1024);
        var outcomeRef = f.resource("outcome", "managed-tool-outcome", outcome);
        var event = f.json.createObjectNode().put("kind", "tool.receipt").put("sequence", 1);
        event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", f.session);
        var payload = event.putObject("payload").put("executionCallId", "call-1");
        payload.set("toolOutcomeRef", outcomeRef);
        payload.set("resultRef", !committed || "receipt".equals(mode) ? f.json.nullNode() : manifestRef);
        payload.putArray("resources").add(manifestRef);
        byte[] bytes = f.json.writeValueAsBytes(f.json.createObjectNode().put("subtype", "managed_session_event_v1").set("managedSession", event));
        f.jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision, command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence, event_count, writer_generation, writer_id, writer_token_hash, activation_epoch, record_encoding, record_bytes, byte_length, record_digest, gmt_create) VALUES ('tenant', 'workspace', ?, 1, ?, 'receipt', 'recordToolResult', 'call-1', ?, 1, 1, 1, 1, 'writer', ?, 0, 'identity', ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                f.session, "c".repeat(64), "c".repeat(64), "c".repeat(64), bytes, bytes.length, ToolPublicationContract.sha256(bytes));
        var beans = new org.springframework.beans.factory.support.DefaultListableBeanFactory();
        var results = new ManagedToolResultStore(f.jdbc, new org.springframework.jdbc.datasource.DataSourceTransactionManager(f.jdbc.getDataSource()), f.store);
        results.captureEvents("tenant", "workspace", f.session, 1, java.util.List.of(event));
        beans.registerSingleton("results", results);
        var verifier = new WorkspaceProfileLifecycleVerifier(f.jdbc, beans.getBeanProvider(ToolPublicationDataStore.class),
                beans.getBeanProvider(ManagedToolResultStore.class));
        var operation = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        Runnable verify = () -> f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation, java.util.List.of(binding), WorkspaceToolProfiles.SHELL));
        if (publication) {
            f.jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id, publication_id, execution_key,"
                    + " capture_id, binding_json, binding_digest, token_hash, state, capture_bytes, producer_bytes, admission_bytes, producer_phase,"
                    + " admission_resource_id, receipt_sequence, receipt_revision) VALUES (?, ?, 'tenant', 'workspace', ?, 'pub-1', ?, 'capture-1', '{}', ?, ?,"
                    + " 'READY', 1024, 1024, 1024, 'REFERENCED', 'outcome', 1, 1)",
                    "s".repeat(64), "t".repeat(64), f.session, "e".repeat(64), "b".repeat(64), "h".repeat(64));
            f.jdbc.update("UPDATE ma_resource SET storage_kind = 'TOOL_PUBLICATION', inline_bytes = NULL WHERE resource_id = X'6f7574636f6d65'");
            assertThatThrownBy(() -> verifier.verifyPublications(operation)).isInstanceOf(ApiException.class);
            verify.run();
            f.jdbc.update("UPDATE ma_output_capture SET quarantined = TRUE WHERE publication_id = X'7075622d31'");
            assertThatThrownBy(verify::run).isInstanceOf(ApiException.class);
            return;
        }
        if ("missing_seal".equals(mode)) {
            String sealId = ToolPublicationContract.sha256(f.json.writeValueAsBytes(java.util.List.of("capture-1", "stdout", "seal")));
            f.jdbc.update("DELETE FROM ma_resource WHERE resource_id = ?", sealId);
        }
        if (java.util.List.of("wrong_identity", "missing_seal", "open", "receipt", "wrong_digest", "missing_input_digest", "invalid_input_digest").contains(mode)) {
            assertThatThrownBy(verify::run).isInstanceOf(ApiException.class);
            return;
        }
        verify.run();
        f.jdbc.update("UPDATE ma_resource SET sha256 = ? WHERE resource_id = X'6d616e6966657374'", "0".repeat(64));
        assertThatThrownBy(verify::run).isInstanceOf(ApiException.class);
        f.jdbc.update("UPDATE ma_resource SET sha256 = ? WHERE resource_id = X'6d616e6966657374'", manifestRef.path("digest").asText());
        verify.run();
        f.jdbc.update("DELETE FROM ma_resource WHERE resource_id = X'6d616e6966657374'");
        assertThatThrownBy(verify::run).isInstanceOf(ApiException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"exited", "signalled", "stop_requested", "capture_failed", "publication"})
    void verifiesOriginalBackgroundExitAndSealedOrKnownFailedOutput(String mode) throws Exception {
        var f = fixture();
        var binding = f.bindings.findOrCreate(new RuntimeProvisionRequest(f.scope(), f.session));
        var ledger = new JdbcToolExecutionRepository(f.jdbc.getDataSource());
        var reference = new java.util.HashMap<String, Object>(Map.of("sessionId", "original-owner", "promptId", "turn-1", "callId", "runtime-call",
                "argsDigest", "sha256:" + "a".repeat(64), "dispatchMode", "deferred_v3", "payloadDigest", "sha256:" + "c".repeat(64)));
        if ("publication".equals(mode)) {
            reference.put("publicationId", "pub-1");
        }
        ledger.findOrCreate(ToolExecutionRecord.prepared("call-1", "call-1", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "runtime-call", "sha256:" + "c".repeat(64), reference));
        var start = ledger.claimDispatch("call-1", "dispatcher", Duration.ofSeconds(30));
        ledger.compareAndSet(start, start.withResult(Map.of("executionStatus", "success"), 0, java.time.Instant.now()),
                "dispatcher", start.getDispatchGeneration());
        var processReference = new java.util.HashMap<>(reference);
        processReference.remove("payloadDigest");
        processReference.remove("publicationId");
        processReference.put("argsDigest", "sha256:" + "c".repeat(64));
        processReference.put("dispatchMode", "background_v3_process");
        processReference.put("processOf", "call-1");
        var process = ledger.findOrCreate(ToolExecutionRecord.prepared("call-1:process", "call-1:process", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "runtime-call", "sha256:" + "c".repeat(64), processReference));
        boolean signal = "signalled".equals(mode) || "stop_requested".equals(mode);
        var evidence = signal ? Map.<String, Object>of("exitSignal", "SIGTERM") : Map.<String, Object>of("exitCode", 0);
        ledger.settlePrepared(process, Map.of("state", "exited", "executionStatus", signal ? "error" : "success", "evidence", evidence),
                java.time.Instant.now());
        var manifest = f.json.createObjectNode().put("toolResult", "managed-tool-result/1").put("type", "manifest")
                .put("tenantId", "tenant").put("sessionId", f.session).put("turnId", "turn-1").put("executionCallId", "call-1")
                .put("callId", "runtime-call").put("invocationDigest", "sha256:" + "a".repeat(64)).put("bindingGeneration", "1")
                .put("captureId", "capture-1").put("revision", 1).put("executionStatus", signal ? "error" : "success")
                .put("captureScope", "process_pipes").put("capturePolicy", "complete_required")
                .put("captureStatus", "capture_failed".equals(mode) ? "unavailable" : "complete")
                .put("captureReason", "capture_failed".equals(mode) ? "storage_failed" : null).put("upstreamTruncated", false);
        if (signal) {
            manifest.putNull("exitCode").put("signal", "SIGTERM");
        } else {
            manifest.put("exitCode", 0).putNull("signal");
        }
        var contents = manifest.putArray("contents");
        for (String stream : java.util.List.of("stdout", "stderr")) {
            var content = contents.addObject().put("streamId", stream).put("role", stream).put("mimeType", "application/octet-stream")
                    .put("state", "capture_failed".equals(mode) ? "incomplete" : "sealed").put("byteLength", 0)
                    .put("digest", ToolPublicationContract.sha256(new byte[0]));
            content.putArray("missingRanges");
            content.putObject("body").putArray("pages");
            String sealId = ToolPublicationContract.sha256(f.json.writeValueAsBytes(java.util.List.of("capture-1", stream, "seal")));
            f.resource(sealId, "managed-tool-result-content", f.json.createObjectNode().put("segmentCount", 0).put("byteLength", 0)
                    .put("digest", ToolPublicationContract.sha256(new byte[0])));
        }
        var record = f.json.readTree(java.nio.file.Path.of("../core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json").toFile())
                .path("templates").path("child_run").deepCopy();
        var shell = (com.fasterxml.jackson.databind.node.ObjectNode) record;
        shell.set("startReceiptRef", f.resource("receipt", "managed-runtime-receipt", f.json.createObjectNode()
                .put("executionCallId", "call-1").put("runtimeCallId", "runtime-call").put("bindingGeneration", "1")));
        shell.set("outputRef", f.resource("manifest", "managed-tool-result-manifest", manifest));
        shell.put("stopReason", "stop_requested".equals(mode) ? "stop_requested" : "exited")
                .put("stopRequested", "stop_requested".equals(mode));
        if (!"stop_requested".equals(mode)) {
            if (signal) {
                shell.put("exitSignal", "SIGTERM");
            } else {
                shell.put("exitCode", 0);
            }
        }
        shell.withObject("/run").put("state", "stop_requested".equals(mode) ? "cancelled" : "settled").put("execution", "settled")
                .putObject("runtime").put("runtimeBindingId", binding.getBindingId()).put("generation", "1");
        ManagedExtensionRecords.requireChildRun(shell);
        var ref = f.resource("background-record", "managed-child_run", shell);
        f.jdbc.update("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, workspace_id, session_id,"
                + " domain, record_id, operation_hash, revision, record_resource_id, task_kind, task_state, gmt_create)"
                + " VALUES (?, ?, 'tenant', 'workspace', ?, 'child_run', 'shell-1', ?, 1, ?, 'background_shell', 'settled', 1)",
                ManagedSessionStore.sessionScopeKey("tenant", f.session), "r".repeat(64), f.session, "o".repeat(64), ref.path("resourceId").asText());
        var operation = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        var beans = new org.springframework.beans.factory.support.DefaultListableBeanFactory();
        var verifier = new WorkspaceProfileLifecycleVerifier(f.jdbc, beans.getBeanProvider(ToolPublicationDataStore.class),
                beans.getBeanProvider(ManagedToolResultStore.class));
        verifier.verifyPublications(operation);
        f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation, java.util.List.of(binding), WorkspaceToolProfiles.SHELL));
        f.jdbc.update("DELETE FROM ma_resource WHERE resource_id = X'6d616e6966657374'");
        assertThatThrownBy(() -> f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation,
                java.util.List.of(binding), WorkspaceToolProfiles.SHELL))).isInstanceOf(ApiException.class);
        if ("publication".equals(mode)) {
            f.jdbc.update("DELETE FROM ma_session_record WHERE domain = 'child_run'");
            assertThatThrownBy(() -> verifier.verifyPublications(operation)).isInstanceOf(ApiException.class);
        }
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void queuedNotificationIsCleanupWorkButAnActivatedNotificationIsATurn(boolean activated) throws Exception {
        var f = fixture();
        var journal = new com.alibaba.qwen.code.managedagent.ExtensionRecordJournal(new ManagedSessionStore(f.jdbc), "tenant", "workspace", f.session);
        f.transactions.executeWithoutResult(ignored -> journal.open());
        var input = f.json.createObjectNode();
        var event = input.putObject("managedSession").put("kind", "input.accepted");
        event.putObject("payload").put("turnId", "queued-monitor").put("source", "monitor");
        String records = input + "\n";
        if (activated) {
            var activation = f.json.createObjectNode();
            activation.putObject("managedSession").put("kind", "activation.changed").putObject("payload")
                    .putObject("subject").put("type", "turn").put("turnId", "queued-monitor");
            records += activation + "\n";
        }
        f.jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ?", records.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (activated) {
            assertThatThrownBy(() -> admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE))
                    .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("turn_active"));
        } else {
            assertThat(admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE)).isNotNull();
        }
    }

    @Test
    void rejectsNewModelAttemptsDuringBothLifecyclePhases() {
        var f = fixture();
        var operation = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        byte[] bytes = "{\"managedSession\":{\"kind\":\"model.attempt\",\"payload\":{\"state\":\"started\"}}}\n"
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        var records = new ManagedExtensionRecordStore(f.jdbc);
        for (boolean resources : java.util.List.of(false, true)) {
            if (resources) {
                f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(operation));
            }
            boolean resourcePhase = WorkspaceLifecycleStore.resourceClaim(f.jdbc, "tenant", f.session,
                    WorkspaceLifecycleStore.authority(operation));
            assertThat(resourcePhase).isEqualTo(resources);
            assertThatThrownBy(() -> records.hasNewLifecycleDispatch("tenant", f.session, bytes, ignored -> null, true, resourcePhase))
                    .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_lifecycle_admission_closed"));
        }
    }

    @Test
    void unknownPersistedProtocolCannotAcquireARecoveryOwner() {
        var f = fixture();
        var operation = admit(f, WorkspaceToolProfiles.MCP, OperationKind.CLOSE);
        f.jdbc.update("UPDATE ma_operation SET lifecycle_protocol_version = 3");
        assertThatThrownBy(() -> f.bindings.requireHarnessRecovery(f.scope(), f.session, WorkspaceLifecycleStore.authority(operation)))
                .hasMessageContaining("closed");
    }

    @ParameterizedTest
    @ValueSource(strings = {"hosted-workspace-shell/2", "hosted-workspace-mcp/2"})
    void rejectsUnsupportedProfilesBeforeWritingAnOperation(String profile) {
        var f = fixture();
        assertThatThrownBy(() -> admit(f, profile, OperationKind.CLOSE)).isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> f.transactions.execute(ignored -> f.store.beginWorkspaceLifecycle("tenant", f.session,
                OperationKind.CLOSE, "owner", "a".repeat(64), "legacy", "digest", true, 0)))
                .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("workspace_unavailable"));
        assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Integer.class)).isZero();
    }

    /**
     * An ordinary duplicate commit against a v2-claimed Session is refused
     * with the claim's name, like a first attempt; it must not replay the
     * earlier receipt and read the drained Session as writable (#13800).
     */
    @Test
    void duplicateOrdinaryCommitIsFencedByAVersionTwoClaim() throws Exception {
        var f = fixture();
        var sessions = new ManagedSessionStore(f.jdbc);
        var journal = f.transactions.execute(ignored ->
                new ExtensionRecordJournal(sessions, "tenant", "workspace", f.session).open());
        var templates = ManagedHookRecordContractTest.fixtures().get("templates");
        var data = new ManagedSessionStoreModels.CommitResource("hook-data", "hook-data", 1, 2,
                ToolPublicationContract.sha256("{}".getBytes(java.nio.charset.StandardCharsets.UTF_8)), "e30=");
        var registration = templates.get("hook_registration").deepCopy();
        ((com.fasterxml.jackson.databind.node.ObjectNode) registration).withObject("/catalogRef")
                .put("digest", data.digest());
        var request = journal.requestDomain("duplicate-under-claim", "hook_registration",
                registration, List.of(data), System.currentTimeMillis());
        f.transactions.execute(ignored -> journal.commit(request));
        assertThat(admit(f, WorkspaceToolProfiles.SHELL, OperationKind.DELETE).lifecycleProtocolVersion()).isEqualTo(2);
        assertThatThrownBy(() -> f.transactions.execute(ignored -> journal.commit(request)))
                .isInstanceOfSatisfying(ApiException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_lifecycle_claim_fenced"));
    }
}

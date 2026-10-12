package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import java.time.Clock;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.junit.jupiter.api.Test;

class WorkspaceProfileLifecycleTest {
    WorkspaceLifecycleStoreTest.Fixture fixture() {
        return new WorkspaceLifecycleStoreTest.Fixture();
    }

    OperationRecord admit(WorkspaceLifecycleStoreTest.Fixture f, String profile, OperationKind kind) {
        f.jdbc.update("UPDATE managed_agent_session SET tool_profile = ?", profile);
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
        assertThat(f.jdbc.queryForObject("SELECT phase FROM qwen_runtime_harness_drain", String.class)).isEqualTo("DRAINING");
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.verifyResources(op));
        assertThat(f.transactions.<Boolean>execute(ignored -> f.store.completeOperation("tenant", f.session, op.operationId(),
                op.leaseOwner(), op.claimGeneration(), true))).isTrue();
        assertThat(f.store.requireSession("tenant", f.session).status()).isEqualTo("DELETED");
        assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isEqualTo(1);
        assertThat(f.jdbc.queryForObject("SELECT state FROM managed_workspace_registry", String.class)).isEqualTo("ACTIVE");
    }

    @Test
    void drainingTakeoverAllowsOnlyTheCurrentCleanupWriterAndBrokerClaim() {
        var f = fixture();
        var first = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(first));
        f.jdbc.update("UPDATE managed_agent_operation SET lease_until = 0");
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
    void cleanupAdmissionDoesNotRequireTheNewExecutionSwitch(String profile) {
        var f = fixture();
        f.jdbc.update("UPDATE managed_agent_session SET tool_profile = ?", profile);
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
        assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isZero();
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
    @ValueSource(strings = {"exited", "signalled", "stop_requested", "capture_failed"})
    void verifiesOriginalBackgroundExitAndSealedOrKnownFailedOutput(String mode) throws Exception {
        var f = fixture();
        var binding = f.bindings.findOrCreate(new RuntimeProvisionRequest(f.scope(), f.session));
        var ledger = new JdbcToolExecutionRepository(f.jdbc.getDataSource());
        var reference = Map.<String, Object>of("sessionId", "original-owner", "promptId", "turn-1", "callId", "runtime-call",
                "argsDigest", "sha256:" + "a".repeat(64));
        var start = ledger.findOrCreate(ToolExecutionRecord.prepared("call-1", "call-1", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "runtime-call", "sha256:" + "a".repeat(64), reference));
        ledger.settlePrepared(start, Map.of("executionStatus", "success"), java.time.Instant.now());
        var processReference = new java.util.HashMap<>(reference);
        processReference.put("dispatchMode", "background_v3_process");
        processReference.put("processOf", "call-1");
        var process = ledger.findOrCreate(ToolExecutionRecord.prepared("call-1:process", "call-1:process", binding.getBindingId(), binding.getGeneration(),
                f.session, "original-owner", "turn-1", "runtime-call", "sha256:" + "a".repeat(64), processReference));
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
        var record = f.json.readTree(java.nio.file.Path.of("../../core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json").toFile())
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
        f.jdbc.update("INSERT INTO qwen_managed_session_extension_record (session_scope_key, record_key, tenant_id, workspace_id, session_id,"
                + " domain, record_id, operation_hash, revision, record_resource_id, task_kind, task_state, created_at)"
                + " VALUES (?, ?, 'tenant', 'workspace', ?, 'child_run', 'shell-1', ?, 1, ?, 'background_shell', 'settled', 1)",
                ManagedSessionStore.sessionScopeKey("tenant", f.session), "r".repeat(64), f.session, "o".repeat(64), ref.path("resourceId").asText());
        var operation = admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE);
        var beans = new org.springframework.beans.factory.support.DefaultListableBeanFactory();
        var verifier = new WorkspaceProfileLifecycleVerifier(f.jdbc, beans.getBeanProvider(ToolPublicationDataStore.class),
                beans.getBeanProvider(ManagedToolResultStore.class));
        f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation, java.util.List.of(binding), WorkspaceToolProfiles.SHELL));
        f.jdbc.update("DELETE FROM qwen_managed_session_resource WHERE resource_id = 'manifest'");
        assertThatThrownBy(() -> f.transactions.executeWithoutResult(ignored -> verifier.verifyResources(operation,
                java.util.List.of(binding), WorkspaceToolProfiles.SHELL))).isInstanceOf(ApiException.class);
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
        f.jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?", records.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        if (activated) {
            assertThatThrownBy(() -> admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE))
                    .isInstanceOfSatisfying(ApiException.class, error -> assertThat(error.getCode()).isEqualTo("turn_active"));
        } else {
            assertThat(admit(f, WorkspaceToolProfiles.SHELL, OperationKind.CLOSE)).isNotNull();
        }
    }

    @Test
    void unknownPersistedProtocolCannotAcquireARecoveryOwner() {
        var f = fixture();
        var operation = admit(f, WorkspaceToolProfiles.MCP, OperationKind.CLOSE);
        f.jdbc.update("UPDATE managed_agent_operation SET lifecycle_protocol_version = 3");
        assertThatThrownBy(() -> f.bindings.requireHarnessRecovery(f.scope(), f.session, WorkspaceLifecycleStore.authority(operation)))
                .hasMessageContaining("closed");
    }

    @ParameterizedTest
    @ValueSource(strings = {"hosted-workspace-shell/2", "hosted-workspace-mcp/2"})
    void rejectsUnsupportedProfilesBeforeWritingAnOperation(String profile) {
        var f = fixture();
        assertThatThrownBy(() -> admit(f, profile, OperationKind.CLOSE)).isInstanceOf(ApiException.class);
        assertThat(f.jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_operation", Integer.class)).isZero();
    }
}

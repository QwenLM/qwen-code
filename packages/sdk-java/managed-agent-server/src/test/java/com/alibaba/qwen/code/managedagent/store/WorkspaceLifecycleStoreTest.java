package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.ExtensionRecordJournal;
import com.alibaba.qwen.code.managedagent.ManagedHookRecordContractTest;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class WorkspaceLifecycleStoreTest {
    @ParameterizedTest
    @MethodSource("fencedHookTransitions")
    void lifecycleHookTransitionsRecheckNewEffectsAndKeepOriginalSettlement(boolean authority, boolean granted,
            String before, String after, boolean replacement, boolean accepted, boolean batch, boolean draining) throws Exception {
        var fixture = fixture();
        var store = new ManagedSessionStore(fixture.jdbc);
        store.setLifecycleExecution(new WorkspaceExecutionStore(fixture.jdbc,
                new DataSourceTransactionManager(fixture.jdbc.getDataSource())), fixture.store);
        var journal = fixture.transactions.execute(ignored -> new ExtensionRecordJournal(store, "tenant", "workspace", fixture.session).open());
        var templates = ManagedHookRecordContractTest.fixtures().get("templates");
        var data = new ManagedSessionStoreModels.CommitResource("hook-data", "hook-data", 1, 2,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest("{}".getBytes(StandardCharsets.UTF_8))), "e30=");
        ObjectNode registration = templates.get("hook_registration").deepCopy();
        registration.withObject("/catalogRef").put("digest", data.digest());
        for (String state : List.of("admitted", "running", "settled")) {
            registration.withObject("/run").put("state", state);
            var request = journal.requestDomain("register-" + state, "hook_registration", registration, List.of(data), 1000);
            fixture.transactions.executeWithoutResult(ignored -> journal.commit(request));
            journal.committed(request);
        }
        ObjectNode execution = templates.get("hook_execution").deepCopy();
        execution.set("planRef", registration.get("catalogRef"));
        execution.set("inputRef", registration.get("catalogRef"));
        execution.withObject("/run").put("execution", "intent").putObject("runtime")
                .put("runtimeBindingId", "original-binding").put("generation", "1");
        for (String state : "intent".equals(before) ? List.of("intent")
                : "dispatch_started".equals(before) ? List.of("intent", "dispatch_started")
                : List.of("intent", "dispatch_started", "outcome_unknown")) {
            hookState(execution, state, registration.get("catalogRef"));
            var request = journal.requestDomain("seed-" + state, "hook_execution", execution, List.of(), 1000);
            fixture.transactions.executeWithoutResult(ignored -> journal.commit(request));
            journal.committed(request);
        }
        var operation = fixture.admit(OperationKind.DELETE);
        if (draining) fixture.jdbc.update("UPDATE qwen_runtime_harness_drain SET phase = 'DRAINING'");
        fixture.jdbc.update("UPDATE managed_workspace_access SET can_create = ?", granted);
        ObjectNode next = execution.deepCopy();
        hookState(next, after, registration.get("catalogRef"));
        if (replacement && !batch) next.withObject("/run/runtime").put("generation", "2");
        assertThat(ManagedHookRecords.isExecutionSuccessor(execution, next)).isTrue();
        var first = journal.requestDomain("fenced", "hook_execution", next, List.of(), 1000);
        var request = first;
        if (batch) {
            ObjectNode resumed = next.deepCopy();
            hookState(resumed, "running_attached", registration.get("catalogRef"));
            if (replacement) resumed.withObject("/run/runtime").put("generation", "2");
            assertThat(ManagedHookRecords.isExecutionSuccessor(next, resumed)).isTrue();
            var second = journal.requestDomain("fenced", "hook_execution", resumed, List.of(), 1000);
            String[] firstLines = new String(Base64.getDecoder().decode(first.recordBytesBase64()), StandardCharsets.UTF_8).split("\n");
            String[] secondLines = new String(Base64.getDecoder().decode(second.recordBytesBase64()), StandardCharsets.UTF_8).split("\n");
            var event = (ObjectNode) fixture.json.readTree(secondLines[0]);
            event.withObject("/managedSession").put("sequence", first.lastSequence() + 1).put("eventId", "hook_execution:" + (first.lastSequence() + 1));
            byte[] bytes = (firstLines[0] + "\n" + event + "\n" + firstLines[1] + "\n").getBytes(StandardCharsets.UTF_8);
            var closure = new java.util.ArrayList<>(first.resources());
            closure.addAll(second.resources());
            request = new ManagedSessionStoreModels.CommitTransactionRequest(first.workspaceId(), first.writerId(), first.writerGeneration(),
                    first.expectedJournalRevision(), first.expectedCommittedSequence(), first.transactionId(), first.operation(), first.commandId(),
                    first.contentDigest(), first.firstSequence(), first.lastSequence() + 1, 2, first.eventsDigest(), first.previousCommitDigest(),
                    first.commitDigest(), first.activationEpoch(), null, 3, Base64.getEncoder().encodeToString(bytes),
                    HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)), closure);
        }
        var commitRequest = request;
        long revision = fixture.jdbc.queryForObject("SELECT journal_revision FROM qwen_managed_session_journal_head", Long.class);
        int resources = fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource", Integer.class);
        Runnable commit = () -> fixture.transactions.executeWithoutResult(ignored -> store.commit("tenant", fixture.session,
                "extension-writer-token-0123456789", commitRequest, authority ? WorkspaceLifecycleStore.authority(operation) : null));
        if (accepted && !batch) {
            commit.run();
            assertThat(fixture.jdbc.queryForObject("SELECT journal_revision FROM qwen_managed_session_journal_head", Long.class))
                    .isEqualTo(revision + 1);
        } else {
            assertThatThrownBy(commit::run).isInstanceOfSatisfying(ApiException.class, error -> {
                assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                assertThat(error.getCode()).isEqualTo(accepted && batch ? "managed_session_extension_record_rejected"
                        : draining ? "workspace_lifecycle_claim_fenced" : authority && !replacement
                        ? "workspace_lifecycle_authorization_revoked" : "workspace_lifecycle_admission_closed");
                if (accepted && batch) assertThat(error.getMessage()).contains("at most one Stage H record");
            });
            assertThat(fixture.jdbc.queryForObject("SELECT journal_revision FROM qwen_managed_session_journal_head", Long.class)).isEqualTo(revision);
            assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource", Integer.class)).isEqualTo(resources);
        }
    }

    static Stream<Arguments> fencedHookTransitions() {
        Stream<Arguments> single = Stream.concat(Stream.of(true, false).flatMap(authority -> Stream.of(
                Arguments.of(authority, false, "intent", "dispatch_started", false, false),
                Arguments.of(authority, false, "intent", "outcome_unknown", false, false),
                Arguments.of(authority, false, "intent", "corrupt", false, false),
                Arguments.of(authority, false, "intent", "not_started_proven", false, true),
                Arguments.of(authority, false, "dispatch_started", "outcome_unknown", false, true),
                Arguments.of(authority, false, "dispatch_started", "settled", false, true),
                Arguments.of(authority, false, "outcome_unknown", "running_attached", false, true),
                Arguments.of(authority, true, "outcome_unknown", "running_attached", true, false))),
                Stream.of(Arguments.of(true, true, "intent", "dispatch_started", false, true),
                        Arguments.of(true, true, "intent", "outcome_unknown", false, true))).map(arguments -> {
                            var values = java.util.Arrays.copyOf(arguments.get(), 7);
                            values[6] = false;
                            return Arguments.of(values);
                        });
        Stream<Arguments> existing = Stream.concat(single, Stream.of(Arguments.of(true, true, "intent", "outcome_unknown", true, false, true),
                Arguments.of(true, true, "intent", "outcome_unknown", false, true, true))).map(arguments -> {
                    var values = java.util.Arrays.copyOf(arguments.get(), 8);
                    values[7] = false;
                    return Arguments.of(values);
                });
        return Stream.concat(existing, Stream.of(
                Arguments.of(true, true, "intent", "dispatch_started", false, false, false, true),
                Arguments.of(true, true, "intent", "outcome_unknown", false, false, false, true),
                Arguments.of(true, true, "intent", "not_started_proven", false, true, false, true)));
    }

    private static void hookState(ObjectNode record, String execution, JsonNode result) {
        var run = record.withObject("/run").put("execution", execution).putNull("reason");
        if (List.of("outcome_unknown", "corrupt").contains(execution)) {
            run.put("state", "recovery_blocked").put("reason", "corrupt".equals(execution) ? "execution_corrupt" : execution);
        } else if ("settled".equals(execution)) {
            run.put("state", "settled");
            record.set("resultRef", result);
        } else if ("not_started_proven".equals(execution)) {
            run.put("state", "cancelled");
        } else {
            run.put("state", "intent".equals(execution) ? "admitted" : "running");
        }
    }

    @Test
    void lifecycleClaimRefusalRemainsANonRetryableBrokerConflict() {
        var fixture = fixture();
        var operation = fixture.admit(OperationKind.DELETE);
        var execution = new WorkspaceExecutionStore(fixture.jdbc, new DataSourceTransactionManager(fixture.jdbc.getDataSource()));
        var session = fixture.store.requireSession("tenant", fixture.session);
        execution.authorizeLifecycle(session, WorkspaceLifecycleStore.authority(operation));
        assertThatThrownBy(() -> execution.authorizeLifecycle(session,
                new RuntimeLifecycleAuthority(operation.operationId(), operation.claimGeneration() + 1)))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("workspace_lifecycle_claim_fenced");
                    assertThat(error.isRetryable()).isFalse();
                });
        fixture.jdbc.update("UPDATE managed_agent_operation SET lease_until = 0");
        assertThatThrownBy(() -> execution.authorizeLifecycle(session, WorkspaceLifecycleStore.authority(operation)))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("workspace_lifecycle_claim_fenced");
                    assertThat(error.isRetryable()).isFalse();
                });
    }

    @Test
    void brokerAdmissionRejectsAnExpiredMillisecondLifecycleClaim() {
        var fixture = fixture();
        var operation = fixture.admit(OperationKind.DELETE);
        long now = fixture.jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
        fixture.jdbc.update("UPDATE qwen_runtime_harness_drain SET claim_lease_until = ?", now - 1);
        assertThatThrownBy(() -> fixture.bindings.requireHarnessAdmission(fixture.scope(), fixture.session,
                WorkspaceLifecycleStore.authority(operation))).isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("runtime_admission_closed");
                    assertThat(error.isRetryable()).isFalse();
                });
    }

    @Test
    void deleteReclassifiesACompletedCloseUnderTheSessionLock() {
        var fixture = fixture();
        var close = fixture.admit(OperationKind.CLOSE);
        assertThat(fixture.transactions.<JsonNode>execute(ignored -> fixture.lifecycle.recoverEffects(close))).isNotNull();
        fixture.transactions.execute(ignored -> fixture.store.completeOperation("tenant", fixture.session, close.operationId(),
                close.leaseOwner(), close.claimGeneration(), true));
        assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("CLOSED");
        var admission = fixture.transactions.execute(ignored -> fixture.store.beginWorkspaceLifecycle("tenant", fixture.session,
                OperationKind.DELETE, "owner", "a".repeat(64), "stale-active-delete", "digest", true, 1));
        assertThat(admission.operation().lifecycleProtocolVersion()).isZero();
        assertThat(admission.operation().sessionStatusBefore()).isEqualTo("CLOSED");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_runtime_harness_drain", Integer.class)).isEqualTo(1);
        assertThat(fixture.jdbc.queryForObject("SELECT phase FROM qwen_runtime_harness_drain", String.class)).isEqualTo("DRAINING");
    }

    @ParameterizedTest
    @MethodSource("invalidJournalRecords")
    void lifecycleJournalValidationRejectsInvalidRecordsAndRollsBack(String line, String mode) throws Exception {
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

    static Stream<Arguments> invalidJournalRecords() {
        return Stream.of("{", "[]", "null", "{\"n\":1e999}", "{\"a\":1,\"a\":2}")
                .flatMap(line -> Stream.of("ordinary", "authority", "settlement").map(mode -> Arguments.of(line, mode)));
    }

    @ParameterizedTest
    @MethodSource("hookReceiptPaths")
    void hookReceiptsUseCompactProtocolIdentitiesWithAnIndentedApplicationMapper(OperationKind kind, boolean recover) throws Exception {
        var fixture = fixture();
        fixture.json.enable(SerializationFeature.INDENT_OUTPUT);
        var journal = new ManagedSessionStore(fixture.jdbc);
        var writer = fixture.transactions.execute(ignored -> journal.acquireWriter("tenant", fixture.session,
                "w".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "original", 60_000L)));
        byte[] definition = "{\"toolProfile\":\"hosted-workspace-files/1\",\"hookCatalog\":{}}".getBytes(StandardCharsets.UTF_8);
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(definition));
        var header = fixture.json.createObjectNode().put("subtype", "managed_session_header_v1");
        header.putObject("managedSession").putObject("definitionRef").put("resourceId", "definition")
                .put("kind", "managed-session-definition").put("schemaVersion", 1).put("byteLength", definition.length).put("digest", digest);
        byte[] bytes = ("{\"subtype\":\"session_execution_engine\"}\n" + header + "\n").getBytes(StandardCharsets.UTF_8);
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest("workspace", "original", writer.writerGeneration(),
                0, 0, "transaction", "session.create", "command", "a".repeat(64), 0, 0, 0, null, null, null, 0, null, 2,
                Base64.getEncoder().encodeToString(bytes), HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                List.of(new ManagedSessionStoreModels.CommitResource("definition", "managed-session-definition", 1,
                        definition.length, digest, Base64.getEncoder().encodeToString(definition))));
        fixture.transactions.execute(ignored -> journal.commit("tenant", fixture.session, "w".repeat(32), commit));
        var operation = fixture.admit(kind);
        var receipt = fixture.json.createObjectNode().put("protocolVersion", 1).put("operationId", operation.operationId())
                .put("kind", kind.name().toLowerCase(java.util.Locale.ROOT));
        receipt.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", fixture.session);
        receipt.set("definitionRef", header.path("managedSession").path("definitionRef"));
        var effects = receipt.putArray("effects");
        for (String event : kind == OperationKind.CLOSE ? List.of("SessionEnd") : List.of("SessionEnd", "SessionDelete")) {
            // These bytes are JSON.stringify([event, operationId]) on the Harness wire.
            String id = "hook-plan-" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(
                    ("[\"" + event + "\",\"" + operation.operationId() + "\"]").getBytes(StandardCharsets.UTF_8)));
            var plan = fixture.json.createObjectNode();
            plan.putObject("input").put("hook_event_name", event).put("session_id", fixture.session);
            var planRef = fixture.resource(event + "-plan", "hook-data", plan);
            var resultRef = fixture.resource(event + "-result", "hook-data", fixture.json.createObjectNode());
            var record = fixture.json.createObjectNode().put("hookExecutionId", id).put("occurrenceId", operation.operationId())
                    .put("runtimeSessionId", "original").put("registrationId", "registration").put("eventName", event)
                    .put("ordinal", 0).put("hookId", "__plan__").put("cancelRequested", false);
            record.putNull("onceKey");
            record.set("planRef", planRef);
            record.set("inputRef", planRef);
            record.set("resultRef", resultRef);
            var run = record.putObject("run").put("state", "settled").put("effectId", id).put("execution", "settled");
            run.putObject("definition").put("definitionId", "catalog").put("definitionRevision", 1).put("definitionDigest", "b".repeat(64));
            for (String key : List.of("reason", "executionCallId", "dispatchId", "deliveryId", "runtime", "delivery")) {
                run.putNull(key);
            }
            ManagedHookRecords.requireExecution(record);
            var ref = fixture.resource(event + "-record", "hook-execution", record);
            fixture.jdbc.update("INSERT INTO qwen_managed_session_extension_record (session_scope_key, record_key, tenant_id, workspace_id,"
                    + " session_id, domain, record_id, operation_hash, revision, record_resource_id, task_kind, task_state, created_at, first_sequence)"
                    + " VALUES (?, ?, 'tenant', 'workspace', ?, 'hook_execution', ?, ?, 1, ?, 'hook', 'settled', 1, 1)",
                    ManagedSessionStore.sessionScopeKey("tenant", fixture.session),
                    ManagedExtensionProjection.recordKey(fixture.session, "hook_execution", id),
                    fixture.session, id, "a".repeat(64), ref.path("resourceId").asText());
            effects.addObject().put("event", event).set("recordRef", ref);
        }
        if (recover) {
            JsonNode recovered = fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(operation));
            assertThat(recovered).isNotNull();
            assertThat(fixture.json.readTree(recovered.toString())).isEqualTo(receipt);
        } else {
            fixture.transactions.executeWithoutResult(ignored -> fixture.lifecycle.saveEffects(operation, receipt));
        }
        assertThat(fixture.json.readTree(fixture.jdbc.queryForObject("SELECT lifecycle_effects_receipt_json FROM managed_agent_operation",
                String.class))).isEqualTo(receipt);
        assertThat(fixture.jdbc.queryForObject("SELECT phase FROM qwen_runtime_harness_drain", String.class)).isEqualTo("DRAINING");
        fixture.transactions.executeWithoutResult(ignored -> journal.sealWriter("tenant", fixture.session, "w".repeat(32),
                new ManagedSessionStoreModels.SealWriterRequest("workspace", "original", writer.writerGeneration()),
                WorkspaceLifecycleStore.authority(operation)));
        fixture.transactions.executeWithoutResult(ignored -> fixture.lifecycle.verifyCompletion(operation));
    }

    static Stream<Arguments> hookReceiptPaths() {
        return Stream.of(OperationKind.CLOSE, OperationKind.DELETE).flatMap(kind -> Stream.of(false, true).map(recover -> Arguments.of(kind, recover)));
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
        byte[] bytes = ("{\"subtype\":\"session_execution_engine\"}\n" + header + "\n").getBytes(StandardCharsets.UTF_8);
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
        final ObjectMapper json = new ObjectMapper();
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

        ObjectNode resource(String id, String kind, JsonNode body) throws Exception {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind,"
                    + " schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, created_at)"
                    + " VALUES (?, 'tenant', 'workspace', ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'committed-hooks', 'REFERENCED', CURRENT_TIMESTAMP(6))",
                    ManagedSessionStore.sessionScopeKey("tenant", session), session, id, kind, bytes.length, digest, bytes);
            return json.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", digest);
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

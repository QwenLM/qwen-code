package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Snapshot;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiExecutionAdmission;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.TimeUnit;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationJson.require;

/** Read-only application semantics while the original DRAINING holder remains reserved. */
final class WorkspaceCsiApplicationHistory {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final JdbcRuntimeBindingRepository bindings;
    private final ManagedSessionStore nativeStore;
    private final ObjectMapper identityJson;
    private final TransactionTemplate transaction;

    WorkspaceCsiApplicationHistory(JdbcTemplate jdbc, PlatformTransactionManager manager,
            JdbcRuntimeBindingRepository bindings, ManagedSessionStore nativeStore, ObjectMapper identityJson) {
        require(jdbc != null && jdbc.getDataSource() != null && manager != null && bindings != null && nativeStore != null
                && identityJson != null && bindings.usesDataSource(jdbc.getDataSource()) && nativeStore.usesDataSource(jdbc.getDataSource()));
        this.jdbc = jdbc;
        this.bindings = bindings;
        this.nativeStore = nativeStore;
        this.identityJson = identityJson;
        transaction = new TransactionTemplate(manager);
        transaction.setReadOnly(true);
        transaction.setIsolationLevel(TransactionDefinition.ISOLATION_REPEATABLE_READ);
        transaction.setTimeout(10);
    }

    /** Reads the closed application while its original binding and holder remain DRAINING. */
    Snapshot readApplication(String tenant, String workspace, String session, String retirement, String token) {
        require(!TransactionSynchronizationManager.isActualTransactionActive());
        long started = System.nanoTime();
        return transaction.execute(status -> jdbc.execute((ConnectionCallback<Snapshot>) current -> {
            var target = DataSourceUtils.getTargetConnection(current);
            require(!target.getAutoCommit() && target.isReadOnly()
                    && target.getTransactionIsolation() == Connection.TRANSACTION_REPEATABLE_READ
                    && DataSourceUtils.isConnectionTransactional(target, jdbc.getDataSource()));
            var connection = WorkspaceCsiApplicationStore.bounded(target, started);
            var read = new WorkspaceCsiApplicationInventory.HistoricalScan(connection, started, this::readFrozenOwner);
            var owner = WorkspaceCsiApplicationInventory.readHistoricalOwner(read, tenant, retirement);
            var binding = bindings.findByIdInReadOnlySnapshot(connection, owner.binding().text("binding_id"));
            require(binding != null && binding.getState() == RuntimeBindingRecord.State.DRAINING
                    && binding.isDrainRequested() && binding.getGeneration() == 1
                    && "DRAINED".equals(owner.retirement().text("progress_stage"))
                    && Objects.equals(binding.getVersion(), owner.binding().number("record_version"))
                    && binding.getBindingId().equals(owner.retirement().text("target_id"))
                    && binding.getRequest().getScope().getTenantId().equals(tenant)
                    && binding.getRequest().getScope().getWorkspaceId().equals(workspace)
                    && binding.getRequest().getIsolationKey().equals(session));
            var frozen = payload(owner.retirement(), "frozen_request");
            var envelope = WorkspaceCsiApplicationJson.object(frozen, WorkspaceCsiApplicationInventory.MAX_BYTES);
            nativeStore.requireCsiHistoricalCredential(tenant, workspace, session, token,
                    envelope.path("writerTokenSha256").textValue());
            var terminal = JdbcCsiActivationAdmission.readHistoricalTerminal(connection, binding, frozen);
            var result = readSavedApplication(read, binding, owner.retirement(), identityJson, true);
            require(result.blockers().isEmpty()
                    && terminal.terminalSequence() == WorkspaceCsiApplicationImage.sole(result, "ma_session_head").number("committed_sequence"));
            require(Arrays.equals(owner.binding().bytes(), WorkspaceCsiApplicationImage.sole(result, "ma_runtime_binding").bytes()));
            require(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(10));
            return result;
        }));
    }

    /** Replays the saved owner's typed native prefix without a live lease or SQL writes. */
    static CsiNativeActivationProof.TerminalProof preparedTerminal(Snapshot baseline, RuntimeProvisionRequest original,
            byte[] body) {
        require(baseline != null && baseline.blockers().isEmpty() && original != null
                && JdbcCsiFilesRetirementGuard.isProfile(original.getScope()));
        baseline = WorkspaceCsiApplicationInventory.restoreCanonical(baseline.bytes());
        JsonNode metadata = WorkspaceCsiApplicationJson.object(body, 128 * 1024);
        long expectedRevision = number(metadata.get("expectedJournalRevision"));
        long expectedSequence = number(metadata.get("expectedCommittedSequence"));
        var head = WorkspaceCsiApplicationImage.sole(baseline, "ma_session_head");
        scope(head, original);
        require(expectedRevision > 1 && expectedRevision < WorkspaceCsiApplicationInventory.MAX_ROWS
                && Objects.equals(head.number("journal_revision"), expectedRevision)
                && Objects.equals(head.number("committed_sequence"), expectedSequence)
                && "ACTIVE".equals(head.text("state")) && "READY".equals(head.text("recovery_status"))
                && Objects.equals(head.number("storage_version"), 1L)
                && Objects.equals(head.number("compacted_through_revision"), 0L)
                && Objects.equals(head.number("writer_generation"), 1L)
                && "active".equals(head.text("activation_phase"))
                && Objects.equals(head.number("activation_epoch"), 1L)
                && Objects.equals(head.number("activation_event_epoch"), 1L));
        var transactions = baseline.table("ma_session_journal_tx").rows().stream()
                .filter(row -> row.membership() == Membership.ORIGINAL)
                .sorted(Comparator.comparingLong(row -> row.number("journal_revision"))).toList();
        require(transactions.size() == expectedRevision);
        var nativeRows = nativeRows(baseline, original, expectedRevision);
        var resources = nativeRows.resources();
        var references = nativeRows.references();
        long sequence = 0;
        String digest = null;
        String lastUuid = null;
        String firstWriter = null;
        CsiNativeActivationProof.Genesis genesis = null;
        CsiNativeActivationProof.Activation activation = null;
        var prefix = CsiNativeActivationProof.Prefix.empty();
        for (int index = 0; index < transactions.size(); index++) {
            Row row = transactions.get(index);
            long revision = index + 1L;
            scope(row, original);
            byte[] raw = row.binary("record_bytes");
            require(Objects.equals(row.number("journal_revision"), revision)
                    && "identity".equals(row.text("record_encoding")) && raw != null
                    && Objects.equals(row.number("byte_length"), (long) raw.length)
                    && hash(raw).equals(row.text("record_digest")) && Objects.equals(row.number("writer_generation"), 1L));
            var records = CsiNativeActivationProof.records(raw);
            JsonNode saved = metadata(row);
            java.util.function.Function<JsonNode, byte[]> reader = ref -> nativeResource(resources, references, revision, ref);
            if (index == 0) {
                String command = "session.create:" + original.getIsolationKey();
                require(command.equals(row.text("transaction_id")) && command.equals(row.text("command_id"))
                        && "session.create".equals(row.text("operation")) && hash(raw).equals(row.text("content_digest"))
                        && Objects.equals(row.number("first_sequence"), 0L) && Objects.equals(row.number("last_sequence"), 0L)
                        && Objects.equals(row.number("event_count"), 0L) && Objects.equals(row.number("activation_epoch"), 0L)
                        && row.text("events_digest") == null && row.text("previous_commit_digest") == null
                        && row.text("commit_digest") == null && row.text("latest_checkpoint_resource_id") == null);
                require(java.util.UUID.fromString(row.text("writer_id")).toString().equals(row.text("writer_id")));
                firstWriter = row.text("writer_id");
                genesis = CsiNativeActivationProof.genesis(records, original, reader);
                lastUuid = genesis.lastRecordUuid();
            } else {
                require(Objects.equals(row.number("first_sequence"), sequence + 1)
                        && Objects.equals(digest, row.text("previous_commit_digest")));
                if (activation == null) {
                    require(firstWriter.equals(row.text("writer_id")));
                }
                var transaction = CsiNativeActivationProof.transaction(records, saved, original, lastUuid);
                if (CsiNativeActivationProof.hasActivation(transaction)) {
                    require(activation != null || revision == 2);
                    activation = CsiNativeActivationProof.activation(transaction, saved, original,
                            row.text("writer_id"), genesis.definitionDigest(), activation, reader);
                } else {
                    prefix = CsiNativeActivationProof.advance(transaction, saved, original, row.text("writer_id"),
                            genesis, activation, revision - 1, sequence, prefix, reader);
                }
                lastUuid = transaction.lastRecordUuid();
            }
            sequence = row.number("last_sequence");
            digest = row.text("commit_digest");
        }
        require(activation != null && activation.writerGeneration() == 1 && activation.epoch() == 1
                && sequence == expectedSequence && Objects.equals(digest, head.text("last_commit_digest"))
                && Objects.equals(prefix.checkpointResourceId(), head.text("latest_checkpoint_resource_id"))
                && activation.activationId().equals(head.text("activation_id"))
                && activation.workerId().equals(head.text("writer_id"))
                && Objects.equals(head.number("activation_expires_at"), activation.expiresAt())
                && Objects.equals(head.number("activation_head_revision"), expectedRevision));
        var proof = CsiNativeActivationProof.preparedTerminal(metadata, original, genesis, activation, prefix,
                expectedRevision, sequence, lastUuid, digest);
        require(!resources.containsKey(text(proof.boundaryRef(), "resourceId")));
        return proof;
    }

    private record NativeRows(Map<String, Row> resources, Map<Long, Map<String, Row>> references) {
    }

    private static NativeRows nativeRows(Snapshot baseline, RuntimeProvisionRequest original, long maximumRevision) {
        Map<String, Row> resources = new LinkedHashMap<>();
        Map<Long, Map<String, Row>> references = new LinkedHashMap<>();
        String sessionScope = ManagedSessionStore.sessionScopeKey(original.getScope().getTenantId(), original.getIsolationKey());
        Row modelContext = WorkspaceCsiApplicationInventory.modelContextReference(baseline.table("ma_session_journal_tx").rows(),
                baseline.table("ma_session_record").rows(), baseline.table("ma_resource").rows(), baseline.table("ma_resource_ref").rows(),
                original, WorkspaceCsiApplicationImage.sole(baseline, "ma_operation").number("settlement_deadline_ms"));
        for (Row row : baseline.table("ma_resource").rows()) {
            if (row.membership() == Membership.ORIGINAL) {
                scope(row, original);
                require(sessionScope.equals(row.text("session_scope_key"))
                        && resources.put(row.text("resource_id"), row) == null);
            }
        }
        for (Row row : baseline.table("ma_resource_ref").rows()) {
            if (row.membership() == Membership.ORIGINAL) {
                scope(row, original);
                if (modelContext != null && Arrays.equals(modelContext.bytes(), row.bytes())) {
                    continue;
                }
                require(sessionScope.equals(row.text("session_scope_key")) && row.number("journal_revision") != null
                        && "JOURNAL".equals(row.text("owner_kind"))
                        && row.number("journal_revision") > 0 && row.number("journal_revision") <= maximumRevision
                        && resources.containsKey(row.text("resource_id"))
                        && references.computeIfAbsent(row.number("journal_revision"), ignored -> new LinkedHashMap<>())
                                .put(row.text("resource_id"), row) == null);
            }
        }
        return new NativeRows(resources, references);
    }

    private static byte[] nativeResource(Map<String, Row> resources, Map<Long, Map<String, Row>> references,
            long revision, JsonNode ref) {
        String id = text(ref, "resourceId");
        Row row = resources.get(id);
        require(row != null && references.getOrDefault(revision, Map.of()).containsKey(id));
        return storedResource(row, ref, "REFERENCED");
    }

    private static byte[] storedResource(Row row, JsonNode ref, String state) {
        require(row != null && state.equals(row.text("state")) && "MYSQL_INLINE".equals(row.text("storage_kind"))
                && row.text("object_key") == null && row.text("object_version_id") == null && row.text("encryption_key_id") == null
                && text(ref, "kind").equals(row.text("kind"))
                && Objects.equals(row.number("schema_version"), number(ref.get("schemaVersion")))
                && Objects.equals(row.number("byte_length"), number(ref.get("byteLength")))
                && text(ref, "digest").equals(row.text("sha256")));
        byte[] raw = row.binary("inline_bytes");
        require(raw != null && Objects.equals(row.number("byte_length"), (long) raw.length) && hash(raw).equals(row.text("sha256")));
        return raw;
    }

    private static void scope(Row row, RuntimeProvisionRequest original) {
        require(original.getScope().getTenantId().equals(row.text("tenant_id"))
                && original.getScope().getWorkspaceId().equals(row.text("workspace_id"))
                && original.getIsolationKey().equals(row.text("session_id")));
    }

    private static JsonNode metadata(Row row) {
        ObjectNode result = JSON.createObjectNode();
        for (String field : List.of("transaction_id", "command_id", "operation", "content_digest", "events_digest",
                "previous_commit_digest", "commit_digest", "writer_id", "latest_checkpoint_resource_id")) {
            result.put(camel(field), row.text(field));
        }
        for (String field : List.of("first_sequence", "last_sequence", "event_count", "writer_generation", "activation_epoch")) {
            require(row.number(field) != null);
            result.put(camel(field), row.number(field));
        }
        return result;
    }

    /** Pure retained data; the configured reader must first verify the complete current fixed and strong-reference image. */
    static void verifyRetainedExecutions(Snapshot baseline, JdbcCsiFilesRetirementGuard.Original original,
            CsiNativeActivationProof.TerminalProof proof, List<ToolExecutionRecord> members, long ceiling,
            Map<String, Object> pinnedContext) {
        require(baseline != null && baseline.blockers().isEmpty() && original != null && original.request() != null
                && proof != null && members != null && ceiling > 0 && ceiling <= original.version());
        long maximumRevision = WorkspaceCsiApplicationImage.sole(baseline, "ma_session_head").number("journal_revision");
        require(proof.predecessorSequence() == WorkspaceCsiApplicationImage.sole(baseline,
                "ma_session_head").number("committed_sequence"));
        var prefix = proof.predecessorPrefix();
        var nativeRows = nativeRows(baseline, original.request(), maximumRevision);
        var transactions = baseline.table("ma_session_journal_tx").rows().stream()
                .filter(row -> row.membership() == Membership.ORIGINAL).toList();
        Map<String, Row> executions = new LinkedHashMap<>();
        for (Row row : baseline.table("ma_tool_execution").rows()) {
            if (row.membership() == Membership.ORIGINAL) {
                require(executions.put(row.text("execution_call_id"), row) == null);
            }
        }
        require(executions.size() == members.size());
        Map<String, byte[]> bodies = new LinkedHashMap<>();
        for (var member : members) {
            require(executions.containsKey(member.getExecutionCallId()));
            JsonNode ref = JSON.valueToTree(member.getReference());
            var frozen = prefix.fileHistory() == null ? null : prefix.fileHistory().batches().get(text(ref, "batchId"));
            var intent = prefix.intents().get(member.getExecutionCallId());
            Long revision = intent == null ? null : intent.revision();
            if (frozen != null) {
                var associations = transactions.stream().filter(row -> "commitFileHistory".equals(row.text("operation"))
                        && Objects.equals(row.number("first_sequence"), frozen.intentSequence())
                        && Objects.equals(row.number("last_sequence"), frozen.intentSequence())
                        && Objects.equals(row.number("event_count"), 1L)).toList();
                require(associations.size() == 1);
                revision = associations.getFirst().number("journal_revision");
            }
            for (String field : List.of("inputRef", "toolDefinitionRef")) {
                JsonNode resource = ref.path(field);
                String id = text(resource, "resourceId");
                Row stored = nativeRows.resources().get(id);
                require(stored != null && id.equals(stored.text("publish_command_id")));
                byte[] raw = revision == null ? storedResource(stored, resource, "PUBLISHED")
                        : nativeResource(nativeRows.resources(), nativeRows.references(), revision, resource);
                byte[] previous = bodies.putIfAbsent(id, raw);
                require(previous == null || Arrays.equals(previous, raw));
            }
        }
        JdbcCsiExecutionAdmission.verifyHistoricalMembers(original, prefix, members,
                ref -> bodies.get(text(ref, "resourceId")));
        Map<String, List<JdbcCsiExecutionAdmission.DispatchCheckpoint>> checkpoints = new LinkedHashMap<>();
        for (Row row : transactions) {
            if (!"commitCheckpoint".equals(row.text("operation")) || row.text("command_id") == null
                    || !row.text("command_id").startsWith("harness:await_runtime:")) {
                continue;
            }
            long revision = row.number("journal_revision");
            require(revision <= maximumRevision);
            var record = CsiNativeActivationProof.records(row.binary("record_bytes")).stream()
                    .filter(value -> "system".equals(value.path("type").textValue())
                            && "managed_session_event_v1".equals(value.path("subtype").textValue())
                            && "checkpoint.committed".equals(value.path("managedSession").path("kind").textValue()))
                    .findFirst().orElseThrow(() -> new IllegalArgumentException("Missing original dispatch checkpoint"));
            JsonNode ref = record.path("managedSession").path("payload").path("stateRef");
            var state = CsiNativeActivationProof.readObject(nativeResource(nativeRows.resources(), nativeRows.references(), revision, ref));
            Map<String, Boolean> inProgress = new LinkedHashMap<>();
            for (JsonNode item : state.path("tools").path("items")) {
                String batch = item.path("modelMessageId").textValue();
                require(batch != null);
                if (prefix.batches().containsKey(batch)) {
                    inProgress.merge(batch, "in_progress".equals(item.path("state").textValue()), (left, right) -> left && right);
                }
            }
            var checkpoint = new JdbcCsiExecutionAdmission.DispatchCheckpoint(revision, row.number("last_sequence"), ref);
            inProgress.forEach((batch, all) -> {
                if (all) {
                    checkpoints.computeIfAbsent(batch, ignored -> new java.util.ArrayList<>()).add(checkpoint);
                }
            });
        }
        for (var member : members) {
            JdbcCsiExecutionAdmission.DispatchCheckpoint checkpoint = null;
            if (member.getAuthorizedDispatchGeneration() != null) {
                var candidates = checkpoints.getOrDefault((String) member.getReference().get("batchId"), List.of());
                require(candidates.size() == 1);
                checkpoint = candidates.getFirst();
            }
            JdbcCsiExecutionAdmission.verifyHistoricalGrant(original, member, prefix, maximumRevision, ceiling,
                    executions.get(member.getExecutionCallId()).text("native_authorization_json"), checkpoint,
                    checkpoint == null ? null : pinnedContext);
        }
    }

    private static String camel(String field) {
        StringBuilder result = new StringBuilder();
        boolean uppercase = false;
        for (char character : field.toCharArray()) {
            if (character == '_') {
                uppercase = true;
            } else {
                result.append(uppercase ? Character.toUpperCase(character) : character);
                uppercase = false;
            }
        }
        return result.toString();
    }

    private static long number(JsonNode value) {
        require(value != null && value.isIntegralNumber() && value.canConvertToLong()
                && value.longValue() >= 0 && value.longValue() <= 9_007_199_254_740_990L);
        return value.longValue();
    }

    private static String text(JsonNode value, String field) {
        require(value.path(field).isTextual() && !value.path(field).textValue().isEmpty());
        return value.path(field).textValue();
    }

    private Snapshot readFrozenOwner(WorkspaceCsiApplicationInventory.HistoricalScan read, Row carrier) throws SQLException {
        var owner = WorkspaceCsiApplicationInventory.readForeignOwner(read, carrier);
        var binding = bindings.findByIdInReadOnlySnapshot(read.connection, owner.binding().text("binding_id"));
        require(binding != null && binding.getState() == RuntimeBindingRecord.State.DRAINING
                && Objects.equals(binding.getVersion(), owner.binding().number("record_version")));
        readSavedApplication(read, binding, owner.retirement(), identityJson, false);
        return WorkspaceCsiApplicationImage.baseline(payload(owner.retirement(), "frozen_request"));
    }

    private static Snapshot readSavedApplication(WorkspaceCsiApplicationInventory.HistoricalScan read,
            RuntimeBindingRecord binding, Row retirement, ObjectMapper identityJson, boolean originalOwner) throws SQLException {
        var target = read.connection;
        long started = read.started;
        require(target != null && !target.getAutoCommit() && target.isReadOnly()
                && target.getTransactionIsolation() == Connection.TRANSACTION_REPEATABLE_READ
                && identityJson != null && binding != null && binding.isDrainRequested()
                && binding.getGeneration() == 1 && retirement != null && "DRAINING".equals(retirement.text("phase"))
                && "qwen-csi-application-retirement/1".equals(retirement.text("progress_format"))
                && binding.getBindingId().equals(retirement.text("target_id"))
                && Objects.equals(retirement.number("target_revision"), binding.getGeneration()));
        Stage stage = Stage.valueOf(retirement.text("progress_stage"));
        require(stage != Stage.SETTLING && Objects.equals(retirement.number("progress_version"), stage.ordinal() + 1L)
                && binding.getState() == RuntimeBindingRecord.State.DRAINING);
        var intent = WorkspaceCsiApplicationInventory.retirement(retirement);
        require(intent != null && intent.operationId().equals(retirement.text("operation_id"))
                && intent.physicalKey().equals(retirement.text("physical_key")));
        byte[] frozen = payload(retirement, "frozen_request");
        byte[] cut = stagePayload(retirement, "cut", stage == Stage.CUT || stage == Stage.DRAINED);
        byte[] receipt = stagePayload(retirement, "finalize_receipt", stage == Stage.DRAINED);
        var baseline = WorkspaceCsiApplicationImage.baseline(frozen);
        var registration = WorkspaceCsiApplicationJson.typedObject(WorkspaceCsiApplicationImage.sole(baseline,
                "ma_storage").binary("registration_json"), 16 * 1024, WorkspaceCsiRegistration.class);
        WorkspaceCsiReservationStore.requireRetainedIdentity(identityJson, intent, registration, binding);
        var savedBinding = WorkspaceCsiApplicationImage.sole(baseline, "ma_runtime_binding");
        var actual = new JdbcCsiFilesRetirementGuard.Original(binding.getRequest(), binding.getBindingId(), binding.getGeneration(),
                binding.getState(), binding.isDrainRequested(), binding.getVersion(), savedBinding.number("first_activation_journal_revision"));
        require(WorkspaceCsiApplicationInventory.validateHistoricalBaseline(actual, intent, baseline).isEmpty());
        var parent = WorkspaceCsiApplicationImage.sole(baseline, "ma_session");
        var context = new ContextBinding(parent.text("tenant_id"), parent.text("workspace_id"), parent.number("workspace_generation"),
                parent.text("workspace_storage_id"), parent.text("cwd_relative"), parent.text("context_config_ref"), parent.number("context_revision"));
        var envelope = WorkspaceCsiApplicationStore.savedEnvelope(binding, context, intent.operationId(), intent.sealedBindingVersion(), frozen);
        byte[] body = WorkspaceCsiApplicationJson.base64(envelope.path("commitBodyBase64"), 128 * 1024);
        var terminal = preparedTerminal(baseline, binding.getRequest(), body);
        require(!originalOwner || stage == Stage.DRAINED);
        var members = originalOwner ? read.originalExecutions(actual) : read.foreignExecutions(actual);
        var observe = WorkspaceCsiApplicationStore.workerRequest(binding, context, intent.operationId(), "observe", hash(body), null, null);
        WorkspaceCsiApplicationWorkerMatch.verify(baseline, terminal,
                WorkspaceCsiApplicationJson.base64(envelope.path("preCutObservationBase64"), CsiFileFinalizeProtocol.RESPONSE_LIMIT), observe);
        if (stage == Stage.DRAINED) {
            var finalize = WorkspaceCsiApplicationStore.workerRequest(binding, context, intent.operationId(), "finalize",
                    hash(body), hash(frozen), hash(cut));
            var response = CsiFileFinalizeProtocol.response(receipt, finalize);
            require(envelope.path("preCutObservationSha256").textValue().equals(response.get("preCutObservationSha256")));
        }
        var stageImage = WorkspaceCsiApplicationImage.expected(baseline, stage, frozen, cut, receipt);
        var expected = WorkspaceCsiApplicationHistoryImage.owner(stageImage);
        Snapshot current;
        if (originalOwner) {
            current = WorkspaceCsiApplicationInventory.readRetainedReferencedKeys(read, expected, actual, intent);
            WorkspaceCsiApplicationImage.verify(current, expected);
        } else {
            WorkspaceCsiApplicationInventory.auditForeignOwner(read, expected, actual, intent);
            current = expected;
        }
        var handle = WorkspaceCsiApplicationJson.object(savedBinding.binary("resource_handle_json"), 256 * 1024);
        var pinnedContext = JdbcCsiExecutionAdmission.historicalGrantContext(binding.getRequest(), context, handle);
        verifyRetainedExecutions(baseline, actual, terminal, members, intent.sealedBindingVersion(), pinnedContext);
        var retained = WorkspaceCsiApplicationImage.sole(current, "ma_operation");
        require(Arrays.equals(retained.bytes(), retirement.bytes()));
        String writerHash = envelope.path("writerTokenSha256").textValue();
        var head = WorkspaceCsiApplicationImage.sole(current, "ma_session_head");
        require(writerHash != null && writerHash.matches("[0-9a-f]{64}") && writerHash.equals(head.text("lease_token_hash")));
        require(writerHash.equals(WorkspaceCsiApplicationImage.sole(baseline, "ma_session_head").text("lease_token_hash")));
        if (stage != Stage.FROZEN) {
            var commits = current.table("ma_session_journal_tx").rows().stream()
                    .filter(row -> Objects.equals(row.number("journal_revision"), head.number("journal_revision"))).toList();
            require(commits.size() == 1 && writerHash.equals(commits.getFirst().text("writer_token_hash")));
        }
        require(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(10));
        return current;
    }

    private static byte[] stagePayload(Row row, String field, boolean present) {
        if (present) {
            return payload(row, field);
        }
        require(row.cell(field + "_bytes").isNull() && row.cell(field + "_sha256").isNull());
        return null;
    }

    private static byte[] payload(Row row, String field) {
        byte[] bytes = row.binary(field + "_bytes");
        int limit = switch (field) {
            case "frozen_request" -> WorkspaceCsiApplicationInventory.MAX_BYTES;
            case "cut" -> 4096;
            case "finalize_receipt" -> 64 * 1024;
            default -> throw new IllegalArgumentException("Unknown saved application payload");
        };
        require(bytes != null && bytes.length > 0 && bytes.length <= limit && hash(bytes).equals(row.text(field + "_sha256")));
        return bytes;
    }

    private static String hash(byte[] bytes) { return CsiNativeActivationProof.sha256(bytes); }
}

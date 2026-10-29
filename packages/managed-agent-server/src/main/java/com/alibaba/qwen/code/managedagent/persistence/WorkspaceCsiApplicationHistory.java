package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Snapshot;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.CsiProofHistory;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiActivationAdmission;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiExecutionAdmission;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiFilesRetirementGuard;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.ManagedCheckpointHistory;
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
        try (var locators = CsiProofHistory.temporary()) {
            var nativeRows = nativeRows(baseline, original, expectedRevision, locators);
            require(nativeRows.transactions().size() == expectedRevision);
            long sequence = 0;
            String digest = null;
            String lastUuid = null;
            String firstWriter = null;
            CsiNativeActivationProof.Genesis genesis = null;
            CsiNativeActivationProof.Activation activation = null;
            var prefix = CsiNativeActivationProof.Prefix.spilled();
            boolean published = false;
            try {
                for (int index = 0; index < expectedRevision; index++) {
                    Row row = nativeRows.transaction(index + 1L);
                    long revision = index + 1L;
                    scope(row, original);
                    byte[] raw = row.binary("record_bytes");
                    require(Objects.equals(row.number("journal_revision"), revision)
                            && "identity".equals(row.text("record_encoding")) && raw != null
                            && Objects.equals(row.number("byte_length"), (long) raw.length)
                            && hash(raw).equals(row.text("record_digest")) && Objects.equals(row.number("writer_generation"), 1L));
                    var records = CsiNativeActivationProof.records(raw);
                    JsonNode saved = metadata(row);
                    java.util.function.Function<JsonNode, byte[]> reader = nativeCheckpointReader(nativeRows, revision);
                    if (index == 0) {
                        require(row.number("activation_lease_until") == null && row.number("activation_renewal_seq") == null);
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
                            activation = CsiNativeActivationProof.renewed(activation,
                                    row.number("activation_lease_until"), row.number("activation_renewal_seq"));
                        } else {
                            require(row.number("activation_lease_until") == null && row.number("activation_renewal_seq") == null);
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
                require(!nativeRows.resources().containsKey(text(proof.boundaryRef(), "resourceId")));
                published = true;
                return proof;
            } finally {
                if (!published) {
                    prefix.close();
                }
            }
        }
    }

    private record NativeRows(Snapshot baseline, Map<String, Integer> resources, Map<String, Integer> references,
            Map<String, Integer> transactions, Map<String, Long> origins) {
        Row resource(String id) {
            Integer index = resources.get(id);
            return index == null ? null : baseline.table("ma_resource").rows().get(index);
        }

        Row transaction(long revision) {
            Integer index = transactions.get(Long.toString(revision));
            require(index != null);
            return baseline.table("ma_session_journal_tx").rows().get(index);
        }
    }

    private static NativeRows nativeRows(Snapshot baseline, RuntimeProvisionRequest original, long maximumRevision,
            CsiProofHistory locators) {
        Map<String, Integer> resources = locators.map(0, Integer.class);
        Map<String, Integer> references = locators.map(1, Integer.class);
        Map<String, Integer> transactions = locators.map(2, Integer.class);
        Map<String, Long> origins = locators.map(3, Long.class);
        var journalRows = baseline.table("ma_session_journal_tx").rows();
        for (int index = 0; index < journalRows.size(); index++) {
            Row row = journalRows.get(index);
            if (row.membership() == Membership.ORIGINAL) {
                scope(row, original);
                Long revision = row.number("journal_revision");
                require(revision != null && revision > 0 && revision <= maximumRevision
                        && transactions.put(Long.toString(revision), index) == null);
            }
        }
        String sessionScope = ManagedSessionStore.sessionScopeKey(original.getScope().getTenantId(), original.getIsolationKey());
        Row modelContext = WorkspaceCsiApplicationInventory.modelContextReference(journalRows,
                baseline.table("ma_session_record").rows(), baseline.table("ma_resource").rows(), baseline.table("ma_resource_ref").rows(),
                original, WorkspaceCsiApplicationImage.sole(baseline, "ma_operation").number("settlement_deadline_ms"));
        var resourceRows = baseline.table("ma_resource").rows();
        for (int index = 0; index < resourceRows.size(); index++) {
            Row row = resourceRows.get(index);
            if (row.membership() == Membership.ORIGINAL) {
                scope(row, original);
                require(row.text("resource_id") != null && sessionScope.equals(row.text("session_scope_key"))
                        && resources.put(row.text("resource_id"), index) == null);
            }
        }
        var referenceRows = baseline.table("ma_resource_ref").rows();
        for (int index = 0; index < referenceRows.size(); index++) {
            Row row = referenceRows.get(index);
            if (row.membership() == Membership.ORIGINAL) {
                scope(row, original);
                if (modelContext != null && Arrays.equals(modelContext.bytes(), row.bytes())) {
                    continue;
                }
                Long revision = row.number("journal_revision");
                String resource = row.text("resource_id");
                require(sessionScope.equals(row.text("session_scope_key")) && revision != null && resource != null
                        && "JOURNAL".equals(row.text("owner_kind")) && sessionScope.equals(row.text("owner_key"))
                        && Objects.equals(row.number("owner_revision"), revision)
                        && transactions.containsKey(Long.toString(revision)) && revision > 0 && revision <= maximumRevision
                        && resources.containsKey(resource) && references.put(revision + ":" + resource, index) == null);
                Long origin = origins.get(resource);
                origins.put(resource, origin == null ? revision : Math.min(origin, revision));
            }
        }
        return new NativeRows(baseline, resources, references, transactions, origins);
    }

    private static ManagedCheckpointHistory.Reader nativeCheckpointReader(NativeRows rows, long revision) {
        return ManagedCheckpointHistory.reader(ref -> nativeResource(rows, revision, ref), (ref, maximum) -> {
            Long origin = rows.origins().get(text(ref, "resourceId"));
            require(origin != null && origin > 0 && origin <= Math.min(maximum, revision));
            return new ManagedCheckpointHistory.PageBytes(nativeResource(rows, origin, ref), origin);
        }, revision);
    }

    private static byte[] nativeResource(NativeRows rows, long revision, JsonNode ref) {
        String id = text(ref, "resourceId");
        Row row = rows.resource(id);
        require(row != null && rows.references().containsKey(revision + ":" + id));
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
        try (var locators = CsiProofHistory.temporary()) {
            var nativeRows = nativeRows(baseline, original.request(), maximumRevision, locators);
            Map<String, Integer> executions = locators.map(4, Integer.class);
            var executionRows = baseline.table("ma_tool_execution").rows();
            for (int index = 0; index < executionRows.size(); index++) {
                Row row = executionRows.get(index);
                if (row.membership() == Membership.ORIGINAL) {
                    require(row.text("execution_call_id") != null && executions.put(row.text("execution_call_id"), index) == null);
                }
            }
            require(executions.size() == members.size());
            Map<String, ResourceEvidence> bodies = locators.map(5, ResourceEvidence.class);
            for (var member : members) {
                require(executions.containsKey(member.getExecutionCallId()));
                JsonNode ref = JSON.valueToTree(member.getReference());
                var frozen = prefix.fileHistory() == null ? null : prefix.fileHistory().batches().get(text(ref, "batchId"));
                var intent = prefix.intents().get(member.getExecutionCallId());
                Long revision = intent == null ? null : intent.revision();
                if (frozen != null) {
                    Row association = null;
                    for (Row row : baseline.table("ma_session_journal_tx").rows()) {
                        if (row.membership() == Membership.ORIGINAL && "commitFileHistory".equals(row.text("operation"))
                                && Objects.equals(row.number("first_sequence"), frozen.intentSequence())
                                && Objects.equals(row.number("last_sequence"), frozen.intentSequence())
                                && Objects.equals(row.number("event_count"), 1L)) {
                            require(association == null);
                            association = row;
                        }
                    }
                    require(association != null);
                    revision = association.number("journal_revision");
                }
                for (String field : List.of("inputRef", "toolDefinitionRef")) {
                    JsonNode resource = ref.path(field);
                    String id = text(resource, "resourceId");
                    Row stored = nativeRows.resource(id);
                    require(stored != null && id.equals(stored.text("publish_command_id")));
                    ResourceEvidence evidence = new ResourceEvidence(resource, revision);
                    byte[] raw = evidence.bytes(nativeRows);
                    ResourceEvidence previous = bodies.putIfAbsent(id, evidence);
                    require(previous == null || Arrays.equals(previous.bytes(nativeRows), raw));
                }
            }
            JdbcCsiExecutionAdmission.verifyHistoricalMembers(original, prefix, members, ref -> {
                ResourceEvidence evidence = bodies.get(text(ref, "resourceId"));
                require(evidence != null);
                return evidence.bytes(nativeRows);
            });
            for (var member : members) {
                var checkpoint = member.getAuthorizedDispatchGeneration() == null ? null
                        : originalDispatch(nativeRows, (String) member.getReference().get("batchId"), maximumRevision);
                Row execution = executionRows.get(executions.get(member.getExecutionCallId()));
                JdbcCsiExecutionAdmission.verifyHistoricalGrant(original, member, prefix, maximumRevision, ceiling,
                        execution.text("native_authorization_json"), checkpoint, checkpoint == null ? null : pinnedContext);
            }
        }
    }

    private record ResourceEvidence(JsonNode ref, Long revision) {
        byte[] bytes(NativeRows rows) {
            return revision == null ? storedResource(rows.resource(text(ref, "resourceId")), ref, "PUBLISHED")
                    : nativeResource(rows, revision, ref);
        }
    }

    private static JdbcCsiExecutionAdmission.DispatchCheckpoint originalDispatch(NativeRows rows, String batch,
            long maximumRevision) {
        JdbcCsiExecutionAdmission.DispatchCheckpoint result = null;
        for (Row row : rows.baseline().table("ma_session_journal_tx").rows()) {
            if (row.membership() != Membership.ORIGINAL || !"commitCheckpoint".equals(row.text("operation"))
                    || row.text("command_id") == null || !row.text("command_id").startsWith("harness:await_runtime:")) {
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
            var view = CsiNativeActivationProof.readCheckpointView(ref, nativeCheckpointReader(rows, revision));
            boolean[] contains = {false};
            boolean[] all = {true};
            view.tools(item -> {
                String recordedBatch = item.path("modelMessageId").textValue();
                require(recordedBatch != null);
                if (batch.equals(recordedBatch)) {
                    contains[0] = true;
                    all[0] &= "in_progress".equals(item.path("state").textValue());
                }
            });
            if (contains[0] && all[0]) {
                require(result == null);
                result = new JdbcCsiExecutionAdmission.DispatchCheckpoint(revision, row.number("last_sequence"), ref);
            }
        }
        require(result != null);
        return result;
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
        try (var terminal = preparedTerminal(baseline, binding.getRequest(), body)) {
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
                Row commit = null;
                for (Row row : current.table("ma_session_journal_tx").rows()) {
                    if (Objects.equals(row.number("journal_revision"), head.number("journal_revision"))) {
                        require(commit == null);
                        commit = row;
                    }
                }
                require(commit != null && writerHash.equals(commit.text("writer_token_hash")));
            }
            require(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(10));
            return current;
        }
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

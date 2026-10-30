package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Snapshot;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Table;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JdbcCsiApplicationRetirement.Stage;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationJson.require;

/** Exact declared stage deltas over the once-saved SETTLING image. */
final class WorkspaceCsiApplicationImage {
    private WorkspaceCsiApplicationImage() {
    }

    static Snapshot expected(Snapshot baseline, Stage stage, byte[] frozen, byte[] cut, byte[] receipt) {
        require(baseline.blockers().isEmpty());
        Row progress = sole(baseline, "ma_operation");
        require("SETTLING".equals(progress.text("progress_stage")) && progress.number("progress_version") == 1);
        for (String field : List.of("frozen_request", "cut", "finalize_receipt")) {
            require(progress.cell(field + "_bytes").isNull() && progress.cell(field + "_sha256").isNull());
        }
        require((stage == Stage.SETTLING) == (frozen == null)
                && (stage == Stage.SETTLING || stage == Stage.FROZEN) == (cut == null)
                && (stage == Stage.DRAINED) == (receipt != null));
        Map<String, byte[]> progressDelta = new LinkedHashMap<>();
        put(progressDelta, "progress_stage", stage.name());
        put(progressDelta, "progress_version", stage.ordinal() + 1L);
        payload(progressDelta, "frozen_request", frozen);
        payload(progressDelta, "cut", cut);
        payload(progressDelta, "finalize_receipt", receipt);
        Map<String, Map<String, byte[]>> changes = new LinkedHashMap<>();
        changes.put("ma_operation", progressDelta);
        Map<String, Row> additions = new LinkedHashMap<>();
        if (cut != null) {
            JsonNode envelope = WorkspaceCsiApplicationJson.object(frozen, WorkspaceCsiApplicationInventory.MAX_BYTES);
            byte[] body = WorkspaceCsiApplicationJson.base64(envelope.path("commitBodyBase64"), 128 * 1024);
            require(hash(body).equals(envelope.path("preparedCommitSha256").textValue())
                    && Arrays.equals(baseline.bytes(), WorkspaceCsiApplicationJson.base64(
                            envelope.path("baselineBase64"), WorkspaceCsiApplicationInventory.MAX_BYTES)));
            JsonNode request = WorkspaceCsiApplicationJson.object(body, 128 * 1024);
            JsonNode delta = WorkspaceCsiApplicationJson.object(cut, 4096);
            WorkspaceCsiApplicationJson.closed(delta, Set.of("format", "retirementId", "frozenRequestSha256",
                    "baselineSha256", "preparedCommitSha256", "writtenAt"));
            require("qwen-csi-application-cut/1".equals(delta.path("format").textValue())
                    && progress.text("operation_id").equals(delta.path("retirementId").textValue())
                    && hash(frozen).equals(delta.path("frozenRequestSha256").textValue())
                    && hash(baseline.bytes()).equals(delta.path("baselineSha256").textValue())
                    && hash(body).equals(delta.path("preparedCommitSha256").textValue()));
            String writtenAt = delta.path("writtenAt").textValue();
            require(writtenAt != null && Instant.parse(writtenAt).toString().equals(writtenAt));
            Instant instant = Instant.parse(writtenAt);
            long writtenAtMillis = instant.toEpochMilli();
            require(writtenAtMillis >= 0 && Instant.ofEpochMilli(writtenAtMillis).equals(instant));
            Row head = sole(baseline, "ma_session_head");
            require("ACTIVE".equals(head.text("state")) && "active".equals(head.text("activation_phase")));
            long revision = Math.addExact(head.number("journal_revision"), 1L);
            require(head.number("journal_revision") == request.path("expectedJournalRevision").longValue()
                    && head.number("committed_sequence") == request.path("expectedCommittedSequence").longValue());
            Map<String, byte[]> headDelta = new LinkedHashMap<>();
            put(headDelta, "state", "SEALED");
            put(headDelta, "journal_revision", revision);
            Long wakeRevision = head.number("wake_head_revision");
            if (Objects.equals(wakeRevision, head.number("journal_revision"))) {
                put(headDelta, "wake_head_revision", revision);
                wakeRevision = revision;
            }
            put(headDelta, "wake_scan_pending", Boolean.TRUE.equals(head.bool("wake_pending"))
                    || wakeRevision == null || wakeRevision != revision);
            put(headDelta, "committed_sequence", request.path("lastSequence").longValue());
            put(headDelta, "last_commit_digest", text(request, "commitDigest"));
            put(headDelta, "activation_phase", "released");
            put(headDelta, "activation_head_revision", revision);
            put(headDelta, "gmt_modified", writtenAtMillis);
            changes.put("ma_session_head", headDelta);
            require(request.path("resources").isArray() && request.path("resources").size() == 1);
            JsonNode resource = request.path("resources").get(0);
            byte[] resourceBytes = WorkspaceCsiApplicationJson.base64(resource.path("bytesBase64"), 16 * 1024);
            Map<String, byte[]> values = empty(baseline, "ma_resource");
            scope(values, head);
            put(values, "session_scope_key", ManagedSessionStore.sessionScopeKey(head.text("tenant_id"), head.text("session_id")));
            put(values, "resource_id", text(resource, "resourceId"));
            String resourceScope = ManagedSessionStore.sessionScopeKey(head.text("tenant_id"), head.text("session_id"));
            String resourceKey = ManagedSessionStore.resourceKey(resourceScope, text(resource, "resourceId"));
            put(values, "resource_key", resourceKey);
            put(values, "kind", text(resource, "kind"));
            put(values, "schema_version", resource.path("schemaVersion").intValue());
            put(values, "byte_length", resourceBytes.length);
            put(values, "sha256", hash(resourceBytes));
            put(values, "storage_kind", "MYSQL_INLINE");
            values.put("inline_bytes", resourceBytes);
            put(values, "publish_command_id", text(request, "commandId"));
            put(values, "state", "REFERENCED");
            put(values, "gmt_create", writtenAtMillis);
            put(values, "last_verified_at", writtenAtMillis);
            additions.put("ma_resource", row("ma_resource", values));
            values = empty(baseline, "ma_resource_ref");
            scope(values, head);
            put(values, "owner_kind", "JOURNAL");
            put(values, "owner_key", resourceScope);
            put(values, "owner_revision", revision);
            put(values, "resource_key", resourceKey);
            put(values, "session_scope_key", ManagedSessionStore.sessionScopeKey(head.text("tenant_id"), head.text("session_id")));
            put(values, "journal_revision", revision);
            put(values, "resource_id", text(resource, "resourceId"));
            put(values, "gmt_create", writtenAtMillis);
            additions.put("ma_resource_ref", row("ma_resource_ref", values));
            values = empty(baseline, "ma_session_journal_tx");
            scope(values, head);
            put(values, "journal_revision", revision);
            put(values, "command_key_hash", hash((text(request, "operation") + "\u0000" + text(request, "commandId"))
                    .getBytes(StandardCharsets.UTF_8)));
            for (var entry : Map.of("transaction_id", "transactionId", "operation", "operation", "command_id", "commandId",
                    "content_digest", "contentDigest", "events_digest", "eventsDigest", "previous_commit_digest", "previousCommitDigest",
                    "commit_digest", "commitDigest", "writer_id", "writerId", "latest_checkpoint_resource_id", "latestCheckpointResourceId").entrySet()) {
                JsonNode value = request.path(entry.getValue());
                require(value.isNull() || value.isTextual());
                put(values, entry.getKey(), value.isNull() ? null : value.textValue());
            }
            for (var entry : Map.of("first_sequence", "firstSequence", "last_sequence", "lastSequence", "event_count", "eventCount",
                    "writer_generation", "writerGeneration", "activation_epoch", "activationEpoch").entrySet()) {
                put(values, entry.getKey(), request.path(entry.getValue()).longValue());
            }
            put(values, "writer_token_hash", text(envelope, "writerTokenSha256"));
            put(values, "record_encoding", "identity");
            byte[] records = WorkspaceCsiApplicationJson.base64(request.path("recordBytesBase64"), 128 * 1024);
            values.put("record_bytes", records);
            put(values, "byte_length", records.length);
            put(values, "record_digest", hash(records));
            put(values, "gmt_create", writtenAtMillis);
            additions.put("ma_session_journal_tx", row("ma_session_journal_tx", values));
        }
        if (stage == Stage.DRAINED) {
            Row session = sole(baseline, "ma_runtime_session");
            require("READY".equals(session.text("session_state")));
            Map<String, byte[]> release = new LinkedHashMap<>();
            put(release, "session_state", "RELEASED");
            put(release, "record_version", Math.addExact(session.number("record_version"), 1L));
            changes.put("ma_runtime_session", release);
        }
        List<Table> tables = new ArrayList<>();
        for (Table table : baseline.tables()) {
            List<Row> rows = new ArrayList<>(table.rows());
            if (changes.containsKey(table.name())) {
                Row original = sole(baseline, table.name());
                int index = rows.indexOf(original);
                Map<String, byte[]> values = new LinkedHashMap<>();
                original.fields().forEach((name, cell) -> values.put(name, cell.bytes()));
                values.putAll(changes.get(table.name()));
                rows.set(index, WorkspaceCsiApplicationInventory.expectedRow(table.name(), values, original.membership()));
            }
            if (additions.containsKey(table.name())) {
                Row added = additions.get(table.name());
                require(rows.stream().noneMatch(existing -> WorkspaceCsiApplicationInventory.compareKeys(existing, added) == 0));
                rows.add(added);
                rows.sort(WorkspaceCsiApplicationInventory::compareKeys);
            }
            tables.add(new Table(table.name(), table.columns(), table.primaryKey(), rows));
        }
        return WorkspaceCsiApplicationInventory.expectedImage(tables);
    }

    static void verify(Snapshot current, Snapshot expected) {
        require(current.blockers().isEmpty() && Arrays.equals(current.bytes(), expected.bytes()));
    }

    static Snapshot baseline(byte[] frozen) {
        JsonNode value = WorkspaceCsiApplicationJson.object(frozen, WorkspaceCsiApplicationInventory.MAX_BYTES);
        byte[] bytes = WorkspaceCsiApplicationJson.base64(value.path("baselineBase64"), WorkspaceCsiApplicationInventory.MAX_BYTES);
        require(hash(bytes).equals(value.path("baselineSha256").textValue()));
        return WorkspaceCsiApplicationInventory.restoreCanonical(bytes);
    }

    static Row sole(Snapshot snapshot, String table) {
        var rows = snapshot.table(table).rows().stream().filter(row -> row.membership() == Membership.ORIGINAL).toList();
        require(rows.size() == 1);
        return rows.getFirst();
    }

    private static Map<String, byte[]> empty(Snapshot snapshot, String table) {
        Map<String, byte[]> values = new LinkedHashMap<>();
        snapshot.table(table).columns().forEach(column -> values.put(column.name(), null));
        return values;
    }

    private static Row row(String table, Map<String, byte[]> values) {
        return WorkspaceCsiApplicationInventory.expectedRow(table, values, Membership.ORIGINAL);
    }

    private static void scope(Map<String, byte[]> values, Row head) {
        for (String field : List.of("tenant_id", "workspace_id", "session_id")) {
            put(values, field, head.text(field));
        }
    }

    private static void payload(Map<String, byte[]> values, String name, byte[] bytes) {
        values.put(name + "_bytes", bytes);
        put(values, name + "_sha256", bytes == null ? null : hash(bytes));
    }

    private static void put(Map<String, byte[]> values, String key, Object value) {
        values.put(key, value == null ? null : value.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static String text(JsonNode value, String key) {
        require(value.path(key).isTextual());
        return value.path(key).textValue();
    }

    private static String hash(byte[] bytes) { return CsiNativeActivationProof.sha256(bytes); }
}

package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedToolMeasurements;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore;
import com.alibaba.qwen.code.managedagent.repository.ManagedExtensionRecordStore.ActivityPage;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.JdbcTemplate;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.Function;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES;
import static com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore.readBody;
import static com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore.require;
import static com.alibaba.qwen.code.managedagent.persistence.JdbcManagedExtensionRecordStore.requireReference;

/** All writes share the journal transaction and its Session head fence. */
final class ManagedActivityDiagnosticProjection {
    private final JdbcTemplate jdbc;
    private final JdbcManagedExtensionRecordStore store;

    ManagedActivityDiagnosticProjection(JdbcTemplate jdbc, JdbcManagedExtensionRecordStore store) {
        this.jdbc = jdbc;
        this.store = store;
    }

    interface State {
        JsonNode find(String domain, String id);
        void put(String domain, String id, JsonNode body, long sequence, long at);
        void link(String execution, JsonNode body, String resource, long sequence, long at);
        default void invocation(ObjectNode body, long sequence, long at) {
            String id = body.path("invocationId").asText();
            put(ManagedActivityDiagnostics.TOOLS, id, body, sequence, at);
            if (!body.path("file").isNull()) {
                put(ManagedActivityDiagnostics.FILES, id, body, sequence, at);
            }
            if (!body.path("skill").isNull()) {
                put(ManagedActivityDiagnostics.SKILLS, id, body, sequence, at);
            }
        }
    }

    void apply(String tenant, String workspace, String session, JsonNode event, Function<String, StoredResource> resources) {
        reduce(tenant, session, event, resources, new State() {
            @Override public JsonNode find(String domain, String id) {
                return ManagedActivityDiagnosticProjection.this.find(tenant, session, domain, id);
            }
            @Override public void put(String domain, String id, JsonNode body, long sequence, long at) {
                ManagedActivityDiagnosticProjection.this.put(tenant, workspace, session, domain, id, body, sequence, at);
            }
            @Override public void link(String execution, JsonNode body, String resource, long sequence, long at) {
                point(tenant, workspace, session, ManagedActivityDiagnostics.LINKS, execution, resource, sequence, at);
            }
        });
    }

    static void reduce(String tenant, String session, JsonNode event, Function<String, StoredResource> resources, State state) {
        String kind = event.path("kind").asText();
        JsonNode payload = event.path("payload");
        JsonNode ref = payload.get("diagnosticsRef");
        if (ref == null && !List.of("tool.receipt", "tool.measured").contains(kind)) {
            return;
        }
        ObjectNode summary = (ObjectNode) state.find(ManagedActivityDiagnostics.STATS, "latest");
        if (summary != null && summary.path("epochId").isNull()) {
            summary = null;
        }
        long sequence = event.path("sequence").longValue();
        long at = event.path("occurredAt").longValue();
        if (ref != null) {
            require(List.of("message.committed", "tool.intent").contains(kind), "Invalid diagnostic carrier.");
            StoredResource resource = resources.apply(ref.path("resourceId").asText());
            requireReference(resource, ref);
            require(ManagedActivityDiagnostics.KIND.equals(resource.kind()) && resource.schemaVersion() == 1,
                    "Invalid execution diagnostic reference.");
            JsonNode evidence = readBody(resource);
            ManagedActivityDiagnostics.requireEvidence(evidence);
            require(!"message.committed".equals(kind) || List.of("assistant", "tool_result").contains(payload.path("role").asText()),
                    "Invalid diagnostic message role.");
            require(event.path("eventId").equals(evidence.path("sourceEventId")), "Diagnostic source identity conflicts.");
            if (summary == null) {
                summary = ManagedActivityDiagnostics.summary(evidence, sequence, at);
                if (!evidence.path("startEventId").equals(event.path("eventId"))) {
                    ManagedActivityDiagnostics.gap(summary, "collection_start_missing");
                    summary.putNull("coverageStartSequence");
                }
            } else {
                require(summary.path("epochId").equals(evidence.path("epochId"))
                        && summary.path("startEventId").equals(evidence.path("startEventId")), "Diagnostic collection epoch changed.");
            }
            if ("message.committed".equals(kind) && "assistant".equals(payload.path("role").asText())) {
                JsonNode record = message(payload.path("contentRef"), resources);
                require(payload.path("messageId").equals(record.path("uuid")), "Diagnostic message identity conflicts.");
                int ordinal = 0;
                for (JsonNode part : record.path("message").path("parts")) {
                    if (!part.has("functionCall")) {
                        continue;
                    }
                    ObjectNode invocation = ManagedActivityDiagnostics.request(tenant, session, record.path("uuid").asText(),
                            ordinal++, part.path("functionCall"), sequence, at);
                    String id = invocation.path("invocationId").asText();
                    JsonNode existing = state.find(ManagedActivityDiagnostics.TOOLS, id);
                    require(existing == null || existing.path("requestSequence").asText().equals(Long.toString(sequence)),
                            "A diagnostic request changed source.");
                    if (existing == null) {
                        ManagedActivityDiagnostics.contribute(summary, null, invocation);
                        state.invocation(invocation, sequence, at);
                    }
                }
            }
            java.util.Set<JsonNode> responseIds = new java.util.HashSet<>();
            if ("message.committed".equals(kind) && "tool_result".equals(payload.path("role").asText())) {
                JsonNode result = message(payload.path("contentRef"), resources);
                for (JsonNode part : result.path("message").path("parts")) {
                    if (part.has("functionResponse")) {
                        responseIds.add(part.path("functionResponse").path("id"));
                    }
                }
            }
            for (JsonNode fact : evidence.path("observations")) {
                require(!"assistant".equals(payload.path("role").asText()) || payload.path("messageId").equals(fact.path("assistantMessageId")),
                        "Assistant observation belongs to another message.");
                require(ManagedActivityDiagnostics.invocationId(tenant, session, fact.path("assistantMessageId").asText(),
                        fact.path("ordinal").intValue()).equals(fact.path("invocationId").asText()), "Diagnostic invocation belongs to another source.");
                if ("tool.intent".equals(kind)) {
                    require(payload.path("batchId").equals(fact.path("assistantMessageId"))
                            && payload.path("ordinal").equals(fact.path("ordinal"))
                            && payload.path("executionCallId").equals(fact.path("executionCallId")), "Diagnostic intent binding conflicts.");
                }
                JsonNode before = state.find(ManagedActivityDiagnostics.TOOLS, fact.path("invocationId").asText());
                if (before == null) {
                    ManagedActivityDiagnostics.gap(summary, "request_outside_coverage");
                    continue;
                }
                ObjectNode after = ManagedActivityDiagnostics.merge(before, fact, false);
                if ("message.committed".equals(kind) && "tool_result".equals(payload.path("role").asText())) {
                    require(responseIds.contains(fact.path("functionCallId")), "Diagnostic result has no matching response.");
                }
                if ("tool.intent".equals(kind)) {
                    String execution = payload.path("executionCallId").asText();
                    JsonNode previous = state.find(ManagedActivityDiagnostics.LINKS, execution);
                    require(previous == null || previous.path("observations").get(0).path("invocationId").equals(fact.path("invocationId")),
                            "Execution is bound to another diagnostic invocation.");
                    require(evidence.path("observations").size() == 1, "An intent carries exactly one invocation.");
                    state.link(execution, evidence, resource.resourceId(), sequence, at);
                }
                ManagedActivityDiagnostics.contribute(summary, before, after);
                state.invocation(after, sequence, at);
            }
            for (JsonNode reason : evidence.path("coverageReasons")) {
                ManagedActivityDiagnostics.gap(summary, reason.asText());
            }
        } else if ("tool.measured".equals(kind)) {
            com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords.closed(payload,
                    java.util.Set.of("executionCallId", "toolOutcomeRef", "measurementsRef"), "tool measurement carrier");
            require(summary != null, "Measured execution is outside activity coverage.");
            String execution = payload.path("executionCallId").asText();
            JsonNode link = state.find(ManagedActivityDiagnostics.LINKS, execution);
            require(link != null && link.path("observations").size() == 1, "Measured execution has no invocation binding.");
            JsonNode binding = link.path("observations").get(0);
            JsonNode before = state.find(ManagedActivityDiagnostics.TOOLS, binding.path("invocationId").asText());
            require(before != null, "Measured invocation is outside activity coverage.");
            StoredResource measured = resources.apply(payload.path("measurementsRef").path("resourceId").asText());
            requireReference(measured, payload.path("measurementsRef"));
            require(ManagedToolMeasurements.KIND.equals(measured.kind()) && measured.schemaVersion() == 1
                    && measured.byteLength() <= ManagedToolMeasurements.MAX_BYTES, "Invalid measurement reference.");
            JsonNode evidence = readBody(measured);
            ManagedToolMeasurements.requireEvidence(evidence);
            require(execution.equals(evidence.path("executionCallId").asText())
                    && binding.path("invocationId").equals(evidence.path("invocationId")), "Measurement invocation binding conflicts.");
            JsonNode outcomeBody = toolOutcome(payload.path("toolOutcomeRef"), resources);
            if (outcomeBody == null) {
                require(payload.path("toolOutcomeRef").equals(link.path("_receiptOutcomeRef")),
                        "Measured capture has no matching committed receipt.");
            } else if (outcomeBody.has("executionCallId")) {
                require(outcomeBody.path("executionCallId").asText().equals(execution), "Measured outcome belongs to another execution.");
            } else if (outcomeBody.path("identity").has("executionCallId")) {
                require(outcomeBody.path("identity").path("executionCallId").asText().equals(execution), "Measured capture belongs to another execution.");
            } else {
                require(outcomeBody.path("history").path("parts").isArray()
                        && outcomeBody.path("history").path("parts").size() == 1
                        && before.path("functionCallId").equals(outcomeBody.path("history").path("parts").get(0).path("functionResponse").path("id")),
                        "Measured outcome has no original invocation.");
            }
            JsonNode packet = evidence.path("measurements");
            JsonNode file = packet.path("file");
            if (file.isObject()) {
                require("builtin".equals(before.path("toolKind").asText()) && before.path("file").isObject()
                        && before.path("file").path("operation").equals(file.path("operation")), "File measurement is not a native file invocation.");
            }
            ObjectNode after = before.deepCopy();
            if (before.has("_measurementEvidenceDigest")) {
                require(before.path("_measurementEvidenceDigest").asText().equals(measured.digest()), "Frozen measurement evidence changed.");
            } else {
                after.put("_measurementEvidenceDigest", measured.digest());
                after.put("_measurementOutcomeKnown", !packet.isNull() && !"unknown".equals(packet.path("executionOutcome").asText()));
                after.set("measurements", ManagedToolMeasurements.publicMeasurements(evidence, sequence));
                if (!packet.isNull() && !"unknown".equals(packet.path("executionOutcome").asText())) {
                    after.set("execution", packet.path("executionOutcome"));
                }
            }
            if (!summary.has("measurementStartSequence")) {
                summary.put("measurementStartSequence", Long.toString(sequence));
            }
            ManagedActivityDiagnostics.contribute(summary, before, after);
            state.invocation(after, sequence, at);
        } else if (summary != null) {
            JsonNode link = state.find(ManagedActivityDiagnostics.LINKS, payload.path("executionCallId").asText());
            if (link == null) {
                ManagedActivityDiagnostics.gap(summary, "receipt_binding_missing");
            } else {
                JsonNode fact = link.path("observations").get(0);
                JsonNode before = state.find(ManagedActivityDiagnostics.TOOLS, fact.path("invocationId").asText());
                if (before != null) {
                    JsonNode outcomeRef = payload.path("toolOutcomeRef");
                    JsonNode result = toolOutcome(outcomeRef, resources);
                    require(!link.has("_receiptOutcomeRef") || outcomeRef.equals(link.path("_receiptOutcomeRef")),
                            "Diagnostic receipt outcome changed.");
                    if (result == null) {
                        ObjectNode bound = link.deepCopy();
                        bound.set("_receiptOutcomeRef", outcomeRef);
                        state.put(ManagedActivityDiagnostics.LINKS, payload.path("executionCallId").asText(), bound, sequence, at);
                        ManagedActivityDiagnostics.gap(summary, "receipt_outcome_not_inline");
                    } else {
                        JsonNode execution = result.path("envelope").has("executionStatus") ? result.path("envelope")
                                : result.has("executionStatus") ? result : result.path("functionResponse").path("response");
                        ObjectNode observation = fact.deepCopy();
                        observation.set("delivery", before.path("delivery"));
                        observation.set("capture", before.path("capture"));
                        if (ManagedActivityDiagnostics.EXECUTIONS.contains(execution.path("executionStatus").asText())) {
                            observation.set("execution", execution.get("executionStatus"));
                        }
                        JsonNode capture = execution.path("capture");
                        if (List.of("complete", "partial", "unavailable").contains(capture.path("captureStatus").asText())) {
                            observation.set("capture", capture.path("captureStatus"));
                        }
                        if ("blocked".equals(capture.path("deliveryStatus").asText()) && !List.of("complete", "partial").contains(before.path("delivery").asText())) {
                            observation.put("delivery", "unavailable");
                        }
                        ObjectNode after = ManagedActivityDiagnostics.merge(before, observation, true);
                        ManagedActivityDiagnostics.contribute(summary, before, after);
                        state.invocation(after, sequence, at);
                    }
                }
            }
        }
        if (summary != null) {
            summary.put("lastEvidenceSequence", Long.toString(sequence));
            state.put(ManagedActivityDiagnostics.STATS, "latest", summary, sequence, at);
        }
    }

    private static JsonNode toolOutcome(JsonNode ref, Function<String, StoredResource> resources) {
        StoredResource resource = resources.apply(ref.path("resourceId").asText());
        requireReference(resource, ref);
        require(resource.schemaVersion() == 1
                && List.of("managed-tool-outcome", "managed-tool-outcome-chunks").contains(resource.kind()),
                "Invalid diagnostic outcome resource.");
        if ("managed-tool-outcome".equals(resource.kind()) && resource.bytes() == null
                && resource.byteLength() > MAX_INLINE_RESOURCE_BYTES) {
            // Publication already verified the external object; do not fetch it under the Session fence.
            return null;
        }
        return com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.toolOutcomeBody(ref, referenced -> {
            StoredResource part = resources.apply(referenced.path("resourceId").asText());
            requireReference(part, referenced);
            return part.bytes();
        });
    }

    private static JsonNode message(JsonNode ref, Function<String, StoredResource> resources) {
        StoredResource resource = resources.apply(ref.path("resourceId").asText());
        requireReference(resource, ref);
        if (!"managed-message-chunks".equals(resource.kind())) {
            require("managed-message".equals(resource.kind()), "Invalid diagnostic message resource.");
            return readBody(resource);
        }
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (JsonNode part : readBody(resource).path("parts")) {
            StoredResource bytes = resources.apply(part.path("resourceId").asText());
            requireReference(bytes, part);
            require("managed-message-part".equals(bytes.kind()), "Invalid message part.");
            body.writeBytes(bytes.bytes());
        }
        JsonNode record = ManagedExtensionRecordStore.parse(body.toString(StandardCharsets.UTF_8));
        require(record != null, "Invalid diagnostic message.");
        return record;
    }

    JsonNode find(String tenant, String session, String domain, String id) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        return jdbc.queryForList("SELECT record_resource_id FROM ma_session_record WHERE record_kind = 'DOMAIN'"
                        + " AND session_scope_key = ? AND record_key = ?", String.class, scope,
                ManagedExtensionProjection.recordKey(session, domain, id)).stream()
                .findFirst().map(resource -> readBody(store.readResource(tenant, session, resource))).orElse(null);
    }

    ActivityPage page(String tenant, String session, String domain, long upper, Long time, String key, int limit) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        List<Object> args = new ArrayList<>(List.of(scope, domain));
        String position = "";
        if (time != null) {
            position = " AND (gmt_create < ? OR (gmt_create = ? AND record_key < ?))";
            args.addAll(List.of(time, time, key));
        }
        args.add(512);
        var rows = jdbc.query("SELECT record_resource_id, gmt_create, record_key, first_sequence FROM ma_session_record WHERE"
                        + " record_kind = 'DOMAIN' AND session_scope_key = ? AND domain = ? AND delivery_state IS NULL"
                        + position + " ORDER BY gmt_create DESC, record_key DESC LIMIT ?",
                (row, index) -> new ActivityRow(row.getString(1), row.getLong(2), row.getString(3), row.getLong(4)), args.toArray());
        List<JsonNode> items = new ArrayList<>();
        int bytes = 0;
        int checked = 0;
        Long lastTime = time;
        String lastKey = key;
        boolean more = false;
        boolean partial = false;
        for (ActivityRow row : rows) {
            if (items.size() == limit) {
                more = true;
                break;
            }
            if (row.firstSequence() <= upper) {
                StoredResource resource = store.readResource(tenant, session, row.resource());
                require(ManagedActivityDiagnostics.PROJECTION_KIND.equals(resource.kind()) && resource.byteLength() <= 65_536,
                        "Invalid activity projection resource.");
                if (bytes + resource.byteLength() > 1024 * 1024 - 16 * 1024) {
                    more = true;
                    partial = true;
                    break;
                }
                items.add(readBody(resource));
                bytes += Math.toIntExact(resource.byteLength());
            }
            checked++;
            lastTime = row.time();
            lastKey = row.key();
        }
        if (checked == 512) {
            more = true;
            partial = true;
        }
        return new ActivityPage(List.copyOf(items), more, partial, lastTime, lastKey);
    }

    private record PageRow(String resource, long time, String key) { }
    private record ActivityRow(String resource, long time, String key, long firstSequence) { }

    /** Called only while acquiring the fenced writer, never by diagnostic reads. */
    boolean rebuildBatch(String tenant, String workspace, String session, long storageVersion, long headRevision, long headSequence, String headDigest,
            Function<String, StoredResource> resources) {
        if (storageVersion < 4) {
            return true;
        }
        ObjectNode summary = (ObjectNode) find(tenant, session, ManagedActivityDiagnostics.STATS, "latest");
        if (summary != null && "ready".equals(summary.path("readiness").asText())) {
            return true;
        }
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        if (summary == null) {
            summary = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.objectNode().put("schemaVersion", 1)
                    .put("reducerVersion", 1).putNull("epochId").putNull("startEventId").putNull("startedAt")
                    .putNull("coverageStartSequence").put("readiness", "clearing")
                    .put("rebuiltThroughSequence", "0").put("rebuiltThroughRevision", "0")
                    .put("rebuiltCompletedSequence", "0").putNull("rebuiltCommitDigest");
            summary.putArray("coverageReasons").add("rebuilding");
            put(tenant, workspace, session, ManagedActivityDiagnostics.STATS, "latest", summary, 0, 0);
            return false;
        }
        if ("clearing".equals(summary.path("readiness").asText())) {
            var clearing = jdbc.query("SELECT record_resource_id, gmt_create, record_key FROM ma_session_record"
                            + " WHERE session_scope_key = ? AND domain IN (?, ?, ?, ?) ORDER BY record_key LIMIT 512",
                    (row, index) -> new PageRow(row.getString(1), row.getLong(2), row.getString(3)), scope,
                    ManagedActivityDiagnostics.TOOLS, ManagedActivityDiagnostics.FILES, ManagedActivityDiagnostics.SKILLS, ManagedActivityDiagnostics.LINKS);
            for (PageRow row : clearing) {
                jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = 'SESSION_RECORD' AND owner_key = ?", scope, row.key());
                jdbc.update("DELETE FROM ma_session_record WHERE session_scope_key = ? AND record_key = ?", scope, row.key());
                discardUnreferenced(scope, row.resource());
            }
            if (clearing.isEmpty()) {
                summary.put("readiness", "rebuilding");
                put(tenant, workspace, session, ManagedActivityDiagnostics.STATS, "latest", summary, 0, 0);
            }
            return false;
        }
        long afterRevision = Long.parseLong(summary.path("rebuiltThroughRevision").asText("0"));
        long through = Long.parseLong(summary.path("rebuiltThroughSequence").asText("0"));
        long completedSequence = Long.parseLong(summary.path("rebuiltCompletedSequence").asText("0"));
        String previousDigest = summary.path("rebuiltCommitDigest").isTextual() ? summary.path("rebuiltCommitDigest").asText() : null;
        long bytes = 0;
        int events = 0;
        var transactions = jdbc.query("SELECT journal_revision, first_sequence, last_sequence, byte_length, event_count, previous_commit_digest, commit_digest FROM ma_session_journal_tx"
                        + " WHERE tenant_id = ? AND session_id = ? AND journal_revision > ? ORDER BY journal_revision LIMIT 512",
                (row, index) -> new RebuildTransaction(row.getLong(1), row.getLong(2), row.getLong(3), row.getLong(4), row.getInt(5), row.getString(6), row.getString(7)), tenant, session, afterRevision);
        for (RebuildTransaction transaction : transactions) {
            require(transaction.revision() == afterRevision + 1 && transaction.revision() <= headRevision
                    && transaction.sequence() <= headSequence && Objects.equals(previousDigest, transaction.previousDigest())
                    && transaction.first() == completedSequence + (transaction.events() == 0 ? 0 : 1)
                    && transaction.sequence() == completedSequence + transaction.events(), "Diagnostic recovery source chain is incomplete.");
            Long resourceBytes = jdbc.queryForObject("SELECT COALESCE(SUM(r.byte_length), 0) FROM ma_resource_ref f JOIN ma_resource r"
                            + " ON r.resource_key = f.resource_key WHERE f.session_scope_key = ? AND f.owner_kind = 'JOURNAL'"
                            + " AND f.owner_key = ? AND f.owner_revision = ?", Long.class, scope, scope, transaction.revision());
            long cost = Math.addExact(transaction.bytes(), resourceBytes == null ? 0 : resourceBytes);
            if (cost > 8L * 1024 * 1024) {
                throw JournalStoreRows.conflict("managed_activity_rebuild_source_too_large", "Diagnostic recovery source exceeds its bounded batch.");
            }
            if (events >= 512 || bytes + cost > 8L * 1024 * 1024) {
                break;
            }
            var source = jdbc.queryForMap("SELECT record_bytes, record_digest FROM ma_session_journal_tx WHERE tenant_id = ?"
                    + " AND session_id = ? AND journal_revision = ?", tenant, session, transaction.revision());
            byte[] raw = (byte[]) source.get("record_bytes");
            require(raw != null, "Diagnostic recovery journal is missing.");
            require(raw.length == transaction.bytes() && DigestUtils.sha256Hex(raw).equals(source.get("record_digest")),
                    "Diagnostic recovery journal digest conflicts.");
            boolean complete = true;
            long observed = transaction.events() == 0 ? completedSequence : transaction.first() - 1;
            int observedCount = 0;
            for (JsonNode record : com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof.records(raw)) {
                JsonNode event = record.path("managedSession");
                if (!"managed_session_event_v1".equals(record.path("subtype").asText())) {
                    continue;
                }
                require(event.path("sequence").longValue() == observed + 1
                        && tenant.equals(event.path("sessionKey").path("tenantId").asText())
                        && session.equals(event.path("sessionKey").path("sessionId").asText())
                        && workspace.equals(event.path("sessionKey").path("workspaceId").asText()), "Diagnostic recovery event prefix is incomplete.");
                observed++;
                observedCount++;
                if (observed <= through) {
                    continue;
                }
                if (events == 512) {
                    complete = false;
                    break;
                }
                apply(tenant, workspace, session, event, resources);
                through = observed;
                events++;
            }
            bytes += cost;
            if (!complete) {
                break;
            }
            require(observedCount == transaction.events() && observed == transaction.sequence(), "Diagnostic recovery transaction is incomplete.");
            afterRevision = transaction.revision();
            completedSequence = transaction.sequence();
            previousDigest = transaction.digest();
        }
        ObjectNode current = (ObjectNode) find(tenant, session, ManagedActivityDiagnostics.STATS, "latest");
        if (current != null) {
            summary = current;
        }
        boolean ready = through == headSequence && afterRevision == headRevision && Objects.equals(previousDigest, headDigest);
        require(ready || !transactions.isEmpty(), "Diagnostic recovery source prefix is incomplete.");
        if (ready) {
            require(!summary.path("epochId").isNull(), "Diagnostic recovery source facts are missing.");
            summary.put("readiness", "ready");
            summary.remove(List.of("rebuiltThroughSequence", "rebuiltThroughRevision", "rebuiltCompletedSequence", "rebuiltCommitDigest"));
            JsonNode previousReasons = summary.path("coverageReasons").deepCopy();
            var reasons = summary.putArray("coverageReasons");
            if (current != null) {
                for (JsonNode reason : previousReasons) {
                    if (!"rebuilding".equals(reason.asText())) {
                        reasons.add(reason);
                    }
                }
            }
        } else {
            summary.put("readiness", "rebuilding").put("rebuiltThroughSequence", Long.toString(through))
                    .put("rebuiltThroughRevision", Long.toString(afterRevision)).put("rebuiltCompletedSequence", Long.toString(completedSequence))
                    .put("rebuiltCommitDigest", previousDigest);
            ManagedActivityDiagnostics.gap(summary, "rebuilding");
        }
        put(tenant, workspace, session, ManagedActivityDiagnostics.STATS, "latest", summary,
                ready ? Long.parseLong(summary.path("lastEvidenceSequence").asText()) : through, summary.path("startedAt").asLong());
        if (ready && !summary.path("coverageStartSequence").isNull()) {
            jdbc.update("UPDATE ma_session_record SET gmt_create = ?, first_sequence = ? WHERE session_scope_key = ? AND record_key = ?",
                    summary.path("startedAt").longValue(), Long.parseLong(summary.path("coverageStartSequence").asText()),
                    scope, ManagedExtensionProjection.recordKey(session, ManagedActivityDiagnostics.STATS, "latest"));
        }
        return ready;
    }

    private record RebuildTransaction(long revision, long first, long sequence, long bytes, int events, String previousDigest, String digest) { }

    private void put(String tenant, String workspace, String session, String domain, String id, JsonNode body, long sequence, long at) {
        point(tenant, workspace, session, domain, id, immutable(tenant, workspace, session, body), sequence, at);
    }

    private String immutable(String tenant, String workspace, String session, JsonNode body) {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        require(bytes.length <= 65_536, "Activity projection exceeds 64 KiB.");
        String digest = DigestUtils.sha256Hex(bytes);
        String resource = ManagedActivityDiagnostics.PROJECTION_KIND + ":" + digest;
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id,"
                        + " kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', " + ManagedSchemaTime.SQL_NOW
                        + ") ON DUPLICATE KEY UPDATE resource_key = resource_key", ManagedSchemaKeys.key(scope, resource), scope,
                tenant, workspace, session, resource, ManagedActivityDiagnostics.PROJECTION_KIND, bytes.length, digest, bytes);
        StoredResource saved = store.readResource(tenant, session, resource);
        require(saved.kind().equals(ManagedActivityDiagnostics.PROJECTION_KIND) && saved.schemaVersion() == 1
                && java.util.Arrays.equals(saved.bytes(), bytes), "Activity projection digest conflict.");
        return resource;
    }

    private void point(String tenant, String workspace, String session, String domain, String id, String resource, long sequence, long at) {
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String key = ManagedExtensionProjection.recordKey(session, domain, id);
        List<String> old = jdbc.queryForList("SELECT record_resource_id FROM ma_session_record WHERE session_scope_key = ?"
                + " AND record_key = ?", String.class, scope, key);
        if (old.isEmpty()) {
            jdbc.update("INSERT INTO ma_session_record (record_kind, session_scope_key, record_key, tenant_id, workspace_id,"
                            + " session_id, domain, record_id, revision, record_resource_id, gmt_create, first_sequence)"
                            + " VALUES ('DOMAIN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", scope, key, tenant, workspace, session,
                    domain, id, sequence, resource, at, sequence);
        } else if (Objects.equals(old.getFirst(), resource)) {
            return;
        } else {
            jdbc.update("UPDATE ma_session_record SET revision = ?, record_resource_id = ? WHERE session_scope_key = ?"
                    + " AND record_key = ?", sequence, resource, scope, key);
        }
        jdbc.update("DELETE FROM ma_resource_ref WHERE session_scope_key = ? AND owner_kind = 'SESSION_RECORD' AND owner_key = ?", scope, key);
        JdbcManagedExtensionRecordStore.referenceProjectionResource(jdbc, scope, key, sequence, tenant, workspace,
                session, resource);
        for (String previous : old) {
            discardUnreferenced(scope, previous);
        }
    }

    private void discardUnreferenced(String scope, String resource) {
        jdbc.update("DELETE FROM ma_resource WHERE session_scope_key = ? AND resource_id = ? AND kind = ?"
                        + " AND NOT EXISTS (SELECT 1 FROM ma_resource_ref f WHERE f.session_scope_key = ? AND f.resource_id = ?)",
                scope, resource, ManagedActivityDiagnostics.PROJECTION_KIND, scope, resource);
    }
}

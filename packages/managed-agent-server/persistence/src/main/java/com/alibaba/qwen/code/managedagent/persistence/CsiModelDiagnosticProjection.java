package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionRecords;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedModelDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiApplicationJson;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.HistoricalScan;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.expectedRow;
import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.nullRowValues;
import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.requireEncoded;

/** Rebuilds the exact diagnostic rows and resource edges from the qualified CSI journal. */
final class CsiModelDiagnosticProjection {
    private CsiModelDiagnosticProjection() { }

    static Row reference(List<Row> transactions, List<Row> records, List<Row> resources,
            List<Row> references, RuntimeProvisionRequest original, long deadline, boolean statistics) {
        String domain = statistics ? "hosted_session_statistics" : "hosted_context_usage";
        JsonNode first = null;
        JsonNode latest = null;
        JsonNode latestStatistics = null;
        Map<Long, String> snapshots = new HashMap<>();
        boolean stale = false;
        Row latestTransaction = null;
        String tenant = original.getScope().getTenantId();
        String workspace = original.getScope().getWorkspaceId();
        String session = original.getIsolationKey();
        String scope = ManagedSessionStore.sessionScopeKey(tenant, session);
        String key = ManagedExtensionProjection.recordKey(session, domain, "latest");
        boolean diagnostics = CsiFilesRetirementProfile.hasDiagnostics(original.getScope());
        var projected = records.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && (!diagnostics || domain.equals(row.text("domain")))).toList();
        var derived = references.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && "SESSION_RECORD".equals(row.text("owner_kind")) && (!diagnostics || key.equals(row.text("owner_key")))).toList();
        for (Row transaction : transactions.stream().filter(row -> row.membership() == Membership.ORIGINAL)
                .sorted(java.util.Comparator.comparingLong(row -> row.number("journal_revision"))).toList()) {
            byte[] raw = HistoricalScan.payload(transaction, "record_bytes", "record_digest", 8 * 1024 * 1024);
            requireEncoded("identity".equals(transaction.text("record_encoding")));
            for (JsonNode record : CsiNativeActivationProof.records(raw)) {
                JsonNode event = record.path("managedSession");
                if (!"managed_session_event_v1".equals(record.path("subtype").textValue())) {
                    continue;
                }
                String eventKind = event.path("kind").asText();
                JsonNode payload = event.path("payload");
                if (!statistics && latest != null
                        && ManagedModelDiagnostics.MAIN_KIND.equals(latest.path("payload").path("usageRef").path("kind").asText())
                        && ManagedModelDiagnosticProjection.invalidatesContext(eventKind, payload.path("domain").asText())) {
                    stale = true;
                }
                JsonNode candidateUsage = payload.path("usageRef");
                String usageKind = candidateUsage.path("kind").asText();
                JsonNode observation = null;
                if (ManagedModelDiagnostics.KINDS.contains(usageKind)) {
                    requireEncoded(diagnostics && Set.of("model.attempt", "turn.settled").contains(eventKind));
                    var matches = resources.stream().filter(row -> row.membership() == Membership.ORIGINAL
                            && candidateUsage.path("resourceId").asText().equals(row.text("resource_id"))).toList();
                    requireEncoded(matches.size() == 1);
                    Row carrier = matches.getFirst();
                    HistoricalScan.resourceMetadata(carrier);
                    requireEncoded(usageKind.equals(carrier.text("kind")) && candidateUsage.path("schemaVersion").asInt() == 1
                            && Objects.equals(carrier.text("sha256"), candidateUsage.path("digest").asText())
                            && Objects.equals(carrier.number("byte_length"), candidateUsage.path("byteLength").longValue()));
                    observation = CsiNativeActivationProof.readObject(HistoricalScan.payload(carrier, "inline_bytes", "sha256", 65_536));
                    ManagedModelDiagnostics.requireBody(usageKind, observation);
                    JsonNode snapshot = observation.get("statistics");
                    String digest = CsiNativeActivationProof.sha256(utf8(CsiNativeActivationProof.canonical(snapshot)));
                    String previous = snapshots.putIfAbsent(snapshot.path("snapshotRevision").longValue(), digest);
                    requireEncoded(previous == null || previous.equals(digest));
                }
                if (statistics) {
                    if (observation == null) {
                        continue;
                    }
                    JsonNode snapshot = observation.get("statistics");
                    if (latestStatistics != null) {
                        long before = latestStatistics.path("snapshotRevision").longValue();
                        long next = snapshot.path("snapshotRevision").longValue();
                        requireEncoded(before != next || com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedMcpRecords.same(latestStatistics, snapshot));
                        if (next <= before) {
                            continue;
                        }
                    }
                    latestStatistics = snapshot;
                } else if (!"model.attempt".equals(eventKind) || !"output_committed".equals(payload.path("state").asText())
                        || !Set.of("managed-hosted-model-usage", ManagedModelDiagnostics.MAIN_KIND).contains(usageKind)) {
                    continue;
                }
                JsonNode sessionKey = event.path("sessionKey");
                WorkspaceCsiApplicationJson.closed(sessionKey, Set.of("tenantId", "workspaceId", "sessionId"));
                requireEncoded(tenant.equals(sessionKey.path("tenantId").textValue())
                        && workspace.equals(sessionKey.path("workspaceId").textValue())
                        && session.equals(sessionKey.path("sessionId").textValue()));
                ManagedExtensionRecords.count(event.get("v"), 1, 1, "event.v");
                long sequence = ManagedExtensionRecords.count(event.get("sequence"), 1, 9_007_199_254_740_991L, "event.sequence");
                ManagedExtensionRecords.count(event.get("occurredAt"), 0, ManagedExtensionRecords.MAX_TIME, "event.occurredAt");
                requireEncoded(latest == null || sequence > latest.path("sequence").longValue());
                if (first == null) {
                    first = event;
                }
                latest = event;
                latestTransaction = transaction;
                stale = false;
            }
        }
        if (latest == null) {
            requireEncoded(projected.isEmpty() && derived.isEmpty());
            return null;
        }
        requireEncoded(projected.size() == 1 && derived.size() == 1);
        JsonNode usage = latest.path("payload").path("usageRef");
        WorkspaceCsiApplicationJson.closed(usage, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        String resourceId = usage.path("resourceId").textValue();
        var matching = resources.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && Objects.equals(resourceId, row.text("resource_id"))).toList();
        requireEncoded(matching.size() == 1);
        Row resource = matching.getFirst();
        HistoricalScan.resourceMetadata(resource);
        requireEncoded(tenant.equals(resource.text("tenant_id")) && workspace.equals(resource.text("workspace_id"))
                && session.equals(resource.text("session_id")) && "REFERENCED".equals(resource.text("state"))
                && resource.text("kind").equals(usage.path("kind").textValue())
                && (statistics ? ManagedModelDiagnostics.KINDS.contains(resource.text("kind"))
                        : "managed-hosted-model-usage".equals(resource.text("kind"))
                                || diagnostics && ManagedModelDiagnostics.MAIN_KIND.equals(resource.text("kind")))
                && ManagedExtensionRecords.count(usage.get("schemaVersion"), 1, 1, "usage.schemaVersion") == 1
                && Objects.equals(resource.number("byte_length"),
                        ManagedExtensionRecords.count(usage.get("byteLength"), 1, ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES, "usage.byteLength"))
                && Objects.equals(resource.text("sha256"), usage.path("digest").textValue()));
        HistoricalScan.payload(resource, "inline_bytes", "sha256", ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES);
        long revision = latest.path("sequence").longValue();
        Map<String, byte[]> values = nullRowValues("ma_session_record");
        Map.ofEntries(Map.entry("session_scope_key", scope), Map.entry("record_key", key),
                Map.entry("tenant_id", tenant), Map.entry("workspace_id", workspace), Map.entry("session_id", session),
                Map.entry("domain", domain), Map.entry("record_id", "latest"), Map.entry("record_kind", "DOMAIN"),
                Map.entry("revision", Long.toString(revision)), Map.entry("record_resource_id", resourceId),
                Map.entry("gmt_create", first.path("occurredAt").asText()), Map.entry("settled_at", latest.path("occurredAt").asText()),
                Map.entry("first_sequence", first.path("sequence").asText())).forEach((field, value) -> values.put(field, utf8(value)));
        if (stale) {
            values.put("settled_at", null);
        }
        requireEncoded(Arrays.equals(projected.getFirst().bytes(), expectedRow("ma_session_record", values, Membership.ORIGINAL).bytes()));
        Row ref = derived.getFirst();
        requireEncoded(ref.number("gmt_create") != null && latestTransaction.number("gmt_create") != null
                && ref.number("gmt_create") >= latestTransaction.number("gmt_create") && ref.number("gmt_create") <= deadline);
        values.clear();
        values.putAll(nullRowValues("ma_resource_ref"));
        Map.ofEntries(Map.entry("session_scope_key", scope), Map.entry("owner_kind", "SESSION_RECORD"), Map.entry("owner_key", key),
                Map.entry("owner_revision", Long.toString(revision)), Map.entry("resource_key", ManagedSessionStore.resourceKey(scope, resourceId)),
                Map.entry("tenant_id", tenant), Map.entry("workspace_id", workspace), Map.entry("session_id", session),
                Map.entry("resource_id", resourceId), Map.entry("gmt_create", ref.text("gmt_create")))
                .forEach((field, value) -> values.put(field, utf8(value)));
        requireEncoded(Arrays.equals(ref.bytes(), expectedRow("ma_resource_ref", values, Membership.ORIGINAL).bytes()));
        long journalRevision = latestTransaction.number("journal_revision");
        requireEncoded(references.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && "JOURNAL".equals(row.text("owner_kind")) && scope.equals(row.text("session_scope_key"))
                && scope.equals(row.text("owner_key")) && Objects.equals(row.number("journal_revision"), journalRevision)
                && Objects.equals(row.number("owner_revision"), journalRevision)
                && Objects.equals(row.text("resource_key"), resource.text("resource_key"))
                && tenant.equals(row.text("tenant_id")) && workspace.equals(row.text("workspace_id"))
                && session.equals(row.text("session_id")) && resourceId.equals(row.text("resource_id"))).count() == 1);
        return ref;
    }

    private static byte[] utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }
}

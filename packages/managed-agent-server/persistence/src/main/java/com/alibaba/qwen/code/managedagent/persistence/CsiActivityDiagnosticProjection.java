package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedActivityDiagnostics;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.HistoricalScan;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.expectedRow;
import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.nullRowValues;
import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.requireEncoded;

/** Replays source facts with the live reducer before admitting derived SQL inventory. */
final class CsiActivityDiagnosticProjection {
    private CsiActivityDiagnosticProjection() { }

    static List<Row> references(List<Row> transactions, List<Row> records, List<Row> resources,
            List<Row> references, RuntimeProvisionRequest original, long deadline) {
        String tenant = original.getScope().getTenantId();
        String workspace = original.getScope().getWorkspaceId();
        String session = original.getIsolationKey();
        String scope = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey(tenant, session);
        Map<String, Row> source = new HashMap<>();
        for (Row row : resources) {
            if (row.membership() == Membership.ORIGINAL) {
                requireEncoded(source.putIfAbsent(row.text("resource_id"), row) == null);
            }
        }
        Map<String, Entry> projected = new LinkedHashMap<>();
        long[] transactionTime = new long[1];
        ManagedActivityDiagnosticProjection.State state = new ManagedActivityDiagnosticProjection.State() {
            @Override public JsonNode find(String domain, String id) {
                Entry value = projected.get(ManagedExtensionProjection.recordKey(session, domain, id));
                return value == null ? null : value.body().deepCopy();
            }
            @Override public void put(String domain, String id, JsonNode body, long sequence, long at) {
                String resource = ManagedActivityDiagnostics.PROJECTION_KIND + ":" + DigestUtils.sha256Hex(utf8(body.toString()));
                save(domain, id, body, resource, sequence, at);
            }
            @Override public void link(String execution, JsonNode body, String resource, long sequence, long at) {
                save(ManagedActivityDiagnostics.LINKS, execution, body, resource, sequence, at);
            }
            private void save(String domain, String id, JsonNode body, String resource, long sequence, long at) {
                String key = ManagedExtensionProjection.recordKey(session, domain, id);
                Entry before = projected.get(key);
                if (before != null && before.resource().equals(resource)) {
                    return;
                }
                projected.put(key, new Entry(domain, id, body.deepCopy(), resource, sequence,
                        before == null ? at : before.createdAt(), before == null ? sequence : before.firstSequence(), transactionTime[0]));
            }
        };
        for (Row transaction : transactions.stream().filter(row -> row.membership() == Membership.ORIGINAL)
                .sorted(java.util.Comparator.comparingLong(row -> row.number("journal_revision"))).toList()) {
            transactionTime[0] = transaction.number("gmt_create");
            byte[] bytes = HistoricalScan.payload(transaction, "record_bytes", "record_digest", 8 * 1024 * 1024);
            for (JsonNode record : CsiNativeActivationProof.records(bytes)) {
                JsonNode event = record.path("managedSession");
                if (!"managed_session_event_v1".equals(record.path("subtype").asText())) {
                    continue;
                }
                requireEncoded(tenant.equals(event.path("sessionKey").path("tenantId").asText())
                        && session.equals(event.path("sessionKey").path("sessionId").asText()));
                ManagedActivityDiagnosticProjection.reduce(tenant, session, event, id -> {
                    Row row = source.get(id);
                    requireEncoded(row != null);
                    HistoricalScan.resourceMetadata(row);
                    byte[] raw = HistoricalScan.payload(row, "inline_bytes", "sha256", 8 * 1024 * 1024);
                    return new StoredResource(id, row.text("kind"), Math.toIntExact(row.number("schema_version")),
                            row.number("byte_length"), row.text("sha256"), raw);
                }, state);
            }
        }
        requireEncoded(CsiFilesRetirementProfile.hasActivityDiagnostics(original.getScope()) || projected.isEmpty());
        var actual = records.stream().filter(row -> row.membership() == Membership.ORIGINAL
                && ManagedActivityDiagnostics.DOMAINS.contains(row.text("domain"))).toList();
        requireEncoded(actual.size() == projected.size());
        List<Row> edges = new ArrayList<>();
        Set<String> projectionResources = new java.util.HashSet<>();
        for (Map.Entry<String, Entry> entry : projected.entrySet()) {
            String key = entry.getKey();
            Entry value = entry.getValue();
            Row resource = source.get(value.resource());
            requireEncoded(resource != null && tenant.equals(resource.text("tenant_id"))
                    && workspace.equals(resource.text("workspace_id")) && session.equals(resource.text("session_id"))
                    && "REFERENCED".equals(resource.text("state")) && resource.number("schema_version") == 1
                    && Arrays.equals(utf8(value.body().toString()), resource.binary("inline_bytes")));
            if (!ManagedActivityDiagnostics.LINKS.equals(value.domain())) {
                requireEncoded(ManagedActivityDiagnostics.PROJECTION_KIND.equals(resource.text("kind")));
                projectionResources.add(value.resource());
            }
            Map<String, byte[]> recordFields = nullRowValues("ma_session_record");
            Map.ofEntries(Map.entry("record_kind", "DOMAIN"), Map.entry("session_scope_key", scope), Map.entry("record_key", key),
                    Map.entry("tenant_id", tenant), Map.entry("workspace_id", workspace), Map.entry("session_id", session),
                    Map.entry("domain", value.domain()), Map.entry("record_id", value.id()), Map.entry("revision", Long.toString(value.sequence())),
                    Map.entry("record_resource_id", value.resource()), Map.entry("gmt_create", Long.toString(value.createdAt())),
                    Map.entry("first_sequence", Long.toString(value.firstSequence()))).forEach((field, text) -> recordFields.put(field, utf8(text)));
            var matching = actual.stream().filter(row -> key.equals(row.text("record_key"))).toList();
            requireEncoded(matching.size() == 1 && Arrays.equals(matching.getFirst().bytes(), expectedRow("ma_session_record", recordFields, Membership.ORIGINAL).bytes()));
            var linked = references.stream().filter(row -> row.membership() == Membership.ORIGINAL
                    && "SESSION_RECORD".equals(row.text("owner_kind")) && key.equals(row.text("owner_key"))).toList();
            requireEncoded(linked.size() == 1);
            Row edge = linked.getFirst();
            requireEncoded(edge.number("gmt_create") != null && edge.number("gmt_create") >= value.transactionTime()
                    && edge.number("gmt_create") <= deadline);
            Map<String, byte[]> expected = nullRowValues("ma_resource_ref");
            Map.ofEntries(Map.entry("session_scope_key", scope), Map.entry("owner_kind", "SESSION_RECORD"), Map.entry("owner_key", key),
                    Map.entry("owner_revision", Long.toString(value.sequence())), Map.entry("resource_key", ManagedSchemaKeys.key(scope, value.resource())),
                    Map.entry("tenant_id", tenant), Map.entry("workspace_id", workspace), Map.entry("session_id", session),
                    Map.entry("resource_id", value.resource()), Map.entry("gmt_create", edge.text("gmt_create")))
                    .forEach((field, text) -> expected.put(field, utf8(text)));
            requireEncoded(Arrays.equals(edge.bytes(), expectedRow("ma_resource_ref", expected, Membership.ORIGINAL).bytes()));
            edges.add(edge);
        }
        requireEncoded(source.values().stream().filter(row -> ManagedActivityDiagnostics.PROJECTION_KIND.equals(row.text("kind")))
                .allMatch(row -> projectionResources.contains(row.text("resource_id"))));
        return List.copyOf(edges);
    }

    private record Entry(String domain, String id, JsonNode body, String resource, long sequence,
            long createdAt, long firstSequence, long transactionTime) { }

    private static byte[] utf8(String value) {
        return value.getBytes(StandardCharsets.UTF_8);
    }
}

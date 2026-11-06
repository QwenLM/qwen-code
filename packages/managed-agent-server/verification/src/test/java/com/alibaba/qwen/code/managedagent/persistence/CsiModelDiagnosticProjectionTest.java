package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.VerificationFixtures;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedModelDiagnostics;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Membership;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationInventory.Row;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CsiModelDiagnosticProjectionTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SESSION = "00000000-0000-4000-8000-000000000001";
    private static final String SCOPE = com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.sessionScopeKey("tenant", SESSION);
    private static final String KEY = ManagedExtensionProjection.recordKey(SESSION, ManagedModelDiagnostics.STATS_DOMAIN, "latest");

    @Test
    void reconstructsTheHighestRevisionAndRejectsAChangedOldSnapshot() throws Exception {
        var valid = fixture(false);
        Row reference = CsiModelDiagnosticProjection.reference(valid.transactions(), valid.records(), valid.resources(),
                valid.references(), original(CsiFilesRetirementProfile.DIAGNOSTICS_PROFILE), 10_000, true);
        assertThat(reference.text("resource_id")).isEqualTo("stats-2");
        var conflicting = fixture(true);
        assertThatThrownBy(() -> CsiModelDiagnosticProjection.reference(conflicting.transactions(), conflicting.records(), conflicting.resources(),
                conflicting.references(), original(CsiFilesRetirementProfile.DIAGNOSTICS_PROFILE), 10_000, true))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aLegacyProfileCannotImportTheNewCarrier() throws Exception {
        var fixture = fixture(false);
        assertThatThrownBy(() -> CsiModelDiagnosticProjection.reference(fixture.transactions(), fixture.records(), fixture.resources(),
                fixture.references(), original(CsiFilesRetirementProfile.PROFILE), 10_000, true)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aHookCarrierCanSupplyStatisticsWithoutReplacingTheMainContext() throws Exception {
        var statistics = fixture(false, true, false);
        assertThat(CsiModelDiagnosticProjection.reference(statistics.transactions(), statistics.records(), statistics.resources(),
                statistics.references(), original(CsiFilesRetirementProfile.DIAGNOSTICS_PROFILE), 10_000, true)
                .text("resource_id")).isEqualTo("stats-2");
        var context = fixture(false, true, true);
        assertThat(CsiModelDiagnosticProjection.reference(context.transactions(), context.records(), context.resources(),
                context.references(), original(CsiFilesRetirementProfile.DIAGNOSTICS_PROFILE), 10_000, false)
                .text("resource_id")).isEqualTo("stats-1");
    }

    private RuntimeProvisionRequest original(String profile) {
        return CsiFilesRetirementProfile.request(new ContextBinding("tenant", "workspace", 1, "storage", ".",
                CsiFilesRetirementProfile.CONTEXT_CONFIG_REF, 1), "/workspace", SESSION, profile);
    }

    private record Fixture(List<Row> transactions, List<Row> records, List<Row> resources, List<Row> references) { }

    private Fixture fixture(boolean conflict) throws Exception {
        return fixture(conflict, false, false);
    }

    private Fixture fixture(boolean conflict, boolean hook, boolean context) throws Exception {
        var templates = JSON.readTree(VerificationFixtures.moduleRoot()
                .resolve("../core/src/managed-runtime/contracts/managed-model-statistics-v1.fixtures.json").toFile()).path("valid");
        List<Row> transactions = new ArrayList<>();
        Map<String, Row> resources = new LinkedHashMap<>();
        List<Row> references = new ArrayList<>();
        for (int sequence = 1; sequence <= (context ? 2 : 3); sequence++) {
            String id = "stats-" + (sequence == 3 && !conflict ? 1 : sequence);
            String kind = hook && sequence == 2 ? ManagedModelDiagnostics.HOOK_KIND
                    : context ? ManagedModelDiagnostics.MAIN_KIND : ManagedModelDiagnostics.STATS_KIND;
            ObjectNode body = templates.get(ManagedModelDiagnostics.HOOK_KIND.equals(kind) ? 1
                    : ManagedModelDiagnostics.MAIN_KIND.equals(kind) ? 0 : 2).path("body").deepCopy();
            body.withObject("/statistics").put("snapshotRevision", sequence == 2 ? 2 : 1);
            if (sequence == 3 && conflict) {
                body.withObject("/statistics").put("observedAt", 9);
            }
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            Map<String, byte[]> resource = values("ma_resource");
            put(resource, "resource_id", id, "resource_key", resourceKey(id), "kind", kind,
                    "schema_version", "1", "byte_length", Integer.toString(bytes.length), "sha256", DigestUtils.sha256Hex(bytes),
                    "storage_kind", "MYSQL_INLINE", "state", "REFERENCED");
            resource.put("inline_bytes", bytes);
            resources.putIfAbsent(id, row("ma_resource", resource));
            ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", sequence)
                    .put("kind", ManagedModelDiagnostics.STATS_KIND.equals(kind) ? "turn.settled" : "model.attempt")
                    .put("occurredAt", 1000 + sequence);
            event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", SESSION);
            ObjectNode payload = event.putObject("payload");
            if (!ManagedModelDiagnostics.STATS_KIND.equals(kind)) {
                payload.put("state", "output_committed");
            }
            payload.putObject("usageRef").put("resourceId", id).put("kind", kind)
                    .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", DigestUtils.sha256Hex(bytes));
            ObjectNode envelope = JSON.createObjectNode().put("subtype", "managed_session_event_v1");
            envelope.set("managedSession", event);
            byte[] records = (envelope + "\n").getBytes(StandardCharsets.UTF_8);
            Map<String, byte[]> transaction = values("ma_session_journal_tx");
            put(transaction, "journal_revision", Integer.toString(sequence), "record_encoding", "identity",
                    "record_digest", DigestUtils.sha256Hex(records), "byte_length", Integer.toString(records.length),
                    "gmt_create", Integer.toString(1000 + sequence));
            transaction.put("record_bytes", records);
            transactions.add(row("ma_session_journal_tx", transaction));
            Map<String, byte[]> reference = values("ma_resource_ref");
            put(reference, "owner_kind", "JOURNAL", "owner_key", SCOPE, "owner_revision", Integer.toString(sequence),
                    "journal_revision", Integer.toString(sequence), "resource_id", id, "resource_key", resourceKey(id));
            references.add(row("ma_resource_ref", reference));
        }
        String domain = context ? ManagedModelDiagnostics.CONTEXT_DOMAIN : ManagedModelDiagnostics.STATS_DOMAIN;
        String key = context ? ManagedExtensionProjection.recordKey(SESSION, domain, "latest") : KEY;
        String latest = context ? "1" : "2";
        Map<String, byte[]> projection = values("ma_session_record");
        put(projection, "record_kind", "DOMAIN", "record_key", key, "domain", domain,
                "record_id", "latest", "revision", latest, "record_resource_id", "stats-" + latest,
                "gmt_create", "1001", "settled_at", "100" + latest, "first_sequence", "1");
        Map<String, byte[]> reference = values("ma_resource_ref");
        put(reference, "owner_kind", "SESSION_RECORD", "owner_key", key, "owner_revision", latest, "resource_id", "stats-" + latest,
                "resource_key", resourceKey("stats-" + latest), "gmt_create", "100" + latest);
        references.add(row("ma_resource_ref", reference));
        return new Fixture(transactions, List.of(row("ma_session_record", projection)), List.copyOf(resources.values()), references);
    }

    private static Map<String, byte[]> values(String table) {
        Map<String, byte[]> values = WorkspaceCsiApplicationInventory.nullRowValues(table);
        put(values, "tenant_id", "tenant", "workspace_id", "workspace", "session_id", SESSION);
        if (values.containsKey("session_scope_key")) {
            put(values, "session_scope_key", SCOPE);
        }
        return values;
    }

    private static void put(Map<String, byte[]> values, String... pairs) {
        for (int index = 0; index < pairs.length; index += 2) {
            values.put(pairs[index], pairs[index + 1].getBytes(StandardCharsets.UTF_8));
        }
    }

    private static Row row(String table, Map<String, byte[]> values) {
        return WorkspaceCsiApplicationInventory.expectedRow(table, values, Membership.ORIGINAL);
    }

    private static String resourceKey(String id) {
        return com.alibaba.qwen.code.managedagent.repository.ManagedSessionStore.resourceKey(SCOPE, id);
    }
}

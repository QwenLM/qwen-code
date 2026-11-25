package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRef;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedIdentityRefs;
import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract.require;

/**
 * The per-stream seal manifest and the capture resource rows it points at, split
 * out of the publication catalog along the seal seam. The manifest is the only
 * record of which streams are sealed and to what digest, so it is rebuilt and
 * re-hashed in full on every seal, and every row it names is written through the
 * same resource insert the terminal and admission lanes use.
 */
final class ToolPublicationSealManifest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;

    ToolPublicationSealManifest(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    List<Map<String, Object>> sealRows(String scope, String publicationId, String streamId) {
        var pointers = jdbc.query("SELECT seal_manifest_resource_ref, seal_manifest_sha256 FROM ma_output_capture"
                        + " WHERE scope_ref = ? AND publication_id = ?",
                (row, index) -> new String[] {
                        ManagedSchemaRows.identity(row, "seal_manifest_resource_ref"), row.getString(2)},
                scope, publicationId);
        require(pointers.size() == 1, "Seal capture is missing");
        String resourceRef = pointers.getFirst()[0];
        if (resourceRef == null) {
            return List.of();
        }
        List<String> resourceIdentity =
                ManagedIdentityRef.decode(resourceRef.getBytes(StandardCharsets.US_ASCII));
        var resources = jdbc.query("SELECT inline_bytes, sha256, byte_length FROM ma_resource"
                        + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ?"
                        + " AND scope_ref = ? AND publication_id = ?"
                        + " AND kind = X'6d616e616765642d746f6f6c2d7365616c2d6d616e6966657374' AND capture_state = 'VERIFIED'",
                (row, index) -> new Object[] {row.getBytes(1), row.getString(2), row.getLong(3)},
                resourceIdentity.get(0), resourceIdentity.get(1), resourceIdentity.get(2),
                scope, publicationId);
        require(resources.size() == 1, "Seal manifest is missing");
        Object[] resource = resources.getFirst();
        byte[] bytes = (byte[]) resource[0];
        require(bytes != null && bytes.length == (Long) resource[2]
                        && ToolPublicationContract.sha256(bytes).equals(resource[1])
                        && resource[1].equals(pointers.getFirst()[1]), "Seal manifest changed");
        JsonNode manifest = ToolPublicationContract.readJson(bytes);
        require(manifest.path("schemaVersion").asInt(-1) == 1 && manifest.path("seals").isArray()
                && manifest.path("seals").size() <= 2, "Seal manifest is invalid");
        var result = new ArrayList<Map<String, Object>>();
        var seen = new HashSet<String>();
        for (JsonNode seal : manifest.path("seals")) {
            String stream = seal.path("stream_id").asText();
            require(("stdout".equals(stream) || "stderr".equals(stream)) && seen.add(stream)
                    && scope.equals(seal.path("scope_key").asText())
                    && publicationId.equals(seal.path("publication_id").asText()), "Seal identity conflicts");
            if (streamId == null || streamId.equals(stream)) {
                Map<String, Object> row = new HashMap<>();
                for (String field : List.of("scope_key", "publication_id", "stream_id", "sha256", "operation_id")) {
                    row.put(field, seal.path(field).asText());
                }
                row.put("segment_count", seal.path("segment_count").asInt());
                row.put("byte_length", seal.path("byte_length").asLong());
                result.add(row);
            }
        }
        return result;
    }

    void persistSeal(String scope, String publicationId, String stream, int count, long length, String digest, String operationId) {
        jdbc.query("SELECT publication_id FROM ma_output_capture WHERE scope_ref = ?"
                + " AND publication_id = ? FOR UPDATE", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), scope, publicationId);
        List<Map<String, Object>> rows = new ArrayList<>(sealRows(scope, publicationId, null));
        require(rows.stream().noneMatch(row -> stream.equals(row.get("stream_id"))), "Stream was already sealed");
        Map<String, Object> seal = new TreeMap<>();
        seal.put("scope_key", scope);
        seal.put("publication_id", publicationId);
        seal.put("stream_id", stream);
        seal.put("segment_count", count);
        seal.put("byte_length", length);
        seal.put("sha256", digest);
        seal.put("operation_id", operationId);
        rows.add(seal);
        rows.sort(Comparator.comparing(row -> (String) row.get("stream_id")));
        ObjectNode manifest = JSON.createObjectNode().put("schemaVersion", 1);
        manifest.set("seals", JSON.valueToTree(rows));
        byte[] bytes = manifest.toString().getBytes(StandardCharsets.UTF_8);
        String sha = ToolPublicationContract.sha256(bytes);
        String slot = "seal-manifest:" + sha;
        String resourceId = "seal-" + sha;
        Timestamp current = now();
        insertCaptureResource(scope, publicationId, slot, resourceId, "managed-tool-seal-manifest",
                bytes.length, sha, null, operationId, current);
        var owner = jdbc.query("SELECT tenant_id, session_id FROM ma_resource WHERE scope_ref = ?"
                + " AND publication_id = ? AND slot_key = ?", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow),
                scope, publicationId, slot).getFirst();
        String tenant = (String) owner.get("tenant_id");
        String session = (String) owner.get("session_id");
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, capture_state = 'VERIFIED', last_verified_at = ?"
                + " WHERE tenant_id = ? AND session_id = ? AND resource_id = ? AND capture_state = 'CANDIDATE'",
                bytes, current, tenant, session, resourceId);
        jdbc.update("UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", seal_manifest_resource_ref = ?, seal_manifest_sha256 = ? WHERE scope_ref = ? AND publication_id = ?",
                ManagedIdentityRefs.resourceRef(tenant, session, resourceId), sha, scope, publicationId);
    }

    void insertCaptureResource(String scope, String publicationId, String slot, String resourceId, String kind, long length, String digest, String objectKey, String operationId, Timestamp createdAt) {
        var capture = jdbc.query("SELECT tenant_id, workspace_id, session_id FROM ma_output_capture"
                + " WHERE scope_ref = ? AND publication_id = ?", (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), scope, publicationId).getFirst();
        String tenant = (String) capture.get("tenant_id");
        String session = (String) capture.get("session_id");
        if (resourceId == null) {
            resourceId = "capture-segment-" + ManagedSchemaKeys.key(scope, publicationId, slot);
        }
        jdbc.update("INSERT INTO ma_resource (tenant_id, workspace_id, session_id,"
                        + " scope_ref, publication_id, slot_key, resource_id, kind, schema_version, byte_length, sha256,"
                        + " storage_kind, capture_object_key, state, capture_state, operation_id, gmt_create)"
                        + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'PUBLISHED', 'CANDIDATE', ?, ?)",
                tenant, capture.get("workspace_id"), session, scope, publicationId, slot,
                resourceId, kind == null ? "managed-tool-segment" : kind, length, digest,
                objectKey == null ? "MYSQL_INLINE" : "TOOL_PUBLICATION", objectKey, operationId, createdAt);
        jdbc.update("INSERT INTO ma_resource_ref (owner_kind, owner_ref, owner_revision,"
                        + " tenant_id, workspace_id, session_id, resource_id, gmt_create)"
                        + " VALUES ('CAPTURE', ?, 0, ?, ?, ?, ?, ?)",
                ManagedIdentityRefs.ref(ManagedIdentityRefs.OWNER_REF_BYTES, "capture", scope, publicationId),
                tenant, capture.get("workspace_id"), session, resourceId, createdAt);
    }

    private Timestamp now() {
        return jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW + "", Timestamp.class);
    }
}

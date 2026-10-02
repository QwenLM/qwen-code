package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.jdbc.core.JdbcTemplate;

/** Shares the real original-publication fixture without widening the maintenance API. */
public final class WorkspaceRecoveryReaderAssertions {
    private WorkspaceRecoveryReaderAssertions() {
    }

    public static void verifyOriginalPublication(JdbcTemplate jdbc, ToolPublicationObjectStore objects,
            JsonNode key, JsonNode admission, JsonNode manifest, long sequence, byte[] expectedSegment) {
        var before = snapshot(jdbc);
        ObjectNode source = WorkspaceRecoveryStore.JSON.createObjectNode();
        ObjectNode head = source.putObject("head");
        key.fields().forEachRemaining(field -> head.set(field.getKey(), field.getValue()));
        head.put("journalRevision", jdbc.queryForObject("SELECT journal_revision FROM qwen_managed_session_journal_head", Long.class));
        head.put("committedSequence", sequence);
        var reader = new WorkspaceRecoveryReader(jdbc, objects);
        ObjectNode request = WorkspaceRecoveryStore.JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("sequence", sequence);
        request.set("outcomeRef", admission);
        request.set("manifestRef", manifest);
        JsonNode receipt = reader.publicationReceipt(source, request);
        assertThat(receipt.path("publicationId").asText()).isEqualTo("pub-1");
        JsonNode manifestBody = WorkspaceRecoveryStore.parse(Base64.getDecoder().decode(
                reader.resource(source, manifest).path("bytesBase64").asText()));
        JsonNode contentRef = manifestBody.path("contents").get(0).path("body").path("ref");
        assertThat(receipt.path("seals")).hasSize(contentRef.isObject() ? 1 : 2);
        if (contentRef.isObject()) {
            assertThat(Base64.getDecoder().decode(reader.resource(source, contentRef).path("bytesBase64").asText()))
                    .isEqualTo(expectedSegment);
        }
        JsonNode object = reader.publicationObject(source, "pub-1", "segment:stdout:0");
        assertThat(Base64.getDecoder().decode(object.path("bytesBase64").asText())).isEqualTo(expectedSegment);
        assertThat(reader.resource(source, manifest).path("ref")).isEqualTo(manifest);
        assertThatThrownBy(() -> reader.publicationReceipt(source, request.deepCopy().put("sequence", sequence + 1)))
                .hasMessageContaining("publication_receipt_conflict");
        jdbc.update("UPDATE qwen_tool_execution SET request_digest = 'changed'");
        assertThatThrownBy(() -> reader.publicationReceipt(source, request)).hasMessageContaining("publication_owner_conflict");
        jdbc.update("UPDATE qwen_tool_execution SET request_digest = ?", receipt.path("binding").path("requestDigest").asText());
        byte[] terminal = jdbc.queryForObject("SELECT inline_bytes FROM qwen_tool_publication_object WHERE slot_key = 'terminal'", byte[].class);
        jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ? WHERE slot_key = 'terminal'", new byte[]{1});
        assertThatThrownBy(() -> reader.publicationObject(source, "pub-1", "terminal")).hasMessageContaining("resource_corrupt");
        jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ? WHERE slot_key = 'terminal'", terminal);
        assertThat(snapshot(jdbc)).usingRecursiveComparison().isEqualTo(before);
    }

    private static Map<String, Object> snapshot(JdbcTemplate jdbc) {
        Map<String, Object> result = new LinkedHashMap<>();
        for (String table : List.of("qwen_managed_session_journal_head", "qwen_managed_session_resource",
                "qwen_tool_publication", "qwen_tool_publication_object", "qwen_tool_publication_seal",
                "qwen_tool_execution", "qwen_runtime_binding")) result.put(table, jdbc.queryForList("SELECT * FROM " + table));
        return result;
    }
}

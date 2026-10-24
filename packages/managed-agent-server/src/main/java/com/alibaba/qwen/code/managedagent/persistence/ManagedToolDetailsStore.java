package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellShellResult;
import com.alibaba.qwen.code.managedagent.model.ApiModels.WebShellToolDetails;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

@Repository
public class ManagedToolDetailsStore {
    private static final int READ_LIMIT = 8 * 1024 * 1024;
    private final JdbcTemplate jdbc;
    private final ManagedExtensionRecordStore resources;
    private final ObjectMapper json;

    public ManagedToolDetailsStore(JdbcTemplate jdbc,
            ManagedExtensionRecordStore resources, ObjectMapper json) {
        this.jdbc = jdbc;
        this.resources = resources;
        this.json = json;
    }

    public WebShellToolDetails read(String tenant, String workspace,
            String session, String itemId) {
        var items = jdbc.query("SELECT t.prompt_id, m.attributes_json FROM ma_message m"
                        + " JOIN ma_turn t ON t.tenant_id = m.tenant_id AND t.session_id = m.session_id"
                        + " AND t.turn_id = m.turn_id WHERE m.tenant_id = ? AND m.session_id = ?"
                        + " AND m.item_id = ? AND m.item_type = 'tool_call'",
                (row, index) -> new String[] {row.getString(1), row.getString(2)}, tenant, session, itemId);
        if (items.size() != 1) {
            throw unavailable();
        }
        String prompt = items.getFirst()[0];
        JsonNode attributes = parse(items.getFirst()[1].getBytes(StandardCharsets.UTF_8));
        String name = attributes.path("name").asText(attributes.path("toolName").asText());
        if (!List.of("read_file", "run_shell_command").contains(name)) {
            throw unavailable();
        }
        String callId = attributes.path("toolCallId").asText(attributes.path("callId").asText());
        if (callId.isEmpty()) {
            throw unavailable();
        }
        JsonNode input = null;
        String output = null;
        boolean truncated = false;
        WebShellShellResult shellResult = null;
        long before = beforeRevision(tenant, workspace, session, itemId, attributes);
        int remaining = READ_LIMIT;
        for (int page = 0; page < 512; page++) {
            List<Journal> rows = jdbc.query("SELECT journal_revision, record_digest,"
                            + " CASE WHEN OCTET_LENGTH(record_bytes) <= ? THEN record_bytes END AS record_bytes"
                            + " FROM ma_session_journal_tx"
                            + " WHERE tenant_id = ? AND workspace_id = ? AND session_id = ?"
                            + " AND journal_revision < ? ORDER BY journal_revision DESC LIMIT 1",
                    (row, index) -> new Journal(row.getLong(1), row.getString(2), row.getBytes(3)),
                    remaining, tenant, workspace, session, before);
            if (rows.isEmpty()) {
                break;
            }
            for (Journal row : rows) {
                if (row.bytes() == null) {
                    throw limit();
                }
                if (!DigestUtils.sha256Hex(row.bytes()).equals(row.digest())) {
                    throw new IllegalStateException("Stored tool journal is corrupt");
                }
                remaining -= row.bytes().length;
                if (remaining < 0) {
                    throw limit();
                }
                before = row.revision();
                for (String line : new String(row.bytes(), StandardCharsets.UTF_8).split("\n")) {
                    JsonNode event = parse(line.getBytes(StandardCharsets.UTF_8)).path("managedSession");
                    JsonNode key = event.path("sessionKey");
                    JsonNode payload = event.path("payload");
                    if (!"message.committed".equals(event.path("kind").asText())
                            || !tenant.equals(key.path("tenantId").asText())
                            || !workspace.equals(key.path("workspaceId").asText())
                            || !session.equals(key.path("sessionId").asText())
                            || !List.of("assistant", "tool_result").contains(payload.path("role").asText())) {
                        continue;
                    }
                    Message message = message(tenant, session, payload.path("contentRef"), remaining);
                    remaining -= message.readBytes();
                    JsonNode record = parse(message.bytes());
                    if (!prompt.equals(record.path("daemonPromptId").asText())
                            || !payload.path("messageId").asText().equals(record.path("uuid").asText())) {
                        continue;
                    }
                    for (JsonNode part : record.path("message").path("parts")) {
                        JsonNode call = part.path("functionCall");
                        if (input == null && callId.equals(call.path("id").asText())
                                && name.equals(call.path("name").asText()) && call.path("args").isObject()) {
                            input = input(name, call.path("args"));
                        }
                        JsonNode response = part.path("functionResponse");
                        if (output == null && callId.equals(response.path("id").asText())
                                && name.equals(response.path("name").asText())) {
                            JsonNode value = response.path("response");
                            JsonNode result = record.path("toolCallResult");
                            if ("run_shell_command".equals(name) && callId.equals(result.path("callId").asText())) {
                                shellResult = shellResult(result.path("resultDisplay"));
                            }
                            String text = text(value);
                            if (text == null && shellResult != null) {
                                text = result.path("resultDisplay").path("text").textValue();
                                truncated = result.path("resultDisplay").path("truncated").booleanValue();
                            }
                            if (text != null) {
                                output = ManagedToolResultProjector.boundPreview(text);
                                truncated = truncated || !output.equals(text) || value.path("previewTruncated").asBoolean()
                                        || value.path("capture").path("previewTruncated").asBoolean();
                            }
                        }
                    }
                    if (input != null && output != null) {
                        return new WebShellToolDetails(input, output, truncated, shellResult);
                    }
                }
            }
        }
        if (input == null && output == null) {
            throw unavailable();
        }
        return new WebShellToolDetails(input, output, truncated, shellResult);
    }

    private WebShellShellResult shellResult(JsonNode display) {
        if (!"shell_result".equals(display.path("type").asText())
                || !display.path("version").isIntegralNumber() || !display.path("version").canConvertToInt()
                || display.path("version").intValue() != 1
                || !display.path("truncated").isBoolean()
                || !List.of("completed", "failed", "cancelled", "timed_out").contains(display.path("outcome").asText())) {
            return null;
        }
        for (String field : List.of("text", "output", "directory")) {
            if (!display.path(field).isTextual()) {
                return null;
            }
        }
        JsonNode error = display.path("error");
        if (!error.isNull() && !error.isTextual()) {
            return null;
        }
        for (String field : List.of("exitCode", "signal", "pid")) {
            JsonNode value = display.path(field);
            if (!value.isNull() && (!value.isIntegralNumber() || !value.canConvertToLong()
                    || value.longValue() < -9007199254740991L || value.longValue() > 9007199254740991L)) {
                return null;
            }
        }
        List<String> notices = shellStrings(display.path("notices"));
        List<String> files = shellStrings(display.path("outputFiles"));
        if (notices == null || files == null) {
            return null;
        }
        String directory = display.path("directory").textValue();
        int pathBytes = directory.getBytes(StandardCharsets.UTF_8).length;
        for (String file : files) {
            pathBytes += file.getBytes(StandardCharsets.UTF_8).length;
        }
        if (pathBytes > 8192) {
            return null;
        }
        int count = 2 + notices.size() + (error.isNull() ? 0 : 1);
        int bytes = 8192 / count;
        int lines = 200 / count;
        String text = ManagedToolResultProjector.boundPreview(display.path("text").textValue(), bytes, lines);
        String output = ManagedToolResultProjector.boundPreview(display.path("output").textValue(), bytes, lines);
        String boundedError = error.isNull() ? null : ManagedToolResultProjector.boundPreview(error.textValue(), bytes, lines);
        List<String> boundedNotices = notices.stream().map(value -> ManagedToolResultProjector.boundPreview(value, bytes, lines)).toList();
        boolean truncated = display.path("truncated").booleanValue() || !text.equals(display.path("text").textValue())
                || !output.equals(display.path("output").textValue())
                || !error.isNull() && !boundedError.equals(error.textValue()) || !notices.equals(boundedNotices);
        return new WebShellShellResult("shell_result", 1, text, output, directory,
                display.path("exitCode").isNull() ? null : display.path("exitCode").longValue(),
                display.path("signal").isNull() ? null : display.path("signal").longValue(),
                display.path("pid").isNull() ? null : display.path("pid").longValue(),
                boundedError, display.path("outcome").textValue(), boundedNotices, truncated, files);
    }

    private List<String> shellStrings(JsonNode values) {
        if (!values.isArray() || values.size() > 32) {
            return null;
        }
        List<String> strings = new ArrayList<>();
        for (JsonNode value : values) {
            if (!value.isTextual()) {
                return null;
            }
            strings.add(value.textValue());
        }
        return strings;
    }

    private JsonNode input(String name, JsonNode args) {
        var input = json.createObjectNode();
        var keys = "read_file".equals(name) ? List.of("file_path", "path")
                : List.of("command", "directory", "timeout");
        for (String key : keys) {
            JsonNode value = args.path(key);
            boolean numeric = "timeout".equals(key);
            if (numeric ? value.isNumber() && Double.isFinite(value.doubleValue()) : value.isTextual()) {
                input.set(key, value);
            }
        }
        return input.toString().getBytes(StandardCharsets.UTF_8).length <= 4096 ? input : json.nullNode();
    }

    private static String text(JsonNode response) {
        JsonNode output = response.path("output");
        JsonNode error = response.path("error");
        if (!output.isTextual()) {
            return error.isTextual() ? error.textValue() : null;
        }
        if (!error.isTextual() || error.textValue().isEmpty()) {
            return output.textValue();
        }
        return output.textValue().isEmpty() ? error.textValue() : output.textValue() + "\n\n" + error.textValue();
    }

    private long beforeRevision(String tenant, String workspace, String session,
            String itemId, JsonNode attributes) {
        long sequence = attributes.path("sourceSequence").asLong(0);
        var keys = jdbc.query("SELECT source_key FROM ma_public_event WHERE tenant_id = ?"
                        + " AND session_id = ? AND item_id = ? AND event_type = 'item.tool_call.updated'"
                        + " AND source_key IS NOT NULL ORDER BY sequence_id DESC LIMIT 1",
                (row, index) -> row.getString(1), tenant, session, itemId);
        if (!keys.isEmpty()) {
            String key = keys.getFirst();
            try {
                sequence = Math.max(sequence, Long.parseLong(key.substring(key.lastIndexOf(':') + 1)));
            } catch (NumberFormatException error) {
                throw unavailable();
            }
        }
        if (sequence == 0) {
            return Long.MAX_VALUE;
        }
        var revisions = jdbc.query("SELECT journal_revision FROM ma_session_journal_tx WHERE tenant_id = ?"
                        + " AND workspace_id = ? AND session_id = ? AND first_sequence <= ? AND last_sequence >= ?",
                (row, index) -> row.getLong(1), tenant, workspace, session, sequence, sequence);
        if (revisions.size() != 1) {
            throw unavailable();
        }
        return Math.addExact(revisions.getFirst(), 1);
    }

    private Message message(String tenant, String session, JsonNode ref, int remaining) {
        String kind = ref.path("kind").asText();
        if (!List.of("managed-message", "managed-message-chunks").contains(kind)) {
            throw unavailable();
        }
        if (ref.path("byteLength").asLong() > remaining) {
            throw limit();
        }
        byte[] bytes = resources.readCommittedResource(tenant, session, ref).bytes();
        if ("managed-message".equals(kind)) {
            return new Message(bytes, bytes.length);
        }
        remaining -= bytes.length;
        ByteArrayOutputStream joined = new ByteArrayOutputStream();
        for (JsonNode part : parse(bytes).path("parts")) {
            if (!"managed-message-part".equals(part.path("kind").asText())) {
                throw unavailable();
            }
            if (part.path("byteLength").asLong() > remaining - joined.size()) {
                throw limit();
            }
            joined.writeBytes(resources.readCommittedResource(tenant, session, part).bytes());
        }
        return new Message(joined.toByteArray(), bytes.length + joined.size());
    }

    private JsonNode parse(byte[] bytes) {
        try {
            return json.readTree(bytes);
        } catch (java.io.IOException error) {
            throw new IllegalStateException("Stored tool details are invalid", error);
        }
    }

    private record Journal(long revision, String digest, byte[] bytes) { }

    private record Message(byte[] bytes, int readBytes) { }

    private static ManagedAgentException limit() {
        return new ManagedAgentException(HttpStatus.PAYLOAD_TOO_LARGE, "tool_details_limit",
                "Tool details exceed the bounded history read limit.");
    }

    private static ManagedAgentException unavailable() {
        return new ManagedAgentException(HttpStatus.NOT_FOUND, "tool_details_not_found", "Tool details are unavailable.");
    }
}

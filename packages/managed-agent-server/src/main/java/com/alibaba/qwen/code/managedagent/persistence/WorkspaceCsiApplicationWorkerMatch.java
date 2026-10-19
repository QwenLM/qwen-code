package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.transport.CsiFileFinalizeProtocol;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationJson.closed;
import static com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiApplicationJson.require;

final class WorkspaceCsiApplicationWorkerMatch {
    private WorkspaceCsiApplicationWorkerMatch() {
    }

    static void verify(WorkspaceCsiApplicationInventory.Snapshot inventory,
            CsiNativeActivationProof.TerminalProof terminal, byte[] raw, Map<String, Object> request) {
        require(inventory.blockers().isEmpty());
        CsiFileFinalizeProtocol.response(raw, request);
        JsonNode observation = WorkspaceCsiApplicationJson.object(raw, WorkspaceCsiApplicationInventory.MAX_BYTES);
        var prefix = terminal.predecessorPrefix();
        require(prefix.fileHistory() != null);
        JsonNode execution = observation.path("execution");
        closed(execution, Set.of("state", "workState", "pendingStarts", "pendingInvocations", "blockers",
                "entries", "histories", "historyControls", "secondary"));
        require("DRAINING".equals(text(execution, "state")) && "QUIESCENT".equals(text(execution, "workState"))
                && number(execution.get("pendingStarts")) == 0 && number(execution.get("pendingInvocations")) == 0);
        for (String field : List.of("blockers", "histories", "historyControls")) {
            empty(execution.path(field));
        }
        JsonNode secondary = execution.path("secondary");
        closed(secondary, Set.of("captureConfigured", "mcpConfigured", "hooksConfigured", "supervisorConfigured",
                "ledgerConfigured", "providerUsed", "providerSessions", "closedSessions", "mcpCalls",
                "backgroundActivity", "monitorActivity"));
        for (String field : List.of("captureConfigured", "mcpConfigured", "hooksConfigured", "supervisorConfigured",
                "ledgerConfigured", "providerUsed", "backgroundActivity", "monitorActivity")) {
            require(secondary.path(field).isBoolean() && !secondary.path(field).booleanValue());
        }
        empty(secondary.path("providerSessions"));
        empty(secondary.path("closedSessions"));
        require(number(secondary.get("mcpCalls")) == 0);
        Map<String, WorkspaceCsiApplicationInventory.Row> expected = new HashMap<>();
        Set<String> executionCalls = new HashSet<>();
        for (var row : inventory.table("ma_tool_execution").rows()) {
            if (row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL) {
                JsonNode nativeRef = object(row.text("reference_json"));
                String nativeCall = text(nativeRef, "callId");
                require(nativeCall.equals(row.text("tool_call_id"))
                        && executionCalls.add(row.text("execution_call_id"))
                        && expected.put(nativeCall, row) == null);
            }
        }
        require(executionCalls.equals(prefix.receipts().keySet()));
        Set<String> entries = new HashSet<>();
        require(execution.path("entries").isArray());
        for (JsonNode entry : execution.path("entries")) {
            closed(entry, Set.of("version", "reference", "toolName", "input", "inputJson", "state", "lastSequence",
                    "result", "v3Result", "v3Capture", "acknowledgement", "aborted"));
            require(number(entry.get("version")) == 2 && "settled".equals(text(entry, "state"))
                    && entry.path("aborted").isBoolean() && !entry.path("aborted").booleanValue()
                    && entry.path("v3Result").isNull() && entry.path("v3Capture").isNull()
                    && entry.path("acknowledgement").isNull());
            number(entry.get("lastSequence"));
            JsonNode reference = entry.path("reference");
            closed(reference, Set.of("sessionId", "promptId", "callId", "argsDigest"));
            String call = text(reference, "callId");
            require(entries.add(call) && expected.containsKey(call));
            var row = expected.get(call);
            JsonNode nativeRef = object(row.text("reference_json"));
            for (String field : List.of("sessionId", "promptId", "callId", "argsDigest")) {
                require(reference.path(field).equals(nativeRef.path(field)));
            }
            JsonNode wrapper = resource(inventory, nativeRef.path("inputRef"));
            closed(wrapper, Set.of("harnessSessionId", "runtimeSessionId", "payloadJson"));
            require(wrapper.path("harnessSessionId").equals(reference.path("sessionId"))
                    && wrapper.path("runtimeSessionId").equals(reference.path("sessionId")));
            String payloadJson = text(wrapper, "payloadJson");
            require(("sha256:" + CsiNativeActivationProof.sha256(payloadJson.getBytes(StandardCharsets.UTF_8)))
                    .equals(text(reference, "argsDigest")));
            JsonNode payload = object(payloadJson);
            closed(payload, Set.of("toolName", "input"));
            require(Set.of("read_file", "write_file", "edit").contains(text(payload, "toolName"))
                    && payload.path("toolName").equals(entry.path("toolName"))
                    && payload.path("input").isObject() && payload.path("input").equals(entry.path("input"))
                    && object(text(entry, "inputJson")).equals(payload.path("input")));
            JsonNode result = object(row.text("result_json"));
            require(result.equals(entry.path("result"))
                    && result.equals(prefix.receipts().get(row.text("execution_call_id")).body().path("envelope")));
        }
        require(entries.equals(expected.keySet()));
        Map<String, CsiNativeActivationProof.FrozenBatch> expectedPreparations = new HashMap<>();
        for (var batch : prefix.fileHistory().batches().values()) {
            if (batch.preparedRef() != null) {
                require(expectedPreparations.put(text(batch.intentRef(), "resourceId"), batch) == null);
            }
        }
        Set<String> preparations = new HashSet<>();
        require(observation.path("preparations").isArray());
        for (JsonNode preparation : observation.path("preparations")) {
            closed(preparation, Set.of("resourceId", "reference", "observation"));
            String id = text(preparation, "resourceId");
            require(preparations.add(id) && expectedPreparations.containsKey(id));
            var batch = expectedPreparations.get(id);
            require(batch.intentRef().equals(preparation.path("reference")));
            resource(inventory, batch.intentRef());
            JsonNode prepared = resource(inventory, batch.preparedRef());
            JsonNode actual = preparation.path("observation");
            closed(actual, Set.of("state", "backupDirectory", "retainedBackups"));
            for (String field : List.of("state", "backupDirectory", "retainedBackups")) {
                require(actual.path(field).equals(prepared.path(field)));
            }
        }
        require(preparations.equals(expectedPreparations.keySet()));
        verifyFiles(observation.path("files"), prefix.fileHistory().body(), request);
    }

    private static void verifyFiles(JsonNode files, JsonNode history, Map<String, Object> request) {
        closed(files, Set.of("history", "backend", "mount"));
        require(files.path("history").equals(history.path("state")));
        JsonNode backend = files.path("backend");
        closed(backend, Set.of("retained", "directories", "backups", "files"));
        JsonNode retained = backend.path("retained");
        closed(retained, Set.of("backupDirectory", "retainedBackups"));
        require(retained.path("backupDirectory").equals(history.path("backupDirectory"))
                && retained.path("retainedBackups").equals(history.path("retainedBackups")));
        JsonNode mount = files.path("mount");
        closed(mount, Set.of("admissionClosed", "pendingOperations", "closeFailed", "root"));
        require(mount.path("admissionClosed").isBoolean() && !mount.path("admissionClosed").booleanValue()
                && number(mount.get("pendingOperations")) == 0 && mount.path("closeFailed").isBoolean()
                && !mount.path("closeFailed").booleanValue());
        JsonNode root = mount.path("root");
        closed(root, Set.of("admissionClosed", "pendingOperations", "fd", "device", "inode"));
        JsonNode originalMount = object(WorkspaceCsiApplicationJson.encode(request.get("mount")));
        require(root.path("admissionClosed").isBoolean() && !root.path("admissionClosed").booleanValue()
                && number(root.get("pendingOperations")) == 0
                && root.path("device").equals(originalMount.path("rootDevice"))
                && root.path("inode").equals(originalMount.path("rootInode")));
        Set<Long> fds = new HashSet<>();
        require(fds.add(number(root.get("fd"))));
        JsonNode directory = retained.path("backupDirectory");
        require(directory.path("volumeDevice").equals(root.path("device")) && directory.path("volumeInode").equals(root.path("inode")));
        Map<String, JsonNode> directories = indexed(backend.path("directories"), "name");
        require(directories.keySet().equals(Set.of("prefix", "owner")));
        for (var entry : directories.values()) {
            descriptor(entry, fds, root.path("device"));
        }
        require(directories.get("owner").path("device").equals(directory.path("directoryDevice"))
                && directories.get("owner").path("inode").equals(directory.path("directoryInode")));
        Map<String, JsonNode> backups = indexed(backend.path("backups"), "name");
        Map<String, JsonNode> pins = indexed(retained.path("retainedBackups"), "name");
        require(backups.keySet().equals(pins.keySet()));
        for (var entry : backups.entrySet()) {
            descriptor(entry.getValue(), fds, root.path("device"));
            require(entry.getValue().path("device").equals(pins.get(entry.getKey()).path("device"))
                    && entry.getValue().path("inode").equals(pins.get(entry.getKey()).path("inode")));
        }
        Map<String, JsonNode> working = indexed(backend.path("files"), "path");
        Set<String> paths = new HashSet<>();
        history.path("state").path("files").fieldNames().forEachRemaining(paths::add);
        require(working.keySet().equals(paths));
        for (var entry : working.entrySet()) {
            closed(entry.getValue(), Set.of("path", "pin"));
            JsonNode pin = entry.getValue().path("pin");
            JsonNode fingerprint = history.path("state").path("files").path(entry.getKey());
            if (fingerprint.isNull()) {
                require(pin.isNull());
            } else {
                closed(pin, Set.of("path", "device", "inode", "byteLength", "digest", "mode"));
                require(entry.getKey().equals(text(pin, "path")) && pin.path("device").equals(root.path("device"))
                        && pin.path("digest").equals(fingerprint.path("digest")) && pin.path("mode").equals(fingerprint.path("mode")));
                decimal(pin.get("inode"));
                number(pin.get("byteLength"));
            }
        }
    }

    private static void descriptor(JsonNode value, Set<Long> fds, JsonNode device) {
        closed(value, Set.of("name", "fd", "device", "inode"));
        require(value.path("device").equals(device) && fds.add(number(value.get("fd"))));
        decimal(value.get("inode"));
    }

    private static Map<String, JsonNode> indexed(JsonNode values, String key) {
        require(values.isArray() && values.size() <= WorkspaceCsiApplicationInventory.MAX_ROWS);
        Map<String, JsonNode> result = new HashMap<>();
        for (JsonNode value : values) {
            require(result.put(text(value, key), value) == null);
        }
        return result;
    }

    private static JsonNode resource(WorkspaceCsiApplicationInventory.Snapshot inventory, JsonNode ref) {
        closed(ref, Set.of("resourceId", "kind", "schemaVersion", "byteLength", "digest"));
        var rows = inventory.table("ma_resource").rows().stream()
                .filter(row -> row.membership() == WorkspaceCsiApplicationInventory.Membership.ORIGINAL
                        && text(ref, "resourceId").equals(row.text("resource_id"))).toList();
        require(rows.size() == 1);
        var row = rows.getFirst();
        byte[] bytes = row.binary("inline_bytes");
        require(text(ref, "kind").equals(row.text("kind")) && number(ref.get("schemaVersion")) == row.number("schema_version")
                && number(ref.get("byteLength")) == row.number("byte_length") && bytes != null
                && bytes.length == number(ref.get("byteLength")) && CsiNativeActivationProof.sha256(bytes).equals(text(ref, "digest")));
        return object(bytes);
    }

    private static JsonNode object(String value) { return object(value.getBytes(StandardCharsets.UTF_8)); }
    private static JsonNode object(byte[] bytes) { return WorkspaceCsiApplicationJson.object(bytes, WorkspaceCsiApplicationInventory.MAX_BYTES); }
    private static String text(JsonNode value, String field) {
        require(value.path(field).isTextual() && !value.path(field).textValue().isEmpty());
        return value.path(field).textValue();
    }
    private static long number(JsonNode value) {
        require(value != null && value.isIntegralNumber() && value.canConvertToLong()
                && value.longValue() >= 0 && value.longValue() <= 9_007_199_254_740_991L);
        return value.longValue();
    }
    private static void decimal(JsonNode value) {
        require(value != null && value.isTextual() && value.textValue().matches("0|[1-9][0-9]{0,19}")
                && new java.math.BigInteger(value.textValue()).bitLength() <= 64);
    }
    private static void empty(JsonNode value) { require(value.isArray() && value.isEmpty()); }
}

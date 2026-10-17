package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Component
public class WorkspaceProfileLifecycleVerifier {
    private static final ObjectMapper JSON = new ObjectMapper();
    private final JdbcTemplate jdbc;
    private final ManagedExtensionRecordStore records;
    private final org.springframework.beans.factory.ObjectProvider<ToolPublicationDataStore> publications;
    private final org.springframework.beans.factory.ObjectProvider<ManagedToolResultStore> results;

    public WorkspaceProfileLifecycleVerifier(JdbcTemplate jdbc, org.springframework.beans.factory.ObjectProvider<ToolPublicationDataStore> publications,
            org.springframework.beans.factory.ObjectProvider<ManagedToolResultStore> results) {
        this.jdbc = jdbc;
        this.records = new ManagedExtensionRecordStore(jdbc);
        this.publications = publications;
        this.results = results;
    }

    void verifyExecutions(OperationRecord operation) {
        for (ToolExecutionRecord execution : executions(operation)) {
            if (!hold(execution) && !execution.isSettled()) {
                throw WorkspaceLifecycleStore.blocked("workspace_close_execution_unsettled");
            }
        }
    }

    void verifyEffects(OperationRecord operation) {
        verifyExecutions(operation);
        for (String domain : List.of("mcp_configuration", "mcp_operation")) {
            for (JsonNode record : records.listRecords(operation.tenantId(), operation.sessionId(), domain)) {
                known(record);
                for (String field : List.of("catalogRef", "argsRef", "resultRef")) {
                    JsonNode ref = record.path(field);
                    if (!ref.isNull() && !ref.isMissingNode()) {
                        records.readRecordResource(operation.tenantId(), operation.sessionId(), ref);
                    }
                }
            }
        }
    }

    void verifyPublications(OperationRecord operation) {
        var backgroundCalls = backgroundCalls(operation);
        for (ToolExecutionRecord execution : executions(operation)) {
            if (execution.getReference().get("publicationId") == null) {
                continue;
            }
            if (notStarted(execution)) {
                verifyNotStartedPublication(operation, execution);
            } else if (execution.getDispatchGeneration() > 0
                    && !backgroundCalls.contains(execution.getExecutionCallId())) {
                if (publications.getIfAvailable() == null
                        || publications.getIfAvailable().verifyReceiptForLifecycle(execution) == null) {
                    unsettled();
                }
            }
        }
    }

    void verifyResources(OperationRecord operation, List<RuntimeBindingRecord> bindings, String profile) {
        verifyEffects(operation);
        if (WorkspaceToolProfiles.MCP.equals(profile)) {
            Map<String, RuntimeBindingRecord> originals = bindings.stream().collect(Collectors.toMap(
                    RuntimeBindingRecord::getBindingId, Function.identity()));
            for (JsonNode configuration : records.listRecords(operation.tenantId(), operation.sessionId(), "mcp_configuration")) {
                JsonNode runtime = configuration.path("run").path("runtime");
                if ("not_started_proven".equals(configuration.path("run").path("execution").asText()) && runtime.isNull()) {
                    continue;
                }
                RuntimeBindingRecord binding = originals.get(runtime.path("runtimeBindingId").asText());
                long generation;
                try {
                    generation = Long.parseLong(runtime.path("generation").asText());
                } catch (NumberFormatException invalid) {
                    throw WorkspaceLifecycleStore.blocked("workspace_close_identity_unverified");
                }
                if (binding == null || generation < 1 || generation > binding.getGeneration()) {
                    unsettled();
                }
                if (!"released".equals(configuration.path("releaseState").asText())
                        && (generation != binding.getGeneration() || binding.getDrainReceipt() == null || !binding.getDrainReceipt().matches(binding))) {
                    unsettled();
                }
                var owners = jdbc.queryForList("SELECT binding_id, runtime_generation, session_state FROM ma_runtime_session"
                        + " WHERE tenant_id = ? AND harness_session_id = ? AND runtime_session_id = ? FOR UPDATE",
                        operation.tenantId(), operation.sessionId(), configuration.path("runtimeSessionId").asText());
                if (owners.size() != 1 || !binding.getBindingId().equals(owners.getFirst().get("binding_id"))
                        || ((Number) owners.getFirst().get("runtime_generation")).longValue() != generation
                        || !"RELEASED".equals(owners.getFirst().get("session_state"))) {
                    unsettled();
                }
            }
            return;
        }
        if (!WorkspaceToolProfiles.SHELL.equals(profile)) {
            unsettled();
        }
        Map<String, ToolExecutionRecord> executions = executions(operation).stream()
                .collect(Collectors.toMap(ToolExecutionRecord::getExecutionCallId, Function.identity()));
        var backgroundCalls = backgroundCalls(operation);
        var sourcesByCall = jdbc.queryForList("SELECT request_json FROM ma_operation"
                + " WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND session_scope_key = ? AND tenant_id = ? AND session_id = ? FOR UPDATE", String.class,
                ManagedSessionStore.sessionScopeKey(operation.tenantId(), operation.sessionId()), operation.tenantId(), operation.sessionId()).stream().map(this::source)
                .collect(Collectors.groupingBy(ManagedToolResultStore.Source::executionCallId));
        var fileInputs = nativeFileInputs(operation);
        for (ToolExecutionRecord execution : executions.values()) {
            if (!execution.isSettled()) {
                unsettled();
            }
            if (hold(execution) || backgroundCalls.contains(execution.getExecutionCallId())) {
                continue;
            }
            var sources = sourcesByCall.getOrDefault(execution.getExecutionCallId(), List.of());
            if (sources.isEmpty() && "deferred".equals(execution.getReference().get("dispatchMode"))
                    && execution.getReference().get("runtimeProtocol") == null
                    && execution.getReference().get("publicationId") == null
                    && fileInputs.contains(execution.getRuntimeSessionId() + ":" + execution.getRequestDigest())) {
                continue;
            }
            if (sources.size() != 1) {
                unsettled();
            }
            var source = sources.getFirst();
            if (results.getIfAvailable() == null) {
                unsettled();
            }
            results.getIfAvailable().verifySource(source);
            if (execution.getReference().get("publicationId") != null) {
                if (notStarted(execution)) {
                    verifyNotStartedPublication(operation, execution);
                } else {
                    var rows = jdbc.queryForList("SELECT producer_phase, admission_resource_id, receipt_sequence, receipt_revision,"
                            + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined FROM ma_output_capture"
                            + " WHERE tenant_id = ? AND session_id = ? AND publication_id = ? FOR UPDATE",
                            operation.tenantId(), operation.sessionId(), execution.getReference().get("publicationId"));
                    if (rows.size() != 1 || !"REFERENCED".equals(rows.getFirst().get("producer_phase"))
                            || ((Number) rows.getFirst().get("quarantined")).intValue() != 0
                            || !source.outcomeRef().path("resourceId").asText().equals(rows.getFirst().get("admission_resource_id"))
                            || source.receiptSequence() != ((Number) rows.getFirst().get("receipt_sequence")).longValue()
                            || source.journalRevision() != ((Number) rows.getFirst().get("receipt_revision")).longValue()) {
                        unsettled();
                    }
                }
            }
            if (execution.getReference().get("publicationId") == null || execution.getDispatchGeneration() == 0) {
                JsonNode outcome = JSON.nullNode();
                if (!source.outcomeRef().isNull()) {
                    try {
                        outcome = records.readRecordResource(operation.tenantId(), operation.sessionId(), source.outcomeRef());
                    } catch (com.alibaba.qwen.code.managedagent.api.ApiException invalid) {
                        unsettled();
                    }
                }
                JsonNode capture = outcome.path("envelope").path("capture");
                JsonNode ref = capture.path("manifest");
                if (!ref.isNull() && !ref.isMissingNode()) {
                    JsonNode manifest = verifyManifest(operation, ref, execution);
                    boolean complete = "complete".equals(manifest.path("captureStatus").asText());
                    if (outcome.path("version").asInt() != 1
                            || !(complete ? "committed" : "blocked").equals(outcome.path("decision").asText())
                            || !source.resultRef().equals(complete ? ref : JSON.nullNode())
                            || !source.resources().equals(JSON.createArrayNode().add(ref))
                            || !capture.path("captureStatus").equals(manifest.path("captureStatus"))
                            || !outcome.path("envelope").path("executionStatus").equals(manifest.path("executionStatus"))
                            || !execution.getExecutionStatus().equals(manifest.path("executionStatus").asText())) {
                        unsettled();
                    }
                    for (String field : List.of("tenantId", "sessionId", "turnId", "executionCallId", "callId", "invocationDigest", "bindingGeneration", "captureId", "revision")) {
                        if (!outcome.path("identity").path(field).equals(manifest.path(field))) {
                            unsettled();
                        }
                    }
                } else if (!source.resultRef().isNull() || !source.resources().isEmpty()) {
                    unsettled();
                }
            }
        }
        for (String domain : List.of("child_run", "monitor_run")) {
            for (JsonNode record : records.listRecords(operation.tenantId(), operation.sessionId(), domain)) {
                if ("child_run".equals(domain) && !"shell".equals(record.path("kind").asText())) {
                    continue;
                }
                known(record);
                JsonNode run = record.path("run");
                String call = run.path("executionCallId").asText();
                if ("not_started_proven".equals(run.path("execution").asText())) {
                    continue;
                }
                ToolExecutionRecord start = executions.get(call);
                ToolExecutionRecord process = executions.get(call + ":process");
                if (start == null || process == null || !process.isSettled() || !hold(process)
                        || !call.equals(process.getReference().get("processOf"))
                        || !start.getBindingId().equals(process.getBindingId())
                        || start.getRuntimeGeneration() != process.getRuntimeGeneration()
                        || process.getResult() == null || process.getResult().get("evidence") == null) {
                    unsettled();
                }
                JsonNode output = record.path("outputRef");
                if (output.isNull() || output.isMissingNode()) {
                    unsettled();
                }
                JsonNode pin = run.path("runtime");
                if (!start.getBindingId().equals(pin.path("runtimeBindingId").asText())
                        || !Long.toString(start.getRuntimeGeneration()).equals(pin.path("generation").asText())) {
                    unsettled();
                }
                JsonNode evidence = JSON.valueToTree(process.getResult().get("evidence"));
                JsonNode exitCode = evidence.hasNonNull("exitCode") ? evidence.get("exitCode") : JSON.nullNode();
                JsonNode exitSignal = evidence.hasNonNull("exitSignal") ? evidence.get("exitSignal") : JSON.nullNode();
                if ("child_run".equals(domain) && "exited".equals(record.path("stopReason").asText())
                        && (!record.path("exitCode").equals(exitCode) || !record.path("exitSignal").equals(exitSignal))) {
                    unsettled();
                }
                if (record.path("startReceiptRef").isNull() || record.path("startReceiptRef").isMissingNode()) {
                    unsettled();
                }
                JsonNode receipt = records.readRecordResource(operation.tenantId(), operation.sessionId(), record.path("startReceiptRef"));
                if (!call.equals(receipt.path("executionCallId").asText())
                        || !java.util.Objects.equals(start.getReference().get("callId"), receipt.path("runtimeCallId").asText())
                        || !Long.toString(start.getRuntimeGeneration()).equals(receipt.path("bindingGeneration").asText())
                        || !"exited".equals(process.getResult().get("state"))
                        || exitCode.isNull() && exitSignal.isNull()) {
                    unsettled();
                }
                JsonNode manifest = verifyManifest(operation, output, start);
                if (!manifest.path("exitCode").equals(exitCode)
                        || !manifest.path("signal").equals(exitSignal)
                        || !manifest.path("executionStatus").asText().equals(process.getExecutionStatus())) {
                    unsettled();
                }
            }
        }
    }

    private java.util.Set<String> backgroundCalls(OperationRecord operation) {
        // Detached output is verified against its record and physical exit, not a foreground receipt.
        var calls = new java.util.HashSet<String>();
        for (String domain : List.of("child_run", "monitor_run")) {
            for (JsonNode record : records.listRecords(operation.tenantId(), operation.sessionId(), domain)) {
                if ("monitor_run".equals(domain) || "shell".equals(record.path("kind").asText())) {
                    calls.add(record.path("run").path("executionCallId").asText());
                }
            }
        }
        return calls;
    }

    private java.util.Set<String> nativeFileInputs(OperationRecord operation) {
        var inputs = new java.util.HashSet<String>();
        var refs = jdbc.queryForList("SELECT resource_id, kind, schema_version, byte_length, sha256"
                + " FROM ma_resource WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                + " AND kind = ? AND state = 'REFERENCED' FOR UPDATE",
                ManagedSessionStore.sessionScopeKey(operation.tenantId(), operation.sessionId()),
                operation.tenantId(), operation.sessionId(), "managed-tool-input");
        for (var row : refs) {
            var ref = JSON.createObjectNode().put("resourceId", row.get("resource_id").toString())
                    .put("kind", "managed-tool-input").put("schemaVersion", ((Number) row.get("schema_version")).intValue())
                    .put("byteLength", ((Number) row.get("byte_length")).longValue()).put("digest", row.get("sha256").toString());
            JsonNode input = records.readRecordResource(operation.tenantId(), operation.sessionId(), ref);
            if (!operation.sessionId().equals(input.path("harnessSessionId").asText())
                    || !input.path("runtimeSessionId").isTextual() || !input.path("payloadJson").isTextual()) {
                continue;
            }
            byte[] payload = input.path("payloadJson").textValue().getBytes(StandardCharsets.UTF_8);
            JsonNode call = ToolPublicationContract.readJson(payload);
            if (call.size() == 2 && call.path("input").isObject()
                    && List.of("read_file", "write_file", "edit", "glob").contains(call.path("toolName").asText())) {
                inputs.add(input.path("runtimeSessionId").textValue() + ":sha256:" + ToolPublicationContract.sha256(payload));
            }
        }
        return inputs;
    }

    private List<ToolExecutionRecord> executions(OperationRecord operation) {
        return jdbc.execute((ConnectionCallback<List<ToolExecutionRecord>>) connection ->
                JdbcToolExecutionRepository.findHarnessExecutions(connection, operation.tenantId(), operation.sessionId()));
    }

    private static boolean notStarted(ToolExecutionRecord execution) {
        return execution.isSettled() && ("not_started".equals(execution.getExecutionStatus())
                || "cancelled".equals(execution.getExecutionStatus()) && execution.getDispatchGeneration() == 0);
    }

    private void verifyNotStartedPublication(OperationRecord operation, ToolExecutionRecord execution) {
        var rows = jdbc.queryForList("SELECT state, producer_phase, terminal_resource_id, binding_json, binding_digest,"
                + " CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantined"
                + " FROM ma_output_capture WHERE tenant_id = ? AND session_id = ? AND publication_id = ? FOR UPDATE",
                operation.tenantId(), operation.sessionId(), execution.getReference().get("publicationId"));
        if (rows.size() != 1 || !"NOT_STARTED".equals(rows.getFirst().get("state"))
                || !"OPEN".equals(rows.getFirst().get("producer_phase"))
                || ((Number) rows.getFirst().get("quarantined")).intValue() != 0
                || rows.getFirst().get("terminal_resource_id") != null) {
            unsettled();
        }
        var row = rows.getFirst();
        JsonNode binding = ToolPublicationContract.parseBytes("binding", ((String) row.get("binding_json")).getBytes(StandardCharsets.UTF_8));
        if (!ToolPublicationContract.bindingDigest(binding).equals(row.get("binding_digest"))
                || !operation.tenantId().equals(binding.path("sessionKey").path("tenantId").asText())
                || !operation.sessionId().equals(binding.path("sessionKey").path("sessionId").asText())
                || !execution.getExecutionCallId().equals(binding.path("executionCallId").asText())
                || !execution.getBindingId().equals(binding.path("runtimeBindingId").asText())
                || !Long.toString(execution.getRuntimeGeneration()).equals(binding.path("bindingGeneration").asText())
                || !execution.getRequestDigest().equals(binding.path("requestDigest").asText())
                || !java.util.Objects.equals(execution.getReference().get("argsDigest"), binding.path("reference").path("argsDigest").asText())) {
            unsettled();
        }
    }

    private ManagedToolResultStore.Source source(String text) {
        try {
            return JSON.readValue(text, ManagedToolResultStore.Source.class);
        } catch (java.io.IOException error) {
            throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_resources_unsettled");
        }
    }

    private static boolean hold(ToolExecutionRecord execution) {
        Object mode = execution.getReference().get("dispatchMode");
        return "background_v3_process".equals(mode) || "background_v3_monitor".equals(mode);
    }

    private static void known(JsonNode record) {
        JsonNode run = record.path("run");
        if (!List.of("settled", "failed", "cancelled").contains(run.path("state").asText())
                || !List.of("settled", "not_started_proven").contains(run.path("execution").asText())) {
            unsettled();
        }
    }

    private JsonNode verifyManifest(OperationRecord operation, JsonNode ref, ToolExecutionRecord execution) {
        JsonNode manifest = ToolPublicationContract.parseToolResult("manifest", read(operation, ref), 2 * 1024 * 1024);
        Object invocationDigest = execution.getReference().get("argsDigest");
        if (Integer.valueOf(3).equals(execution.getReference().get("runtimeProtocol"))
                && "deferred".equals(execution.getReference().get("dispatchMode"))) {
            invocationDigest = execution.getReference().get("inputDigest");
            if (!(invocationDigest instanceof String digest) || !digest.matches("[0-9a-f]{64}")) {
                unsettled();
            }
        }
        if (!"process_pipes".equals(manifest.path("captureScope").asText())
                || !"complete_required".equals(manifest.path("capturePolicy").asText())
                || !java.util.Objects.equals(execution.getReference().get("callId"), manifest.path("callId").asText())
                || !java.util.Objects.equals(invocationDigest, manifest.path("invocationDigest").asText())
                || !operation.tenantId().equals(manifest.path("tenantId").asText())
                || !operation.sessionId().equals(manifest.path("sessionId").asText())
                || !execution.getTurnId().equals(manifest.path("turnId").asText())
                || !execution.getExecutionCallId().equals(manifest.path("executionCallId").asText())
                || !Long.toString(execution.getRuntimeGeneration()).equals(manifest.path("bindingGeneration").asText())
                || "unknown".equals(manifest.path("executionStatus").asText())
                || "pending".equals(manifest.path("captureStatus").asText())) {
            unsettled();
        }
        String capture = manifest.path("captureId").asText();
        var streams = new java.util.HashSet<String>();
        boolean complete = true;
        boolean emptyIncomplete = true;
        for (JsonNode content : manifest.path("contents")) {
            if ("open".equals(content.path("state").asText())) {
                unsettled();
            }
            String stream = content.path("streamId").asText();
            if (!List.of("stdout", "stderr").contains(stream) || !stream.equals(content.path("role").asText()) || !streams.add(stream)) {
                unsettled();
            }
            complete &= "sealed".equals(content.path("state").asText());
            emptyIncomplete &= "incomplete".equals(content.path("state").asText()) && content.path("byteLength").asLong(-1) == 0;
            MessageDigest hash = digest();
            long length = 0;
            int ordinal = 0;
            JsonNode body = content.path("body");
            if (body.has("ref")) {
                byte[] bytes = read(operation, body.path("ref"));
                hash.update(bytes);
                length = bytes.length;
            } else {
                for (JsonNode pageRef : body.path("pages")) {
                    JsonNode page = ToolPublicationContract.parseToolResult("page", read(operation, pageRef.path("ref")), 262144);
                    if (!capture.equals(page.path("captureId").asText()) || !stream.equals(page.path("streamId").asText())
                            || page.path("firstOrdinal").asInt(-1) != ordinal || page.path("offset").asLong(-1) != length
                            || pageRef.path("segmentCount").asInt(-1) != page.path("segments").size()) {
                        unsettled();
                    }
                    long pageLength = 0;
                    for (JsonNode segment : page.path("segments")) {
                        byte[] bytes = readContent(operation, id(capture, stream, ordinal++), segment);
                        hash.update(bytes);
                        length += bytes.length;
                        pageLength += bytes.length;
                    }
                    if (pageLength != pageRef.path("byteLength").asLong(-1)) {
                        unsettled();
                    }
                }
                if ("sealed".equals(content.path("state").asText())) {
                    JsonNode seal = ToolPublicationContract.readJson(readContent(operation, id(capture, stream, "seal"), null));
                    if (seal.path("segmentCount").asInt(-1) != ordinal
                            || seal.path("byteLength").asLong(-1) != length
                            || !seal.path("digest").equals(content.path("digest"))) {
                        unsettled();
                    }
                }
            }
            if (length != content.path("byteLength").asLong(-1)
                    || !HexFormat.of().formatHex(hash.digest()).equals(content.path("digest").asText())) {
                unsettled();
            }
        }
        String status = streams.isEmpty() || emptyIncomplete ? "unavailable" : complete ? "complete" : "partial";
        if (!status.equals(manifest.path("captureStatus").asText()) || "complete".equals(status) && streams.size() != 2) {
            unsettled();
        }
        return manifest;
    }

    private byte[] read(OperationRecord operation, JsonNode ref) {
        return readContent(operation, ref.path("resourceId").asText(), ref);
    }

    private byte[] readContent(OperationRecord operation, String id, JsonNode expected) {
        var rows = jdbc.queryForList("SELECT resource_id, kind, schema_version, byte_length, sha256, inline_bytes, storage_kind, state"
                + " FROM ma_resource WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                + " AND resource_id = ? FOR UPDATE", ManagedSessionStore.sessionScopeKey(operation.tenantId(), operation.sessionId()),
                operation.tenantId(), operation.sessionId(), id);
        if (rows.size() != 1) {
            unsettled();
        }
        var row = rows.getFirst();
        if (!"MYSQL_INLINE".equals(row.get("storage_kind")) || !List.of("PUBLISHED", "REFERENCED").contains(row.get("state"))
                || ((Number) row.get("schema_version")).intValue() != 1 || !(row.get("inline_bytes") instanceof byte[])
                || expected == null && !"managed-tool-result-content".equals(row.get("kind"))) {
            unsettled();
        }
        byte[] bytes = (byte[]) row.get("inline_bytes");
        String hash = ToolPublicationContract.sha256(bytes);
        if (((Number) row.get("byte_length")).longValue() != bytes.length || !hash.equals(row.get("sha256"))) {
            unsettled();
        }
        if (expected != null && (expected.path("byteLength").asLong(-1) != bytes.length
                || !expected.path("digest").asText().equals(hash)
                || expected.has("kind") && !expected.path("kind").asText().equals(row.get("kind")))) {
            unsettled();
        }
        return bytes;
    }

    private static String id(String capture, String stream, Object ordinal) {
        try {
            return ToolPublicationContract.sha256(JSON.writeValueAsBytes(List.of(capture, stream, ordinal)));
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
    }

    private static MessageDigest digest() {
        try {
            return DigestUtils.getSha256Digest();
        } catch (IllegalArgumentException error) {
            throw new IllegalStateException(error);
        }
    }

    private static void unsettled() {
        throw WorkspaceLifecycleStore.blocked("workspace_lifecycle_resources_unsettled");
    }
}

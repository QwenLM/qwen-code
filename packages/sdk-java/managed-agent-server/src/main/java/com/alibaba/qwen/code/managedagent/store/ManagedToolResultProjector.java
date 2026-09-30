package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore.Artifact;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore.Claim;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore.Projection;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore.Source;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class ManagedToolResultProjector {
    private static final Logger LOG = LoggerFactory.getLogger(ManagedToolResultProjector.class);
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ManagedToolResultStore store;
    private final JdbcTemplate jdbc;
    private final ObjectProvider<ToolPublicationDataStore> publications;
    private final ManagedArtifactReader reader;
    private final ManagedArtifactPolicy policy;
    private final ManagedAgentProperties properties;

    public ManagedToolResultProjector(ManagedToolResultStore store, JdbcTemplate jdbc,
            ObjectProvider<ToolPublicationDataStore> publications, ManagedArtifactReader reader,
            ManagedArtifactPolicy policy, ManagedAgentProperties properties) {
        this.store = store;
        this.jdbc = jdbc;
        this.publications = publications;
        this.reader = reader;
        this.policy = policy;
        this.properties = properties;
    }

    @Scheduled(fixedDelayString = "${qwen.managed-agent.artifacts.projection-interval:1000}")
    public void tick() {
        if (!properties.getArtifacts().isEnabled()) {
            return;
        }
        try {
            store.backfillOnePage();
        } catch (RuntimeException error) {
            LOG.warn("Managed tool result backfill could not advance: {}", error.getClass().getSimpleName());
        }
        for (int index = 0; index < 8; index++) {
            var claim = store.claim();
            if (claim.isEmpty()) {
                return;
            }
            project(claim.get());
        }
    }

    public void project(Claim claim) {
        try {
            var statuses = jdbc.query("SELECT status FROM managed_agent_session WHERE tenant_id = ? AND session_id = ?",
                    (row, index) -> row.getString(1), claim.source().tenantId(), claim.source().sessionId());
            if (statuses.stream().anyMatch(status -> List.of("DELETING", "DELETED").contains(status))) {
                store.fail(claim, "SUPPRESSED", "session_unavailable");
                return;
            }
            Projection projection = resolve(claim.source());
            if (projection == null) {
                store.fail(claim, "UNSUPPORTED", "unsupported_receipt_producer");
            } else {
                store.complete(claim, projection, policy.version());
            }
        } catch (IllegalArgumentException error) {
            store.fail(claim, "QUARANTINED", "tool_result_source_invalid");
        } catch (RuntimeException | IOException error) {
            store.fail(claim, "RETRYABLE", "tool_result_source_unavailable");
        }
    }

    private Projection resolve(Source source) throws IOException {
        store.verifySource(source);
        var candidates = jdbc.queryForList("SELECT p.*, CASE WHEN quarantined THEN 1 ELSE 0 END AS quarantine_mark FROM qwen_tool_publication p WHERE tenant_id = ?"
                        + " AND workspace_id = ? AND session_id = ? AND execution_key = ?",
                source.tenantId(), source.workspaceId(), source.sessionId(),
                ToolPublicationContract.sha256(source.executionCallId().getBytes(StandardCharsets.UTF_8)));
        if (candidates.isEmpty()) {
            return null;
        }
        require(candidates.size() == 1, "Publication source is ambiguous");
        require(source.outcomeRef().isObject() && source.resources().isArray()
                        && "managed-tool-outcome".equals(source.outcomeRef().path("kind").asText())
                        && source.outcomeRef().path("schemaVersion").asInt(-1) == 1, "Receipt references are invalid");
        var publication = candidates.getFirst();
        String publicationId = (String) publication.get("publication_id");
        JsonNode binding = ManagedToolResultStore.parse((String) publication.get("binding_json"));
        require(ToolPublicationContract.bindingDigest(binding).equals(publication.get("binding_digest"))
                        && binding.path("sessionKey").equals(source.sessionKey())
                        && source.executionCallId().equals(binding.path("executionCallId").asText())
                        && publicationId.equals(binding.path("publicationId").asText()), "Publication binding changed");
        var turns = jdbc.queryForList("SELECT t.tenant_id, t.session_id, t.prompt_id, t.turn_id, s.workspace_id FROM managed_agent_turn t"
                        + " JOIN managed_agent_session s ON s.tenant_id = t.tenant_id AND s.session_id = t.session_id"
                        + " WHERE t.tenant_id = ? AND t.session_id = ? AND t.prompt_id = ?",
                source.tenantId(), source.sessionId(), binding.path("turnId").asText());
        if (turns.isEmpty()) {
            return null;
        }
        require(turns.size() == 1 && source.tenantId().equals(turns.getFirst().get("tenant_id"))
                        && source.sessionId().equals(turns.getFirst().get("session_id"))
                        && binding.path("turnId").asText().equals(turns.getFirst().get("prompt_id"))
                        && source.workspaceId().equals(turns.getFirst().get("workspace_id")),
                "Public Turn mapping conflicts");
        String turnId = (String) turns.getFirst().get("turn_id");
        String itemId = EventIdentity.toolItemId(turnId, source.receiptSequence(),
                Map.of("toolCallId", binding.path("modelCallId").asText()));
        boolean notStarted = "NOT_STARTED".equals(publication.get("state"));
        boolean quarantined = number(publication.get("quarantine_mark")) != 0;
        ToolPublicationDataStore data = publications.getIfAvailable();
        JsonNode outcome;
        if (notStarted) {
            outcome = inlineOutcome(source);
        } else {
            require("REFERENCED".equals(publication.get("producer_phase"))
                            && source.outcomeRef().path("resourceId").asText().equals(publication.get("admission_resource_id"))
                            && number(publication.get("receipt_sequence")) == source.receiptSequence()
                            && number(publication.get("receipt_revision")) == source.journalRevision(),
                    "Publication has no original committed receipt");
            if (data == null) {
                throw new IllegalStateException("Publication reader is unavailable");
            }
            outcome = exact(data, source, publicationId, source.outcomeRef());
            JsonNode terminal = ToolPublicationContract.readJson(data.readResource(source.sessionKey(), publicationId,
                    (String) publication.get("terminal_resource_id")));
            require(terminal.equals(outcome.path("envelope")), "Original terminal envelope changed");
        }
        require(outcome.path("schemaVersion").asInt(-1) == 1, "Outcome version is invalid");
        JsonNode envelope = ToolPublicationContract.parseToolResult("result",
                outcome.path("envelope").toString().getBytes(StandardCharsets.UTF_8), 2 * 1024 * 1024);
        JsonNode capture = envelope.path("capture");
        JsonNode manifestRef = outcome.path("manifestRef");
        String decision = outcome.path("decision").asText();
        String execution = envelope.path("executionStatus").asText();
        JsonNode manifest = null;
        if (notStarted) {
            require("not_started".equals(execution) && capture.isNull() && manifestRef.isNull()
                            && source.resultRef().isNull() && source.resources().isEmpty() && "blocked".equals(decision),
                    "Not-started receipt conflicts");
        } else {
            require(capture.isObject() && capture.path("manifest").equals(manifestRef)
                            && ("complete".equals(capture.path("captureStatus").asText()) ? "committed" : "blocked")
                            .equals(decision)
                            && ("committed".equals(decision) ? manifestRef.equals(source.resultRef()) : source.resultRef().isNull())
                            && (manifestRef.isNull() ? source.resources().isEmpty()
                            : source.resources().size() == 1 && manifestRef.equals(source.resources().get(0))),
                    "Recorded delivery decision conflicts");
            if (!manifestRef.isNull()) {
                require("managed-tool-result-manifest".equals(manifestRef.path("kind").asText()),
                        "Manifest kind conflicts");
                manifest = exact(data, source, publicationId, manifestRef);
                validateManifest(source, binding, envelope, manifest);
            } else {
                require("unavailable".equals(capture.path("captureStatus").asText()), "Capture manifest is missing");
            }
        }
        String policyVersion = policy.version();
        boolean publish = !quarantined
                && policy.publishOriginal(source.tenantId(), source.workspaceId(), source.sessionId());
        long createdAt = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", Timestamp.class).getTime();
        List<Artifact> artifacts = new ArrayList<>();
        if (publish && "committed".equals(decision)) {
            require(manifest != null, "Committed capture has no manifest");
            for (JsonNode stream : manifest.path("contents")) {
                String streamId = stream.path("streamId").asText();
                require("sealed".equals(stream.path("state").asText())
                                && List.of("stdout", "stderr").contains(streamId)
                                && streamId.equals(stream.path("role").asText()), "Unsupported public stream");
                String id = ManagedToolResultStore.identity("artifact", "1", source.id(),
                        manifestRef.path("digest").asText(), streamId, policyVersion);
                ObjectNode descriptor = JSON.createObjectNode().put("id", id).put("session_id", source.sessionId())
                        .put("result_id", source.id()).put("revision", stream.path("digest").asText())
                        .put("stream_role", streamId).put("byte_length", stream.path("byteLength").asLong())
                        .put("sha256", stream.path("digest").asText()).put("media_type", "application/octet-stream")
                        .put("availability", "available").put("created_at", createdAt);
                Artifact artifact = new Artifact(descriptor, source, publicationId, binding, manifestRef, streamId, 0);
                try (var verified = reader.open(artifact)) {
                    // Opening verifies the immutable metadata closure before publication.
                }
                artifacts.add(artifact);
            }
        }
        ObjectNode descriptor = JSON.createObjectNode().put("id", source.id()).put("session_id", source.sessionId())
                .put("turn_id", turnId).put("item_id", itemId).put("projection_revision", 1)
                .put("execution_status", execution).put("delivery_status", decision);
        descriptor.set("upstream_truncated", manifest == null ? JSON.nullNode() : manifest.path("upstreamTruncated"));
        if (notStarted) {
            descriptor.putNull("capture_status").putNull("capture_scope");
        } else {
            descriptor.put("capture_status", capture.path("captureStatus").asText())
                    .put("capture_scope", binding.path("captureScope").asText());
            if (capture.path("captureReason").isTextual()) {
                descriptor.put("reason_code", capture.path("captureReason").asText());
            }
        }
        var refs = descriptor.putArray("artifacts");
        artifacts.forEach(artifact -> refs.add(artifact.descriptor()));
        if (policy.publishPreview(source.tenantId(), source.workspaceId(), source.sessionId()) && !artifacts.isEmpty()) {
            Artifact selected = artifacts.stream().filter(artifact -> artifact.descriptor().path("byte_length").asLong() > 0)
                    .findFirst().orElse(artifacts.getFirst());
            long size = selected.descriptor().path("byte_length").asLong();
            int length = (int) Math.min(4096, size);
            byte[] bytes = reader.readRange(selected, 0, length);
            String text = new String(bytes, StandardCharsets.UTF_8)
                    .replaceAll("\\x1B\\[[0-?]*[ -/]*[@-~]", "")
                    .replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", "");
            String bounded = boundPreview(text);
            boolean truncated = size > length || bounded.length() < text.length();
            text = bounded;
            descriptor.set("preview", JSON.createObjectNode().put("text", text).put("truncated", truncated)
                    .put("stream_id", selected.streamId()).put("source_start", 0).put("source_end", length));
        }
        if (descriptor.toString().getBytes(StandardCharsets.UTF_8).length > 15 * 1024) {
            descriptor.remove("preview");
        }
        return new Projection(descriptor, publicationId, binding, manifestRef, List.copyOf(artifacts), policyVersion);
    }

    static String boundPreview(String text) {
        int bytes = 0;
        int lines = 1;
        int end = 0;
        while (end < text.length()) {
            int point = text.codePointAt(end);
            int count = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
            if (bytes + count > 8192 || point == '\n' && lines == 200) {
                break;
            }
            bytes += count;
            if (point == '\n') {
                lines++;
            }
            end += Character.charCount(point);
        }
        return text.substring(0, end);
    }

    private JsonNode inlineOutcome(Source source) {
        var rows = jdbc.queryForList("SELECT kind, schema_version, byte_length, sha256, inline_bytes, storage_kind, state"
                        + " FROM qwen_managed_session_resource WHERE tenant_id = ? AND workspace_id = ?"
                        + " AND session_id = ? AND resource_id = ?", source.tenantId(), source.workspaceId(),
                source.sessionId(), source.outcomeRef().path("resourceId").asText());
        require(rows.size() == 1, "Not-started outcome is missing");
        var row = rows.getFirst();
        require("MYSQL_INLINE".equals(row.get("storage_kind")) && "REFERENCED".equals(row.get("state"))
                        && "managed-tool-outcome".equals(row.get("kind")) && number(row.get("schema_version")) == 1,
                "Not-started outcome is not retained inline");
        byte[] bytes = (byte[]) row.get("inline_bytes");
        return verifyBytes(source.outcomeRef(), bytes);
    }

    private static JsonNode exact(ToolPublicationDataStore data, Source source, String publication, JsonNode ref) {
        return verifyBytes(ref, data.readResource(source.sessionKey(), publication, ref.path("resourceId").asText()));
    }

    private static JsonNode verifyBytes(JsonNode ref, byte[] bytes) {
        require(bytes != null && bytes.length == ref.path("byteLength").asLong(-1)
                        && ToolPublicationContract.sha256(bytes).equals(ref.path("digest").asText()),
                "Result resource digest changed");
        return ToolPublicationContract.readJson(bytes);
    }

    private static void validateManifest(Source source, JsonNode binding, JsonNode envelope, JsonNode manifest) {
        ToolPublicationContract.parseToolResult("manifest", manifest.toString().getBytes(StandardCharsets.UTF_8), 64 * 1024);
        require(source.tenantId().equals(manifest.path("tenantId").asText())
                        && source.sessionId().equals(manifest.path("sessionId").asText())
                        && source.executionCallId().equals(manifest.path("executionCallId").asText())
                        && binding.path("turnId").equals(manifest.path("turnId"))
                        && binding.path("reference").path("callId").equals(manifest.path("callId"))
                        && binding.path("reference").path("argsDigest").equals(manifest.path("invocationDigest"))
                        && binding.path("bindingGeneration").equals(manifest.path("bindingGeneration"))
                        && binding.path("captureId").equals(manifest.path("captureId"))
                        && binding.path("revision").equals(manifest.path("revision"))
                        && envelope.path("executionStatus").equals(manifest.path("executionStatus"))
                        && envelope.path("capture").path("captureStatus").equals(manifest.path("captureStatus"))
                        && envelope.path("capture").path("captureReason").equals(manifest.path("captureReason"))
                        && "process_pipes".equals(manifest.path("captureScope").asText())
                        && "complete_required".equals(manifest.path("capturePolicy").asText()),
                "Manifest identity or capture facts conflict");
    }

    private static long number(Object value) {
        return value instanceof Number number ? number.longValue() : -1;
    }

    private static void require(boolean valid, String message) {
        ManagedToolResultStore.require(valid, message);
    }
}

package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.contracts.persistence.ToolPublicationContract;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

public interface ManagedToolResultStore {
    public record Source(String id, String tenantId, String workspaceId, String sessionId,
            String executionCallId, long journalRevision, long receiptSequence,
            JsonNode outcomeRef, JsonNode resultRef, JsonNode resources, String sourceDigest) {
        public JsonNode sessionKey() {
            return Codec.JSON.createObjectNode().put("tenantId", tenantId).put("workspaceId", workspaceId)
                    .put("sessionId", sessionId);
        }
    }

    public record Claim(Source source, long generation) { }

    public record Artifact(JsonNode descriptor, Source source, String publicationId,
            JsonNode binding, JsonNode manifestRef, String streamId, long creationSequence) { }

    public record ArtifactPage(List<Artifact> artifacts, long watermark, boolean hasMore) { }

    public record Projection(JsonNode descriptor, String publicationId, JsonNode binding,
            JsonNode manifestRef, List<Artifact> artifacts, String policyVersion) { }

    public Optional<Claim> claim();

    public void fail(Claim claim, String state, String code);

    public void verifySource(Source source);

    public boolean complete(Claim claim, Projection projection, String currentPolicyVersion);

    public Optional<JsonNode> findResult(String tenant, String session, String itemId);

    public Optional<Artifact> findArtifact(String tenant, String session, String artifactId);

    public ArtifactPage listArtifacts(String tenant, String session, Long watermark, Long beforeSequence,
            String beforeId, int limit);

    public static String identity(String prefix, String... values) {
        var digest = new java.io.ByteArrayOutputStream();
        for (String value : values) {
            byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
            digest.writeBytes(ByteBuffer.allocate(4).putInt(bytes.length).array());
            digest.writeBytes(bytes);
        }
        return prefix + "_" + ToolPublicationContract.sha256(digest.toByteArray());
    }
    final class Codec {
        private static final ObjectMapper JSON = new ObjectMapper();

        private Codec() { }
    }
}

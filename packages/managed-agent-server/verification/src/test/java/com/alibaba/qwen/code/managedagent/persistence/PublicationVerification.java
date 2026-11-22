package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Producer calls that admit an operation, drain the verifier and return the verified receipt.
 * A recorded failure is thrown with its safe status and code, as the HTTP adapter reports it.
 */
public final class PublicationVerification {
    private final ToolPublicationDataStore data;

    private PublicationVerification(ToolPublicationDataStore data) {
        this.data = data;
    }

    public static PublicationVerification verified(ToolPublicationDataStore data) {
        return new PublicationVerification(data);
    }

    public JsonNode publishSegment(JsonNode key, String publicationId, String token,
            String operationId, String streamId, int ordinal, byte[] input, String expectedDigest) {
        return settle(key, publicationId, token, operationId, data.publishSegment(key, publicationId, token,
                operationId, streamId, ordinal, input, expectedDigest));
    }

    public JsonNode publishResource(JsonNode key, String publicationId, String token,
            String operationId, String slot, String kind, byte[] input) {
        return settle(key, publicationId, token, operationId, data.publishResource(key, publicationId, token,
                operationId, slot, kind, input));
    }

    public JsonNode seal(JsonNode key, String publicationId, String token, String operationId,
            String streamId, int segmentCount, long byteLength, String digest) {
        return settle(key, publicationId, token, operationId, data.seal(key, publicationId, token,
                operationId, streamId, segmentCount, byteLength, digest));
    }

    public JsonNode prefix(JsonNode key, String publicationId, String token, String operationId,
            String streamId) {
        return settle(key, publicationId, token, operationId, data.prefix(key, publicationId, token,
                operationId, streamId));
    }

    public JsonNode finish(JsonNode key, String publicationId, String token, String operationId,
            byte[] bytes) {
        return settle(key, publicationId, token, operationId, data.finish(key, publicationId, token,
                operationId, bytes));
    }

    private JsonNode settle(JsonNode key, String publicationId, String token, String operationId,
            JsonNode admitted) {
        JsonNode status = admitted;
        if ("PENDING".equals(status.path("state").asText())) {
            while (data.verifyNextOperation()) {
                // Run every due verification, including this operation's.
            }
            status = data.operationStatus(key, publicationId, token, operationId);
        }
        String state = status.path("state").asText();
        if ("SUCCEEDED".equals(state)) {
            return status.path("receipt");
        }
        if ("FAILED".equals(state)) {
            String code = status.path("error").path("code").asText();
            throw new ManagedAgentException(status.path("error").path("status").asInt(), code, code);
        }
        throw new IllegalStateException("Publication operation is " + state);
    }
}

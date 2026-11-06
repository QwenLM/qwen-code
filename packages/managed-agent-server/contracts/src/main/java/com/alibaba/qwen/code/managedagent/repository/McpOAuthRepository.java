package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.JsonNode;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

/** Actor-owned OAuth state; secret-bearing records never form a public response. */
public interface McpOAuthRepository {
    record Scope(String tenant, String workspace, String actor) {}

    static String credentialId(Scope scope, JsonNode binding) {
        String identity =
                ManagedSchemaKeys.key(
                        scope.tenant(),
                        scope.workspace(),
                        scope.actor(),
                        binding.path("serverId").asText(),
                        binding.path("providerId").asText(),
                        binding.path("resourceUri").asText());
        return "mcred_" + UUID.nameUUIDFromBytes(identity.getBytes(StandardCharsets.US_ASCII));
    }

    record Attempt(
            String id,
            Scope scope,
            String stateHash,
            String nonceHash,
            String requestDigest,
            String state,
            long expiresAt,
            JsonNode binding,
            JsonNode secrets,
            String credentialId) {
        @Override
        public String toString() {
            return "McpOAuthAttempt[secrets=redacted]";
        }
    }

    record Credential(
            String id,
            Scope scope,
            JsonNode binding,
            long generation,
            String state,
            long expiresAt,
            JsonNode secrets,
            String refreshLease,
            Long refreshUntil) {
        @Override
        public String toString() {
            return "McpOAuthCredential[secrets=redacted]";
        }
    }

    Attempt createAttempt(Attempt attempt);

    Attempt attempt(Scope scope, String id);

    Attempt receiveCode(String stateHash, String issuer, String code, long now);

    void rejectAttempt(String stateHash, long now);

    Attempt claimAttempt(Scope scope, String id, String nonceHash, long now);

    Credential completeAttempt(Scope scope, String id, JsonNode tokens, long expiresAt, long now);

    void failAttempt(Scope scope, String id);

    Credential credential(Scope scope, String id);

    Credential findCredential(String tenant, String workspace, String id);

    List<Credential> credentials(Scope scope);

    Credential claimRefresh(
            Scope scope, String id, long generation, String lease, long now, long until);

    Credential completeRefresh(
            Scope scope, String id, long generation, String lease, JsonNode tokens, long expiresAt);

    void failRefresh(Scope scope, String id, long generation, String lease);

    Credential revoke(Scope scope, String id, long generation);
}

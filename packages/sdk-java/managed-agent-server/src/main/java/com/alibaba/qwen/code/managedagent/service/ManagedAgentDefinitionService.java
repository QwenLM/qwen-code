package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiModels.AgentDefinition;
import com.alibaba.qwen.code.managedagent.api.ApiModels.AgentDefinitionRequest;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore.Admission;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore.ConcurrentWriteException;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentDefinitionStore.DefinitionRevision;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * Stores AgentDefinition revisions (D8a). Definitions are tenant-scoped and
 * immutable once stored; Sessions do not use them yet (D8b), and no field
 * changes Harness execution (D8c).
 */
@Service
public class ManagedAgentDefinitionService {
    // Agent IDs are server-generated, so anything else names no definition.
    private static final Pattern AGENT_ID = Pattern.compile(
            "^agent_[0-9a-f]{32}$");
    private static final Pattern REVISION = Pattern.compile(
            "^[1-9][0-9]{0,17}$");
    private static final String DIGEST_PREFIX = "sha256:";
    private static final TypeReference<Map<String, Object>> CONTENT =
            new TypeReference<>() {
            };
    private final ManagedAgentDefinitionStore store;
    private final RequestDigests digests;
    private final ObjectMapper objectMapper;

    public ManagedAgentDefinitionService(ManagedAgentDefinitionStore store,
            RequestDigests digests, ObjectMapper objectMapper) {
        this.store = store;
        this.digests = digests;
        this.objectMapper = objectMapper;
    }

    public record Result(AgentDefinition definition, boolean replayed) {
    }

    public Result create(String tenantId, String idempotencyKey,
            AgentDefinitionRequest request) {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        Map<String, Object> content = content(request);
        String requestDigest = requestDigest("create", null, content);
        return result(tenantId, idempotencyKey, requestDigest,
                () -> store.create(tenantId, idempotencyKey, requestDigest,
                        newAgentId(), contentDigest(content), json(content),
                        System.currentTimeMillis()));
    }

    public Result update(String tenantId, String agentId,
            String idempotencyKey, AgentDefinitionRequest request) {
        ManagedAgentService.validateIdempotencyKey(idempotencyKey);
        requireAgentId(agentId);
        Map<String, Object> content = content(request);
        String requestDigest = requestDigest("update", agentId, content);
        return result(tenantId, idempotencyKey, requestDigest,
                () -> store.update(tenantId, idempotencyKey, requestDigest,
                        agentId, contentDigest(content), json(content),
                        System.currentTimeMillis()));
    }

    /** Reads the requested revision, or the latest when none is named. */
    public AgentDefinition get(String tenantId, String agentId,
            String revision) {
        requireAgentId(agentId);
        DefinitionRevision found;
        if (revision == null) {
            found = store.latest(tenantId, agentId).orElseThrow(
                    ManagedAgentDefinitionStore::notFound);
        } else {
            if (!REVISION.matcher(revision).matches()) {
                throw ManagedAgentDefinitionStore.notFound();
            }
            found = store.find(tenantId, agentId, Long.parseLong(revision))
                    .orElseThrow(ManagedAgentDefinitionStore::notFound);
        }
        return publicDefinition(found);
    }

    /**
     * Runs a write. When a concurrent request committed first, the same
     * request replays that request's result instead of conflicting.
     */
    private Result result(String tenantId, String idempotencyKey,
            String requestDigest, Supplier<Admission> write) {
        Admission admission;
        try {
            admission = write.get();
        } catch (ConcurrentWriteException conflict) {
            admission = store.replayCommitted(tenantId, idempotencyKey,
                    requestDigest).orElseThrow(() -> new ApiException(
                            HttpStatus.CONFLICT, conflict.code(),
                            conflict.getMessage()));
        }
        return new Result(publicDefinition(admission.revision()),
                admission.replayed());
    }

    private AgentDefinition publicDefinition(DefinitionRevision revision) {
        Object metadata = parse(revision.definitionJson()).get("metadata");
        @SuppressWarnings("unchecked")
        Map<String, Object> metadataMap = metadata instanceof Map<?, ?>
                ? (Map<String, Object>) metadata : null;
        return new AgentDefinition(revision.agentId(), "agent",
                Long.toString(revision.revision()), revision.digest(),
                revision.createdAt(), metadataMap);
    }

    // Absent and null optional fields store the same content and digest.
    private Map<String, Object> content(AgentDefinitionRequest request) {
        Map<String, Object> content = new LinkedHashMap<>(
                objectMapper.convertValue(request, CONTENT));
        content.values().removeIf(value -> value == null);
        return content;
    }

    private String contentDigest(Map<String, Object> content) {
        return digests.digest(content).substring(DIGEST_PREFIX.length());
    }

    private String requestDigest(String operation, String agentId,
            Map<String, Object> content) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("operation", operation);
        if (agentId != null) {
            request.put("agentId", agentId);
        }
        request.put("definition", content);
        return digests.digest(request);
    }

    private String json(Map<String, Object> content) {
        try {
            return objectMapper.writeValueAsString(content);
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException(
                    "Agent definition cannot be serialized", error);
        }
    }

    private Map<String, Object> parse(String json) {
        try {
            return objectMapper.readValue(json, CONTENT);
        } catch (JsonProcessingException error) {
            throw new IllegalStateException(
                    "A stored agent definition is not valid JSON", error);
        }
    }

    private static void requireAgentId(String agentId) {
        if (agentId == null || !AGENT_ID.matcher(agentId).matches()) {
            throw ManagedAgentDefinitionStore.notFound();
        }
    }

    private static String newAgentId() {
        return "agent_" + UUID.randomUUID().toString().replace("-", "");
    }
}

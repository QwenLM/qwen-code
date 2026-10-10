package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.CommitTransactionRequest;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.util.Objects;
import java.util.concurrent.Semaphore;
import java.util.function.Supplier;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@ConditionalOnProperty(prefix = "qwen.managed-agent.tool-publication",
        name = "enabled", havingValue = "true")
@RequestMapping("/internal/managed-tool-publications/v1/sessions/{sessionId}")
public class ToolPublicationController {
    public static final String PUBLICATION_TOKEN_HEADER = "X-Qwen-Tool-Publication-Token";
    public static final String OPERATION_ID_HEADER = "X-Qwen-Tool-Publication-Operation";
    private static final ObjectMapper JSON = new ObjectMapper();
    private final ToolPublicationStore grants;
    private final ToolPublicationDataStore data;
    private final ToolPublicationAdmissionStore admissions;
    private final Semaphore entries;

    public ToolPublicationController(ToolPublicationStore grants,
            ToolPublicationDataStore data, ToolPublicationAdmissionStore admissions,
            ManagedAgentProperties properties) {
        this.grants = Objects.requireNonNull(grants);
        this.data = Objects.requireNonNull(data);
        this.admissions = Objects.requireNonNull(admissions);
        this.entries = new Semaphore(properties.getToolPublication().getEntryConcurrency());
    }

    @PostMapping("/grants")
    public JsonNode grant(TenantContext tenant, @PathVariable String sessionId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestHeader(value = PUBLICATION_TOKEN_HEADER, required = false) String publicationToken,
            HttpServletRequest request) throws IOException {
        return limited(() -> {
            JsonNode body = ToolPublicationContract.readJson(read(request, 64 * 1024));
            requireScope(tenant, sessionId, body.path("sessionKey"));
            return grants.apply(body, writerToken, publicationToken);
        });
    }

    @PostMapping("/publications/{publicationId}/segments/{streamId}/{ordinal}")
    public JsonNode segment(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @PathVariable String streamId,
            @PathVariable int ordinal, @RequestParam String workspaceId,
            @RequestHeader(PUBLICATION_TOKEN_HEADER) String token,
            @RequestHeader(OPERATION_ID_HEADER) String operationId,
            @RequestHeader(value = "X-Qwen-Tool-Segment-Digest", required = false) String digest,
            HttpServletRequest request) throws IOException {
        return limited(() -> {
            JsonNode key = scope(tenant, workspaceId, sessionId);
            byte[] bytes = read(request, 16 * 1024 * 1024);
            return data.publishSegment(key, publicationId, token,
                    operationId, streamId, ordinal, bytes, digest);
        });
    }

    @PostMapping("/publications/{publicationId}/resources/{kind}/{slot}")
    public JsonNode resource(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @PathVariable String kind,
            @PathVariable String slot, @RequestParam String workspaceId,
            @RequestHeader(PUBLICATION_TOKEN_HEADER) String token,
            @RequestHeader(OPERATION_ID_HEADER) String operationId,
            HttpServletRequest request) throws IOException {
        return limited(() -> {
            JsonNode key = scope(tenant, workspaceId, sessionId);
            byte[] bytes = read(request, 16 * 1024 * 1024);
            return data.publishResource(key, publicationId, token,
                    operationId, slot, kind, bytes);
        });
    }

    @PostMapping("/publications/{publicationId}/streams/{streamId}/seal")
    public JsonNode seal(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @PathVariable String streamId,
            @RequestParam String workspaceId,
            @RequestHeader(PUBLICATION_TOKEN_HEADER) String token,
            @RequestHeader(OPERATION_ID_HEADER) String operationId,
            HttpServletRequest request) throws IOException {
        return limited(() -> {
            JsonNode body = ToolPublicationContract.readJson(read(request, 64 * 1024));
            JsonNode key = scope(tenant, workspaceId, sessionId);
            return data.seal(key, publicationId, token, operationId,
                    streamId, body.path("segmentCount").asInt(-1),
                    body.path("byteLength").asLong(-1), body.path("digest").asText(null));
        });
    }

    @PostMapping("/publications/{publicationId}/streams/{streamId}/prefix")
    public JsonNode prefix(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @PathVariable String streamId,
            @RequestParam String workspaceId,
            @RequestHeader(PUBLICATION_TOKEN_HEADER) String token,
            @RequestHeader(OPERATION_ID_HEADER) String operationId) {
        JsonNode key = scope(tenant, workspaceId, sessionId);
        return limited(() -> data.prefix(key, publicationId, token, operationId, streamId));
    }

    @PostMapping("/publications/{publicationId}/finish")
    public JsonNode finish(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @RequestParam String workspaceId,
            @RequestHeader(PUBLICATION_TOKEN_HEADER) String token,
            @RequestHeader(OPERATION_ID_HEADER) String operationId,
            HttpServletRequest request) throws IOException {
        return limited(() -> {
            byte[] body = read(request, 2 * 1024 * 1024);
            JsonNode key = scope(tenant, workspaceId, sessionId);
            return data.finish(key, publicationId, token, operationId, body);
        });
    }

    @GetMapping("/publications/{publicationId}/operations/{operationId}")
    public JsonNode status(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @PathVariable String operationId,
            @RequestParam String workspaceId,
            @RequestHeader(PUBLICATION_TOKEN_HEADER) String token) {
        return limited(() -> data.operationStatus(scope(tenant, workspaceId, sessionId),
                publicationId, token, operationId));
    }

    @PostMapping("/publications/{publicationId}/operations/{operationId}/recover")
    public JsonNode recover(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @PathVariable String operationId,
            @RequestParam String workspaceId,
            @RequestHeader(PUBLICATION_TOKEN_HEADER) String token) {
        return limited(() -> data.recoverOperation(scope(tenant, workspaceId, sessionId),
                publicationId, token, operationId));
    }

    @GetMapping("/publications/{publicationId}/finished")
    public JsonNode finished(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @RequestParam String workspaceId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken) {
        return limited(() -> data.finished(scope(tenant, workspaceId, sessionId),
                publicationId, writerToken));
    }

    @PostMapping("/publications/{publicationId}/admissions/prepare")
    public JsonNode admission(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @RequestParam String workspaceId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            @RequestHeader("X-Qwen-Managed-Writer-Id") String writerId,
            @RequestHeader("X-Qwen-Managed-Writer-Generation") long writerGeneration,
            HttpServletRequest request) {
        return limited(() -> data.prepareAdmission(scope(tenant, workspaceId, sessionId),
                publicationId, writerId, writerGeneration, writerToken,
                ToolPublicationContract.readJson(read(request, 2 * 1024 * 1024))));
    }

    @PostMapping("/receipts/verify")
    public JsonNode verifyReceipt(TenantContext tenant, @PathVariable String sessionId,
            @RequestParam String workspaceId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            HttpServletRequest request) {
        return limited(() -> admissions.verifyReceipt(scope(tenant, workspaceId, sessionId),
                writerToken, ToolPublicationContract.readJson(read(request, 64 * 1024))));
    }

    @PostMapping("/publications/{publicationId}/receipts/commit")
    public JsonNode commitReceipt(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @RequestParam String workspaceId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            HttpServletRequest request) {
        return limited(() -> {
            JsonNode body = ToolPublicationContract.readJson(read(request, 8 * 1024 * 1024));
            try {
                CommitTransactionRequest commit = JSON.treeToValue(body, CommitTransactionRequest.class);
                return admissions.commitReceipt(scope(tenant, workspaceId, sessionId),
                        publicationId, writerToken, commit);
            } catch (IOException error) {
                throw new UncheckedIOException(error);
            }
        });
    }

    @PostMapping(value = "/publications/{publicationId}/range",
            produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<byte[]> range(TenantContext tenant, @PathVariable String sessionId,
            @PathVariable String publicationId, @RequestParam String workspaceId,
            @RequestHeader(ManagedSessionStoreModels.WRITER_TOKEN_HEADER) String writerToken,
            HttpServletRequest request) throws IOException {
        byte[] bytes = limited(() -> {
            JsonNode body = ToolPublicationContract.readJson(read(request, 64 * 1024));
            JsonNode offset = body.path("offset");
            JsonNode length = body.path("length");
            if (!offset.isIntegralNumber() || !offset.canConvertToLong()
                    || !length.isIntegralNumber() || !length.canConvertToInt()) {
                throw new IllegalArgumentException("Invalid publication range");
            }
            return data.readRange(scope(tenant, workspaceId, sessionId),
                    publicationId, writerToken, body.path("manifestRef"), body.path("expectedIdentity"),
                    body.path("streamId").asText(), offset.longValue(), length.intValue());
        });
        return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL, "no-store")
                .contentType(MediaType.APPLICATION_OCTET_STREAM).body(bytes);
    }

    private <T> T limited(Supplier<T> operation) {
        if (!entries.tryAcquire()) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS,
                    "managed_tool_publication_busy", "Tool publication entry capacity is exhausted");
        }
        try {
            return operation.get();
        } finally {
            entries.release();
        }
    }

    private static byte[] read(HttpServletRequest request, int maximum) {
        try {
            byte[] body = request.getInputStream().readNBytes(maximum + 1);
            if (body.length > maximum) {
                throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE,
                        "managed_tool_publication_too_large", "Tool publication body exceeds its limit");
            }
            return body;
        } catch (IOException error) {
            throw new UncheckedIOException(error);
        }
    }

    private static JsonNode scope(TenantContext tenant, String workspaceId, String sessionId) {
        return JSON.createObjectNode().put("tenantId", tenant.tenantId())
                .put("workspaceId", workspaceId).put("sessionId", sessionId);
    }

    private static void requireScope(TenantContext tenant, String sessionId, JsonNode key) {
        if (!tenant.tenantId().equals(key.path("tenantId").asText())
                || !sessionId.equals(key.path("sessionId").asText())) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "managed_tool_publication_scope", "Publication Session scope conflicts");
        }
    }
}

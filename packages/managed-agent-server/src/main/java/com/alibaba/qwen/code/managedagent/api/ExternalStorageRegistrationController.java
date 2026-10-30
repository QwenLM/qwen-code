package com.alibaba.qwen.code.managedagent.api;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistration;
import com.alibaba.qwen.code.managedagent.persistence.ExternalStorageRegistrationStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.boot.autoconfigure.web.ServerProperties;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@RestController
public final class ExternalStorageRegistrationController {
    private final ExternalStorageRegistrationStore store;
    private final ManagedAgentProperties properties;
    private final ServerProperties server;
    private final ObjectMapper json = new ObjectMapper()
            .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION)
            .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT);

    public ExternalStorageRegistrationController(ExternalStorageRegistrationStore store,
            ManagedAgentProperties properties, ServerProperties server) {
        this.store = store;
        this.properties = properties;
        this.server = server;
    }

    public record Request(ExternalStorageRegistration.ExternalStorageIdentity identity,
            ExternalStorageRegistration.StorageAlias alias, String idempotencyKey, String requestId) {
    }

    public record PublishRequest(String storageId, String providerId, long registrationRevision,
            String actorId, String displayName, String idempotencyKey, String requestId) {
    }

    @PostMapping(value = "/internal/managed-workspaces/v1/workspaces:publish-external", consumes = "application/json")
    public ResponseEntity<ExternalStorageRegistrationStore.WorkspacePublication> publish(
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        byte[] bytes = operatorPayload(request, response);
        PublishRequest input;
        try {
            input = json.readValue(bytes, PublishRequest.class);
            if (input == null || input.requestId() != null && !input.requestId().matches("[\\x21-\\x7e]{1,128}")) {
                throw new IllegalArgumentException();
            }
        } catch (IOException | IllegalArgumentException error) {
            throw new RuntimeBrokerException(400, "invalid_external_workspace", "Invalid external Workspace publication.", false);
        }
        RequestIdFilter.useClientId(request, response, input.requestId());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore()).body(store.publishWorkspace(
                request.getHeader(TenantContextFilter.HEADER), input.idempotencyKey(), input.storageId(),
                input.providerId(), input.registrationRevision(), input.actorId(), input.displayName()));
    }

    @PostMapping(value = "/internal/managed-workspaces/v1/storage:register-external", consumes = "application/json")
    public ResponseEntity<ExternalStorageRegistrationStore.Receipt> register(
            HttpServletRequest request, HttpServletResponse response) throws IOException {
        byte[] bytes = operatorPayload(request, response);
        String tenant = request.getHeader(TenantContextFilter.HEADER);
        Request input;
        ExternalStorageRegistration registration;
        try {
            input = json.readValue(bytes, Request.class);
            if (input == null || input.requestId() != null && !input.requestId().matches("[\\x21-\\x7e]{1,128}")) {
                throw new IllegalArgumentException();
            }
            registration = new ExternalStorageRegistration(input.identity(), input.alias());
        } catch (IOException | IllegalArgumentException error) {
            throw new RuntimeBrokerException(400, "invalid_external_storage_registration",
                    "Invalid external storage registration.", false);
        }
        RequestIdFilter.useClientId(request, response, input.requestId());
        return ResponseEntity.ok().cacheControl(CacheControl.noStore())
                .body(store.registerExternalStorage(tenant, input.idempotencyKey(), registration));
    }

    private byte[] operatorPayload(HttpServletRequest request, HttpServletResponse response) throws IOException {
        response.setHeader("Cache-Control", "no-store");
        var internal = properties.getInternalServer();
        boolean loopbackListener = internal.getPort() > 0
                ? request.getLocalPort() == internal.getPort() && loopback(internal.getAddress())
                : server.getAddress() != null && server.getAddress().isLoopbackAddress();
        String token = properties.getRuntimeBroker().getToken();
        String authorization = request.getHeader("Authorization");
        if (!loopbackListener || !loopback(request.getLocalAddr()) || !loopback(request.getRemoteAddr())
                || token == null || token.isBlank() || authorization == null || authorization.length() > 4096
                || !MessageDigest.isEqual(("Bearer " + token).getBytes(StandardCharsets.UTF_8),
                        authorization.getBytes(StandardCharsets.UTF_8))) {
            throw new RuntimeBrokerException(403, "external_storage_registration_denied",
                    "External storage registration requires a loopback operator credential.", false);
        }
        byte[] bytes = request.getInputStream().readNBytes(16385);
        if (bytes.length > 16384) {
            throw new RuntimeBrokerException(413, "payload_too_large", "Registration payload exceeds the limit.", false);
        }
        return bytes;
    }

    private static boolean loopback(String address) {
        return "127.0.0.1".equals(address) || "::1".equals(address) || "0:0:0:0:0:0:0:1".equals(address);
    }
}

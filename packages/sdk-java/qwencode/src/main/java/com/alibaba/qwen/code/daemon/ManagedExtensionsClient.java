package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;

import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.encode;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.hex;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.identity;
import static com.alibaba.qwen.code.daemon.ManagedHttpTransport.sha256;

/** Signed public Managed package, configuration and recovery APIs. No mutation is retried automatically. */
public final class ManagedExtensionsClient {
    private static final long MAXIMUM_ARCHIVE_BYTES = 100L * 1024 * 1024;
    private final ManagedHttpTransport transport;

    public ManagedExtensionsClient(URI baseUri, String tenantId, String actorId, byte[] signingKey) {
        this(new ManagedHttpTransport(baseUri, tenantId, actorId, signingKey));
    }

    ManagedExtensionsClient(ManagedHttpTransport transport) {
        this.transport = transport;
    }

    public Map<String, Object> catalog(String workspaceId) {
        return json("GET", workspace(workspaceId), null, null);
    }

    public Map<String, Object> publish(String workspaceId, String extensionId, Path archive,
            Map<String, Object> manifest, String idempotencyKey) {
        Path snapshot = null;
        try {
            snapshot = Files.createTempFile("qwen-managed-package-", ".archive");
            String digest = archiveDigest(archive, snapshot);
            String encoded = Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(JsonSupport.encode(manifest).getBytes(StandardCharsets.UTF_8));
            String route = extensionId == null ? workspace(workspaceId) + "?packageDigest=" + digest + "&manifest=" + encoded
                    : workspace(workspaceId) + "/" + segment(extensionId) + "/packages/" + digest + "?manifest=" + encoded;
            return send(extensionId == null ? "POST" : "PUT", route, digest,
                    HttpRequest.BodyPublishers.ofFile(snapshot), "application/octet-stream", identity(idempotencyKey));
        } catch (IOException error) {
            throw new DaemonTransportException("The package archive could not be read", error);
        } finally {
            if (snapshot != null) {
                try {
                    Files.deleteIfExists(snapshot);
                } catch (IOException error) {
                    snapshot.toFile().deleteOnExit();
                }
            }
        }
    }

    public Map<String, Object> packageVersion(String workspaceId, String extensionId, long revision, String digest) {
        return json("GET", workspace(workspaceId) + "/" + segment(extensionId) + "/packages/" + revision
                + "?packageDigest=" + segment(digest), null, null);
    }

    public Map<String, Object> previewImport(String workspaceId, Path input, Map<String, Object> metadata) {
        return importInput(workspaceId, null, input, metadata, null, true);
    }

    public Map<String, Object> importSource(String workspaceId, String providerId, String kind,
            String resourceId, String revision, Map<String, Object> target, String idempotencyKey) {
        return json("POST", workspace(workspaceId) + "/source-imports", Map.of("reference", Map.of(
                "providerId", providerId, "kind", kind, "resourceId", resourceId, "revision", revision), "target", target),
                identity(idempotencyKey));
    }

    public Map<String, Object> sourceImportReceipt(String workspaceId, String operationId) {
        return json("GET", workspace(workspaceId) + "/source-imports/" + segment(operationId), null, null);
    }

    public Map<String, Object> lookupSourceImport(String workspaceId, String idempotencyKey) {
        return json("GET", workspace(workspaceId) + "/source-imports", null, identity(idempotencyKey));
    }

    public Map<String, Object> importPackage(String workspaceId, String extensionId, Path input,
            Map<String, Object> metadata, String idempotencyKey) {
        return importInput(workspaceId, extensionId, input, metadata, identity(idempotencyKey), false);
    }

    private Map<String, Object> importInput(String workspaceId, String extensionId, Path input,
            Map<String, Object> metadata, String key, boolean preview) {
        Path snapshot = null;
        try {
            snapshot = Files.createTempFile("qwen-managed-import-", ".input");
            String digest = archiveDigest(input, snapshot);
            Map<String, Object> bound = new java.util.LinkedHashMap<>(metadata);
            bound.put("sourceDigest", digest);
            String encoded = JsonSupport.encode(bound);
            if (encoded.getBytes(StandardCharsets.UTF_8).length > 16 * 1024) {
                throw new IllegalArgumentException("Import metadata exceeds 16 KiB");
            }
            String route = workspace(workspaceId) + "/imports" + (preview ? "/preview" : "")
                    + "?metadata=" + segment(encoded) + (extensionId == null ? "" : "&extensionId=" + segment(extensionId));
            return send("POST", route, digest, HttpRequest.BodyPublishers.ofFile(snapshot), "application/octet-stream", key, Duration.ofMinutes(10));
        } catch (IOException error) {
            throw new DaemonTransportException("The import input could not be read", error);
        } finally {
            if (snapshot != null) {
                try {
                    Files.deleteIfExists(snapshot);
                } catch (IOException error) {
                    snapshot.toFile().deleteOnExit();
                }
            }
        }
    }

    public Map<String, Object> inspectPackage(String workspaceId, String extensionId, long revision, String digest) {
        return json("GET", workspace(workspaceId) + "/" + segment(extensionId) + "/packages/" + revision
                + "/inspection?packageDigest=" + segment(digest), null, null);
    }

    public Map<String, Object> lookupPackageOperation(String workspaceId, String kind, String key) {
        return json("POST", workspace(workspaceId) + "/operations/lookup", Map.of("kind", kind, "idempotencyKey", identity(key)), null);
    }

    public Map<String, Object> lookupConfigurationOperation(String sessionId, String key) {
        return json("POST", session(sessionId) + "/operations/lookup", Map.of("idempotencyKey", identity(key)), null);
    }

    public Map<String, Object> runtimeSkillCandidates(String sessionId) {
        return json("GET", session(sessionId) + "/skills/candidates", null, null);
    }

    public Map<String, Object> runtimeSkillSnapshot(String sessionId, Map<String, Object> request) {
        return json("POST", session(sessionId) + "/skills/snapshot", request, null);
    }

    public Map<String, Object> importRuntimeSkill(String sessionId, Map<String, Object> request, String key) {
        return json("POST", session(sessionId) + "/skills/imports", request, identity(key));
    }

    public Map<String, Object> settings(String workspaceId, String extensionId) {
        return json("GET", workspace(workspaceId) + "/" + segment(extensionId) + "/settings", null, null);
    }

    public Map<String, Object> saveSettings(String workspaceId, String extensionId, long expectedRevision,
            Map<String, String> values, String idempotencyKey) {
        return json("POST", workspace(workspaceId) + "/" + segment(extensionId) + "/settings",
                Map.of("expectedRevision", expectedRevision, "values", values), identity(idempotencyKey));
    }

    public Map<String, Object> packageOperation(String workspaceId, String operationId) {
        return json("GET", workspace(workspaceId) + "/operations/" + segment(operationId), null, null);
    }

    public Map<String, Object> configuration(String sessionId) {
        return json("GET", session(sessionId), null, null);
    }

    public Map<String, Object> apply(String sessionId, long expectedConfigRevision,
            List<Map<String, Object>> pins, String idempotencyKey) {
        return json("POST", session(sessionId), Map.of("expectedConfigRevision", expectedConfigRevision, "extensions", pins),
                identity(idempotencyKey));
    }

    public Map<String, Object> configurationOperation(String sessionId, String operationId) {
        return json("GET", session(sessionId) + "/operations/" + segment(operationId), null, null);
    }

    public Map<String, Object> continueOperation(String sessionId, String operationId) {
        return json("POST", session(sessionId) + "/operations/" + segment(operationId) + "/continue", Map.of(), null);
    }

    public Map<String, Object> recoverPrevious(String sessionId, String operationId) {
        return json("POST", session(sessionId) + "/operations/" + segment(operationId) + "/recover-previous", Map.of(), null);
    }

    private Map<String, Object> json(String method, String route, Map<String, Object> body, String key) {
        byte[] bytes = body == null ? new byte[0] : JsonSupport.encode(body).getBytes(StandardCharsets.UTF_8);
        if (bytes.length > HttpSupport.MAXIMUM_JSON_BYTES) {
            throw new IllegalArgumentException("Managed request exceeds its JSON limit");
        }
        return send(method, route, hex(sha256().digest(bytes)), HttpRequest.BodyPublishers.ofByteArray(bytes),
                "application/json; charset=utf-8", key);
    }

    private Map<String, Object> send(String method, String route, String digest, HttpRequest.BodyPublisher body,
            String contentType, String key) {
        return send(method, route, digest, body, contentType, key, Duration.ofMinutes(5));
    }

    private Map<String, Object> send(String method, String route, String digest, HttpRequest.BodyPublisher body,
            String contentType, String key, Duration timeout) {
        String operation = method + " Managed extensions";
        int maximumBytes = route.contains("/imports") || route.contains("/inspection") || route.contains("/skills/")
                ? 8 * 1024 * 1024 : HttpSupport.MAXIMUM_JSON_BYTES;
        HttpRequest request = transport.signedRequest(method, route, digest, key)
                .timeout(timeout).header("Content-Type", contentType).method(method, body).build();
        return transport.sendJson(request, 200, maximumBytes, operation);
    }

    private static String archiveDigest(Path archive, Path snapshot) throws IOException {
        if (!Files.isRegularFile(archive) || Files.size(archive) > MAXIMUM_ARCHIVE_BYTES) {
            throw new IllegalArgumentException("Archive must be a regular file of at most 100 MiB");
        }
        MessageDigest digest = sha256();
        long count = 0;
        byte[] buffer = new byte[64 * 1024];
        try (InputStream input = Files.newInputStream(archive);
                var output = Files.newOutputStream(snapshot, StandardOpenOption.TRUNCATE_EXISTING)) {
            int read;
            while ((read = input.read(buffer)) != -1) {
                count += read;
                if (count > MAXIMUM_ARCHIVE_BYTES) {
                    throw new IllegalArgumentException("Archive exceeds 100 MiB");
                }
                digest.update(buffer, 0, read);
                output.write(buffer, 0, read);
            }
        }
        return hex(digest.digest());
    }

    private static String segment(String value) {
        return encode(identity(value));
    }

    private static String workspace(String id) {
        return "v1/agents/workspaces/" + segment(id) + "/extensions";
    }

    private static String session(String id) {
        return "v1/agents/sessions/" + segment(id) + "/extensions";
    }
}

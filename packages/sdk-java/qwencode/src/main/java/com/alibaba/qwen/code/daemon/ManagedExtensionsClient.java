package com.alibaba.qwen.code.daemon;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.Map;

/** Signed public Managed package, configuration and recovery APIs. No mutation is retried automatically. */
public final class ManagedExtensionsClient {
    private static final long MAXIMUM_ARCHIVE_BYTES = 100L * 1024 * 1024;
    private final URI baseUri;
    private final String tenantId;
    private final String actorId;
    private final byte[] signingKey;
    private final HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NEVER).build();

    public ManagedExtensionsClient(URI baseUri, String tenantId, String actorId, byte[] signingKey) {
        if (baseUri == null || !List.of("http", "https").contains(baseUri.getScheme())
                || baseUri.getHost() == null || baseUri.getUserInfo() != null
                || baseUri.getRawQuery() != null || baseUri.getRawFragment() != null) {
            throw new IllegalArgumentException("Invalid Managed API base URI");
        }
        this.baseUri = URI.create(baseUri.toString().replaceAll("/+$", "") + "/");
        this.tenantId = header(tenantId);
        this.actorId = header(actorId);
        if (signingKey == null || signingKey.length == 0) {
            throw new IllegalArgumentException("A signing key is required");
        }
        this.signingKey = signingKey.clone();
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
                    HttpRequest.BodyPublishers.ofFile(snapshot), "application/octet-stream", header(idempotencyKey));
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

    public Map<String, Object> settings(String workspaceId, String extensionId) {
        return json("GET", workspace(workspaceId) + "/" + segment(extensionId) + "/settings", null, null);
    }

    public Map<String, Object> saveSettings(String workspaceId, String extensionId, long expectedRevision,
            Map<String, String> values, String idempotencyKey) {
        return json("POST", workspace(workspaceId) + "/" + segment(extensionId) + "/settings",
                Map.of("expectedRevision", expectedRevision, "values", values), header(idempotencyKey));
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
                header(idempotencyKey));
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
        URI target = baseUri.resolve(route);
        String timestamp = Long.toString(System.currentTimeMillis() / 1000);
        String canonical = "qwen-broker-auth-v1\n" + method + "\n" + target.getRawPath() + "\n"
                + (target.getRawQuery() == null ? "" : target.getRawQuery()) + "\n" + tenantId + "\n" + actorId
                + "\n" + timestamp + "\n" + digest + "\n" + (key == null ? "" : key);
        HttpRequest.Builder request = HttpRequest.newBuilder(target).timeout(Duration.ofMinutes(5))
                .header("X-Qwen-Tenant-Id", tenantId).header("X-Qwen-Actor-Id", actorId)
                .header("X-Qwen-Signature-Timestamp", timestamp).header("X-Qwen-Signature", "v1=" + signature(canonical))
                .header("Content-Type", contentType).method(method, body);
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        String operation = method + " Managed extensions";
        try {
            HttpSupport.Response response = HttpSupport.consume(http.send(request.build(), HttpSupport.bodyHandler()), operation);
            DaemonClient.requireStatus(response, 200, operation);
            return JsonSupport.parseObject(response.getBody(), operation);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new DaemonTransportException(operation + " interrupted; query the original operation", error);
        } catch (IOException error) {
            throw new DaemonTransportException(operation + " outcome is unconfirmed; query or retry the original operation", error);
        }
    }

    private String signature(String canonical) {
        try {
            Mac hmac = Mac.getInstance("HmacSHA256");
            hmac.init(new SecretKeySpec(signingKey, "HmacSHA256"));
            return hex(hmac.doFinal(canonical.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException("HmacSHA256 is unavailable", error);
        }
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

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) {
            value.append(Character.forDigit((item >>> 4) & 15, 16)).append(Character.forDigit(item & 15, 16));
        }
        return value.toString();
    }

    private static String header(String value) {
        if (value == null || value.isEmpty() || value.length() > 512 || value.chars().anyMatch(c -> c < 32 || c == 127)) {
            throw new IllegalArgumentException("Invalid Managed request identity");
        }
        return value;
    }

    private static String segment(String value) {
        return URLEncoder.encode(header(value), StandardCharsets.UTF_8).replace("+", "%20");
    }

    private static String workspace(String id) {
        return "v1/agents/workspaces/" + segment(id) + "/extensions";
    }

    private static String session(String id) {
        return "v1/agents/sessions/" + segment(id) + "/extensions";
    }
}

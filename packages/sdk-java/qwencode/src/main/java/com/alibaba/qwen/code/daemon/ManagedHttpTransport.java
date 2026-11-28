package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

final class ManagedHttpTransport {
    private final URI baseUri;
    private final String tenantId;
    private final String actorId;
    private final byte[] signingKey;
    private final HttpClient http = HttpClient.newBuilder()
            .followRedirects(HttpClient.Redirect.NEVER).build();

    ManagedHttpTransport(URI baseUri, String tenantId, String actorId, byte[] signingKey) {
        if (baseUri == null || !List.of("http", "https").contains(baseUri.getScheme())
                || baseUri.getHost() == null || baseUri.getUserInfo() != null
                || baseUri.getRawQuery() != null || baseUri.getRawFragment() != null) {
            throw new IllegalArgumentException("Invalid Managed API base URI");
        }
        this.baseUri = URI.create(baseUri.toASCIIString().replaceAll("/+$", "") + "/");
        this.tenantId = identity(tenantId);
        this.actorId = identity(actorId);
        if (signingKey == null || signingKey.length == 0) {
            throw new IllegalArgumentException("A signing key is required");
        }
        this.signingKey = signingKey.clone();
    }

    HttpRequest.Builder signedRequest(String method, String route, String digest, String key) {
        URI target = baseUri.resolve(route);
        String timestamp = Long.toString(System.currentTimeMillis() / 1000);
        String canonical = "qwen-broker-auth-v1\n" + method + "\n" + target.getRawPath() + "\n"
                + (target.getRawQuery() == null ? "" : target.getRawQuery()) + "\n" + tenantId + "\n" + actorId
                + "\n" + timestamp + "\n" + digest + "\n" + (key == null ? "" : key);
        HttpRequest.Builder request = HttpRequest.newBuilder(target)
                .header("X-Qwen-Tenant-Id", tenantId).header("X-Qwen-Actor-Id", actorId)
                .header("X-Qwen-Signature-Timestamp", timestamp)
                .header("X-Qwen-Signature", "v1=" + signature(canonical));
        if (key != null) {
            request.header("Idempotency-Key", key);
        }
        return request;
    }

    Map<String, Object> sendJson(HttpRequest request, int status, int maximumBytes, String operation) {
        HttpSupport.Response response = HttpSupport.consume(
                send(request, HttpSupport.bodyHandler(maximumBytes), operation), operation);
        DaemonClient.requireStatus(response, status, operation);
        return JsonSupport.parseObject(response.getBody(), operation);
    }

    InputStream openEventStream(HttpRequest request) {
        String operation = "Open Managed event stream";
        HttpResponse<InputStream> response = send(request, HttpResponse.BodyHandlers.ofInputStream(), operation);
        InputStream body = response.body();
        try {
            if (response.statusCode() != 200) {
                DaemonClient.requireStatus(new HttpSupport.Response(response.statusCode(),
                        HttpSupport.readError(body, operation)), 200, operation);
            }
            String type = response.headers().firstValue("Content-Type").orElse("");
            if (!type.split(";", 2)[0].trim().equalsIgnoreCase("text/event-stream")) {
                throw new DaemonProtocolException(operation + " did not receive an SSE response");
            }
            List<String> encodings = response.headers().allValues("Content-Encoding");
            if (encodings.size() > 1 || (encodings.size() == 1
                    && !encodings.get(0).trim().equalsIgnoreCase("identity"))) {
                throw new DaemonProtocolException(operation + " received an unsupported Content-Encoding");
            }
            return body;
        } catch (RuntimeException failure) {
            try {
                body.close();
            } catch (IOException closeFailure) {
                failure.addSuppressed(closeFailure);
            }
            throw failure;
        }
    }

    private <T> HttpResponse<T> send(HttpRequest request, HttpResponse.BodyHandler<T> handler, String operation) {
        try {
            return http.send(request, handler);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new DaemonTransportException(operation + " interrupted", error);
        } catch (IOException error) {
            throw new DaemonTransportException(operation + " outcome is unconfirmed", error);
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

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }

    static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte item : bytes) {
            value.append(Character.forDigit((item >>> 4) & 15, 16)).append(Character.forDigit(item & 15, 16));
        }
        return value.toString();
    }

    static String identity(String value) {
        if (value == null || value.isEmpty() || value.length() > 512
                || value.chars().anyMatch(c -> c < 32 || c == 127)) {
            throw new IllegalArgumentException("Invalid Managed request identity");
        }
        return value;
    }

    static String encode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }
}

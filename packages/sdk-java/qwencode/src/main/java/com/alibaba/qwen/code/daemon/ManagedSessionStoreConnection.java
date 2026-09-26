package com.alibaba.qwen.code.daemon;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/** Session-scoped connection metadata for the Hosted Harness durable store. */
public final class ManagedSessionStoreConnection {
    private static final Pattern TENANT_PATTERN = Pattern.compile(
            "^[A-Za-z0-9._:-]{1,128}$");
    private final URI baseUri;
    private final String tenantId;
    private final String workspaceId;
    private final String writerId;
    private final long leaseDurationMs;

    private ManagedSessionStoreConnection(Builder builder) {
        this.baseUri = requireBaseUri(builder.baseUri);
        this.tenantId = requireText(builder.tenantId, "tenantId", 128);
        if (!TENANT_PATTERN.matcher(tenantId).matches()) {
            throw new IllegalArgumentException("tenantId is invalid");
        }
        this.workspaceId = requireText(builder.workspaceId,
                "workspaceId", 512);
        this.writerId = requireText(builder.writerId, "writerId", 512);
        if (builder.leaseDuration == null) {
            throw new IllegalArgumentException(
                    "leaseDuration must not be null");
        }
        this.leaseDurationMs = builder.leaseDuration.toMillis();
        if (leaseDurationMs < 1_000 || leaseDurationMs > 300_000) {
            throw new IllegalArgumentException(
                    "leaseDuration must be between 1 and 300 seconds");
        }
    }

    public static Builder builder() {
        return new Builder();
    }

    Map<String, Object> toJson() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("baseUrl", stripTrailingSlash(baseUri.toString()));
        result.put("tenantId", tenantId);
        result.put("workspaceId", workspaceId);
        result.put("writerId", writerId);
        result.put("leaseDurationMs", leaseDurationMs);
        return result;
    }

    private static URI requireBaseUri(URI value) {
        if (value == null || value.toString().length() > 2048
                || value.getHost() == null
                || !("http".equalsIgnoreCase(value.getScheme())
                        || "https".equalsIgnoreCase(value.getScheme()))
                || value.getUserInfo() != null || value.getQuery() != null
                || value.getFragment() != null) {
            throw new IllegalArgumentException(
                    "baseUri must be an HTTP(S) URL without credentials,"
                            + " query, or fragment");
        }
        return value;
    }

    private static String requireText(String value, String label,
            int maxBytes) {
        if (value == null || value.isEmpty()
                || value.getBytes(StandardCharsets.UTF_8).length > maxBytes
                || value.chars().anyMatch(character -> character < 0x20
                        || character == 0x7f)) {
            throw new IllegalArgumentException(label + " is invalid");
        }
        return value;
    }

    private static String stripTrailingSlash(String value) {
        return value.endsWith("/") ? value.substring(0, value.length() - 1)
                : value;
    }

    public static final class Builder {
        private URI baseUri;
        private String tenantId;
        private String workspaceId;
        private String writerId;
        private Duration leaseDuration = Duration.ofSeconds(60);

        private Builder() {
        }

        public Builder baseUri(URI baseUri) {
            this.baseUri = baseUri;
            return this;
        }

        public Builder tenantId(String tenantId) {
            this.tenantId = tenantId;
            return this;
        }

        public Builder workspaceId(String workspaceId) {
            this.workspaceId = workspaceId;
            return this;
        }

        public Builder writerId(String writerId) {
            this.writerId = writerId;
            return this;
        }

        public Builder leaseDuration(Duration leaseDuration) {
            this.leaseDuration = leaseDuration;
            return this;
        }

        public ManagedSessionStoreConnection build() {
            return new ManagedSessionStoreConnection(this);
        }
    }
}

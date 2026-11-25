package com.alibaba.qwen.code.managedagent.contracts.extensions;

import java.net.URI;
import java.time.Instant;

public interface AgentBootstrapBundleSource {
    String id();

    Resolved resolve(ManagedExtensionSource.Context context, BundleRef ref);

    record BundleRef(String providerId, String resourceId,
            String sourceRevision, String expectedDigest,
            Long expectedLength) {
        public BundleRef {
            if (providerId == null || !providerId.matches("[a-z][a-z0-9-]{0,63}")
                    || resourceId == null || resourceId.isBlank()
                    || sourceRevision == null
                    || !sourceRevision.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
                    || "latest".equalsIgnoreCase(sourceRevision)) {
                throw new IllegalArgumentException("An exact bundle reference is required");
            }
            if (expectedDigest != null && !expectedDigest.matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException("expectedDigest must be lowercase SHA-256 hex");
            }
            if (expectedLength != null && expectedLength <= 0) {
                throw new IllegalArgumentException("expectedLength must be positive");
            }
        }
    }

    record Resolved(BundleRef ref, Download download) {
        public Resolved {
            if (ref == null || download == null) {
                throw new IllegalArgumentException("Bundle download information is incomplete");
            }
        }
    }

    record Download(URI signedUri, Instant expiresAt, String contentType) {
        public Download {
            if (signedUri == null || !signedUri.isAbsolute() || expiresAt == null) {
                throw new IllegalArgumentException("A signed URI and its expiry are required");
            }
            if (contentType == null || contentType.isBlank()) {
                throw new IllegalArgumentException("contentType is required");
            }
        }

        @Override
        public String toString() {
            return "Download[signedUri=<redacted>, expiresAt=" + expiresAt + "]";
        }
    }
}

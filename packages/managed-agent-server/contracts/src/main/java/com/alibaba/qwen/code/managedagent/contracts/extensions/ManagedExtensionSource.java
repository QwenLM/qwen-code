package com.alibaba.qwen.code.managedagent.contracts.extensions;

import com.fasterxml.jackson.annotation.JsonAnySetter;
import com.fasterxml.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.InputStream;
import java.time.Instant;

/** Application-owned assets. Implementations authorize each resolve and never change a revision's bytes. */
public interface ManagedExtensionSource {
    String id();
    Resolved resolve(Context context, Reference reference) throws IOException;
    InputStream open(Context context, Resolved source) throws IOException;

    record Context(String tenantId, String actorId, String workspaceId, String requestId, Instant deadline) {
        public void checkDeadline() throws IOException {
            if (!Instant.now().isBefore(deadline) || Thread.currentThread().isInterrupted()) {
                throw new IOException("Extension source deadline exceeded");
            }
        }
    }

    record Reference(String providerId, String kind, String resourceId, String revision) {
        public Reference {
            if (providerId == null || !providerId.matches("[a-z][a-z0-9-]{0,63}")
                    || !("skill".equals(kind) || "extension".equals(kind))
                    || resourceId == null || resourceId.isBlank() || resourceId.length() > 512
                    || resourceId.chars().anyMatch(Character::isISOControl)
                    || revision == null || !revision.matches("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
                    || "latest".equalsIgnoreCase(revision)) {
                throw new IllegalArgumentException("An exact extension source reference is required");
            }
        }

        @JsonAnySetter
        public void rejectUnknown(String name, JsonNode value) {
            throw new IllegalArgumentException("Unknown extension source field");
        }
    }

    /** archiveId is private adapter state, not a URL, public response or durable credential. */
    record Resolved(Reference reference, String archiveId, String expectedDigest) {
        @Override public String toString() { return "Resolved[reference=" + reference + ", archiveId=redacted]"; }
    }

    /** Use NOT_FOUND for both nonexistent and inaccessible assets. */
    final class Failure extends RuntimeException {
        public enum Reason { NOT_FOUND, UNAVAILABLE, INVALID_SOURCE }
        private final Reason reason;
        public Failure(Reason reason, Throwable cause) {
            super("Extension source " + reason, cause);
            this.reason = reason;
        }
        public Reason reason() { return reason; }
    }
}

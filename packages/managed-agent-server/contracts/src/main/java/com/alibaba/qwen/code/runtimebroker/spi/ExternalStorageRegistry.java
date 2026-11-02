package com.alibaba.qwen.code.runtimebroker.spi;

import java.util.Optional;

/**
 * Read-only view over the durable EXTERNAL storage registrations an operator
 * wrote through {@code /internal/managed-workspaces/v1/storage:register-external}.
 *
 * <p>This is the only trusted source of external storage identity: the provision
 * request and the boot document never carry a provider identity, and the worker
 * compares the boot against its own adapter-written descriptor. An implementation
 * must return only a row bound to the caller's tenant and alias, and must fail
 * closed (a permanent {@code RuntimeBrokerException}) when the durable record is
 * ambiguous or internally inconsistent rather than picking one.
 */
public interface ExternalStorageRegistry {
    /**
     * Resolves the persisted registration for one tenant-bound alias.
     *
     * @param tenantId          the tenant the placement request is scoped to
     * @param tenantWorkspaceId the alias/Workspace id the request selected
     * @return the registration, or empty when this tenant registered no such alias
     */
    public Optional<RegisteredExternalStorage> find(String tenantId, String tenantWorkspaceId);

    /** One persisted registration, in the shape the boot document needs. */
    public record RegisteredExternalStorage(String providerId, String physicalKey,
            long registrationRevision, String tenantWorkspaceId,
            String aliasPath, String mountRoot) {
        /**
         * Largest integer both sides of the wire represent exactly (2^53-1),
         * mirrored from the persisted registration record; the two must agree
         * or a revision could round on one side only.
         */
        public static final long MAX_REGISTRATION_REVISION = 9_007_199_254_740_991L;

        public RegisteredExternalStorage {
            if (providerId == null || physicalKey == null
                    || tenantWorkspaceId == null || aliasPath == null
                    || mountRoot == null || registrationRevision < 1
                    || registrationRevision > MAX_REGISTRATION_REVISION) {
                throw new IllegalArgumentException(
                        "Invalid external storage registration record.");
            }
        }

        /** Registration content never belongs in a log line or an error body. */
        @Override
        public String toString() {
            return "RegisteredExternalStorage[redacted]";
        }
    }
}

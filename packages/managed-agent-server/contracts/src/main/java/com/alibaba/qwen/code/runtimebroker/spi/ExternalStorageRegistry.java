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

    /** Decodes the persisted identity/alias document, never provider-supplied evidence. */
    static RegisteredExternalStorage decodeRegistration(String encoded) {
        var root = com.alibaba.qwen.code.runtimebroker.JsonCodec.parseObject(
                encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8), "External registration");
        if ("ephemeral".equals(root.get("kind"))) {
            if (!root.keySet().equals(java.util.Set.of("kind", "tenantId", "providerId", "workspaceId",
                    "mountRoot", "registrationRevision"))
                    || !(root.get("registrationRevision") instanceof Number revision)
                    || !(revision instanceof Long || revision instanceof Integer)) {
                throw new IllegalArgumentException("Invalid ephemeral Workspace registration.");
            }
            return new RegisteredExternalStorage((String) root.get("providerId"), null,
                    revision.longValue(), (String) root.get("workspaceId"), (String) root.get("mountRoot"),
                    (String) root.get("mountRoot"), (String) root.get("tenantId"));
        }
        if (!root.keySet().equals(java.util.Set.of("identity", "alias"))
                || !(root.get("identity") instanceof java.util.Map<?, ?> identity)
                || !(root.get("alias") instanceof java.util.Map<?, ?> alias)
                || !identity.keySet().equals(java.util.Set.of("providerId", "physicalKey", "registrationRevision"))
                || !alias.keySet().equals(java.util.Set.of("tenantWorkspaceId", "aliasPath", "mountRoot"))
                || !(identity.get("registrationRevision") instanceof Number revision)
                || !(revision instanceof Long || revision instanceof Integer)) {
            throw new IllegalArgumentException("Invalid external storage registration.");
        }
        return new RegisteredExternalStorage((String) identity.get("providerId"),
                (String) identity.get("physicalKey"), revision.longValue(),
                (String) alias.get("tenantWorkspaceId"), (String) alias.get("aliasPath"),
                (String) alias.get("mountRoot"));
    }

    /** One persisted registration, in the shape the boot document needs. */
    public record RegisteredExternalStorage(String providerId, String physicalKey,
            long registrationRevision, String tenantWorkspaceId,
            String aliasPath, String mountRoot, String ephemeralTenantId) {
        /**
         * Largest integer both sides of the wire represent exactly (2^53-1),
         * mirrored from the persisted registration record; the two must agree
         * or a revision could round on one side only.
         */
        public static final long MAX_REGISTRATION_REVISION = 9_007_199_254_740_991L;

        public RegisteredExternalStorage(String providerId, String physicalKey, long registrationRevision,
                String tenantWorkspaceId, String aliasPath, String mountRoot) {
            this(providerId, physicalKey, registrationRevision, tenantWorkspaceId, aliasPath, mountRoot, null);
        }

        public RegisteredExternalStorage {
            if (providerId == null || !providerId.matches("[A-Za-z0-9._-]{1,128}")
                    || (ephemeralTenantId == null
                            ? physicalKey == null || !physicalKey.matches("[A-Za-z0-9._-]{1,128}")
                            : physicalKey != null || !ephemeralTenantId.matches("[A-Za-z0-9._:-]{1,128}"))
                    || tenantWorkspaceId == null || !tenantWorkspaceId.matches("[A-Za-z0-9._-]{1,128}")
                    || !registeredPath(aliasPath) || !registeredPath(mountRoot) || registrationRevision < 1
                    || registrationRevision > MAX_REGISTRATION_REVISION) {
                throw new IllegalArgumentException(
                        "Invalid external storage registration record.");
            }
        }

        public boolean ephemeral() {
            return ephemeralTenantId != null;
        }

        public String storageKind() {
            return ephemeral() ? "EPHEMERAL" : "EXTERNAL";
        }

        public java.util.Map<String, Object> bootStorage(
                com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed seed) {
            if (ephemeral()) {
                return java.util.Map.of("kind", "ephemeral", "workspaceId", tenantWorkspaceId,
                        "mountRoot", mountRoot, "registrationRevision", registrationRevision,
                        "provisionRequestId", seed.getProvisionRequestId(),
                        "runtimeIncarnation", seed.getGatewayIncarnation());
            }
            return java.util.Map.of("kind", "external", "physicalKey", physicalKey,
                    "aliasPath", aliasPath, "mountRoot", mountRoot,
                    "registrationRevision", registrationRevision);
        }

        public String ownerKey() {
            if (ephemeral()) {
                return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                        "ephemeral-workspace/1", providerId, ephemeralTenantId, tenantWorkspaceId);
            }
            return com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys.key(
                    "external-storage/1", providerId, physicalKey);
        }

        private static boolean registeredPath(String value) {
            return value != null && value.length() <= 2048 && value.startsWith("/")
                    && !value.equals("/") && java.util.Arrays.stream(value.substring(1).split("/", -1))
                            .allMatch(part -> part.matches("[A-Za-z0-9._-]+")
                                    && !part.equals(".") && !part.equals(".."));
        }

        /** Registration content never belongs in a log line or an error body. */
        @Override
        public String toString() {
            return "RegisteredExternalStorage[redacted]";
        }
    }
}

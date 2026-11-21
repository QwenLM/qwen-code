package com.alibaba.qwen.code.managedagent.contracts.persistence;

import com.alibaba.qwen.code.runtimebroker.schema.ManagedSchemaKeys;

/** Operator metadata only; registration does not attest or mount storage. */
public record ExternalStorageRegistration(ExternalStorageIdentity identity, StorageAlias alias) {
    public ExternalStorageRegistration {
        if (identity == null || alias == null) {
            throw invalid();
        }
    }

    public record ExternalStorageIdentity(String providerId, String physicalKey, long registrationRevision) {
        /**
         * The largest integer both sides of the wire represent exactly (2^53-1):
         * above it a JSON number may round, so a revision would stop identifying
         * one registration.
         */
        public static final long MAX_REGISTRATION_REVISION = 9_007_199_254_740_991L;

        public ExternalStorageIdentity {
            identifier(providerId);
            identifier(physicalKey);
            if (registrationRevision < 1
                    || registrationRevision > MAX_REGISTRATION_REVISION) {
                throw invalid();
            }
        }

        public String ownerKey() {
            // A revision must never create a second owner for the same provider storage.
            return ManagedSchemaKeys.key("external-storage/1", providerId, physicalKey);
        }

        @Override
        public String toString() {
            return "ExternalStorageIdentity[redacted]";
        }
    }

    public record StorageAlias(String tenantWorkspaceId, String aliasPath, String mountRoot) {
        public StorageAlias {
            identifier(tenantWorkspaceId);
            path(aliasPath);
            path(mountRoot);
        }

        @Override
        public String toString() {
            return "StorageAlias[redacted]";
        }
    }

    private static void identifier(String value) {
        if (value == null || !value.matches("[A-Za-z0-9._-]{1,128}")) {
            throw invalid();
        }
    }

    private static void path(String value) {
        if (value == null || value.length() > 2048 || !value.startsWith("/") || value.equals("/")) {
            throw invalid();
        }
        for (String part : value.substring(1).split("/", -1)) {
            if (!part.matches("[A-Za-z0-9._-]+") || part.equals(".") || part.equals("..")) {
                throw invalid();
            }
        }
    }

    private static IllegalArgumentException invalid() {
        return new IllegalArgumentException("Invalid external storage registration.");
    }
}

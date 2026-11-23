package com.alibaba.qwen.code.runtimebroker.schema;

import java.nio.charset.StandardCharsets;

/**
 * Canonical readable references replacing the identity-hash key layer. Each shape encodes the
 * raw identity tuple reversibly through {@link ManagedIdentityRef}; the byte budget is enforced
 * fail-closed at encode time and sized so every index that carries the reference stays within
 * InnoDB's 3072-byte limit. These are coordination keys, not content digests.
 *
 * <p>References are ASCII text. They are stored in {@code VARBINARY} columns (index cost equals
 * the byte budget) and bound/read as UTF-8 identity strings through the repository helpers, so
 * Java callers handle them as {@code String} and compare them with {@code equals}.
 */
public final class ManagedIdentityRefs {
    /**
     * Scoped resource identity (tenant, Session, resource id); cross-table
     * resource references. Sized to the VARBINARY(1024) reference columns:
     * a 256-character resource id plus the tenant/Session scope percent-encodes
     * past 512 bytes for non-ASCII identities. The budget stays an admission
     * cap — an over-budget tuple is a named 4xx here, never a driver error.
     */
    public static final int RESOURCE_REF_BYTES = 1024;
    /** Durable operation identity; cross-table operation references and the operation unique key. */
    public static final int OPERATION_REF_BYTES = 1024;
    /**
     * Polymorphic resource owner identity within a Session scope. Sized to the
     * ma_resource_ref.owner_ref VARBINARY(1024) column so a 256-character
     * record id under a 64-character Session still encodes; see RESOURCE_REF_BYTES.
     */
    public static final int OWNER_REF_BYTES = 1024;
    /** Tool publication scope (tenant, Workspace, Session). */
    public static final int PUBLICATION_SCOPE_REF_BYTES = 512;
    /** Request receipt scope (tenant, raw scope id). */
    public static final int RECEIPT_SCOPE_REF_BYTES = 768;
    /** Private journal command deduplication (operation, command id). */
    public static final int COMMAND_REF_BYTES = 512;
    /** Canonical physical storage identity shared by logical aliases. */
    public static final int PHYSICAL_REF_BYTES = 512;
    /** Exclusive external Workspace holder (binding, generation, Runtime Session). */
    public static final int HOLDER_REF_BYTES = 512;
    /** Runtime request slot identity (full provision request tuple). */
    public static final int RUNTIME_REQUEST_REF_BYTES = 3000;
    /** Runtime placement scope identity (tenant, Workspace, generation, cwd, capabilities). */
    public static final int RUNTIME_SCOPE_REF_BYTES = 2048;
    /**
     * Actor-private side query scope (tenant, Session, actor). The actor is
     * bounded to 36 code points (at most 144 UTF-8 bytes), which
     * percent-encodes to at most 432 bytes; with a 36-character tenant and a
     * 64-character Session the whole tuple is at most 549 bytes.
     */
    public static final int ACTOR_SCOPE_REF_BYTES = 550;

    private ManagedIdentityRefs() {}

    public static String resourceRef(String tenantId, String sessionId, String resourceId) {
        return text(ManagedIdentityRef.encode(RESOURCE_REF_BYTES, tenantId, sessionId, resourceId));
    }

    public static String operationRef(
            String operationKind,
            String tenantId,
            String scopeKind,
            String scopeId,
            String targetId,
            String operationId) {
        return text(ManagedIdentityRef.encode(OPERATION_REF_BYTES,
                "operation", operationKind, tenantId, scopeKind, scopeId, targetId, operationId));
    }

    /** Tenant-addressed operations (SSH creation, Workspace operations, uploads) omit the target. */
    public static String tenantOperationRef(String operationKind, String tenantId, String operationId) {
        return text(ManagedIdentityRef.encode(OPERATION_REF_BYTES, operationKind, tenantId, operationId));
    }

    public static String publicationScopeRef(String tenantId, String workspaceId, String sessionId) {
        return text(ManagedIdentityRef.encode(PUBLICATION_SCOPE_REF_BYTES, tenantId, workspaceId, sessionId));
    }

    public static String receiptScopeRef(String tenantId, String scopeId) {
        return text(ManagedIdentityRef.encode(RECEIPT_SCOPE_REF_BYTES, tenantId, scopeId));
    }

    public static String commandRef(String operation, String commandId) {
        return requireRef(COMMAND_REF_BYTES, "journal command reference (operation/commandId)", operation, commandId);
    }

    public static String actorScopeRef(String tenantId, String sessionId, String actorId) {
        return text(ManagedIdentityRef.encode(ACTOR_SCOPE_REF_BYTES, tenantId, sessionId, actorId));
    }

    /** Encodes an arbitrary owner/physical/holder/runtime tuple within a named byte budget. */
    public static String ref(int maximumBytes, String... components) {
        return text(ManagedIdentityRef.encode(maximumBytes, components));
    }

    /**
     * Encodes a tuple at an admission boundary, refusing an over-budget identity
     * with a named error rather than letting the encode throw an unnamed overflow
     * from a repository INSERT or replay path. The components' own validators
     * bound characters, not the percent-encoded reference, so the encoded length
     * must be checked where the identity is admitted.
     */
    public static String requireRef(int maximumBytes, String name, String... components) {
        try {
            return ref(maximumBytes, components);
        } catch (IllegalArgumentException overflow) {
            throw new IllegalArgumentException(name + " exceeds its " + maximumBytes
                    + "-byte identity reference budget", overflow);
        }
    }

    private static String text(byte[] encoded) {
        return new String(encoded, StandardCharsets.US_ASCII);
    }
}

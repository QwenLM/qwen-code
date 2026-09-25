package com.alibaba.qwen.code.runtimebroker.managedworkspace;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Objects;

/**
 * The Workspace context a Session committed: which Workspace generation and
 * storage, which relative directory, which frozen configuration, and at which
 * context revision. The context digest is derived from exactly these fields
 * and matches the TypeScript implementation byte for byte; the shared
 * fixtures in {@code managed-workspace-binding-v1.fixtures.json} pin both.
 */
public final class ContextBinding {
    static final String DOMAIN_TAG = "qwen-managed-context-binding-v1";

    private final String tenantId;
    private final String workspaceId;
    private final long workspaceGeneration;
    private final String storageId;
    private final String cwdRelative;
    private final String contextConfigRef;
    private final long contextRevision;
    private final String contextDigest;

    /**
     * @param cwdRelative a directory already in normal form
     * @param contextConfigRef the frozen configuration descriptor recorded at
     *     admission; opaque here
     */
    public ContextBinding(String tenantId, String workspaceId,
            long workspaceGeneration, String storageId, String cwdRelative,
            String contextConfigRef, long contextRevision) {
        this.tenantId = WorkspaceValues.requireIdentifier(tenantId,
                "tenantId");
        this.workspaceId = WorkspaceValues.requireIdentifier(workspaceId,
                "workspaceId");
        this.workspaceGeneration = WorkspaceValues.requirePositive(
                workspaceGeneration, "workspaceGeneration");
        this.storageId = WorkspaceValues.requirePrintableAscii(storageId,
                "storageId", WorkspaceRecord.MAXIMUM_STORAGE_ID_LENGTH);
        if (cwdRelative == null || !isNormalized(cwdRelative)) {
            throw new IllegalArgumentException(
                    "cwdRelative must be a normalized relative directory");
        }
        this.cwdRelative = cwdRelative;
        this.contextConfigRef = WorkspaceValues.requirePrintableAscii(
                contextConfigRef, "contextConfigRef",
                WorkspaceRecord.MAXIMUM_REFERENCE_LENGTH);
        this.contextRevision = WorkspaceValues.requirePositive(
                contextRevision, "contextRevision");
        this.contextDigest = "sha256:" + HexFormat.of().formatHex(
                sha256(encode()));
    }

    public String getTenantId() {
        return tenantId;
    }

    public String getWorkspaceId() {
        return workspaceId;
    }

    public long getWorkspaceGeneration() {
        return workspaceGeneration;
    }

    public String getStorageId() {
        return storageId;
    }

    public String getCwdRelative() {
        return cwdRelative;
    }

    public String getContextConfigRef() {
        return contextConfigRef;
    }

    public long getContextRevision() {
        return contextRevision;
    }

    /**
     * {@code sha256:} and the lowercase hex SHA-256 of the domain tag and the
     * seven fields, each as a 4-byte big-endian length and its UTF-8 bytes.
     */
    public String getContextDigest() {
        return contextDigest;
    }

    // Each item is a 4-byte big-endian length and its UTF-8 bytes. Integers
    // are decimal strings, so a JavaScript peer never needs a 64-bit Number.
    byte[] encode() {
        ByteArrayOutputStream encoded = new ByteArrayOutputStream();
        for (String item : new String[] {DOMAIN_TAG, tenantId, workspaceId,
                Long.toString(workspaceGeneration), storageId, cwdRelative,
                contextConfigRef, Long.toString(contextRevision)}) {
            byte[] bytes = item.getBytes(StandardCharsets.UTF_8);
            encoded.writeBytes(ByteBuffer.allocate(Integer.BYTES)
                    .putInt(bytes.length).array());
            encoded.writeBytes(bytes);
        }
        return encoded.toByteArray();
    }

    private static boolean isNormalized(String value) {
        try {
            return WorkspaceRelativePath.normalize(value).equals(value);
        } catch (WorkspaceException exception) {
            return false;
        }
    }

    private static byte[] sha256(byte[] value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value);
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 is unavailable",
                    exception);
        }
    }

    @Override
    public boolean equals(Object candidate) {
        if (this == candidate) {
            return true;
        }
        if (!(candidate instanceof ContextBinding)) {
            return false;
        }
        ContextBinding other = (ContextBinding) candidate;
        return tenantId.equals(other.tenantId)
                && workspaceId.equals(other.workspaceId)
                && workspaceGeneration == other.workspaceGeneration
                && storageId.equals(other.storageId)
                && cwdRelative.equals(other.cwdRelative)
                && contextConfigRef.equals(other.contextConfigRef)
                && contextRevision == other.contextRevision;
    }

    @Override
    public int hashCode() {
        return Objects.hash(tenantId, workspaceId, workspaceGeneration,
                storageId, cwdRelative, contextConfigRef, contextRevision);
    }
}

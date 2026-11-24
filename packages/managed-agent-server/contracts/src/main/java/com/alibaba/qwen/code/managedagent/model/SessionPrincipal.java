package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;

import java.nio.charset.StandardCharsets;

/**
 * The immutable, verified owner of a non-Workspace Session: the tenant, the
 * user and the DataAgent business actor subject. It is always constructed at
 * a trusted boundary from the verified request context and never from a
 * client body. A null {@code actorSubjectId} means the caller provably
 * carries no business actor; an empty one is rejected.
 */
public record SessionPrincipal(String tenantId, String userId,
        String actorSubjectId) {
    // The ownership columns hold 1024 bytes each. Keep headroom for a
    // future signed encoding while bounding every principal component.
    private static final int MAX_COMPONENT_BYTES = 512;

    public SessionPrincipal {
        if (tenantId == null || tenantId.isBlank()
                || userId == null || userId.isBlank()) {
            throw actorRequired();
        }
        checkComponent("tenant", tenantId);
        checkComponent("actor", userId);
        if (actorSubjectId != null) {
            if (actorSubjectId.isBlank()) {
                throw new ManagedAgentException(400,
                        "invalid_actor",
                        "An actor subject must not be empty or blank.");
            }
            checkComponent("actor subject", actorSubjectId);
        }
    }

    /** An ownership principal with no business actor. */
    public static SessionPrincipal ofUser(String tenantId, String userId) {
        return new SessionPrincipal(tenantId, userId, null);
    }

    /** An ownership principal carrying the business actor subject. */
    public static SessionPrincipal of(String tenantId, String userId,
            String actorSubjectId) {
        return new SessionPrincipal(tenantId, userId, actorSubjectId);
    }

    /** Whether this principal carries a business actor subject. */
    public boolean actorPresent() {
        return actorSubjectId != null;
    }

    /**
     * The receipt actor stamp for a principal-carried entry. 合并 main 的
     * de-hash（#18058）后 stamp 必须适配 VARCHAR(36) 的 actor 列：
     * 无 business actor 的 principal 与 raw twin 完全同形（raw userId 字节，
     * 滚动部署下两种写入臂互相应答）；携带 subject 的 principal 写入
     * "p:" + sha256 前 32 位 的定长摘要。携带 subject 的 replay 宽准入
     * 不再从 stamp 反解 userId，而由 ma_session_principal 所有权行承担
     * （行本就是唯一权威）；raw actor 与带 subject 的 principal 在所有权
     * 门禁处本就不能互换，回执层无需再放行。
     */
    public byte[] receiptActorKey() {
        if (!actorPresent()) {
            return userId.getBytes(StandardCharsets.UTF_8);
        }
        String joined = userId + "\0" + "1" + "\0" + actorSubjectId;
        return ("p:" + sha256Hex(joined).substring(0, 32))
                .getBytes(StandardCharsets.US_ASCII);
    }

    private static String sha256Hex(String value) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(digest);
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    /**
     * The user a principal-encoded receipt stamp names, or null when the
     * bytes are not a principal encoding. A rolling deploy replays through
     * either recording twin, so the raw actor key of the same user must
     * still answer a principal-stamped receipt. The flag and subject
     * members are not re-validated here: the stamp was written by a trusted
     * boundary, and this match only widens replay admission to the user the
     * stamp itself recorded.
     */
    public static String replayUserId(byte[] stamp) {
        if (stamp == null || stamp.length == 0) {
            return null;
        }
        int firstNul = -1;
        int secondNul = -1;
        for (int index = 0; index < stamp.length; index++) {
            if (stamp[index] != 0) {
                continue;
            }
            if (firstNul < 0) {
                firstNul = index;
            } else {
                secondNul = index;
                break;
            }
        }
        // 摘要 stamp（"p:" 前缀）不可逆解：带 subject 的宽准入由所有权行承担。
        if (stamp.length >= 2 && stamp[0] == 'p' && stamp[1] == ':') {
            return null;
        }
        if (firstNul <= 0 || secondNul < 0
                || secondNul - firstNul != 2
                || (stamp[firstNul + 1] != '0' && stamp[firstNul + 1] != '1')) {
            return null;
        }
        String userId = new String(stamp, 0, firstNul, StandardCharsets.UTF_8);
        try {
            new SessionPrincipal("replay", userId, null);
        } catch (ManagedAgentException invalid) {
            return null;
        }
        return userId;
    }

    private static void checkComponent(String name, String value) {
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (character <= 0x1f || (character >= 0x7f && character <= 0x9f)) {
                throw new ManagedAgentException(400,
                        "invalid_actor",
                        "The " + name + " must not contain control characters.");
            }
        }
        if (value.getBytes(StandardCharsets.UTF_8).length
                > MAX_COMPONENT_BYTES) {
            throw new ManagedAgentException(400,
                    "invalid_actor",
                    "The " + name + " is too long.");
        }
    }

    private static ManagedAgentException actorRequired() {
        return new ManagedAgentException(401,
                "actor_required", "A trusted actor is required.");
    }
}

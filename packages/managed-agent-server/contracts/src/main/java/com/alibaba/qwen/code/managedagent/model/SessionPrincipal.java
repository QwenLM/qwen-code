package com.alibaba.qwen.code.managedagent.model;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;

import java.nio.charset.StandardCharsets;

/**
 * The immutable, verified owner of a non-Workspace Session: the tenant, the
 * user and the DataAgent business actor subject. It is always constructed at
 * a trusted boundary from the verified request context and never from a
 * client body. A null {@code actorSubjectId} means the caller provably
 * carries no business actor; an empty one is rejected.
 *
 * <p><b>Inert until a signed adapter supplies it.</b> No production
 * {@code AuthenticatedTenantActor} implementation overrides
 * {@code actorSubjectId()} today, so every live request builds a subjectless
 * principal and the subject member exists only for the schema and the test
 * harness. The receipt encoding below deliberately drops the subject so a
 * receipt stamped by a subjectless caller answers its recorder; the subject
 * joins no derived key until an adapter signs it.
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
     * The receipt actor stamp for a principal-carried entry: the user, the
     * actor-present flag and the subject, NUL-separated. The replay
     * comparison must use this same encoding, never the raw Workspace actor
     * key, or a principal-encoded receipt could not answer its recorder.
     * The subject member stays in the stamp so receipts recorded before the
     * subject axis went inert still replay for their recorder.
     */
    public byte[] receiptActorKey() {
        String joined = userId
                + "\0" + (actorPresent() ? "1" : "0")
                + "\0" + (actorSubjectId == null ? "" : actorSubjectId);
        return joined.getBytes(StandardCharsets.UTF_8);
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

package com.alibaba.qwen.code.managedagent.security;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.codec.digest.HmacAlgorithms;
import org.apache.commons.codec.digest.HmacUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

/**
 * Decides which writer token a Managed Session accepts. With a configured
 * binding key the token is broker-provisioned as an HMAC over the Session
 * scope and self-minted tokens are rejected; without one the legacy
 * first-writer-wins registration keeps serving loopback deployments.
 */
@Component
public class WriterCredentialPolicy {
    private static final String TOKEN_PREFIX = "qwt1_";
    private static final String PLACEMENT_PREFIX = "qwp1_";
    private static final int MIN_BINDING_KEY_BYTES = 32;
    private static final WriterCredentialPolicy UNBOUND =
            new WriterCredentialPolicy((String) null);
    private final byte[] bindingKey;

    @Autowired
    public WriterCredentialPolicy(ManagedAgentProperties properties) {
        this(properties.getSessionStore().getBindingKey());
    }

    private WriterCredentialPolicy(String bindingKey) {
        byte[] key = StringUtils.isBlank(bindingKey)
                ? null : bindingKey.getBytes(StandardCharsets.UTF_8);
        // A weak key can be brute-forced from one observed token.
        if (key != null && key.length < MIN_BINDING_KEY_BYTES) {
            throw new IllegalStateException(
                    "qwen.managed-agent.session-store.binding-key must"
                            + " contain at least " + MIN_BINDING_KEY_BYTES
                            + " bytes.");
        }
        this.bindingKey = key;
    }

    public static WriterCredentialPolicy unbound() {
        return UNBOUND;
    }

    public boolean isBound() {
        return bindingKey != null;
    }

    /** The credential the broker hands to a Session's harness. */
    public String issue(String tenantId, String workspaceId,
            String sessionId) {
        if (!isBound()) {
            throw new IllegalStateException(
                    "A writer credential requires a configured binding key.");
        }
        return TOKEN_PREFIX + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac(tenantId, workspaceId, sessionId));
    }

    public String issue(String tenantId, String workspaceId, String sessionId,
            String instanceId, String bootId, long epoch) {
        if (!isBound() || StringUtils.isBlank(instanceId) || StringUtils.isBlank(bootId) || epoch < 1) {
            throw new IllegalStateException("A placement credential requires a binding key and a concrete owner.");
        }
        String owner = DigestUtils.sha256Hex(instanceId + "\0" + bootId);
        String claims = epoch + "_" + owner;
        return PLACEMENT_PREFIX + claims + "_" + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(placementMac(tenantId, workspaceId, sessionId, claims));
    }

    /** Rejects a presented token that is not the Session's credential. */
    public void require(String tenantId, String workspaceId, String sessionId,
            String writerToken) {
        if (isPlacementToken(writerToken)) {
            int signatureAt = writerToken.length() - 44;
            if (isBound() && signatureAt > PLACEMENT_PREFIX.length()
                    && writerToken.charAt(signatureAt) == '_') {
                String claims = writerToken.substring(PLACEMENT_PREFIX.length(), signatureAt);
                if (claims.matches("[1-9][0-9]{0,18}_[0-9a-f]{64}")) {
                    String expected = PLACEMENT_PREFIX + claims + "_" + Base64.getUrlEncoder().withoutPadding()
                            .encodeToString(placementMac(tenantId, workspaceId, sessionId, claims));
                    if (same(expected, writerToken)) {
                        return;
                    }
                }
            }
            throw invalidCredential();
        }
        if (!isBound()) {
            return;
        }
        boolean valid = same(issue(tenantId, workspaceId, sessionId), writerToken);
        if (!valid) {
            throw invalidCredential();
        }
    }

    public void requirePlacement(String tenantId, String workspaceId, String sessionId,
            String instanceId, String bootId, long epoch, String token) {
        if (!isBound() || !same(issue(tenantId, workspaceId, sessionId, instanceId, bootId, epoch), token)) {
            throw invalidCredential();
        }
    }

    public static boolean isPlacementToken(String token) {
        return token != null && token.startsWith(PLACEMENT_PREFIX);
    }

    private byte[] placementMac(String tenant, String workspace, String session, String claims) {
        return new HmacUtils(HmacAlgorithms.HMAC_SHA_256, bindingKey)
                .hmac(("qwen-managed-writer/v2\0" + tenant + "\0" + workspace + "\0" + session + "\0" + claims)
                        .getBytes(StandardCharsets.UTF_8));
    }

    private static boolean same(String expected, String presented) {
        return presented != null && MessageDigest.isEqual(expected.getBytes(StandardCharsets.US_ASCII),
                presented.getBytes(StandardCharsets.US_ASCII));
    }

    private static ManagedAgentException invalidCredential() {
        return new ManagedAgentException(HttpStatus.FORBIDDEN,
                ManagedSessionStoreModels.ERROR_WRITER_CREDENTIAL_INVALID,
                "The writer credential is not valid for this Session.");
    }

    private byte[] mac(String tenantId, String workspaceId,
            String sessionId) {
        String canonical = "qwen-managed-writer/v1\0" + tenantId + "\0"
                + workspaceId + "\0" + sessionId;
        try {
            return new HmacUtils(HmacAlgorithms.HMAC_SHA_256, bindingKey)
                    .hmac(canonical.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            throw new IllegalStateException("HmacSHA256 is unavailable",
                    error);
        }
    }
}

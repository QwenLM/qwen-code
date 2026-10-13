package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * Decides which writer token a Managed Session accepts. With a configured
 * binding key the token is broker-provisioned as an HMAC over the Session
 * scope and self-minted tokens are rejected; without one the legacy
 * first-writer-wins registration keeps serving loopback deployments.
 */
@Component
public class WriterCredentialPolicy {
    private static final String TOKEN_PREFIX = "qwt1_";
    private static final int MIN_BINDING_KEY_BYTES = 32;
    private static final WriterCredentialPolicy UNBOUND =
            new WriterCredentialPolicy((String) null);
    private final byte[] bindingKey;

    @Autowired
    public WriterCredentialPolicy(ManagedAgentProperties properties) {
        this(properties.getSessionStore().getBindingKey());
    }

    private WriterCredentialPolicy(String bindingKey) {
        byte[] key = bindingKey == null || bindingKey.isBlank()
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

    /** Rejects a presented token that is not the Session's credential. */
    public void require(String tenantId, String workspaceId, String sessionId,
            String writerToken) {
        if (!isBound()) {
            return;
        }
        boolean valid = writerToken != null && MessageDigest.isEqual(
                issue(tenantId, workspaceId, sessionId)
                        .getBytes(StandardCharsets.US_ASCII),
                writerToken.getBytes(StandardCharsets.US_ASCII));
        if (!valid) {
            throw new ApiException(HttpStatus.FORBIDDEN,
                    ManagedSessionStoreModels.ERROR_WRITER_CREDENTIAL_INVALID,
                    "The writer credential is not valid for this Session.");
        }
    }

    private byte[] mac(String tenantId, String workspaceId,
            String sessionId) {
        String canonical = "qwen-managed-writer/v1\0" + tenantId + "\0"
                + workspaceId + "\0" + sessionId;
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(bindingKey, "HmacSHA256"));
            return mac.doFinal(canonical.getBytes(StandardCharsets.UTF_8));
        } catch (Exception error) {
            throw new IllegalStateException("HmacSHA256 is unavailable",
                    error);
        }
    }
}

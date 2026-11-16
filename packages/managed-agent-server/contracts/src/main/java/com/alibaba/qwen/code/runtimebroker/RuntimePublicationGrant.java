package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;

/**
 * The original publication authorization passed only to its selected Runtime.
 *
 * <p>{@code expiresAt} is the grant's own absolute millisecond horizon. A
 * worker that keeps its own capture store needs it to bound a channel, since
 * it never sees the control-plane grant; an installed-grant worker ignores it
 * and renews through the control plane as before. Zero means unspecified.
 */
public record RuntimePublicationGrant(String publicationId, String token,
        String serviceBaseUrl, Map<String, Object> binding, long expiresAt) {
    public RuntimePublicationGrant(String publicationId, String token,
            String serviceBaseUrl, Map<String, Object> binding) {
        this(publicationId, token, serviceBaseUrl, binding, 0L);
    }
}

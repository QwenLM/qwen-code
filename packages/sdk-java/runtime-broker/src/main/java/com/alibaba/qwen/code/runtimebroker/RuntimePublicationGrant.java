package com.alibaba.qwen.code.runtimebroker;

import java.util.Map;

/** The original publication authorization passed only to its selected Runtime. */
public record RuntimePublicationGrant(String publicationId, String token,
        String serviceBaseUrl, Map<String, Object> binding) {
}

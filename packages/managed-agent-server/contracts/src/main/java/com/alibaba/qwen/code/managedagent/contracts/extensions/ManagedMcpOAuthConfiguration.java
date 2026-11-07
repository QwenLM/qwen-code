package com.alibaba.qwen.code.managedagent.contracts.extensions;

import java.util.List;
import java.util.Map;

public interface ManagedMcpOAuthConfiguration {
    boolean isEnabled();

    String getCallbackUri();

    String getRuntimeTokenProxyBaseUrl();

    List<String> getIsolatedToolProfiles();

    Map<String, ? extends Provider> getProviders();

    interface Provider {
        String getIssuer();

        String getResourceUri();

        String getResourceMetadataUri();

        String getAuthorizationMetadataUri();

        String getAuthorizationEndpoint();

        String getTokenEndpoint();

        String getRevocationEndpoint();

        String getClientId();

        String getClientSecret();

        List<String> getScopes();

        boolean isAllowPrivateNetwork();

        boolean isAllowInsecureLoopback();
    }
}

package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.contracts.extensions.ManagedMcpOAuthConfiguration;
import org.springframework.boot.context.properties.ConfigurationProperties;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@ConfigurationProperties(prefix = "qwen.managed-agent.mcp-oauth")
public class ManagedMcpOAuthProperties implements ManagedMcpOAuthConfiguration {
    private boolean enabled;
    private String callbackUri;
    private String runtimeTokenProxyBaseUrl;
    private List<String> isolatedToolProfiles = List.of();
    private Map<String, OAuthProvider> providers = new LinkedHashMap<>();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getCallbackUri() {
        return callbackUri;
    }

    public void setCallbackUri(String callbackUri) {
        this.callbackUri = callbackUri;
    }

    public String getRuntimeTokenProxyBaseUrl() {
        return runtimeTokenProxyBaseUrl;
    }

    public void setRuntimeTokenProxyBaseUrl(String value) {
        runtimeTokenProxyBaseUrl = value;
    }

    public List<String> getIsolatedToolProfiles() {
        return isolatedToolProfiles;
    }

    public void setIsolatedToolProfiles(List<String> profiles) {
        this.isolatedToolProfiles = List.copyOf(profiles);
    }

    public Map<String, OAuthProvider> getProviders() {
        return providers;
    }

    public void setProviders(Map<String, OAuthProvider> providers) {
        this.providers = new LinkedHashMap<>(providers);
    }

    public static class OAuthProvider implements ManagedMcpOAuthConfiguration.Provider {
        private String issuer;
        private String resourceUri;
        private String resourceMetadataUri;
        private String authorizationMetadataUri;
        private String authorizationEndpoint;
        private String tokenEndpoint;
        private String revocationEndpoint;
        private String clientId;
        private String clientSecret;
        private List<String> scopes = List.of();
        private boolean allowPrivateNetwork;
        private boolean allowInsecureLoopback;

        public String getIssuer() {
            return issuer;
        }

        public void setIssuer(String value) {
            issuer = value;
        }

        public String getResourceUri() {
            return resourceUri;
        }

        public void setResourceUri(String value) {
            resourceUri = value;
        }

        public String getResourceMetadataUri() {
            return resourceMetadataUri;
        }

        public void setResourceMetadataUri(String value) {
            resourceMetadataUri = value;
        }

        public String getAuthorizationMetadataUri() {
            return authorizationMetadataUri;
        }

        public void setAuthorizationMetadataUri(String value) {
            authorizationMetadataUri = value;
        }

        public String getAuthorizationEndpoint() {
            return authorizationEndpoint;
        }

        public void setAuthorizationEndpoint(String value) {
            authorizationEndpoint = value;
        }

        public String getTokenEndpoint() {
            return tokenEndpoint;
        }

        public void setTokenEndpoint(String value) {
            tokenEndpoint = value;
        }

        public String getRevocationEndpoint() {
            return revocationEndpoint;
        }

        public void setRevocationEndpoint(String value) {
            revocationEndpoint = value;
        }

        public String getClientId() {
            return clientId;
        }

        public void setClientId(String value) {
            clientId = value;
        }

        public String getClientSecret() {
            return clientSecret;
        }

        public void setClientSecret(String value) {
            clientSecret = value;
        }

        public List<String> getScopes() {
            return scopes;
        }

        public void setScopes(List<String> value) {
            scopes = List.copyOf(value);
        }

        public boolean isAllowPrivateNetwork() {
            return allowPrivateNetwork;
        }

        public void setAllowPrivateNetwork(boolean value) {
            allowPrivateNetwork = value;
        }

        public boolean isAllowInsecureLoopback() {
            return allowInsecureLoopback;
        }

        public void setAllowInsecureLoopback(boolean value) {
            allowInsecureLoopback = value;
        }

        @Override
        public String toString() {
            return "McpOAuthProvider[secrets=redacted]";
        }
    }

}

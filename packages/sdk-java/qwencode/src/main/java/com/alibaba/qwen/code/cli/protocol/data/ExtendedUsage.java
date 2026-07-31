package com.alibaba.qwen.code.cli.protocol.data;

import com.alibaba.fastjson2.annotation.JSONField;

/**
 * Extends the Usage class with additional usage information.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class ExtendedUsage extends Usage {
    /**
     * Server tool use information.
     */
    @JSONField(name = "server_tool_use")
    private ServerToolUse serverToolUse;

    /**
     * Service tier information.
     */
    @JSONField(name = "service_tier")
    private String serviceTier;

    /**
     * Cache creation information.
     */
    @JSONField(name = "cache_creation")
    private CacheCreation cacheCreation;

    /**
     * Gets the server tool use information.
     *
     * @return The server tool use information
     */
    public ServerToolUse getServerToolUse() {
        return serverToolUse;
    }

    /**
     * Sets the server tool use information.
     *
     * @param serverToolUse The server tool use information
     */
    public void setServerToolUse(ServerToolUse serverToolUse) {
        this.serverToolUse = serverToolUse;
    }

    /**
     * Gets the service tier information.
     *
     * @return The service tier information
     */
    public String getServiceTier() {
        return serviceTier;
    }

    /**
     * Sets the service tier information.
     *
     * @param serviceTier The service tier information
     */
    public void setServiceTier(String serviceTier) {
        this.serviceTier = serviceTier;
    }

    /**
     * Gets the cache creation information.
     *
     * @return The cache creation information
     */
    public CacheCreation getCacheCreation() {
        return cacheCreation;
    }

    /**
     * Sets the cache creation information.
     *
     * @param cacheCreation The cache creation information
     */
    public void setCacheCreation(CacheCreation cacheCreation) {
        this.cacheCreation = cacheCreation;
    }

    /**
     * Represents server tool use information.
     */
    public static class ServerToolUse {
        /**
         * Number of web search requests.
         */
        @JSONField(name = "web_search_requests")
        private int webSearchRequests;
    }

    /**
     * Represents cache creation information.
     */
    public static class CacheCreation {
        /**
         * Number of ephemeral 1-hour input tokens.
         */
        @JSONField(name = "ephemeral_1h_input_tokens")
        private int ephemeral1hInputTokens;

        /**
         * Number of ephemeral 5-minute input tokens.
         */
        @JSONField(name = "ephemeral_5m_input_tokens")
        private int ephemeral5mInputTokens;

        /**
         * Gets the number of ephemeral 1-hour input tokens.
         *
         * @return The number of ephemeral 1-hour input tokens
         */
        public int getEphemeral1hInputTokens() {
            return ephemeral1hInputTokens;
        }

        /**
         * Sets the number of ephemeral 1-hour input tokens.
         *
         * @param ephemeral1hInputTokens The number of ephemeral 1-hour input tokens
         */
        public void setEphemeral1hInputTokens(int ephemeral1hInputTokens) {
            this.ephemeral1hInputTokens = ephemeral1hInputTokens;
        }

        /**
         * Gets the number of ephemeral 5-minute input tokens.
         *
         * @return The number of ephemeral 5-minute input tokens
         */
        public int getEphemeral5mInputTokens() {
            return ephemeral5mInputTokens;
        }

        /**
         * Sets the number of ephemeral 5-minute input tokens.
         *
         * @param ephemeral5mInputTokens The number of ephemeral 5-minute input tokens
         */
        public void setEphemeral5mInputTokens(int ephemeral5mInputTokens) {
            this.ephemeral5mInputTokens = ephemeral5mInputTokens;
        }
    }
}

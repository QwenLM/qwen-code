package com.alibaba.acp.sdk.protocol.domain.agent;

import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;

/**
 * Agent Capabilities Class
 *
 * Describes functional capabilities supported by the agent, such as loading sessions, prompt capabilities, MCP, etc.
 */
public class AgentCapabilities extends Meta {
    private Boolean loadSession;
    private PromptCapabilities promptCapabilities;
    private McpCapabilities mcp;
    private Meta sessionCapabilities;

    /**
     * Checks if loading sessions is supported
     *
     * @return True if loading sessions is supported, false otherwise
     */
    public Boolean getLoadSession() {
        return loadSession;
    }

    /**
     * Sets loading session support
     *
     * @param loadSession Whether loading sessions is supported
     */
    public void setLoadSession(Boolean loadSession) {
        this.loadSession = loadSession;
    }

    /**
     * Gets the prompt capabilities
     *
     * @return Prompt capabilities object
     */
    public PromptCapabilities getPromptCapabilities() {
        return promptCapabilities;
    }

    /**
     * Sets the prompt capabilities
     *
     * @param promptCapabilities Prompt capabilities object
     */
    public void setPromptCapabilities(PromptCapabilities promptCapabilities) {
        this.promptCapabilities = promptCapabilities;
    }

    /**
     * Gets the MCP capabilities
     *
     * @return MCP capabilities object
     */
    public McpCapabilities getMcp() {
        return mcp;
    }

    /**
     * Gets the session capabilities
     *
     * @return Session capabilities object
     */
    public Meta getSessionCapabilities() {
        return sessionCapabilities;
    }

    /**
     * Sets the session capabilities
     *
     * @param sessionCapabilities Session capabilities object
     */
    public void setSessionCapabilities(Meta sessionCapabilities) {
        this.sessionCapabilities = sessionCapabilities;
    }

    /**
     * Prompt Capabilities Class
     *
     * Describes the agent's support capabilities for different types of prompt content, such as images, audio, and embedded context.
     */
    public static class PromptCapabilities extends Meta {
        private Boolean image;
        private Boolean audio;
        private Boolean embeddedContext;

        /**
         * Checks if images are supported
         *
         * @return True if images are supported, false otherwise
         */
        public Boolean getImage() {
            return image;
        }

        /**
         * Sets image support
         *
         * @param image Whether images are supported
         */
        public void setImage(Boolean image) {
            this.image = image;
        }

        /**
         * Checks if audio is supported
         *
         * @return True if audio is supported, false otherwise
         */
        public Boolean getAudio() {
            return audio;
        }

        /**
         * Sets audio support
         *
         * @param audio Whether audio is supported
         */
        public void setAudio(Boolean audio) {
            this.audio = audio;
        }

        /**
         * Checks if embedded context is supported
         *
         * @return True if embedded context is supported, false otherwise
         */
        public Boolean getEmbeddedContext() {
            return embeddedContext;
        }

        /**
         * Sets embedded context support
         *
         * @param embeddedContext Whether embedded context is supported
         */
        public void setEmbeddedContext(Boolean embeddedContext) {
            this.embeddedContext = embeddedContext;
        }
    }

    /**
     * MCP Capabilities Class
     *
     * Describes the agent's support capabilities for MCP (Model Context Protocol).
     */
    public static class McpCapabilities extends Meta {
        private Boolean sse;
        private Boolean mcp;

        /**
         * Checks if SSE is supported
         *
         * @return True if SSE is supported, false otherwise
         */
        public Boolean getSse() {
            return sse;
        }

        /**
         * Sets SSE support
         *
         * @param sse Whether SSE is supported
         */
        public void setSse(Boolean sse) {
            this.sse = sse;
        }

        /**
         * Checks if MCP is supported
         *
         * @return True if MCP is supported, false otherwise
         */
        public Boolean getMcp() {
            return mcp;
        }

        /**
         * Sets MCP support
         *
         * @param mcp Whether MCP is supported
         */
        public void setMcp(Boolean mcp) {
            this.mcp = mcp;
        }
    }
}

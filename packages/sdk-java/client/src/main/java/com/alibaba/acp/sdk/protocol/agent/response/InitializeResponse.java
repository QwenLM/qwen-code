package com.alibaba.acp.sdk.protocol.agent.response;

import java.util.List;

import com.alibaba.acp.sdk.protocol.domain.agent.AgentCapabilities;
import com.alibaba.acp.sdk.protocol.domain.agent.AgentInfo;
import com.alibaba.acp.sdk.protocol.domain.agent.AuthMethod;
import com.alibaba.acp.sdk.protocol.jsonrpc.Response;

import static com.alibaba.acp.sdk.protocol.agent.response.InitializeResponse.InitializeResponseResult;

/**
 * Initialize Response Class
 *
 * Represents the agent's response to the client's initialization request, containing agent capability information, authentication methods, etc.
 */
public class InitializeResponse extends Response<InitializeResponseResult> {
    /**
     * Initialize Response Result Class
     *
     * Contains initialization response data such as protocol version, agent capabilities, agent information, and authentication methods.
     */
    public static class InitializeResponseResult {
        private int protocolVersion;
        private AgentCapabilities agentCapabilities;
        private AgentInfo agentInfo;
        private List<AuthMethod> authMethods;

        /**
         * Gets the protocol version
         *
         * @return Protocol version number
         */
        public int getProtocolVersion() {
            return protocolVersion;
        }

        /**
         * Sets the protocol version
         *
         * @param protocolVersion Protocol version number
         */
        public void setProtocolVersion(int protocolVersion) {
            this.protocolVersion = protocolVersion;
        }

        /**
         * Gets the agent capabilities
         *
         * @return Agent capabilities object
         */
        public AgentCapabilities getAgentCapabilities() {
            return agentCapabilities;
        }

        /**
         * Sets the agent capabilities
         *
         * @param agentCapabilities Agent capabilities object
         */
        public void setAgentCapabilities(AgentCapabilities agentCapabilities) {
            this.agentCapabilities = agentCapabilities;
        }

        /**
         * Gets the agent information
         *
         * @return Agent information object
         */
        public AgentInfo getAgentInfo() {
            return agentInfo;
        }

        /**
         * Sets the agent information
         *
         * @param agentInfo Agent information object
         */
        public void setAgentInfo(AgentInfo agentInfo) {
            this.agentInfo = agentInfo;
        }

        /**
         * Gets the authentication method list
         *
         * @return Authentication method list
         */
        public List<AuthMethod> getAuthMethods() {
            return authMethods;
        }

        /**
         * Sets the authentication method list
         *
         * @param authMethods Authentication method list
         */
        public void setAuthMethods(List<AuthMethod> authMethods) {
            this.authMethods = authMethods;
        }
    }
}

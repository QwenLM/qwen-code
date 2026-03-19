package com.alibaba.acp.sdk.protocol.client.request;

import com.alibaba.acp.sdk.protocol.domain.client.ClientCapabilities;
import com.alibaba.acp.sdk.protocol.domain.client.ClientInfo;
import com.alibaba.acp.sdk.protocol.jsonrpc.Meta;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.fastjson2.annotation.JSONType;

import static com.alibaba.acp.sdk.protocol.client.request.InitializeRequest.InitializeRequestParams;

/**
 * Initialize Request Class
 *
 * Used to send client initialization information to the agent, including protocol version, client capabilities, and client information.
 */
@JSONType(typeName = "initialize")
public class InitializeRequest extends Request<InitializeRequestParams> {
    /**
     * Constructs an initialization request with default parameters
     */
    public InitializeRequest() {
        this(new InitializeRequestParams());
    }

    /**
     * Constructs an initialization request with specified parameters
     *
     * @param requestParams Initialization request parameters
     */
    public InitializeRequest(InitializeRequestParams requestParams) {
        super("initialize", requestParams);
    }

    /**
     * Initialize Request Parameters Class
     *
     * Contains initialization information such as protocol version, client capabilities, and client information.
     */
    public static class InitializeRequestParams extends Meta {
        private int protocolVersion;
        private ClientCapabilities clientCapabilities = new ClientCapabilities();
        private ClientInfo clientInfo;

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
         * Gets the client capabilities
         *
         * @return Client capabilities object
         */
        public ClientCapabilities getClientCapabilities() {
            return clientCapabilities;
        }

        /**
         * Sets the client capabilities
         *
         * @param clientCapabilities Client capabilities object
         * @return Current object instance, facilitating method chaining
         */
        public InitializeRequestParams setClientCapabilities(ClientCapabilities clientCapabilities) {
            this.clientCapabilities = clientCapabilities;
            return this;
        }

        /**
         * Gets the client information
         *
         * @return Client information object
         */
        public ClientInfo getClientInfo() {
            return clientInfo;
        }

        /**
         * Sets the client information
         *
         * @param clientInfo Client information object
         * @return Current object instance, facilitating method chaining
         */
        public InitializeRequestParams setClientInfo(ClientInfo clientInfo) {
            this.clientInfo = clientInfo;
            return this;
        }
    }
}

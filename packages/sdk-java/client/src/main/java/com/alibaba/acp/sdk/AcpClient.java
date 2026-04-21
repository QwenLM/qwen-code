package com.alibaba.acp.sdk;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;

import com.alibaba.acp.sdk.protocol.agent.response.InitializeResponse;
import com.alibaba.acp.sdk.protocol.client.request.InitializeRequest;
import com.alibaba.acp.sdk.protocol.client.request.InitializeRequest.InitializeRequestParams;
import com.alibaba.acp.sdk.protocol.client.request.LoadSessionRequest;
import com.alibaba.acp.sdk.protocol.client.request.LoadSessionRequest.LoadSessionRequestParams;
import com.alibaba.acp.sdk.protocol.client.request.NewSessionRequest;
import com.alibaba.acp.sdk.protocol.client.request.NewSessionRequest.NewSessionRequestParams;
import com.alibaba.acp.sdk.protocol.agent.response.LoadSessionResponse;
import com.alibaba.acp.sdk.protocol.agent.response.NewSessionResponse;
import com.alibaba.acp.sdk.protocol.domain.content.block.ContentBlock;
import com.alibaba.acp.sdk.session.Session;
import com.alibaba.acp.sdk.session.event.consumer.AgentEventConsumer;
import com.alibaba.acp.sdk.session.exception.SessionLoadException;
import com.alibaba.acp.sdk.session.exception.SessionNewException;
import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.acp.sdk.utils.AgentInitializeException;
import com.alibaba.acp.sdk.utils.TransportUtils;

import org.apache.commons.lang3.Validate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * ACP (Agent Client Protocol) Client Implementation
 * This class provides the main entry point for communicating with AI agents, responsible for initializing connections, managing sessions, and other
 * operations.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class AcpClient {
    private final Transport transport;
    private Session session;
    private static final Logger logger = LoggerFactory.getLogger(AcpClient.class);

    /**
     * Constructs a new ACP client instance
     * This constructor starts the transport layer and sends an initialization request to the agent side, completing the protocol handshake process.
     *
     * @param transport Transport instance for communication with the agent, cannot be null
     * @throws AgentInitializeException Thrown when an error occurs during initialization
     */
    public AcpClient(Transport transport) throws AgentInitializeException {
        this(transport, new InitializeRequestParams());
    }

    /**
     * Constructs a new ACP client instance
     * This constructor starts the transport layer and sends an initialization request to the agent side, completing the protocol handshake process.
     *
     * @param transport Transport instance for communication with the agent, cannot be null
     * @param initializeRequestParams Initialization request parameters, including client capabilities and other information, cannot be null
     * @throws AgentInitializeException Thrown when an error occurs during initialization
     */
    public AcpClient(Transport transport, InitializeRequestParams initializeRequestParams) throws AgentInitializeException {
        Validate.notNull(transport, "transport can't be null");
        this.transport = transport;

        try {
            transport.start();
        } catch (IOException e) {
            throw new AgentInitializeException("transport start error")
                    .addContextValue("initializeRequestParams", initializeRequestParams);
        }
        Validate.notNull(initializeRequestParams, "initializeRequestParams can't be null");

        InitializeResponse initializeResponse;
        try {
            InitializeRequest initializeRequest = new InitializeRequest(initializeRequestParams);
            logger.debug("start to initialize agent {}", initializeRequest);
            initializeResponse = TransportUtils.inputWaitForOneLine(transport, initializeRequest, InitializeResponse.class);
            logger.debug("initialize response: {}", initializeResponse);
        } catch (IOException | ExecutionException | InterruptedException | TimeoutException e) {
            throw new AgentInitializeException("agent transport error")
                    .addContextValue("initializeRequestParams", initializeRequestParams);
        }
        if (initializeResponse.getError() != null) {
            throw new AgentInitializeException("agent initialize error")
                    .addContextValue("initializeRequestParams", initializeRequestParams)
                    .addContextValue("initializeResponse", initializeResponse);
        }
    }

    public void sendPrompt(List<ContentBlock> prompts, AgentEventConsumer agentEventConsumer) throws IOException, SessionNewException {
        newSession();
        session.sendPrompt(prompts, agentEventConsumer);
    }

    /**
     * Creates a new session
     * Sends a new session request to the agent and creates a Session instance based on the response.
     *
     * @return Session object representing the newly created session
     * @throws SessionNewException Thrown when an error occurs during session creation
     */
    public Session newSession() throws SessionNewException {
        return newSession(new NewSessionRequestParams());
    }

    /**
     * Creates a new session
     * Sends a new session request to the agent and creates a Session instance based on the response.
     *
     * @param newSessionRequestParams New session request parameters, including session configuration information
     * @return Session object representing the newly created session
     * @throws SessionNewException Thrown when an error occurs during session creation
     */
    public Session newSession(NewSessionRequestParams newSessionRequestParams) throws SessionNewException {
        Validate.notNull(newSessionRequestParams, "newSessionRequestParams can't be null");
        NewSessionRequest newSessionRequest = new NewSessionRequest(newSessionRequestParams);
        NewSessionResponse newSessionResponse;
        try {
            logger.debug("start to new session {}", newSessionRequest);
            newSessionResponse = TransportUtils.inputWaitForOneLine(transport, newSessionRequest, NewSessionResponse.class);
        } catch (IOException | ExecutionException | InterruptedException | TimeoutException e) {
            throw new SessionNewException("transport inputWaitForOneLine error", e)
                    .addContextValue("newSessionRequestParams", newSessionRequestParams)
                    .addContextValue("newSessionRequest", newSessionRequest);
        }
        logger.debug("new session response: {}", newSessionResponse);
        if (newSessionResponse.getError() != null) {
            throw new SessionNewException("new session error")
                    .addContextValue("newSessionRequest", newSessionRequest)
                    .addContextValue("newSessionRequestParams", newSessionRequestParams)
                    .addContextValue("newSessionResponse", newSessionResponse);
        }

        session = new Session(transport, new LoadSessionRequestParams()
                .setSessionId(newSessionResponse.getResult().getSessionId())
                .setCwd(newSessionRequestParams.getCwd())
                .setMcpServers(newSessionRequestParams.getMcpServers())
        );
        return session;
    }

    /**
     * Loads an existing session
     * Sends a load session request to the agent and creates a Session instance representing the session.
     *
     * @param loadSessionRequestParams Load session request parameters, including session identifier and other information
     * @return Session object representing the loaded session
     * @throws SessionLoadException Thrown when an error occurs during session loading
     */
    public Session loadSession(LoadSessionRequestParams loadSessionRequestParams)
            throws SessionLoadException {
        LoadSessionRequest loadSessionRequest = new LoadSessionRequest(loadSessionRequestParams);
        logger.debug("start to load session {}", loadSessionRequest);
        LoadSessionResponse loadSessionResponse;
        try {
            loadSessionResponse = TransportUtils.inputWaitForOneLine(transport, loadSessionRequest, LoadSessionResponse.class);
        } catch (IOException | ExecutionException | InterruptedException | TimeoutException e) {
            throw new SessionLoadException("transport inputWaitForOneLine error", e)
                    .addContextValue("loadSessionRequestParams", loadSessionRequestParams)
                    .addContextValue("loadSessionRequest", loadSessionRequest);
        }
        logger.debug("loadSessionResponse: {}", loadSessionResponse);
        session = new Session(transport, loadSessionRequestParams);
        return session;
    }

    public void close() throws IOException {
        if (transport != null) {
            transport.close();
        }
        //ThreadPoolConfig.shutdown();
    }
}

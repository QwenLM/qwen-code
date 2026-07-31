package com.alibaba.qwen.code.cli.session;

import java.util.Optional;

import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;
import com.alibaba.fastjson2.JSONReader.Feature;
import com.alibaba.fastjson2.TypeReference;
import com.alibaba.qwen.code.cli.protocol.data.Capabilities;
import com.alibaba.qwen.code.cli.protocol.data.PermissionMode;
import com.alibaba.qwen.code.cli.protocol.message.SDKResultMessage;
import com.alibaba.qwen.code.cli.protocol.message.SDKSystemMessage;
import com.alibaba.qwen.code.cli.protocol.message.SDKUserMessage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.SDKAssistantMessage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.SDKPartialAssistantMessage;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlInitializeRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlInitializeResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlInterruptRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlSetModelRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlSetPermissionModeRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlRequestPayload;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlResponsePayload;
import com.alibaba.qwen.code.cli.session.event.consumers.SessionEventConsumers;
import com.alibaba.qwen.code.cli.session.exception.SessionControlException;
import com.alibaba.qwen.code.cli.session.exception.SessionSendPromptException;
import com.alibaba.qwen.code.cli.transport.Transport;
import com.alibaba.qwen.code.cli.transport.TransportOptions;
import com.alibaba.qwen.code.cli.utils.MyConcurrentUtils;
import com.alibaba.qwen.code.cli.utils.Timeout;

import org.apache.commons.lang3.StringUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Manages a session with the Qwen Code CLI, handling communication, sending prompts, and processing responses.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class Session {
    private static final Logger log = LoggerFactory.getLogger(Session.class);
    private final Transport transport;
    private CLIControlInitializeResponse lastCliControlInitializeResponse;
    private SDKSystemMessage lastSdkSystemMessage;
    private final Timeout defaultEventTimeout = Timeout.TIMEOUT_60_SECONDS;

    /**
     * Checks if the session is configured for streaming.
     *
     * @return true if streaming is enabled, false otherwise
     */
    public boolean isStreaming() {
        return Optional.ofNullable(transport)
                .map(Transport::getTransportOptions)
                .map(TransportOptions::getIncludePartialMessages)
                .orElse(false);
    }

    /**
     * Constructs a new session with the specified transport.
     *
     * @param transport The transport layer to use for communication
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if the transport is not available
     */
    public Session(Transport transport) throws SessionControlException {
        if (transport == null || !transport.isAvailable()) {
            throw new SessionControlException("Transport is not available");
        }
        this.transport = transport;
        start();
    }

    /**
     * Starts the session by initializing communication with the CLI.
     *
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if initialization fails
     */
    public void start() throws SessionControlException {
        try {
            if (!transport.isAvailable()) {
                transport.start();
            }
            String response = transport.inputWaitForOneLine(CLIControlRequest.create(new CLIControlInitializeRequest()).toString());
            CLIControlResponse<CLIControlInitializeResponse> cliControlResponse = JSON.parseObject(response,
                    new TypeReference<CLIControlResponse<CLIControlInitializeResponse>>() {});
            this.lastCliControlInitializeResponse = cliControlResponse.getResponse().getResponse();
        } catch (Exception e) {
            throw new SessionControlException("Failed to initialize the session", e);
        }
    }

    /**
     * Closes the session and releases resources.
     *
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if closing fails
     */
    public void close() throws SessionControlException {
        try {
            transport.close();
        } catch (Exception e) {
            throw new SessionControlException("Failed to close the session", e);
        }
    }

    /**
     * Interrupts the current operation in the CLI.
     *
     * @return An optional boolean indicating success of the interrupt operation
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if the operation fails
     */
    public Optional<Boolean> interrupt() throws SessionControlException {
        checkAvailable();
        return processControlRequest(new CLIControlRequest<CLIControlInterruptRequest>().setRequest(new CLIControlInterruptRequest()).toString());
    }

    /**
     * Sets the model to be used in the session.
     *
     * @param modelName The name of the model to use
     * @return An optional boolean indicating success of the operation
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if the operation fails
     */
    public Optional<Boolean> setModel(String modelName) throws SessionControlException {
        checkAvailable();
        CLIControlSetModelRequest cliControlSetModelRequest = new CLIControlSetModelRequest();
        cliControlSetModelRequest.setModel(modelName);
        return processControlRequest(new CLIControlRequest<CLIControlSetModelRequest>().setRequest(cliControlSetModelRequest).toString());
    }

    /**
     * Sets the permission mode for the session.
     *
     * @param permissionMode The permission mode to use
     * @return An optional boolean indicating success of the operation
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if the operation fails
     */
    public Optional<Boolean> setPermissionMode(PermissionMode permissionMode) throws SessionControlException {
        checkAvailable();
        CLIControlSetPermissionModeRequest cliControlSetPermissionModeRequest = new CLIControlSetPermissionModeRequest();
        cliControlSetPermissionModeRequest.setMode(permissionMode.getValue());
        return processControlRequest(
                new CLIControlRequest<CLIControlSetPermissionModeRequest>().setRequest(cliControlSetPermissionModeRequest).toString());
    }

    private Optional<Boolean> processControlRequest(String request) throws SessionControlException {
        try {
            if (transport.isReading()) {
                transport.inputNoWaitResponse(request);
                return Optional.empty();
            } else {
                String response = transport.inputWaitForOneLine(request);
                CLIControlResponse<?> cliControlResponse = JSON.parseObject(response, new TypeReference<CLIControlResponse<?>>() {});
                return Optional.of("success".equals(cliControlResponse.getResponse().getSubtype()));
            }
        } catch (Exception e) {
            throw new SessionControlException("Failed to set model", e);
        }
    }

    /**
     * Continues the current session.
     *
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if the operation fails
     */
    public void continueSession() throws SessionControlException {
        resumeSession(getSessionId());
    }

    /**
     * Resumes a session with the specified ID.
     *
     * @param sessionId The ID of the session to resume
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if the operation fails
     */
    public void resumeSession(String sessionId) throws SessionControlException {
        if (StringUtils.isNotBlank(sessionId)) {
            transport.getTransportOptions().setResumeSessionId(sessionId);
        }
        this.start();
    }

    /**
     * Sends a prompt to the CLI and processes the response.
     *
     * @param prompt The prompt to send to the CLI
     * @param sessionEventConsumers Consumers for handling different types of events
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionSendPromptException if sending the prompt fails
     * @throws com.alibaba.qwen.code.cli.session.exception.SessionControlException if a control operation fails
     */
    public void sendPrompt(String prompt, SessionEventConsumers sessionEventConsumers) throws SessionSendPromptException, SessionControlException {
        checkAvailable();
        try {
            transport.inputWaitForMultiLine(new SDKUserMessage().setContent(prompt).toString(), (line) -> {
                JSONObject jsonObject = JSON.parseObject(line);
                String messageType = jsonObject.getString("type");
                if ("system".equals(messageType)) {
                    lastSdkSystemMessage = jsonObject.to(SDKSystemMessage.class);
                    MyConcurrentUtils.runAndWait(() -> sessionEventConsumers.onSystemMessage(this, lastSdkSystemMessage),
                            Optional.ofNullable(sessionEventConsumers.onSystemMessageTimeout(this, lastSdkSystemMessage))
                                    .orElse(defaultEventTimeout));
                    return false;
                } else if ("assistant".equals(messageType)) {
                    SDKAssistantMessage assistantMessage = jsonObject.to(SDKAssistantMessage.class);
                    MyConcurrentUtils.runAndWait(() -> sessionEventConsumers.onAssistantMessage(this, assistantMessage),
                            Optional.ofNullable(sessionEventConsumers.onAssistantMessageTimeout(this, assistantMessage)).orElse(defaultEventTimeout));
                    return false;
                } else if ("stream_event".equals(messageType)) {
                    SDKPartialAssistantMessage sdkPartialAssistantMessage = jsonObject.to(SDKPartialAssistantMessage.class);
                    MyConcurrentUtils.runAndWait(
                            () -> sessionEventConsumers.onPartialAssistantMessage(this, sdkPartialAssistantMessage),
                            Optional.ofNullable(sessionEventConsumers.onPartialAssistantMessageTimeout(this, sdkPartialAssistantMessage))
                                    .orElse(defaultEventTimeout));
                    return false;
                } else if ("user".equals(messageType)) {
                    SDKUserMessage sdkUserMessage = jsonObject.to(SDKUserMessage.class, Feature.FieldBased);
                    MyConcurrentUtils.runAndWait(
                            () -> sessionEventConsumers.onUserMessage(this, sdkUserMessage),
                            Optional.ofNullable(sessionEventConsumers.onUserMessageTimeout(this, sdkUserMessage)).orElse(defaultEventTimeout));
                    return false;
                } else if ("result".equals(messageType)) {
                    SDKResultMessage sdkResultMessage = jsonObject.to(SDKResultMessage.class);
                    MyConcurrentUtils.runAndWait(() -> sessionEventConsumers.onResultMessage(this, sdkResultMessage),
                            Optional.ofNullable(sessionEventConsumers.onResultMessageTimeout(this, sdkResultMessage)).orElse(defaultEventTimeout));
                    return true;
                } else if ("control_response".equals(messageType)) {
                    CLIControlResponse<? extends ControlResponsePayload> controlResponse = jsonObject.to(
                            new TypeReference<CLIControlResponse<? extends ControlResponsePayload>>() {});
                    MyConcurrentUtils.runAndWait(() -> sessionEventConsumers.onControlResponse(this, controlResponse),
                            Optional.ofNullable(sessionEventConsumers.onControlResponseTimeout(this, controlResponse)).orElse(defaultEventTimeout));
                    if (!"error".equals(jsonObject.getString("subtype"))) {
                        return false;
                    } else {
                        log.info("control_response error: {}", jsonObject.toJSONString());
                        return "error".equals(jsonObject.getString("subtype"));
                    }
                } else if ("control_request".equals(messageType)) {
                    CLIControlResponse<? extends ControlResponsePayload> controlResponse;
                    try {
                        CLIControlRequest<? extends ControlRequestPayload> controlRequest = jsonObject.to(
                                new TypeReference<CLIControlRequest<? extends ControlRequestPayload>>() {});
                        controlResponse = MyConcurrentUtils.runAndWait(
                                () -> sessionEventConsumers.onControlRequest(this, controlRequest),
                                Optional.ofNullable(sessionEventConsumers.onControlRequestTimeout(this, controlRequest)).orElse(defaultEventTimeout));
                    } catch (Exception e) {
                        log.error("Failed to process control request", e);
                        controlResponse = new CLIControlResponse<>();
                    }
                    try {
                        transport.inputNoWaitResponse(Optional.ofNullable(controlResponse).map(CLIControlResponse::toString)
                                .orElse(new CLIControlResponse<ControlResponsePayload>().toString()));
                    } catch (Exception e) {
                        throw new RuntimeException("Failed to send control response", e);
                    }
                    return false;
                } else {
                    log.warn("unknown message type: {}", messageType);
                    MyConcurrentUtils.runAndWait(() -> sessionEventConsumers.onOtherMessage(this, line),
                            Optional.ofNullable(sessionEventConsumers.onOtherMessageTimeout(this, line)).orElse(defaultEventTimeout));
                    return false;
                }
            });
        } catch (Exception e) {
            throw new SessionSendPromptException("Failed to send prompt", e);
        }
    }

    /**
     * Gets the current session ID.
     *
     * @return The session ID, or null if not available
     */
    public String getSessionId() {
        return Optional.ofNullable(lastSdkSystemMessage).map(SDKSystemMessage::getSessionId).orElse(null);
    }

    /**
     * Checks if the session is available for operations.
     *
     * @return true if the session is available, false otherwise
     */
    public boolean isAvailable() {
        return transport.isAvailable();
    }

    /**
     * Gets the capabilities of the CLI.
     *
     * @return A Capabilities object representing the CLI's capabilities
     */
    public Capabilities getCapabilities() {
        return Optional.ofNullable(lastCliControlInitializeResponse).map(CLIControlInitializeResponse::getCapabilities).orElse(new Capabilities());
    }

    private void checkAvailable() throws SessionControlException {
        if (!isAvailable()) {
            throw new SessionControlException("Session is not available");
        }
    }
}

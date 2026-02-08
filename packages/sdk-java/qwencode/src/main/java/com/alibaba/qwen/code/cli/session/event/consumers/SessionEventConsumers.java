package com.alibaba.qwen.code.cli.session.event.consumers;

import com.alibaba.qwen.code.cli.protocol.message.SDKResultMessage;
import com.alibaba.qwen.code.cli.protocol.message.SDKSystemMessage;
import com.alibaba.qwen.code.cli.protocol.message.SDKUserMessage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.SDKAssistantMessage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.SDKPartialAssistantMessage;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlRequestPayload;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlResponsePayload;
import com.alibaba.qwen.code.cli.session.Session;
import com.alibaba.qwen.code.cli.utils.Timeout;

/**
 * Interface for handling different types of events during a session.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public interface SessionEventConsumers {
    /**
     * Handles system messages.
     *
     * @param session The session
     * @param systemMessage The system message
     */
    void onSystemMessage(Session session, SDKSystemMessage systemMessage);

    /**
     * Handles result messages.
     *
     * @param session The session
     * @param resultMessage The result message
     */
    void onResultMessage(Session session, SDKResultMessage resultMessage);

    /**
     * Handles assistant messages.
     *
     * @param session The session
     * @param assistantMessage The assistant message
     */
    void onAssistantMessage(Session session, SDKAssistantMessage assistantMessage);

    /**
     * Handles partial assistant messages.
     *
     * @param session The session
     * @param partialAssistantMessage The partial assistant message
     */
    void onPartialAssistantMessage(Session session, SDKPartialAssistantMessage partialAssistantMessage);

    /**
     * Handles user messages.
     *
     * @param session The session
     * @param userMessage The user message
     */
    void onUserMessage(Session session, SDKUserMessage userMessage);

    /**
     * Handles other types of messages.
     *
     * @param session The session
     * @param message The message
     */
    void onOtherMessage(Session session, String message);

    /**
     * Handles control responses.
     *
     * @param session The session
     * @param cliControlResponse The control response
     */
    void onControlResponse(Session session, CLIControlResponse<?> cliControlResponse);

    /**
     * Handles control requests.
     *
     * @param session The session
     * @param cliControlRequest The control request
     * @return The control response
     */
    CLIControlResponse<? extends ControlResponsePayload> onControlRequest(Session session, CLIControlRequest<? extends ControlRequestPayload> cliControlRequest);

    /**
     * Gets timeout for system message handling.
     *
     * @param session The session
     * @param systemMessage The system message
     * @return The timeout for system message handling
     */
    Timeout onSystemMessageTimeout(Session session, SDKSystemMessage systemMessage);

    /**
     * Gets timeout for result message handling.
     *
     * @param session The session
     * @param resultMessage The result message
     * @return The timeout for result message handling
     */
    Timeout onResultMessageTimeout(Session session, SDKResultMessage resultMessage);

    /**
     * Gets timeout for assistant message handling.
     *
     * @param session The session
     * @param assistantMessage The assistant message
     * @return The timeout for assistant message handling
     */
    Timeout onAssistantMessageTimeout(Session session, SDKAssistantMessage assistantMessage);

    /**
     * Gets timeout for partial assistant message handling.
     *
     * @param session The session
     * @param partialAssistantMessage The partial assistant message
     * @return The timeout for partial assistant message handling
     */
    Timeout onPartialAssistantMessageTimeout(Session session, SDKPartialAssistantMessage partialAssistantMessage);

    /**
     * Gets timeout for user message handling.
     *
     * @param session The session
     * @param userMessage The user message
     * @return The timeout for user message handling
     */
    Timeout onUserMessageTimeout(Session session, SDKUserMessage userMessage);

    /**
     * Gets timeout for other message handling.
     *
     * @param session The session
     * @param message The message
     * @return The timeout for other message handling
     */
    Timeout onOtherMessageTimeout(Session session, String message);

    /**
     * Gets timeout for control response handling.
     *
     * @param session The session
     * @param cliControlResponse The control response
     * @return The timeout for control response handling
     */
    Timeout onControlResponseTimeout(Session session, CLIControlResponse<?> cliControlResponse);

    /**
     * Gets timeout for control request handling.
     *
     * @param session The session
     * @param cliControlRequest The control request
     * @return The timeout for control request handling
     */
    Timeout onControlRequestTimeout(Session session, CLIControlRequest<?> cliControlRequest);
}

package com.alibaba.qwen.code.cli.session.event.consumers;

import com.alibaba.qwen.code.cli.protocol.data.AssistantUsage;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.TextAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ThingkingAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolResultAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolUseAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Behavior;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Behavior.Operation;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlPermissionRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlRequestPayload;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlResponsePayload;
import com.alibaba.qwen.code.cli.session.Session;
import com.alibaba.qwen.code.cli.utils.Timeout;

/**
 * Interface for handling different types of assistant content during a session.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public interface AssistantContentConsumers {
    /**
     * Handles text content from the assistant.
     *
     * @param session The session
     * @param textAssistantContent The text content from the assistant
     */
    void onText(Session session, TextAssistantContent textAssistantContent);

    /**
     * Handles thinking content from the assistant.
     *
     * @param session The session
     * @param thingkingAssistantContent The thinking content from the assistant
     */
    void onThinking(Session session, ThingkingAssistantContent thingkingAssistantContent);

    /**
     * Handles tool use content from the assistant.
     *
     * @param session The session
     * @param toolUseAssistantContent The tool use content from the assistant
     */
    void onToolUse(Session session, ToolUseAssistantContent toolUseAssistantContent);

    /**
     * Handles tool result content from the assistant.
     *
     * @param session The session
     * @param toolResultAssistantContent The tool result content from the assistant
     */
    void onToolResult(Session session, ToolResultAssistantContent toolResultAssistantContent);

    /**
     * Handles other types of assistant content.
     *
     * @param session The session
     * @param other The other content from the assistant
     */
    void onOtherContent(Session session, AssistantContent<?> other);

    /**
     * Handles permission requests.
     *
     * @param session The session
     * @param permissionRequest The permission request
     * @return The behavior for the permission request
     */
    Behavior onPermissionRequest(Session session, CLIControlPermissionRequest permissionRequest);

    /**
     * Handles permission requests.
     *
     * @param session The session
     * @param requestPayload The control request payload
     * @return The response payload for the control request
     */
    ControlResponsePayload onOtherControlRequest(Session session, ControlRequestPayload requestPayload);

    /**
     * Handles usage information from the assistant.
     *
     * @param session The session
     * @param AssistantUsage The usage information from the assistant
     */
    void onUsage(Session session, AssistantUsage AssistantUsage);

    /**
     * Sets the default permission operation.
     *
     * @param defaultPermissionOperation The default permission operation
     * @return This instance for method chaining
     */
    AssistantContentSimpleConsumers setDefaultPermissionOperation(Operation defaultPermissionOperation);

    /**
     * Gets timeout for permission request handling.
     *
     * @param session The session
     * @return The timeout for permission request handling
     */
    Timeout onPermissionRequestTimeout(Session session, CLIControlPermissionRequest permissionRequest);

    /**
     * Gets timeout for other control request handling.
     *
     * @param session The session
     * @param requestPayload The control request payload
     * @return The timeout for other control request handling
     */
    Timeout onOtherControlRequestTimeout(Session session, ControlRequestPayload requestPayload);

    /**
     * Gets timeout for text handling.
     *
     * @param session The session
     * @param textAssistantContent The text content from the assistant
     * @return The timeout for text handling
     */
    Timeout onTextTimeout(Session session, TextAssistantContent textAssistantContent);

    /**
     * Gets timeout for thinking handling.
     *
     * @param session The session
     * @param thingkingAssistantContent The thinking content from the assistant
     * @return The timeout for thinking handling
     */
    Timeout onThinkingTimeout(Session session, ThingkingAssistantContent thingkingAssistantContent);

    /**
     * Gets timeout for tool use handling.
     *
     * @param session The session
     * @param toolUseAssistantContent The tool use content from the assistant
     * @return The timeout for tool use handling
     */
    Timeout onToolUseTimeout(Session session, ToolUseAssistantContent toolUseAssistantContent);

    /**
     * Gets timeout for tool result handling.
     *
     * @param session The session
     * @param toolResultAssistantContent The tool result content from the assistant
     * @return The timeout for tool result handling
     */
    Timeout onToolResultTimeout(Session session, ToolResultAssistantContent toolResultAssistantContent);

    /**
     * Gets timeout for other content handling.
     *
     * @param session The session
     * @param other The other content from the assistant
     * @return The timeout for other content handling
     */
    Timeout onOtherContentTimeout(Session session, AssistantContent<?> other);
}

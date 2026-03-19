package com.alibaba.qwen.code.cli.session.event.consumers;

import java.util.List;
import java.util.Optional;

import com.alibaba.qwen.code.cli.protocol.data.AssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.TextAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ThingkingAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolResultAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantContent.ToolUseAssistantContent;
import com.alibaba.qwen.code.cli.protocol.data.AssistantUsage;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Allow;
import com.alibaba.qwen.code.cli.protocol.data.behavior.Behavior;
import com.alibaba.qwen.code.cli.protocol.message.SDKResultMessage;
import com.alibaba.qwen.code.cli.protocol.message.SDKSystemMessage;
import com.alibaba.qwen.code.cli.protocol.message.SDKUserMessage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.SDKAssistantMessage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.SDKPartialAssistantMessage;
import com.alibaba.qwen.code.cli.protocol.message.assistant.block.ContentBlock;
import com.alibaba.qwen.code.cli.protocol.message.assistant.event.ContentBlockDeltaEvent;
import com.alibaba.qwen.code.cli.protocol.message.assistant.event.StreamEvent;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlPermissionRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.CLIControlPermissionResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlRequest;
import com.alibaba.qwen.code.cli.protocol.message.control.CLIControlResponse;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlRequestPayload;
import com.alibaba.qwen.code.cli.protocol.message.control.payload.ControlResponsePayload;
import com.alibaba.qwen.code.cli.session.Session;
import com.alibaba.qwen.code.cli.utils.MyConcurrentUtils;
import com.alibaba.qwen.code.cli.utils.Timeout;

import org.apache.commons.lang3.ObjectUtils;
import org.apache.commons.lang3.Validate;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Simple implementation of SessionEventConsumers that provides basic implementations for all methods.
 *
 * @author skyfire
 * @version $Id: 0.0.1
 */
public class SessionEventSimpleConsumers implements SessionEventConsumers {
    /**
     * {@inheritDoc}
     */
    @Override
    public void onSystemMessage(Session session, SDKSystemMessage systemMessage) {
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onResultMessage(Session session, SDKResultMessage resultMessage) {
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onAssistantMessage(Session session, SDKAssistantMessage assistantMessage) {
        List<ContentBlock<?>> contentBlocks = assistantMessage.getMessage().getContent();
        if (assistantContentConsumers == null || contentBlocks == null || contentBlocks.isEmpty()) {
            return;
        }
        assistantContentConsumers.onUsage(session,
                new AssistantUsage(assistantMessage.getMessage().getId(), assistantMessage.getMessage().getUsage()));

        if (!session.isStreaming()) {
            contentBlocks.forEach(contentBlock -> consumeAssistantContent(session, contentBlock));
        }
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onPartialAssistantMessage(Session session, SDKPartialAssistantMessage partialAssistantMessage) {
        StreamEvent event = partialAssistantMessage.getEvent();
        if (!(event instanceof ContentBlockDeltaEvent)) {
            log.debug("received partialAssistantMessage and is not instance of ContentBlockDeltaEvent, will ignore process. the message is {}",
                    partialAssistantMessage);
            return;
        }
        ContentBlockDeltaEvent contentBlockDeltaEvent = (ContentBlockDeltaEvent) event;
        contentBlockDeltaEvent.getDelta().setMessageId(partialAssistantMessage.getMessageId());
        consumeAssistantContent(session, contentBlockDeltaEvent.getDelta());
    }

    /**
     * <p>consumeAssistantContent.</p>
     *
     * @param session a {@link com.alibaba.qwen.code.cli.session.Session} object.
     * @param assistantContent a {@link com.alibaba.qwen.code.cli.protocol.data.AssistantContent} object.
     */
    protected void consumeAssistantContent(Session session, AssistantContent<?> assistantContent) {
        if (assistantContent instanceof TextAssistantContent) {
            MyConcurrentUtils.runAndWait(() -> assistantContentConsumers.onText(session, (TextAssistantContent) assistantContent),
                    Optional.ofNullable(assistantContentConsumers.onTextTimeout(session, (TextAssistantContent) assistantContent))
                            .orElse(defaultEventTimeout));
        } else if (assistantContent instanceof ThingkingAssistantContent) {
            MyConcurrentUtils.runAndWait(() -> assistantContentConsumers.onThinking(session, (ThingkingAssistantContent) assistantContent),
                    Optional.ofNullable(assistantContentConsumers.onThinkingTimeout(session, (ThingkingAssistantContent) assistantContent))
                            .orElse(defaultEventTimeout));
        } else if (assistantContent instanceof ToolUseAssistantContent) {
            MyConcurrentUtils.runAndWait(() -> assistantContentConsumers.onToolUse(session, (ToolUseAssistantContent) assistantContent),
                    Optional.ofNullable(assistantContentConsumers.onToolUseTimeout(session, (ToolUseAssistantContent) assistantContent))
                            .orElse(defaultEventTimeout));
        } else if (assistantContent instanceof ToolResultAssistantContent) {
            MyConcurrentUtils.runAndWait(() -> assistantContentConsumers.onToolResult(session, (ToolResultAssistantContent) assistantContent),
                    Optional.ofNullable(assistantContentConsumers.onToolResultTimeout(session, (ToolResultAssistantContent) assistantContent))
                            .orElse(defaultEventTimeout));
        } else {
            MyConcurrentUtils.runAndWait(() -> assistantContentConsumers.onOtherContent(session, assistantContent),
                    Optional.ofNullable(assistantContentConsumers.onOtherContentTimeout(session, assistantContent)).orElse(defaultEventTimeout));
        }
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onUserMessage(Session session, SDKUserMessage userMessage) {
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onOtherMessage(Session session, String message) {
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public void onControlResponse(Session session, CLIControlResponse<?> cliControlResponse) {
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public CLIControlResponse<? extends ControlResponsePayload> onControlRequest(Session session, CLIControlRequest<?> cliControlRequest) {
        if (assistantContentConsumers == null) {
            throw new RuntimeException("please set assistantContentConsumers or override onControlRequest of ");
        }
        ControlRequestPayload payload = cliControlRequest.getRequest();
        if (payload instanceof CLIControlPermissionRequest) {
            CLIControlPermissionRequest permissionRequest = (CLIControlPermissionRequest) payload;
            return supplyPermissionControlResponse(session, permissionRequest, cliControlRequest.getRequestId());
        } else {
            ControlRequestPayload request = cliControlRequest.getRequest();
            return supplyOtherControlResponse(session, request, cliControlRequest.getRequestId());
        }
    }

    private CLIControlResponse<CLIControlPermissionResponse> supplyPermissionControlResponse(Session session,
            CLIControlPermissionRequest permissionRequest, String requestId) {
        Behavior behavior;
        try {
            behavior = Optional.ofNullable(
                            MyConcurrentUtils.runAndWait(() -> this.assistantContentConsumers.onPermissionRequest(session, permissionRequest),
                                    Optional.ofNullable(assistantContentConsumers.onPermissionRequestTimeout(session, permissionRequest))
                                            .orElse(defaultEventTimeout)))
                    .map(b -> {
                        if (b instanceof Allow) {
                            Allow allow = (Allow) b;
                            if (allow.getUpdatedInput() == null) {
                                allow.setUpdatedInput(permissionRequest.getInput());
                            }
                        }
                        return b;
                    })
                    .orElse(Behavior.defaultBehavior());
        } catch (Exception e) {
            log.error("Failed to process permission response", e);
            behavior = Behavior.defaultBehavior();
        }

        CLIControlResponse<CLIControlPermissionResponse> permissionResponse = new CLIControlResponse<>();
        permissionResponse.createResponse().setResponse(new CLIControlPermissionResponse().setBehavior(behavior)).setRequestId(requestId);
        return permissionResponse;
    }

    private CLIControlResponse<ControlResponsePayload> supplyOtherControlResponse(Session session, ControlRequestPayload requestPayload,
            String requestId) {
        ControlResponsePayload controlResponsePayload;
        try {
            controlResponsePayload = Optional.ofNullable(
                            MyConcurrentUtils.runAndWait(() -> this.assistantContentConsumers.onOtherControlRequest(session, requestPayload),
                                    ObjectUtils.getIfNull(assistantContentConsumers.onOtherControlRequestTimeout(session, requestPayload),
                                            defaultEventTimeout)))
                    .orElse(new ControlResponsePayload());
        } catch (Exception e) {
            log.error("Failed to process permission response", e);
            controlResponsePayload = new ControlResponsePayload();
        }

        CLIControlResponse<ControlResponsePayload> cliControlResponse = new CLIControlResponse<>();
        cliControlResponse.createResponse().setResponse(controlResponsePayload).setRequestId(requestId);
        return cliControlResponse;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onSystemMessageTimeout(Session session, SDKSystemMessage systemMessage) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onResultMessageTimeout(Session session, SDKResultMessage resultMessage) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onAssistantMessageTimeout(Session session, SDKAssistantMessage assistantMessage) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onPartialAssistantMessageTimeout(Session session, SDKPartialAssistantMessage partialAssistantMessage) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onUserMessageTimeout(Session session, SDKUserMessage userMessage) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onOtherMessageTimeout(Session session, String message) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onControlResponseTimeout(Session session, CLIControlResponse<?> cliControlResponse) {
        return defaultEventTimeout;
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public Timeout onControlRequestTimeout(Session session, CLIControlRequest<?> cliControlRequest) {
        return defaultEventTimeout;
    }

    /**
     * Gets the default event timeout.
     *
     * @return The default event timeout
     */
    protected Timeout getDefaultEventTimeout() {
        return defaultEventTimeout;
    }

    /**
     * Sets the default event timeout.
     *
     * @param defaultEventTimeout The default event timeout
     * @return This instance for method chaining
     */
    public SessionEventSimpleConsumers setDefaultEventTimeout(Timeout defaultEventTimeout) {
        this.defaultEventTimeout = defaultEventTimeout;
        return this;
    }

    /**
     * Creates a new SessionEventSimpleConsumers instance with default values.
     */
    public SessionEventSimpleConsumers() {
    }

    /**
     * Creates a new SessionEventSimpleConsumers instance with the specified parameters.
     *
     * @param defaultEventTimeout The default event timeout
     * @param assistantContentConsumers The assistant content consumers
     */
    public SessionEventSimpleConsumers(Timeout defaultEventTimeout, AssistantContentConsumers assistantContentConsumers) {
        Validate.notNull(defaultEventTimeout, "defaultEventTimeout can't be null");
        Validate.notNull(assistantContentConsumers, "assistantContentConsumers can't be null");
        this.defaultEventTimeout = defaultEventTimeout;
        this.assistantContentConsumers = assistantContentConsumers;
    }

    /**
     * The default event timeout.
     */
    protected Timeout defaultEventTimeout = Timeout.TIMEOUT_180_SECONDS;
    /**
     * The assistant content consumers.
     */
    protected AssistantContentConsumers assistantContentConsumers = new AssistantContentSimpleConsumers();
    private static final Logger log = LoggerFactory.getLogger(SessionEventSimpleConsumers.class);

    /**
     * Sets the assistant content consumers.
     *
     * @param assistantContentConsumers The assistant content consumers
     * @return This instance for method chaining
     */
    public SessionEventSimpleConsumers setAssistantContentConsumer(AssistantContentConsumers assistantContentConsumers) {
        Validate.notNull(assistantContentConsumers, "assistantContentConsumers can't be null");
        this.assistantContentConsumers = assistantContentConsumers;
        return this;
    }

    /**
     * Gets the assistant content consumers.
     *
     * @return The assistant content consumers
     */
    public AssistantContentConsumers getAssistantContentConsumers() {
        return assistantContentConsumers;
    }
}

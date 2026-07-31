package com.alibaba.acp.sdk.session;

import java.io.IOException;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;
import java.util.function.Function;

import com.alibaba.acp.sdk.protocol.agent.notification.SessionNotification;
import com.alibaba.acp.sdk.protocol.agent.request.ReadTextFileRequest;
import com.alibaba.acp.sdk.protocol.agent.request.RequestPermissionRequest;
import com.alibaba.acp.sdk.protocol.agent.request.WriteTextFileRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.CreateTerminalRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.KillTerminalCommandRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.ReleaseTerminalRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.TerminalOutputRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.WaitForTerminalExitRequest;
import com.alibaba.acp.sdk.protocol.agent.response.PromptResponse;
import com.alibaba.acp.sdk.protocol.client.notification.CancelNotification;
import com.alibaba.acp.sdk.protocol.client.request.LoadSessionRequest.LoadSessionRequestParams;
import com.alibaba.acp.sdk.protocol.client.request.PromptRequest;
import com.alibaba.acp.sdk.protocol.client.request.PromptRequest.PromptRequestParams;
import com.alibaba.acp.sdk.protocol.domain.content.block.ContentBlock;
import com.alibaba.acp.sdk.protocol.domain.session.update.AgentMessageChunkSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.AvailableCommandsUpdateSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.CurrentModeUpdateSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.PlanSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.SessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.ToolCallSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.ToolCallUpdateSessionUpdate;
import com.alibaba.acp.sdk.protocol.jsonrpc.Error;
import com.alibaba.acp.sdk.protocol.jsonrpc.Message;
import com.alibaba.acp.sdk.protocol.jsonrpc.MethodMessage;
import com.alibaba.acp.sdk.protocol.jsonrpc.Request;
import com.alibaba.acp.sdk.protocol.jsonrpc.Response;
import com.alibaba.acp.sdk.session.event.consumer.AgentEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.ContentEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.FileEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.PermissionEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.PromptEndEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.TerminalEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.exception.EventConsumeException;
import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.acp.sdk.utils.MyConcurrentUtils;
import com.alibaba.acp.sdk.utils.Timeout;
import com.alibaba.fastjson2.JSON;
import com.alibaba.fastjson2.JSONObject;

import org.apache.commons.lang3.Validate;
import org.apache.commons.lang3.exception.ContextedRuntimeException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static com.alibaba.acp.sdk.protocol.jsonrpc.Error.ErrorCode.INTERNAL_ERROR;
import static com.alibaba.acp.sdk.utils.MyConcurrentUtils.runAndWait;

/**
 * Represents a session connection with an AI agent
 * This class encapsulates all functionality for interacting with the agent, including sending prompts, handling various events and responses, etc.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public class Session {
    private final Transport transport;
    private final LoadSessionRequestParams loadSessionRequestParams;
    private static final Logger logger = LoggerFactory.getLogger(Session.class);

    /**
     * Constructs a new session instance
     *
     * @param transport Transport instance for communication with the agent, cannot be null
     * @param loadSessionRequestParams Load session request parameters, including session identifier and other information, cannot be null
     */
    public Session(Transport transport, LoadSessionRequestParams loadSessionRequestParams) {
        Validate.notNull(transport, "transport can't be null");
        this.transport = transport;
        Validate.notNull(loadSessionRequestParams, "loadSessionRequestParams can't be null");
        this.loadSessionRequestParams = loadSessionRequestParams;
    }

    /**
     * Cancels the currently ongoing operation
     * Sends a cancellation notification to the agent, requesting termination of the currently executing task.
     *
     * @throws IOException Thrown when an IO error occurs while sending the cancellation notification
     */
    public void cancel() throws IOException {
        CancelNotification cancelNotification = new CancelNotification();
        String message = cancelNotification.toString();
        logger.debug("send_cancelNotification to agent {}", message);
        transport.inputNoWaitResponse(message);
    }

    /**
     * Sends a prompt message to the agent and handles the response
     * This method sends a prompt to the agent and handles various responses and events from the agent, including content updates, terminal operations, permission requests, etc.
     *
     * @param prompts List of prompt content blocks, cannot be empty
     * @param agentEventConsumer Consumer for handling agent events, cannot be null
     * @throws IOException Thrown when an IO error occurs while sending the prompt or receiving the response
     */
    public void sendPrompt(List<ContentBlock> prompts, AgentEventConsumer agentEventConsumer) throws IOException {
        Validate.notEmpty(prompts, "prompts can't be empty");
        PromptRequest promptRequest = new PromptRequest(new PromptRequestParams(loadSessionRequestParams.getSessionId(), prompts));

        Validate.notNull(agentEventConsumer, "agentEventConsumer can't be null");
        ContentEventConsumer contentEventConsumer = agentEventConsumer.getContentEventConsumer();
        PromptEndEventConsumer promptEndEventConsumer = agentEventConsumer.getPromptEndEventConsumer();
        TerminalEventConsumer terminalEventConsumer = agentEventConsumer.getTerminalEventConsumer();
        PermissionEventConsumer permissionEventConsumer = agentEventConsumer.getPermissionEventConsumer();
        FileEventConsumer fileEventConsumer = agentEventConsumer.getFileEventConsumer();

        String requestMessage = promptRequest.toString();
        logger.debug("send_prompt to agent: {}", requestMessage);
        transport.inputWaitForMultiLine(requestMessage, (String line) -> {
            logger.debug("received_message from agent: {}", line);
            if (line == null) {
                return true;
            }
            Message message = this.toMessage(line);
            if (message instanceof PromptResponse) {
                logger.debug("rcv prompt_turn_end for prompt {}", prompts);
                if (promptEndEventConsumer != null) {
                    processNoWaitResponse(promptEndEventConsumer::onPromptEnd, promptEndEventConsumer::onPromptEndTimeout,
                            ((PromptResponse) message).getResult());
                }
                return true;
            } else if (message instanceof SessionNotification) {
                if (contentEventConsumer != null) {
                    processSessionUpdate(contentEventConsumer, ((SessionNotification) message).getParams().getUpdate());
                }
                return false;
            } else if (message instanceof RequestPermissionRequest) {
                if (permissionEventConsumer != null) {
                    processRequest(permissionEventConsumer::onRequestPermissionRequest, permissionEventConsumer::onRequestPermissionRequestTimeout,
                            (RequestPermissionRequest) message);
                }
                return false;
            } else if (message instanceof ReadTextFileRequest) {
                if (fileEventConsumer != null) {
                    processRequest(fileEventConsumer::onReadTextFileRequest, fileEventConsumer::onReadTextFileRequestTimeout,
                            (ReadTextFileRequest) message);
                }
                return false;
            } else if (message instanceof WriteTextFileRequest) {
                if (fileEventConsumer != null) {
                    processRequest(fileEventConsumer::onWriteTextFileRequest, fileEventConsumer::onWriteTextFileRequestTimeout,
                            (WriteTextFileRequest) message);
                }
                return false;
            } else if (message instanceof CreateTerminalRequest) {
                if (terminalEventConsumer != null) {
                    processRequest(terminalEventConsumer::onCreateTerminalRequest, terminalEventConsumer::onCreateTerminalRequestTimeout,
                            (CreateTerminalRequest) message);
                }
                return false;
            } else if (message instanceof ReleaseTerminalRequest) {
                if (terminalEventConsumer != null) {
                    processRequest(terminalEventConsumer::onReleaseTerminalRequest, terminalEventConsumer::onReleaseTerminalRequestTimeout,
                            (ReleaseTerminalRequest) message);
                }
                return false;
            } else if (message instanceof WaitForTerminalExitRequest) {
                if (terminalEventConsumer != null) {
                    processRequest(terminalEventConsumer::onWaitForTerminalExitRequest, terminalEventConsumer::onWaitForTerminalExitRequestTimeout,
                            (WaitForTerminalExitRequest) message);
                }
                return false;
            } else if (message instanceof TerminalOutputRequest) {
                if (terminalEventConsumer != null) {
                    processRequest(terminalEventConsumer::onTerminalOutput, terminalEventConsumer::onTerminalOutputRequestTimeout,
                            (TerminalOutputRequest) message);
                }
                return false;
            } else if (message instanceof KillTerminalCommandRequest) {
                if (terminalEventConsumer != null) {
                    processRequest(terminalEventConsumer::onKillTerminalCommandRequest, terminalEventConsumer::onKillTerminalCommandRequestTimeout,
                            (KillTerminalCommandRequest) message);
                }
                return false;
            } else {
                logger.warn("Unknown message, will end prompt turn. {}", line);
                return false;
            }
        });
    }

    /**
     * Parses a string into the corresponding message object
     * <br/>
     * Determines the message type based on the fields in the JSON content and converts it to the corresponding object.
     *
     * @param line String containing JSON-formatted message
     * @return Parsed message object
     */
    private Message toMessage(String line) {
        JSONObject jsonObject = JSON.parseObject(line);
        if (jsonObject.containsKey("method")) {
            return jsonObject.toJavaObject(MethodMessage.class);
        } else if (jsonObject.containsKey("result") || jsonObject.containsKey("error")) {
            JSONObject result = jsonObject.getJSONObject("result");
            if (result != null && result.containsKey("stopReason")) {
                return jsonObject.toJavaObject(PromptResponse.class);
            } else {
                return jsonObject.toJavaObject(Response.class);
            }
        } else {
            return jsonObject.toJavaObject(Message.class);
        }
    }

    /**
     * Processes session update events
     * <br/>
     * Calls the corresponding content event handler based on different session update types.
     *
     * @param contentEventConsumer Content event consumer
     * @param sessionUpdate Session update object
     */
    private void processSessionUpdate(ContentEventConsumer contentEventConsumer, SessionUpdate sessionUpdate) {
        if (contentEventConsumer == null) {
            return;
        }
        if (sessionUpdate instanceof AgentMessageChunkSessionUpdate) {
            processNoWaitResponse(contentEventConsumer::onAgentMessageChunkSessionUpdate,
                    contentEventConsumer::onAgentMessageChunkSessionUpdateTimeout, (AgentMessageChunkSessionUpdate) sessionUpdate);
        } else if (sessionUpdate instanceof ToolCallUpdateSessionUpdate) {
            processNoWaitResponse(contentEventConsumer::onToolCallUpdateSessionUpdate, contentEventConsumer::onToolCallUpdateSessionUpdateTimeout,
                    (ToolCallUpdateSessionUpdate) sessionUpdate);
        } else if (sessionUpdate instanceof ToolCallSessionUpdate) {
            processNoWaitResponse(contentEventConsumer::onToolCallSessionUpdate, contentEventConsumer::onToolCallSessionUpdateTimeout,
                    (ToolCallSessionUpdate) sessionUpdate);
        } else if (sessionUpdate instanceof AvailableCommandsUpdateSessionUpdate) {
            processNoWaitResponse(contentEventConsumer::onAvailableCommandsUpdateSessionUpdate,
                    contentEventConsumer::onAvailableCommandsUpdateSessionUpdateTimeout,
                    (AvailableCommandsUpdateSessionUpdate) sessionUpdate);
        } else if (sessionUpdate instanceof CurrentModeUpdateSessionUpdate) {
            processNoWaitResponse(contentEventConsumer::onCurrentModeUpdateSessionUpdate,
                    contentEventConsumer::onCurrentModeUpdateSessionUpdateTimeout,
                    (CurrentModeUpdateSessionUpdate) sessionUpdate);
        } else if (sessionUpdate instanceof PlanSessionUpdate) {
            processNoWaitResponse(contentEventConsumer::onPlanSessionUpdate, contentEventConsumer::onPlanSessionUpdateTimeout,
                    (PlanSessionUpdate) sessionUpdate);
        }
    }

    /**
     * Processes event consumption without waiting for a response
     * <br/>
     * Executes event consumption logic within the specified timeout period.
     *
     * @param consumer Event consumer
     * @param timeoutFunction Timeout function
     * @param notification Notification object
     * @param <N> Notification type
     */
    private <N> void processNoWaitResponse(Consumer<N> consumer, Function<N, Timeout> timeoutFunction, N notification) {
        runAndWait(() -> consumer.accept(notification), Optional.ofNullable(timeoutFunction)
                .map(tf -> tf.apply(notification))
                .orElse(defaultEventConsumeTimeout));
    }

    /**
     * Processes requests that require a response
     * <br/>
     * Executes request processing logic and sends a response to the agent upon completion.
     *
     * @param requestProcessor Request processor
     * @param timeoutFunction Timeout function
     * @param request Request object
     * @param <R> Request type
     * @param <L> Response payload type
     */
    private <R extends Request<?>, L> void processRequest(Function<R, L> requestProcessor, Function<R, Timeout> timeoutFunction, R request) {
        Response<L> response = new Response<>();
        response.setId(request.getId());
        try {
            L result = MyConcurrentUtils.runAndWait(
                    () -> requestProcessor.apply(request),
                    Optional.ofNullable(timeoutFunction)
                            .map(tf -> tf.apply(request))
                            .orElse(defaultEventConsumeTimeout));
            response.setResult(result);
        } catch (EventConsumeException eventConsumeException) {
            response.setError(eventConsumeException.getError());
        } catch (ExecutionException e) {
            if (e.getCause() instanceof EventConsumeException) {
                response.setError(((EventConsumeException) e.getCause()).getError());
            } else {
                response.setError(new Error(INTERNAL_ERROR.getCode(), INTERNAL_ERROR.getDescription(), e.getMessage()));
            }
        } catch (InterruptedException | TimeoutException e) {
            response.setError(new Error(INTERNAL_ERROR.getCode(), INTERNAL_ERROR.getDescription(), e.getMessage()));
        }
        try {
            String message = response.toString();
            logger.debug("send_response to agent: {}", message);
            transport.inputNoWaitResponse(message);
        } catch (Exception e) {
            throw new ContextedRuntimeException("Failed to send response by transport ", e)
                    .addContextValue("transport", transport)
                    .addContextValue("request", request)
                    .addContextValue("response", response);
        }
    }

    /** Default event consumption timeout is 60 seconds */
    Timeout defaultEventConsumeTimeout = Timeout.TIMEOUT_60_SECONDS;
}

package com.alibaba.acp.sdk.session;

import java.io.IOException;
import java.util.Collections;
import java.util.Optional;

import com.alibaba.acp.sdk.AcpClient;
import com.alibaba.acp.sdk.protocol.domain.client.ClientCapabilities;
import com.alibaba.acp.sdk.protocol.domain.client.ClientCapabilities.FileSystemCapability;
import com.alibaba.acp.sdk.protocol.domain.content.block.TextContent;
import com.alibaba.acp.sdk.protocol.domain.permission.PermissionOption;
import com.alibaba.acp.sdk.protocol.domain.permission.RequestPermissionOutcome;
import com.alibaba.acp.sdk.protocol.domain.session.update.AgentMessageChunkSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.AvailableCommandsUpdateSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.CurrentModeUpdateSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.PlanSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.ToolCallSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.ToolCallUpdateSessionUpdate;
import com.alibaba.acp.sdk.session.event.consumer.ContentEventSimpleConsumer;
import com.alibaba.acp.sdk.session.event.consumer.FileEventSimpleConsumer;
import com.alibaba.acp.sdk.utils.AgentInitializeException;
import com.alibaba.acp.sdk.protocol.agent.request.RequestPermissionRequest;
import com.alibaba.acp.sdk.protocol.agent.request.RequestPermissionRequest.RequestPermissionRequestParams;
import com.alibaba.acp.sdk.protocol.client.request.InitializeRequest.InitializeRequestParams;
import com.alibaba.acp.sdk.protocol.client.request.NewSessionRequest.NewSessionRequestParams;
import com.alibaba.acp.sdk.protocol.client.response.RequestPermissionResponse.RequestPermissionResponseResult;
import com.alibaba.acp.sdk.protocol.domain.permission.PermissionOutcomeKind;
import com.alibaba.acp.sdk.protocol.jsonrpc.MethodMessage;
import com.alibaba.acp.sdk.session.event.consumer.AgentEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.PermissionEventConsumer;
import com.alibaba.acp.sdk.session.event.consumer.exception.EventConsumeException;
import com.alibaba.acp.sdk.session.exception.SessionNewException;
import com.alibaba.acp.sdk.transport.Transport;
import com.alibaba.acp.sdk.transport.process.ProcessTransport;
import com.alibaba.acp.sdk.transport.process.ProcessTransportOptions;
import com.alibaba.acp.sdk.utils.Timeout;

import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static com.alibaba.acp.sdk.protocol.domain.permission.PermissionOptionKind.ALLOW_ALWAYS;

class SessionTest {
    private static final Logger logger = LoggerFactory.getLogger(SessionTest.class);
    @Test
    public void testSession() throws AgentInitializeException, SessionNewException, IOException {
        AcpClient acpClient = new AcpClient(new ProcessTransport(new ProcessTransportOptions().setCommandArgs(new String[] {"qwen", "--acp", "-y"})));
        try {
            acpClient.sendPrompt(Collections.singletonList(new TextContent("你是谁")), new AgentEventConsumer().setContentEventConsumer(new ContentEventSimpleConsumer(){
                @Override
                public void onAgentMessageChunkSessionUpdate(AgentMessageChunkSessionUpdate sessionUpdate) {
                    logger.info(sessionUpdate.toString());
                }

                @Override
                public void onAvailableCommandsUpdateSessionUpdate(AvailableCommandsUpdateSessionUpdate sessionUpdate) {
                    logger.info(sessionUpdate.toString());
                }

                @Override
                public void onCurrentModeUpdateSessionUpdate(CurrentModeUpdateSessionUpdate sessionUpdate) {
                    logger.info(sessionUpdate.toString());
                }

                @Override
                public void onPlanSessionUpdate(PlanSessionUpdate sessionUpdate) {
                    logger.info(sessionUpdate.toString());
                }

                @Override
                public void onToolCallUpdateSessionUpdate(ToolCallUpdateSessionUpdate sessionUpdate) {
                    logger.info(sessionUpdate.toString());
                }

                @Override
                public void onToolCallSessionUpdate(ToolCallSessionUpdate sessionUpdate) {
                    logger.info(sessionUpdate.toString());
                }
            }));
        } finally {
            acpClient.close();
        }
    }

    @Test
    void test() throws SessionNewException, AgentInitializeException, IOException {
        Transport transport = new ProcessTransport(
                new ProcessTransportOptions().setCommandArgs(new String[] {"qwen", "--acp", "-y"}));
        AcpClient acpClient = new AcpClient(transport, new InitializeRequestParams().setClientCapabilities(
                new ClientCapabilities()
                        .setTerminal(true)
                        .setFs(new FileSystemCapability().setReadTextFile(true).setWriteTextFile(true))));
        Session session = acpClient.newSession(new NewSessionRequestParams());
        session.sendPrompt(Collections.singletonList(new TextContent("你是谁")), new AgentEventConsumer());
    }

    @Test
    void testPermission() throws AgentInitializeException, SessionNewException, IOException {
        Transport transport = new ProcessTransport(
                new ProcessTransportOptions().setCommandArgs(new String[] {"qwen", "--acp"}));
        AcpClient acpClient = new AcpClient(transport, new InitializeRequestParams().setClientCapabilities(
                new ClientCapabilities()
                        .setTerminal(false)
                        .setFs(new FileSystemCapability(true, true))));
        Session session = acpClient.newSession(new NewSessionRequestParams());
        session.sendPrompt(Collections.singletonList(new TextContent("创建一个test.touch文件"))
                , new AgentEventConsumer().setFileEventConsumer(new FileEventSimpleConsumer()).setPermissionEventConsumer(new PermissionEventConsumer() {
                    @Override
                    public RequestPermissionResponseResult onRequestPermissionRequest(RequestPermissionRequest request) throws EventConsumeException {
                        return new RequestPermissionResponseResult(new RequestPermissionOutcome().
                                setOptionId(Optional.of(request)
                                        .map(MethodMessage::getParams)
                                        .map(RequestPermissionRequestParams::getOptions)
                                        .flatMap(options -> options.stream()
                                                .filter(option -> ALLOW_ALWAYS.equals(option.getKind()))
                                                .findFirst())
                                        .map(PermissionOption::getOptionId).orElse(null))
                                .setOutcome(PermissionOutcomeKind.SELECTED));
                    }

                    @Override
                    public Timeout onRequestPermissionRequestTimeout(RequestPermissionRequest request) {
                        return Timeout.TIMEOUT_60_SECONDS;
                    }
                }));
    }
}

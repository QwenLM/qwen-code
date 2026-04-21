package com.alibaba.acp.sdk.session.event.consumer;

import com.alibaba.acp.sdk.protocol.agent.request.terminal.CreateTerminalRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.KillTerminalCommandRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.ReleaseTerminalRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.TerminalOutputRequest;
import com.alibaba.acp.sdk.protocol.agent.request.terminal.WaitForTerminalExitRequest;
import com.alibaba.acp.sdk.protocol.client.response.terminal.CreateTerminalResponse.CreateTerminalResponseResult;
import com.alibaba.acp.sdk.protocol.client.response.terminal.KillTerminalCommandResponse.KillTerminalCommandResponseResult;
import com.alibaba.acp.sdk.protocol.client.response.terminal.ReleaseTerminalResponse.ReleaseTerminalResponseResult;
import com.alibaba.acp.sdk.protocol.client.response.terminal.TerminalOutputResponse.TerminalOutputResponseResult;
import com.alibaba.acp.sdk.protocol.client.response.terminal.WaitForTerminalExitResponse.WaitForTerminalExitResponseResult;
import com.alibaba.acp.sdk.session.event.consumer.exception.EventConsumeException;
import com.alibaba.acp.sdk.utils.Timeout;

/**
 * Terminal Event Consumer Interface
 *
 * This interface defines methods for handling terminal-related events received from the AI agent,
 * such as creating terminals, waiting for terminal exit, releasing terminals, handling terminal output, and killing terminal commands.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public interface TerminalEventConsumer {
    /**
     * Handles create terminal requests from the agent
     *
     * @param request Create terminal request from the agent
     * @return Result of creating the terminal
     * @throws EventConsumeException Thrown when an error occurs during event processing
     */
    CreateTerminalResponseResult onCreateTerminalRequest(CreateTerminalRequest request) throws EventConsumeException;

    /**
     * Handles wait for terminal exit requests from the agent
     *
     * @param request Wait for terminal exit request from the agent
     * @return Result of waiting for terminal exit
     * @throws EventConsumeException Thrown when an error occurs during event processing
     */
    WaitForTerminalExitResponseResult onWaitForTerminalExitRequest(WaitForTerminalExitRequest request) throws EventConsumeException;

    /**
     * Handles release terminal requests from the agent
     *
     * @param request Release terminal request from the agent
     * @return Result of releasing the terminal
     * @throws EventConsumeException Thrown when an error occurs during event processing
     */
    ReleaseTerminalResponseResult onReleaseTerminalRequest(ReleaseTerminalRequest request) throws EventConsumeException;

    /**
     * Handles terminal output requests from the agent
     *
     * @param request Terminal output request from the agent
     * @return Result of processing terminal output
     * @throws EventConsumeException Thrown when an error occurs during event processing
     */
    TerminalOutputResponseResult onTerminalOutput(TerminalOutputRequest request) throws EventConsumeException;

    /**
     * Handles kill terminal command requests from the agent
     *
     * @param request Kill terminal command request from the agent
     * @return Result of killing the terminal command
     * @throws EventConsumeException Thrown when an error occurs during event processing
     */
    KillTerminalCommandResponseResult onKillTerminalCommandRequest(KillTerminalCommandRequest request) throws EventConsumeException;

    /**
     * Gets timeout for create terminal request processing
     *
     * @param createTerminalRequest Create terminal request
     * @return Timeout for processing the request
     */
    Timeout onCreateTerminalRequestTimeout(CreateTerminalRequest createTerminalRequest);

    /**
     * Gets timeout for wait for terminal exit request processing
     *
     * @param waitForTerminalExitRequest Wait for terminal exit request
     * @return Timeout for processing the request
     */
    Timeout onWaitForTerminalExitRequestTimeout(WaitForTerminalExitRequest waitForTerminalExitRequest);

    /**
     * Gets timeout for release terminal request processing
     *
     * @param releaseTerminalRequest Release terminal request
     * @return Timeout for processing the request
     */
    Timeout onReleaseTerminalRequestTimeout(ReleaseTerminalRequest releaseTerminalRequest);

    /**
     * Gets timeout for terminal output request processing
     *
     * @param terminalOutputRequest Terminal output request
     * @return Timeout for processing the request
     */
    Timeout onTerminalOutputRequestTimeout(TerminalOutputRequest terminalOutputRequest);

    /**
     * Gets timeout for kill terminal command request processing
     *
     * @param killTerminalCommandRequest Kill terminal command request
     * @return Timeout for processing the request
     */
    Timeout onKillTerminalCommandRequestTimeout(KillTerminalCommandRequest killTerminalCommandRequest);
}

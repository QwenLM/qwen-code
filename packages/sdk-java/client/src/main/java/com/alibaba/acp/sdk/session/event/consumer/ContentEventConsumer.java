package com.alibaba.acp.sdk.session.event.consumer;

import com.alibaba.acp.sdk.protocol.domain.session.update.AgentMessageChunkSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.AvailableCommandsUpdateSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.CurrentModeUpdateSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.PlanSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.ToolCallSessionUpdate;
import com.alibaba.acp.sdk.protocol.domain.session.update.ToolCallUpdateSessionUpdate;
import com.alibaba.acp.sdk.utils.Timeout;

/**
 * Content Event Consumer Interface
 *
 * This interface defines methods for handling content-related events received from the AI agent,
 * such as message chunks, available commands, mode updates, plans, and tool calls.
 *
 * @author SkyFire
 * @version 0.0.1
 */
public interface ContentEventConsumer {
    /**
     * Handles agent message chunk session updates
     *
     * @param sessionUpdate Agent message chunk session update
     */
    void onAgentMessageChunkSessionUpdate(AgentMessageChunkSessionUpdate sessionUpdate);

    /**
     * Handles available commands update session updates
     *
     * @param sessionUpdate Available commands update session update
     */
    void onAvailableCommandsUpdateSessionUpdate(AvailableCommandsUpdateSessionUpdate sessionUpdate);

    /**
     * Handles current mode update session updates
     *
     * @param sessionUpdate Current mode update session update
     */
    void onCurrentModeUpdateSessionUpdate(CurrentModeUpdateSessionUpdate sessionUpdate);

    /**
     * Handles plan session updates
     *
     * @param sessionUpdate Plan session update
     */
    void onPlanSessionUpdate(PlanSessionUpdate sessionUpdate);

    /**
     * Handles tool call update session updates
     *
     * @param sessionUpdate Tool call update session update
     */
    void onToolCallUpdateSessionUpdate(ToolCallUpdateSessionUpdate sessionUpdate);

    /**
     * Handles tool call session updates
     *
     * @param sessionUpdate Tool call session update
     */
    void onToolCallSessionUpdate(ToolCallSessionUpdate sessionUpdate);

    /**
     * Gets timeout for agent message chunk session update processing
     *
     * @param sessionUpdate Agent message chunk session update
     * @return Timeout for processing the update
     */
    Timeout onAgentMessageChunkSessionUpdateTimeout(AgentMessageChunkSessionUpdate sessionUpdate);

    /**
     * Gets timeout for available commands update session update processing
     *
     * @param sessionUpdate Available commands update session update
     * @return Timeout for processing the update
     */
    Timeout onAvailableCommandsUpdateSessionUpdateTimeout(AvailableCommandsUpdateSessionUpdate sessionUpdate);

    /**
     * Gets timeout for current mode update session update processing
     *
     * @param sessionUpdate Current mode update session update
     * @return Timeout for processing the update
     */
    Timeout onCurrentModeUpdateSessionUpdateTimeout(CurrentModeUpdateSessionUpdate sessionUpdate);

    /**
     * Gets timeout for plan session update processing
     *
     * @param sessionUpdate Plan session update
     * @return Timeout for processing the update
     */
    Timeout onPlanSessionUpdateTimeout(PlanSessionUpdate sessionUpdate);

    /**
     * Gets timeout for tool call update session update processing
     *
     * @param sessionUpdate Tool call update session update
     * @return Timeout for processing the update
     */
    Timeout onToolCallUpdateSessionUpdateTimeout(ToolCallUpdateSessionUpdate sessionUpdate);

    /**
     * Gets timeout for tool call session update processing
     *
     * @param sessionUpdate Tool call session update
     * @return Timeout for processing the update
     */
    Timeout onToolCallSessionUpdateTimeout(ToolCallSessionUpdate sessionUpdate);
}

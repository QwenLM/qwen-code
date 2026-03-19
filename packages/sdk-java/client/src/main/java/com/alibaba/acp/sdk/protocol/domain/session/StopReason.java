package com.alibaba.acp.sdk.protocol.domain.session;

import com.alibaba.fastjson2.annotation.JSONField;

public enum StopReason {
    @JSONField(name = "end_turn", label = "The turn ended successfully.")
    END_TURN,

    @JSONField(name = "max_tokens", label = "The turn ended because the agent reached the maximum number of tokens.")
    MAX_TOKENS,

    @JSONField(name = "max_turn_requests", label = "The turn ended because the agent reached the maximum number of allowed\nagent requests between user turns.")
    MAX_TURN_REQUESTS,

    @JSONField(name = "refusal", label = "The turn ended because the agent refused to continue. The user prompt\nand everything that comes after it won't be included in the next\nprompt, so this should be reflected in the UI.")
    REFUSAL,

    @JSONField(name = "cancelled", label = "The turn was cancelled by the client via `session/cancel`.\n\nThis stop reason MUST be returned when the client sends a `session/cancel`\nnotification, even if the cancellation causes exceptions in underlying operations.\nAgents should catch these exceptions and return this semantically meaningful\nresponse to confirm successful cancellation.")
    CANCELLED;
}

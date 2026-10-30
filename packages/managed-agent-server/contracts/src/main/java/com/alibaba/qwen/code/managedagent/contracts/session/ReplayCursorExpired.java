package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;

import java.util.Map;

/**
 * A replay cursor below the durable floor requires reloading the live message
 * projection. JSON reads answer with {@code 409 cursor_expired}; streams send
 * one resync frame. A rebuilding projection can temporarily require a retry.
 */
public final class ReplayCursorExpired extends ManagedAgentException {
    private final transient ReplayWindow window;

    public ReplayCursorExpired(ReplayWindow window) {
        super(409, "cursor_expired",
                "The replay cursor is older than the replay floor.",
                Map.of("replay_floor_sequence", window.floorSequence(),
                        "snapshot_through_sequence",
                        window.snapshotThroughSequence()));
        this.window = window;
    }

    public ReplayWindow window() {
        return window;
    }
}

package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;
import org.springframework.http.HttpStatus;

import java.util.Map;

/**
 * A replay cursor below the Session's replay floor while the Snapshot backs
 * the floor; a stream reconciliation discards the Snapshot without lowering
 * the floor, and during the rebuild such a cursor is still served. JSON reads
 * answer it with {@code 409 cursor_expired}; streams send one resync frame
 * instead.
 */
public final class ReplayCursorExpired extends ManagedAgentException {
    private final transient ReplayWindow window;

    ReplayCursorExpired(ReplayWindow window) {
        super(HttpStatus.CONFLICT, "cursor_expired",
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

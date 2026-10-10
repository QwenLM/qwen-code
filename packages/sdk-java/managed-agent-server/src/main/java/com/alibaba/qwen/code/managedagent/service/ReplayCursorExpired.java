package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ReplayWindow;
import java.util.Map;
import org.springframework.http.HttpStatus;

/**
 * A replay cursor below the Session's replay floor while the Snapshot backs
 * the floor; a stream reconciliation discards the Snapshot without lowering
 * the floor, and during the rebuild such a cursor is still served. JSON reads
 * answer it with {@code 409 cursor_expired}; streams send one resync frame
 * instead.
 */
public final class ReplayCursorExpired extends ApiException {
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

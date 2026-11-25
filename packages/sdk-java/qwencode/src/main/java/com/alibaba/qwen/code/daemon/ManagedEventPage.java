package com.alibaba.qwen.code.daemon;

import java.util.Map;

/** A JSON event page. The next sequence can be passed to listEvents or streamEvents. */
public final class ManagedEventPage extends ManagedPage<ManagedAgentEventStream.Event> {
    ManagedEventPage(Map<String, Object> json) {
        super(json, ManagedAgentEventStream.Event::fromJson);
    }

    /** Returns the next sequence cursor, or null when the server provides none. */
    public Long getNextSequence() {
        String cursor = getNextCursor();
        if (cursor == null) {
            return null;
        }
        try {
            long sequence = Long.parseLong(cursor);
            if (sequence >= 0) {
                return sequence;
            }
        } catch (NumberFormatException ignored) {
            // Report the same protocol error for malformed and negative cursors.
        }
        throw new DaemonProtocolException("Managed event cursor must be a nonnegative integer");
    }
}

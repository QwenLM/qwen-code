package com.alibaba.qwen.code.daemon;

import java.io.IOException;
import java.io.InputStream;
import java.util.Map;

/** A blocking reader for a public Managed Session's SSE response. */
public final class ManagedAgentEventStream implements AutoCloseable {
    private static final int MAXIMUM_FRAME_BYTES = 8 * 1024 * 1024;
    private final SseReader reader;
    private long lastEventId;

    ManagedAgentEventStream(InputStream input, long after) {
        this.reader = new SseReader(input, MAXIMUM_FRAME_BYTES, () -> {});
        this.lastEventId = after;
    }

    /** Returns the last decoded event ID, or the requested cursor before any event arrives. */
    public long getLastEventId() {
        return lastEventId;
    }

    /** Reads the next event, or returns null at EOF. Use one reader per stream. */
    public Event next() {
        SseReader.Frame frame;
        try {
            frame = reader.next();
        } catch (IOException error) {
            throw new DaemonTransportException("Could not read Managed event stream", error);
        }
        if (frame == null) {
            return null;
        }
        if (frame.getEvent() == null) {
            throw new DaemonProtocolException("Managed SSE event is missing its type");
        }
        Map<String, Object> payload = JsonSupport.parseObject(frame.getData(), "Managed SSE event");
        if (frame.getId() != null) {
            if (frame.getId() <= lastEventId) {
                throw new DaemonProtocolException("Managed SSE event ID moved backward or repeated");
            }
            lastEventId = frame.getId();
        }
        return new Event(frame.getEvent(), frame.getId(), payload);
    }

    @Override
    public void close() {
        try {
            reader.close();
        } catch (IOException error) {
            throw new DaemonTransportException("Could not close Managed event stream", error);
        }
    }

    /** One SSE frame. The payload is the complete public event or resync object. */
    public static final class Event {
        private final String type;
        private final Long id;
        private final Map<String, Object> payload;

        private Event(String type, Long id, Map<String, Object> payload) {
            this.type = type;
            this.id = id;
            this.payload = payload;
        }

        public String getType() {
            return type;
        }

        /** Returns null for an unsequenced control event. */
        public Long getId() {
            return id;
        }

        public Map<String, Object> getPayload() {
            return payload;
        }

        public boolean isResyncRequired() {
            return "agent.session.resync_required".equals(type);
        }
    }
}

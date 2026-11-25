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
    public static final class Event extends ManagedJson {
        private final String type;
        private final Long id;

        private Event(String type, Long id, Map<String, Object> payload) {
            super(payload);
            this.type = type;
            this.id = id;
        }

        static Event fromJson(Map<String, Object> payload) {
            return new Event(JsonSupport.requiredString(payload, "type", "Managed event"),
                    JsonSupport.requiredNonNegativeLong(payload, "sequence", "Managed event"), payload);
        }

        public String getType() {
            return type;
        }

        /** Returns null for an unsequenced control event. */
        public Long getId() {
            return id;
        }

        public Map<String, Object> getPayload() {
            return json();
        }

        public String getSessionId() {
            return string("session_id");
        }

        public String getTurnId() {
            return optionalString("turn_id");
        }

        public String getItemId() {
            return optionalString("item_id");
        }

        public String getContentPartId() {
            return optionalString("content_part_id");
        }

        public String getEventId() {
            return optionalString("event_id");
        }

        public Long getCreatedAt() {
            return optionalNumber("created_at");
        }

        public Long getSchemaVersion() {
            return optionalNumber("schema_version");
        }

        public Long getProjectionVersion() {
            return optionalNumber("projection_version");
        }

        public boolean isTerminal() {
            return !isResyncRequired() && flag("terminal");
        }

        /** Event-specific data, or null on a resync control frame. */
        public Map<String, Object> getData() {
            return optionalObject("data");
        }

        /** Returns a text fragment for output-text delta events, or null for other events. */
        public String getOutputTextDelta() {
            return "item.output_text.delta".equals(type)
                    ? JsonSupport.optionalString(object("data"), "text") : null;
        }

        public Long getReplayFloorSequence() {
            return optionalNumber("replay_floor_sequence");
        }

        /** Resync watermark at event creation. Use the fresh Items page's watermark to resume. */
        public Long getSnapshotThroughSequence() {
            return optionalNumber("snapshot_through_sequence");
        }

        public boolean isResyncRequired() {
            return "agent.session.resync_required".equals(type);
        }
    }
}

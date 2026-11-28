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

    /** One public Session event from replay or SSE. A resync control frame has no sequence. */
    public static final class Event extends ManagedJson {
        private final String type;
        private final Long id;

        private Event(String type, Long id, Map<String, Object> json) {
            super(json);
            this.type = type;
            this.id = id;
        }

        static Event fromJson(Map<String, Object> json) {
            return new Event(JsonSupport.requiredString(json, "type", "Managed event"),
                    JsonSupport.requiredNonNegativeLong(json, "sequence", "Managed event"), json);
        }

        public String getType() {
            return type;
        }

        /** Returns null for an unsequenced control event. */
        public Long getId() {
            return id;
        }

        /** The numeric replay position, or null for an unsequenced control event. */
        public Long getSequence() {
            return id;
        }

        /** The server's opaque event identifier, or null for a control event. */
        public String getEventId() {
            return optionalString("event_id");
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

        /** UNIX epoch seconds, or null for a control event. */
        public Long getCreatedAt() {
            return optionalNumber("created_at");
        }

        public Integer getSchemaVersion() {
            return json().get("schema_version") == null ? null
                    : JsonSupport.requiredInt(json(), "schema_version", "Managed event");
        }

        public Integer getProjectionVersion() {
            return json().get("projection_version") == null ? null
                    : JsonSupport.requiredInt(json(), "projection_version", "Managed event");
        }

        public boolean isTerminal() {
            return Boolean.TRUE.equals(optionalFlag("terminal"));
        }

        /** The event-specific payload. Types with open data return a {@link JsonPayload}. */
        public Payload getPayload() {
            if (isResyncRequired()) {
                return new ResyncRequired(json());
            }
            Map<String, Object> data = optionalObject("data");
            if (data == null) {
                data = Map.of();
            }
            switch (type) {
                case "item.output_text.delta":
                case "item.reasoning.delta":
                    return new TextDelta(data);
                case "turn.completed":
                case "turn.cancelled":
                    return new TurnFinished(data);
                case "turn.failed":
                    return new TurnFailed(data);
                default:
                    return new JsonPayload(data);
            }
        }

        /** The output fragment, including empty retracted fragments, or null for other events. */
        public String getOutputTextDelta() {
            return "item.output_text.delta".equals(type) ? ((TextDelta) getPayload()).getText() : null;
        }

        /** The reasoning fragment, or null for other events. */
        public String getReasoningDelta() {
            return "item.reasoning.delta".equals(type) ? ((TextDelta) getPayload()).getText() : null;
        }

        public boolean isResyncRequired() {
            return "agent.session.resync_required".equals(type);
        }

        /** The lowest replay cursor available at resync, or null for a normal event. */
        public Long getReplayFloorSequence() {
            return isResyncRequired() ? number("replay_floor_sequence") : null;
        }

        /** The resync watermark at delivery, or null for a normal event. Resume from the fresh Items watermark. */
        public Long getSnapshotThroughSequence() {
            return isResyncRequired() ? number("snapshot_through_sequence") : null;
        }
    }

    /** Event-specific data. Common identifiers and sequence numbers are on {@link Event}. */
    public abstract static class Payload extends ManagedJson {
        private Payload(Map<String, Object> json) {
            super(json);
        }
    }

    /** Assistant output or reasoning delta. */
    public static final class TextDelta extends Payload {
        private TextDelta(Map<String, Object> json) {
            super(json);
        }

        public String getText() {
            return optionalString("text");
        }

        /** Identity supplied by the event producer. For the projected Item use {@link Event#getItemId()}. */
        public String getSourceItemId() {
            return optionalString("itemId");
        }

        /** Identity supplied by the event producer. For the projected part use {@link Event#getContentPartId()}. */
        public String getSourceContentPartId() {
            return optionalString("contentPartId");
        }
    }

    /** Data for a completed or cancelled Turn. */
    public static final class TurnFinished extends Payload {
        private TurnFinished(Map<String, Object> json) {
            super(json);
        }

        public String getStopReason() {
            return optionalString("stopReason");
        }

        /** Turn ID included in cancellation data, when present. */
        public String getTurnId() {
            return optionalString("turnId");
        }
    }

    /** Data for a failed Turn. */
    public static final class TurnFailed extends Payload {
        private TurnFailed(Map<String, Object> json) {
            super(json);
        }

        public String getCode() {
            return optionalString("code");
        }

        public String getMessage() {
            return optionalString("message");
        }
    }

    /** A request to load fresh Items before restarting the stream. */
    public static final class ResyncRequired extends Payload {
        private ResyncRequired(Map<String, Object> json) {
            super(json);
        }

        public long getReplayFloorSequence() {
            return number("replay_floor_sequence");
        }

        public long getSnapshotThroughSequence() {
            return number("snapshot_through_sequence");
        }

        public String getAction() {
            return string("action");
        }
    }

    /** Immutable JSON data for other event types. */
    public static final class JsonPayload extends Payload {
        private JsonPayload(Map<String, Object> json) {
            super(json);
        }

        public Map<String, Object> getJson() {
            return json();
        }
    }
}

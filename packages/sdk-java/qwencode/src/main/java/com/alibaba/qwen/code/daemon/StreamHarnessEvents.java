package com.alibaba.qwen.code.daemon;

/** Cursor and epoch used to open one Hosted Harness SSE stream. */
public final class StreamHarnessEvents {
    private final HarnessSessionRef session;
    private final Long lastEventId;
    private final String eventEpoch;
    private final boolean snapshot;

    private StreamHarnessEvents(Builder builder) {
        if (builder.session == null) {
            throw new IllegalStateException("session must be provided");
        }
        if (builder.lastEventId != null && builder.lastEventId < 0) {
            throw new IllegalArgumentException(
                    "lastEventId must be non-negative");
        }
        this.session = builder.session;
        this.lastEventId = builder.lastEventId;
        this.eventEpoch = HostedHarnessClient.requireEventEpoch(
                builder.eventEpoch, true);
        this.snapshot = builder.snapshot;
    }

    public static Builder builder() {
        return new Builder();
    }

    HarnessSessionRef getSession() {
        return session;
    }

    Long getLastEventId() {
        return lastEventId;
    }

    String getEventEpoch() {
        return eventEpoch;
    }

    boolean isSnapshot() {
        return snapshot;
    }

    public static final class Builder {
        private HarnessSessionRef session;
        private Long lastEventId;
        private String eventEpoch;
        private boolean snapshot;

        private Builder() {
        }

        public Builder session(HarnessSessionRef session) {
            this.session = session;
            return this;
        }

        /**
         * Resumes the stream after this event id. An explicit cursor always
         * wins — including 0, which asks for a replay from the beginning;
         * only an omitted cursor falls back to the session ref's watermark,
         * so the epoch fence stays on by default.
         */
        public Builder lastEventId(long lastEventId) {
            this.lastEventId = lastEventId;
            return this;
        }

        public Builder eventEpoch(String eventEpoch) {
            this.eventEpoch = eventEpoch;
            return this;
        }

        /**
         * Adds the snapshot query parameter to the stream request. The
         * snapshot frame is produced only by the primary daemon transport;
         * the hosted events route does not read this parameter, so the
         * switch is parsed-compatibly ignored there.
         */
        public Builder snapshot(boolean snapshot) {
            this.snapshot = snapshot;
            return this;
        }

        public StreamHarnessEvents build() {
            return new StreamHarnessEvents(this);
        }
    }
}

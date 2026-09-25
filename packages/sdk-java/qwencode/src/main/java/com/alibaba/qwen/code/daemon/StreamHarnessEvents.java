package com.alibaba.qwen.code.daemon;

/** Cursor and epoch used to open one Hosted Harness SSE stream. */
public final class StreamHarnessEvents {
    private final HarnessSessionRef session;
    private final long lastEventId;
    private final String eventEpoch;
    private final boolean snapshot;

    private StreamHarnessEvents(Builder builder) {
        if (builder.session == null) {
            throw new IllegalStateException("session must be provided");
        }
        if (builder.lastEventId < 0) {
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

    long getLastEventId() {
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
        private long lastEventId;
        private String eventEpoch;
        private boolean snapshot;

        private Builder() {
        }

        public Builder session(HarnessSessionRef session) {
            this.session = session;
            return this;
        }

        public Builder lastEventId(long lastEventId) {
            this.lastEventId = lastEventId;
            return this;
        }

        public Builder eventEpoch(String eventEpoch) {
            this.eventEpoch = eventEpoch;
            return this;
        }

        public Builder snapshot(boolean snapshot) {
            this.snapshot = snapshot;
            return this;
        }

        public StreamHarnessEvents build() {
            return new StreamHarnessEvents(this);
        }
    }
}

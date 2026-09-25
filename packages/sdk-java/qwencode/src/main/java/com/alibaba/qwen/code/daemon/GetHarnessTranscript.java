package com.alibaba.qwen.code.daemon;

/** Paging request for persisted Hosted Harness transcript records. */
public final class GetHarnessTranscript {
    private final HarnessSessionRef session;
    private final Integer limit;
    private final String cursor;
    private final String direction;

    private GetHarnessTranscript(Builder builder) {
        if (builder.session == null) {
            throw new IllegalStateException("session must be provided");
        }
        this.session = builder.session;
        this.limit = builder.limit;
        this.cursor = builder.cursor;
        this.direction = builder.direction;
    }

    public static Builder builder() {
        return new Builder();
    }

    HarnessSessionRef getSession() {
        return session;
    }

    Integer getLimit() {
        return limit;
    }

    String getCursor() {
        return cursor;
    }

    String getDirection() {
        return direction;
    }

    public static final class Builder {
        private HarnessSessionRef session;
        private Integer limit;
        private String cursor;
        private String direction;

        private Builder() {
        }

        public Builder session(HarnessSessionRef session) {
            this.session = session;
            return this;
        }

        public Builder limit(int limit) {
            if (limit <= 0) {
                throw new IllegalArgumentException("limit must be positive");
            }
            this.limit = limit;
            return this;
        }

        public Builder cursor(String cursor) {
            if (cursor == null || cursor.isEmpty()) {
                throw new IllegalArgumentException("cursor must not be empty");
            }
            this.cursor = cursor;
            return this;
        }

        public Builder direction(String direction) {
            if (!"forward".equals(direction)
                    && !"backward".equals(direction)) {
                throw new IllegalArgumentException(
                        "direction must be forward or backward");
            }
            this.direction = direction;
            return this;
        }

        public GetHarnessTranscript build() {
            if (cursor != null && direction != null) {
                throw new IllegalStateException(
                        "cursor and direction are mutually exclusive");
            }
            return new GetHarnessTranscript(this);
        }
    }
}

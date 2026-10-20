package com.alibaba.qwen.code.daemon;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/** One persisted transcript page used for Java-side reconciliation. */
public final class HarnessTranscriptPage {
    private final String harnessSessionId;
    private final List<Object> events;
    private final String nextCursor;
    private final boolean more;
    private final Map<String, Object> raw;

    HarnessTranscriptPage(String harnessSessionId, List<Object> events,
            String nextCursor, boolean more, Map<String, Object> raw) {
        this.harnessSessionId = harnessSessionId;
        this.events = Collections.unmodifiableList(events);
        this.nextCursor = nextCursor;
        this.more = more;
        this.raw = JsonSupport.immutableObject(raw);
    }

    public String getHarnessSessionId() {
        return harnessSessionId;
    }

    public List<Object> getEvents() {
        return events;
    }

    public String getNextCursor() {
        return nextCursor;
    }

    public boolean hasMore() {
        return more;
    }

    public Map<String, Object> getRaw() {
        return raw;
    }
}

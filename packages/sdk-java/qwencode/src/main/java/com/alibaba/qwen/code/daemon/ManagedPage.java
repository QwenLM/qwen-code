package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** One page of a Managed collection. */
public class ManagedPage<T> extends ManagedJson {
    private final List<T> entries;

    ManagedPage(Map<String, Object> json, Function<Map<String, Object>, T> decoder) {
        super(json);
        this.entries = objects("data", decoder);
    }

    public final List<T> getEntries() {
        return entries;
    }

    public final boolean hasMore() {
        return flag("has_more");
    }

    /** Pass this cursor to the next call. Returns null when no cursor is provided. */
    public final String getNextCursor() {
        return optionalString("next_cursor");
    }
}

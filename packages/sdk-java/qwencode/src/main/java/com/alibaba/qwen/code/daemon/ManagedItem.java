package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;

/** One projected Session history item. */
public final class ManagedItem extends ManagedJson {
    ManagedItem(Map<String, Object> json) {
        super(json);
    }

    public String getId() {
        return string("id");
    }

    public String getObject() {
        return string("object");
    }

    public String getSessionId() {
        return string("session_id");
    }

    public String getTurnId() {
        return optionalString("turn_id");
    }

    public String getType() {
        return string("type");
    }

    public String getRole() {
        return optionalString("role");
    }

    public long getRevision() {
        return number("revision");
    }

    public String getStatus() {
        return string("status");
    }

    public long getFirstSequence() {
        return number("first_sequence");
    }

    public long getLastSequence() {
        return number("last_sequence");
    }

    public List<ContentPart> getContent() {
        return objects("content", ContentPart::new);
    }

    public Map<String, Object> getAttributes() {
        return optionalObject("attributes");
    }

    public Long getCreatedAt() {
        return optionalNumber("created_at");
    }

    public Long getUpdatedAt() {
        return optionalNumber("updated_at");
    }

    /** Projected history and the event sequence covered by that projection. */
    public static final class Page extends ManagedPage<ManagedItem> {
        Page(Map<String, Object> json) {
            super(json, ManagedItem::new);
        }

        public long getSnapshotThroughSequence() {
            return number("snapshot_through_sequence");
        }
    }

    /** One projected content segment. */
    public static final class ContentPart extends ManagedJson {
        ContentPart(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("part_id");
        }

        public String getType() {
            return string("type");
        }

        public String getText() {
            return optionalString("text");
        }

        public long getFirstSequence() {
            return number("first_sequence");
        }

        public long getLastSequence() {
            return number("last_sequence");
        }
    }
}

package com.alibaba.qwen.code.daemon;

import java.util.List;
import java.util.Map;

/** Effective Hook catalog for a Session. */
public final class ManagedHookCatalog extends ManagedJson {
    ManagedHookCatalog(Map<String, Object> json) {
        super(json);
    }

    public String getSessionId() {
        return string("session_id");
    }

    public List<Catalog> getCatalogs() {
        return objects("catalogs", Catalog::new);
    }

    /** Pinned catalog and its Hook descriptors. */
    public static final class Catalog extends ManagedJson {
        Catalog(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("catalog_id");
        }

        public long getRevision() {
            return number("catalog_revision");
        }

        public List<Hook> getHooks() {
            return objects("hooks", Hook::new);
        }
    }

    /** One effective Hook descriptor. */
    public static final class Hook extends ManagedJson {
        Hook(Map<String, Object> json) {
            super(json);
        }

        public String getId() {
            return string("hook_id");
        }

        public String getEventName() {
            return string("event_name");
        }

        public String getType() {
            return string("type");
        }

        public String getMatcher() {
            return optionalString("matcher");
        }

        public boolean isSequential() {
            return flag("sequential");
        }

        public boolean isAsync() {
            return flag("async");
        }

        public boolean isFailClosed() {
            return flag("fail_closed");
        }

        public boolean isOnce() {
            return flag("once");
        }
    }
}

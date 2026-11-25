package com.alibaba.qwen.code.daemon;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

abstract class ManagedJson {
    private final Map<String, Object> json;

    ManagedJson(Map<String, Object> json) {
        this.json = json;
    }

    final Map<String, Object> json() {
        return json;
    }

    final String string(String key) {
        return JsonSupport.requiredString(json, key, "Managed response");
    }

    final String optionalString(String key) {
        return JsonSupport.optionalString(json, key);
    }

    final boolean flag(String key) {
        return JsonSupport.requiredBoolean(json, key, "Managed response");
    }

    final Boolean optionalFlag(String key) {
        return json.get(key) == null ? null : flag(key);
    }

    final long number(String key) {
        return JsonSupport.requiredNonNegativeLong(json, key, "Managed response");
    }

    final Long optionalNumber(String key) {
        return json.get(key) == null ? null : number(key);
    }

    final Map<String, Object> object(String key) {
        return JsonSupport.requiredObject(json, key, "Managed response");
    }

    final Map<String, Object> optionalObject(String key) {
        return JsonSupport.optionalObject(json, key);
    }

    final <T> T optionalObject(String key, Function<Map<String, Object>, T> decode) {
        Map<String, Object> value = optionalObject(key);
        return value == null ? null : decode.apply(value);
    }

    final <T> List<T> objects(String key, Function<Map<String, Object>, T> decode) {
        List<Object> items = JsonSupport.optionalList(json, key);
        if (items == null) {
            throw new DaemonProtocolException(key + " must be an array");
        }
        List<T> result = new ArrayList<>(items.size());
        for (Object item : items) {
            Map<String, Object> value = JsonSupport.extensionObject(item);
            if (value == null) {
                throw new DaemonProtocolException(key + " must contain only objects");
            }
            result.add(decode.apply(value));
        }
        return List.copyOf(result);
    }

    static void put(Map<String, Object> json, String key, Object value) {
        if (value != null) {
            json.put(key, value);
        }
    }
}

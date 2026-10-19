package com.alibaba.qwen.code.managedagent.model;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.springframework.stereotype.Component;

@Component
public class RequestDigests {
    private final ObjectMapper canonicalMapper;

    public RequestDigests() {
        this.canonicalMapper = JsonMapper.builder()
                .enable(MapperFeature.SORT_PROPERTIES_ALPHABETICALLY)
                .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
                .build();
    }

    public String digest(Object value) {
        try {
            byte[] encoded = canonicalMapper.writeValueAsBytes(value);
            return "sha256:" + DigestUtils.sha256Hex(encoded);
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException(
                    "Request cannot be canonicalized", error);
        }
    }

    public int byteLength(Object value) {
        try {
            return canonicalMapper.writeValueAsBytes(value).length;
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException("Request cannot be canonicalized", error);
        }
    }
}

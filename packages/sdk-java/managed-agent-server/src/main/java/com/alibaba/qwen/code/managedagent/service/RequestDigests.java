package com.alibaba.qwen.code.managedagent.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.MapperFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
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
            byte[] hashed = MessageDigest.getInstance("SHA-256")
                    .digest(encoded);
            StringBuilder result = new StringBuilder("sha256:");
            for (byte item : hashed) {
                result.append(String.format("%02x", item & 0xff));
            }
            return result.toString();
        } catch (JsonProcessingException error) {
            throw new IllegalArgumentException(
                    "Request cannot be canonicalized", error);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException("SHA-256 is unavailable", error);
        }
    }
}

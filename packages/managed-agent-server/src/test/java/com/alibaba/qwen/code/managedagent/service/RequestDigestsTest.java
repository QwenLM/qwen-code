package com.alibaba.qwen.code.managedagent.service;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RequestDigestsTest {
    private final RequestDigests digests = new RequestDigests();

    @Test
    void preservesThePersistedDigestOfSortedNestedMapsAndUtf8Text() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("z", List.of("中文", 1, true));
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("beta", 2);
        nested.put("alpha", "x");
        value.put("a", nested);

        assertThat(digests.digest(value)).isEqualTo(
                "sha256:a8f649f7bbe9e4aea58bfc4bfdd542e4f8697505d6dcb36e6f017d6ec8ecb846");
    }

    @Test
    void preservesThePersistedDigestOfAlphabeticallySortedRecordProperties() {
        assertThat(digests.digest(new Payload("中文", 3))).isEqualTo(
                "sha256:019dd894d1f75f9428e5ab3defef7e06b565d909ac8c01265075a319b2e70455");
    }

    private record Payload(String zeta, int alpha) {
    }
}

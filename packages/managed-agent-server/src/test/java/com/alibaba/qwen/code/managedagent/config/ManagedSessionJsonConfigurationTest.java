package com.alibaba.qwen.code.managedagent.config;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.CommitTransactionRequest;
import com.fasterxml.jackson.core.exc.StreamConstraintsException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.mock.http.MockHttpInputMessage;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedSessionJsonConfigurationTest {
    @Test
    void readsLargeBase64OnlyForInternalCommitRequests() throws Exception {
        var mapper = new ObjectMapper();
        var converter = new MappingJackson2HttpMessageConverter(mapper);
        new ManagedSessionJsonConfiguration().extendMessageConverters(List.of(converter));
        String encoded = "A".repeat(21_000_000);
        byte[] body = ("{\"resources\":[{\"bytesBase64\":\"" + encoded + "\"}]}").getBytes(StandardCharsets.UTF_8);
        var input = new MockHttpInputMessage(body);
        input.getHeaders().setContentType(MediaType.APPLICATION_JSON);
        var decoded = (CommitTransactionRequest) converter.read(CommitTransactionRequest.class, input);
        assertThat(decoded.resources().getFirst().bytesBase64()).isEqualTo(encoded);
        assertThatThrownBy(() -> mapper.readTree(body)).isInstanceOf(StreamConstraintsException.class);
    }
}

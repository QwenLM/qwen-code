package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

/** Pure conversion coverage; original SQL admission is verified separately. */
class CsiNativeToolResultProofTest {
    private static final ObjectMapper JSON = new ObjectMapper();

    @Test
    void convertsOriginalFiniteExecutorTypedTextAndPlainPartsIdentically() throws Exception {
        var call = new CsiNativeActivationProof.FunctionCall("provider-call-0", "read_file", JSON.createObjectNode(), 2, 0);
        var expected = JSON.readTree("""
                [{"functionResponse":{"id":"provider-call-0","name":"read_file",
                "response":{"output":"Showing lines 1-1 of 2 total lines.\\n\\n---\\n\\n原文 😀","executionStatus":"success"}}}]
                """);
        for (String prefix : new String[] {"", "\"type\":\"text\","}) {
            var result = JSON.readTree("{\"executionStatus\":\"success\",\"responseParts\":[{"
                    + prefix + "\"text\":\"Showing lines 1-1 of 2 total lines.\\n\\n---\\n\\n原文 😀\"}]}");
            assertEquals(expected, CsiNativeActivationProof.convertedResult(result, call));
        }
    }

    @Test
    void refusesTextWithIncorrectTypeOrAdditionalFields() throws Exception {
        var call = new CsiNativeActivationProof.FunctionCall("provider-call-0", "read_file", JSON.createObjectNode(), 2, 0);
        for (String fields : new String[] {"\"type\":\"image\",", "\"type\":\"text\",\"foreign\":true,"}) {
            var result = JSON.readTree("{\"executionStatus\":\"success\",\"responseParts\":[{"
                    + fields + "\"text\":\"original\"}]}");
            assertThrows(RuntimeBrokerException.class, () -> CsiNativeActivationProof.convertedResult(result, call));
        }
    }
}

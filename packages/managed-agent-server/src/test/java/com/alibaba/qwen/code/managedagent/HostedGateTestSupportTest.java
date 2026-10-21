package com.alibaba.qwen.code.managedagent;

import org.junit.jupiter.api.Test;

import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.camel;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.quote;
import static org.assertj.core.api.Assertions.assertThat;

// #14921 R1-2: these two helpers are shared by nine Hosted*IT classes whose
// only lane needs MySQL and the Harness. Pinning them here keeps a wrong edit
// red in the default surefire lane instead of the slowest CI job.
class HostedGateTestSupportTest {
    @Test
    void quoteClosesTheLiteralAndReopensItAroundASingleQuote() {
        assertThat(quote("plain")).isEqualTo("'plain'");
        assertThat(quote("it's")).isEqualTo("'it'\"'\"'s'");
        assertThat(quote("")).isEqualTo("''");
    }

    @Test
    void camelUppercasesTheLetterAfterAnUnderscore() {
        assertThat(camel("foo_bar")).isEqualTo("fooBar");
        assertThat(camel("a_b_c")).isEqualTo("aBC");
        assertThat(camel("plain")).isEqualTo("plain");
    }

    @Test
    void camelKeepsATrailingUnderscoreLiteral() {
        assertThat(camel("foo_")).isEqualTo("foo_");
    }
}

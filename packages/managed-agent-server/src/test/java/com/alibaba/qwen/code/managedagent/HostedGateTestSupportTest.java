package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.daemon.HarnessSessionRef;
import com.alibaba.qwen.code.managedagent.harness.QwenHostedHarnessConnector;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.LinkedHashMap;

import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.attachment;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.camel;
import static com.alibaba.qwen.code.managedagent.HostedGateTestSupport.quote;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

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

    // The lookup reads the connector's private field by name; renaming that
    // field turns this red here rather than in five Hosted gate classes.
    @Test
    void attachmentReturnsTheSessionsRefFromTheConnector() {
        var connector = mock(QwenHostedHarnessConnector.class);
        var attachments = new LinkedHashMap<Object, HarnessSessionRef>();
        attachments.put("other", ref("session-b"));
        HarnessSessionRef mine = ref("session-a");
        attachments.put("mine", mine);
        ReflectionTestUtils.setField(connector, "attachments", attachments);

        assertThat(attachment(connector, "session-a")).isSameAs(mine);
        assertThat(attachment(connector, "session-c")).isNull();
    }

    private static HarnessSessionRef ref(String sessionId) {
        HarnessSessionRef ref = mock(HarnessSessionRef.class);
        when(ref.getHarnessSessionId()).thenReturn(sessionId);
        return ref;
    }
}

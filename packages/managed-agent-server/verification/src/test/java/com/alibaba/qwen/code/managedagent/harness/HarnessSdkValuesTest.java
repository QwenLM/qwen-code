package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.DaemonTransportException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessGenerationFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessProtocolFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessTransportFailure;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.concurrent.CompletionException;

import static org.assertj.core.api.Assertions.assertThat;

class HarnessSdkValuesTest {
    @Test
    void httpStatusBodyFieldsAndTransportCauseSurviveTheBoundary() throws Exception {
        var cause = new IOException("disconnected");
        var http = sdk(DaemonHttpException.class, new Class<?>[] {String.class, int.class, String.class},
                "create", 409, "{\"code\":\"generation_changed\",\"detail\":\"stale\"}");
        http.initCause(cause);
        var mapped = (HarnessHttpFailure) HarnessSdkValues.failure(http);
        assertThat(mapped.getStatusCode()).isEqualTo(409);
        assertThat(mapped.getResponseBody()).isEqualTo(http.getResponseBody());
        assertThat(mapped.getErrorCode()).isEqualTo("generation_changed");
        assertThat(mapped.getBodyField("detail")).isEqualTo("stale");
        assertThat(mapped).hasMessage(http.getMessage()).hasCause(cause);
    }

    @Test
    void deferredFailuresAndSuppressedSdkFailuresAreConverted() throws Exception {
        var protocol = sdk(DaemonProtocolException.class, new Class<?>[] {String.class}, "malformed");
        var transport = sdk(DaemonTransportException.class, new Class<?>[] {String.class}, "disconnected");
        var deferred = new CompletionException(protocol);
        deferred.addSuppressed(transport);
        Throwable mapped = HarnessSdkValues.failure(deferred);
        assertThat(mapped).isInstanceOf(CompletionException.class).hasCauseInstanceOf(HarnessProtocolFailure.class);
        assertThat(mapped.getSuppressed()).hasSize(1);
        assertThat(mapped.getSuppressed()[0]).isInstanceOf(HarnessTransportFailure.class);
        assertThat(HarnessSdkValues.failure(new IllegalStateException("outer", protocol)))
                .isInstanceOf(HarnessFailure.class).hasCauseInstanceOf(HarnessProtocolFailure.class);
    }

    @Test
    void generationIdentityAndUnrelatedFailuresKeepTheirMeaning() throws Exception {
        var generation = sdk(HostedHarnessGenerationException.class,
                new Class<?>[] {String.class, String.class}, "before", "after");
        var mapped = (HarnessGenerationFailure) HarnessSdkValues.failure(generation);
        assertThat(mapped.getExpectedBootId()).isEqualTo("before");
        assertThat(mapped.getActualBootId()).isEqualTo("after");
        assertThat(mapped.getCode()).isEqualTo(generation.getCode());
        var unrelated = new IllegalArgumentException("invalid");
        assertThat(HarnessSdkValues.failure(unrelated)).isSameAs(unrelated);
        assertThat(HarnessSdkValues.recovery(null)).isNull();
    }
    private static <T extends Throwable> T sdk(Class<T> type, Class<?>[] parameters, Object... arguments) throws Exception {
        var constructor = type.getDeclaredConstructor(parameters);
        constructor.setAccessible(true);
        return constructor.newInstance(arguments);
    }
}

package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonProtocolException;
import com.alibaba.qwen.code.daemon.DaemonTransportException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessGenerationFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessProtocolFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessTransportFailure;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.CompletionException;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

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

    @Test
    void boundaryPreservesResultsAndMapsImmediateFailures() throws Exception {
        var delegate = mock(HarnessConnector.class);
        var boundary = new SdkHarnessBoundary(delegate);
        Map<String, Object> body = Map.of("message", "hello");
        Map<String, Object> result = Map.of("state", "done");
        when(delegate.runMessageOperation("tenant", "session", body)).thenReturn(result);
        assertThat(boundary.runMessageOperation("tenant", "session", body)).isSameAs(result);
        verify(delegate).runMessageOperation("tenant", "session", body);

        var http = sdk(DaemonHttpException.class, new Class<?>[] {String.class, int.class, String.class},
                "drain", 503, "{\"code\":\"unavailable\"}");
        when(delegate.drainInstance("instance", "operation")).thenThrow(http);
        assertThatThrownBy(() -> boundary.drainInstance("instance", "operation"))
                .isInstanceOfSatisfying(HarnessHttpFailure.class, failure -> {
                    assertThat(failure.getStatusCode()).isEqualTo(503);
                    assertThat(failure.getErrorCode()).isEqualTo("unavailable");
                });
        var transport = sdk(DaemonTransportException.class, new Class<?>[] {String.class}, "disconnected");
        doThrow(transport).when(delegate).cancel("tenant", "session");
        assertThatThrownBy(() -> boundary.cancel("tenant", "session"))
                .isInstanceOf(HarnessTransportFailure.class).hasMessage("disconnected");
        verify(delegate).cancel("tenant", "session");
    }

    @Test
    void compressionSubmissionStaysDeferredAndMapsLaterFailures() throws Exception {
        var delegate = mock(HarnessConnector.class);
        var submission = mock(HarnessConnector.ContextCompressionSubmission.class);
        Map<String, Object> body = Map.of("operationId", "operation");
        when(delegate.prepareContextCompression("tenant", "session", body)).thenReturn(submission);
        var prepared = new SdkHarnessBoundary(delegate).prepareContextCompression("tenant", "session", body);
        verifyNoInteractions(submission);
        var transport = sdk(DaemonTransportException.class, new Class<?>[] {String.class}, "disconnected");
        when(submission.submit()).thenThrow(new CompletionException(transport));
        assertThatThrownBy(prepared::submit).isInstanceOf(CompletionException.class)
                .hasCauseInstanceOf(HarnessTransportFailure.class);
        verify(submission).submit();
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void streamReadsAndCloseMapFailuresAfterCreation(boolean observe) throws Exception {
        var delegate = mock(HarnessConnector.class);
        var source = mock(HarnessConnector.SourceStream.class);
        if (observe) {
            when(delegate.observeStream("tenant", "session", "boot", 7L, "epoch")).thenReturn(source);
        } else {
            when(delegate.stream("tenant", "session", 7L, "epoch")).thenReturn(source);
        }
        var boundary = new SdkHarnessBoundary(delegate);
        var stream = observe ? boundary.observeStream("tenant", "session", "boot", 7L, "epoch")
                : boundary.stream("tenant", "session", 7L, "epoch");
        verifyNoInteractions(source);
        var event = new HarnessConnector.SourceEvent(8L, "message", "hello", "prompt", Map.of());
        var transport = sdk(DaemonTransportException.class, new Class<?>[] {String.class}, "disconnected");
        when(source.next()).thenReturn(event).thenThrow(transport);
        when(source.eventEpoch()).thenReturn("epoch").thenThrow(transport);
        when(source.recoveryBlocked(7L)).thenReturn(true).thenThrow(transport);
        doThrow(transport).when(source).close();
        assertThat(stream.next()).isSameAs(event);
        assertThat(stream.eventEpoch()).isEqualTo("epoch");
        assertThat(stream.recoveryBlocked(7L)).isTrue();
        assertThatThrownBy(stream::next).isInstanceOf(HarnessTransportFailure.class);
        assertThatThrownBy(stream::eventEpoch).isInstanceOf(HarnessTransportFailure.class);
        assertThatThrownBy(() -> stream.recoveryBlocked(7L)).isInstanceOf(HarnessTransportFailure.class);
        assertThatThrownBy(stream::close).isInstanceOf(HarnessTransportFailure.class);
        verify(source).close();
    }

    @Test
    void boundaryKeepsUnrelatedFailuresAndErrorsUnchanged() {
        var delegate = mock(HarnessConnector.class);
        var boundary = new SdkHarnessBoundary(delegate);
        var invalid = new IllegalArgumentException("invalid");
        var fatal = new AssertionError("fatal");
        when(delegate.isAvailable()).thenThrow(invalid).thenThrow(fatal);
        assertThatThrownBy(boundary::isAvailable).isSameAs(invalid);
        assertThatThrownBy(boundary::isAvailable).isSameAs(fatal);
    }

    private static <T extends Throwable> T sdk(Class<T> type, Class<?>[] parameters, Object... arguments) throws Exception {
        var constructor = type.getDeclaredConstructor(parameters);
        constructor.setAccessible(true);
        return constructor.newInstance(arguments);
    }
}

package com.alibaba.qwen.code.managedagent.harness;

import com.alibaba.qwen.code.daemon.HostedHarnessClient;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessCapabilities;

import java.net.URI;
import java.time.Duration;
public final class HarnessNegotiation implements AutoCloseable {
    private final HostedHarnessClient client;
    public HarnessNegotiation(URI uri, String token, String digest) {
        this(uri, token, digest, null);
    }
    public HarnessNegotiation(URI uri, String token, String digest, Duration timeout) {
        try {
            var builder = HostedHarnessClient.builder().baseUri(uri).bearerToken(token).capabilityDigest(digest);
            if (timeout != null) {
                builder.connectTimeout(timeout).requestTimeout(timeout);
            }
            client = builder.build();
        } catch (RuntimeException failure) {
            throw HarnessSdkValues.runtime(failure);
        }
    }
    public HarnessCapabilities capabilities() {
        try {
            var value = client.capabilities();
            return new HarnessCapabilities(value.getCurrentProtocolVersion(), value.getSupportedProtocolVersions(), value.getBootId(), value.getInstanceId(), value.getCapabilityDigest(), value.getLifecycleProtocolVersion(), value.getFeatures(), value.getTitleProtocolVersion(), value.getLifecycleV2Profiles());
        } catch (RuntimeException failure) {
            throw HarnessSdkValues.runtime(failure);
        }
    }
    public void close() { client.close(); }
}

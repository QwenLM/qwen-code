package com.alibaba.qwen.code.runtimebroker;

import java.util.LinkedHashMap;
import java.util.Arrays;
import java.util.UUID;

/** Prepared normal deletion and its observed API reply; neither proves physical stop. */
public final class CsiPodDeletion {
    private CsiPodDeletion() {
    }

    public static Request prepare(String namespace, String name, String uid, String resourceVersion) {
        KubernetesHttpRuntimeClient.dnsLabel(namespace);
        KubernetesHttpRuntimeClient.dnsSubdomain(name);
        if (uid == null || !UUID.fromString(uid).toString().equals(uid) || resourceVersion == null
                || resourceVersion.isBlank() || resourceVersion.length() > 128 || resourceVersion.indexOf('\0') >= 0) {
            throw new IllegalArgumentException("Original Pod UID and resource version are required");
        }
        return new Request(namespace, name, uid, resourceVersion);
    }

    public static Request restore(String namespace, String name, String uid, String resourceVersion, byte[] savedBytes) {
        var request = prepare(namespace, name, uid, resourceVersion);
        if (savedBytes == null || !Arrays.equals(request.bytes, savedBytes)) {
            throw new IllegalArgumentException("Saved original Pod deletion bytes do not match their identity");
        }
        return request;
    }

    public static final class Request {
        private final String namespace;
        private final String name;
        private final String uid;
        private final String resourceVersion;
        private final byte[] bytes;

        private Request(String namespace, String name, String uid, String resourceVersion) {
            this.namespace = namespace;
            this.name = name;
            this.uid = uid;
            this.resourceVersion = resourceVersion;
            var preconditions = new LinkedHashMap<String, Object>();
            preconditions.put("uid", uid);
            preconditions.put("resourceVersion", resourceVersion);
            var body = new LinkedHashMap<String, Object>();
            body.put("apiVersion", "v1");
            body.put("kind", "DeleteOptions");
            body.put("gracePeriodSeconds", 30);
            body.put("propagationPolicy", "Background");
            body.put("preconditions", preconditions);
            this.bytes = JsonCodec.encode(body);
        }

        public String namespace() { return namespace; }
        public String name() { return name; }
        public String uid() { return uid; }
        public String resourceVersion() { return resourceVersion; }
        public byte[] bytes() { return bytes.clone(); }
    }

    public static final class Result {
        private final Request request;
        private final int statusCode;
        private final byte[] responseBytes;

        Result(Request request, int statusCode, byte[] responseBytes) {
            this.request = request;
            this.statusCode = statusCode;
            this.responseBytes = responseBytes.clone();
        }

        public Request request() { return request; }
        public int statusCode() { return statusCode; }
        public byte[] responseBytes() { return responseBytes.clone(); }
        public boolean accepted() { return statusCode == 200 || statusCode == 202; }
    }
}

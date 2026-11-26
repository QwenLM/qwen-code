package com.alibaba.qwen.code.runtimebroker.protocol;

public final class KubernetesNames {
    private KubernetesNames() { }

    public static void dnsLabel(String value) {
        if (value == null || !value.matches("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")) {
            throw new IllegalArgumentException("Kubernetes name must be a DNS label");
        }
    }

    public static void dnsSubdomain(String value) {
        if (value == null || value.length() > 253) {
            throw new IllegalArgumentException("Kubernetes name must be a DNS subdomain");
        }
        for (String label : value.split("\\.", -1)) {
            dnsLabel(label);
        }
    }
}

package com.alibaba.qwen.code.runtimebroker.security;

/** Protects Runtime credentials before they enter durable storage. */
public interface SecretProtector {
    public ProtectedSecret protect(String context, byte[] plaintext);

    public byte[] unprotect(String context, ProtectedSecret protectedSecret);
}

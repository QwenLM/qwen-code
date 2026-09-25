package com.alibaba.qwen.code.runtimebroker;

/** Protects Runtime credentials before they enter durable storage. */
public interface SecretProtector {
    ProtectedSecret protect(String context, byte[] plaintext);

    byte[] unprotect(String context, ProtectedSecret protectedSecret);
}

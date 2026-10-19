package com.alibaba.qwen.code.runtimebroker.transport;

/** Fixed synthetic expectations for ordinary data tests; never a deployment contract. */
public final class CsiCreationContractFixture {
    private CsiCreationContractFixture() { }

    public static byte[] bytes() {
        try (var input = CsiCreationContractFixture.class.getResourceAsStream("/contracts/k2-creation-contract-v1.fixture.json")) {
            if (input == null) { throw new IllegalStateException("Synthetic creation contract is missing"); }
            return input.readAllBytes();
        } catch (java.io.IOException failure) {
            throw new IllegalStateException("Synthetic creation contract is unavailable", failure);
        }
    }
}

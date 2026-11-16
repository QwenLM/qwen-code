package com.qwen.mobileshell

import java.security.GeneralSecurityException
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class ProfileCipher(private val key: (create: Boolean) -> SecretKey) : VaultCipher {
    override fun encrypt(bytes: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(true))
        cipher.updateAAD(CONTEXT)
        check(cipher.iv.size == 12)
        return byteArrayOf(1) + cipher.iv + cipher.doFinal(bytes)
    }

    override fun decrypt(bytes: ByteArray): ByteArray {
        if (bytes.size < 29 || bytes[0] != 1.toByte()) throw GeneralSecurityException("Invalid vault format.")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(CONTEXT)
        return cipher.doFinal(bytes, 13, bytes.size - 13)
    }

    companion object {
        private val CONTEXT = "com.qwen.mobileshell/profiles/v1".toByteArray(Charsets.UTF_8)
    }
}

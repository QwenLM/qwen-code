package com.qwen.mobileshell

import javax.crypto.KeyGenerator
import org.junit.Assert.*
import org.junit.Test

class ProfileCipherTest {
    private val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
    private val cipher = ProfileCipher { key }

    @Test fun encryptsRoundTripWithFreshNonce() {
        val plain = "synthetic credential".toByteArray()
        val first = cipher.encrypt(plain)
        val second = cipher.encrypt(plain)
        assertFalse(first.contentEquals(second))
        assertArrayEquals(plain, cipher.decrypt(first))
        assertArrayEquals(plain, cipher.decrypt(second))
    }

    @Test fun rejectsTamperedNonceCiphertextTagAndVersion() {
        val valid = cipher.encrypt("synthetic".toByteArray())
        for (index in listOf(0, 1, 12, 13, valid.lastIndex)) {
            val changed = valid.clone()
            changed[index] = (changed[index].toInt() xor 1).toByte()
            assertThrows(Exception::class.java) { cipher.decrypt(changed) }
        }
        assertThrows(Exception::class.java) { cipher.decrypt(valid.copyOf(12)) }
    }

    @Test fun rejectsAnotherKey() {
        val other = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        assertThrows(Exception::class.java) { ProfileCipher { other }.decrypt(cipher.encrypt(byteArrayOf(1))) }
    }
}

package com.qwen.mobileshell

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

internal class AndroidProfileStore(private val context: Context, prefix: String = "") {
    private val file = AtomicFile(File(context.noBackupFilesDir, "${prefix}connection-profiles.v1"))
    private val legacyName = "${prefix}qwen_profiles"
    private val keyAlias = "$prefix$KEY_ALIAS"
    private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val cipher = ProfileCipher { create ->
        (keys.getKey(keyAlias, null) as? SecretKey) ?: if (create) {
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
                init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build())
            }.generateKey()
        } else throw IOException("The saved connection key is unavailable.")
    }

    val vault = ProfileVault(object : VaultStorage {
        override fun read(): ByteArray? = try {
            file.openRead().use { input ->
                if (input.channel.size() > 2 * 1024 * 1024) throw IOException("Saved connection data is too large.")
                input.readBytes()
            }
        } catch (_: FileNotFoundException) {
            if (file.baseFile.exists()) throw IOException("Cannot read saved connection data.")
            null
        }

        override fun write(bytes: ByteArray) {
            val output = file.startWrite()
            try {
                output.write(bytes)
                output.fd.sync()
            } catch (error: Exception) {
                file.failWrite(output)
                throw error
            }
            file.finishWrite(output)
            if (!file.readFully().contentEquals(bytes)) throw IOException("Connection data was not saved.")
        }
    }, cipher, object : LegacyProfiles {
        override fun read(): Pair<String?, String?> {
            val preferences = context.getSharedPreferences(legacyName, Context.MODE_PRIVATE)
            return preferences.getString("daemon_url", null) to preferences.getString("daemon_token", null)
        }

        override fun clear() {
            if (!context.deleteSharedPreferences(legacyName)) {
                throw IOException("Cannot remove the development credential. Retry before connecting.")
            }
        }
    })

    fun reset() {
        if (!context.deleteSharedPreferences(legacyName)) throw IOException("Cannot reset connection data.")
        file.delete()
        if (file.baseFile.exists()) throw IOException("Cannot reset connection data.")
        keys.deleteEntry(keyAlias)
    }

    companion object {
        internal const val KEY_ALIAS = "qwen.connection-profiles.v1"
    }
}

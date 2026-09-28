package com.qwen.mobileshell

import java.nio.ByteBuffer

internal class DownloadBuffer(val id: String, size: Int) {
    var bytes = ByteArray(size)
        private set
    var offset = 0
        private set

    fun append(frame: ByteArray) {
        require(frame.size in HEADER_SIZE + 1..HEADER_SIZE + CHUNK_SIZE) { "Invalid download chunk size." }
        require(String(frame, 0, 32, Charsets.US_ASCII) == id) { "Invalid download ID." }
        require(ByteBuffer.wrap(frame, 32, 4).int == offset) { "Invalid download offset." }
        val count = frame.size - HEADER_SIZE
        require(count <= bytes.size - offset) { "Download exceeds its declared size." }
        frame.copyInto(bytes, offset, HEADER_SIZE)
        offset += count
    }

    fun clear() { bytes = ByteArray(0) }

    companion object {
        const val MAX_SIZE = 16 * 1024 * 1024
        const val CHUNK_SIZE = 64 * 1024
        const val HEADER_SIZE = 36

        fun fileName(value: String): String {
            val clean = value.replace(Regex("[\\p{Cc}\\p{Cf}\\p{Cs}/\\\\:*?\"<>|]"), "_")
                .trim { it.isWhitespace() || it == '.' }
            val dot = clean.lastIndexOf('.')
            val extension = if (dot > 0 && clean.length - dot in 2..16) clean.substring(dot) else ""
            val source = clean.substring(0, clean.length - extension.length)
            val limited = limitUtf8(source, 255 - extension.toByteArray(Charsets.UTF_8).size)
            val stem = if (limited.length < source.length) limited.trimEnd { it.isWhitespace() || it == '.' } else limited
            return stem.ifEmpty { "download" } + extension
        }

        private fun limitUtf8(value: String, limit: Int): String {
            val result = StringBuilder()
            var byteCount = 0
            var index = 0
            // Document providers commonly limit names in UTF-8 bytes, not UTF-16 units.
            while (index < value.length) {
                val codePoint = value.codePointAt(index)
                val part = String(Character.toChars(codePoint))
                val bytes = part.toByteArray(Charsets.UTF_8).size
                if (byteCount + bytes > limit) break
                result.append(part)
                byteCount += bytes
                index += Character.charCount(codePoint)
            }
            return result.toString()
        }
    }
}

package com.qwen.mobileshell

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class DownloadBufferTest {
    private val id = "0123456789abcdef0123456789abcdef"
    private fun frame(offset: Int, bytes: ByteArray, transfer: String = id): ByteArray =
        ByteBuffer.allocate(36 + bytes.size).put(transfer.toByteArray(Charsets.US_ASCII)).putInt(offset).put(bytes).array()

    @Test fun reconstructsBinaryAndClearsRetainedData() {
        val bytes = ByteArray(80_123) { (it % 256).toByte() }
        val buffer = DownloadBuffer(id, bytes.size)
        buffer.append(frame(0, bytes.copyOfRange(0, 65_536)))
        buffer.append(frame(65_536, bytes.copyOfRange(65_536, bytes.size)))
        assertArrayEquals(bytes, buffer.bytes)
        assertEquals(bytes.size, buffer.offset)
        buffer.clear()
        assertEquals(0, buffer.bytes.size)
    }

    @Test fun rejectsDuplicateWrongIdOverflowAndOversizedChunks() {
        val buffer = DownloadBuffer(id, 2)
        buffer.append(frame(0, byteArrayOf(1)))
        for (invalid in listOf(frame(0, byteArrayOf(1)), frame(1, byteArrayOf(2), "f".repeat(32)), frame(1, byteArrayOf(2, 3)), frame(1, ByteArray(65_537)), ByteArray(35))) {
            assertThrows(IllegalArgumentException::class.java) { buffer.append(invalid) }
        }
        assertEquals(1, buffer.offset)
        buffer.append(frame(1, byteArrayOf(2)))
        assertArrayEquals(byteArrayOf(1, 2), buffer.bytes)
    }

    @Test fun emptyFilesNeedNoChunks() {
        val buffer = DownloadBuffer(id, 0)
        assertEquals(0, buffer.bytes.size)
        assertThrows(IllegalArgumentException::class.java) { buffer.append(frame(0, byteArrayOf())) }
    }

    @Test fun sanitizesDestinationNameWithoutAcceptingPaths() {
        assertEquals("_.._report_.txt", DownloadBuffer.fileName("../..\\report\n.txt"))
        assertEquals("download", DownloadBuffer.fileName(" .. "))
        assertEquals(255, DownloadBuffer.fileName("a".repeat(300)).length)
    }
}

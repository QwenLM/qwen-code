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
        assertEquals("download", DownloadBuffer.fileName(""))
        assertEquals("download", DownloadBuffer.fileName(". ."))
        assertEquals(255, DownloadBuffer.fileName("a".repeat(300)).length)
    }

    @Test fun replacesBidirectionalFormatCharactersInDestinationNames() {
        assertEquals("report_txt.pdf", DownloadBuffer.fileName("report\u202Etxt.pdf"))
        assertEquals("report_txt.pdf", DownloadBuffer.fileName("report\u0085txt.pdf"))
        assertEquals("report_txt.pdf", DownloadBuffer.fileName("report\uD83Dtxt.pdf"))
        assertEquals("report_txt.pdf", DownloadBuffer.fileName("report\uDE00txt.pdf"))
    }

    @Test fun truncatingDestinationNamesNeverSplitsASurrogatePair() {
        val name = DownloadBuffer.fileName("a".repeat(254) + "\uD83D\uDE00" + "x")
        assertTrue("A truncated filename must remain valid Unicode", Charsets.UTF_8.newEncoder().canEncode(name))
        assertEquals("a".repeat(254), name)
        val exactBoundary = "a".repeat(251) + "\uD83D\uDE00"
        assertEquals(exactBoundary, DownloadBuffer.fileName(exactBoundary + "x"))
    }

    @Test fun boundsDestinationNamesByUtf8BytesAndPreservesShortUnicodeNames() {
        val short = "报告-测试 \uD83D\uDE00.txt"
        assertEquals(short, DownloadBuffer.fileName(short))
        for (value in listOf("报".repeat(200), "é".repeat(128), "\uD83D\uDE00".repeat(64))) {
            val name = DownloadBuffer.fileName(value)
            assertTrue("A filename must fit within 255 UTF-8 bytes", name.toByteArray(Charsets.UTF_8).size <= 255)
            assertTrue("A bounded filename must remain valid Unicode", Charsets.UTF_8.newEncoder().canEncode(name))
            assertTrue("Truncation must retain the beginning of the Unicode name", name.isNotEmpty() && value.startsWith(name))
        }
        assertEquals("报".repeat(85), DownloadBuffer.fileName("报".repeat(200)))
    }

    @Test fun truncatingDestinationNamesDoesNotExposeTrailingDotsOrSpaces() {
        assertEquals("a".repeat(254), DownloadBuffer.fileName("a".repeat(254) + ".txt"))
        assertEquals("a".repeat(253), DownloadBuffer.fileName("a".repeat(253) + " .txt"))
    }
}

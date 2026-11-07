package com.qwen.mobileshell

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OriginPolicyTest {
    @Test fun comparesParsedOrigins() {
        val origin = "https://daemon.example"
        assertTrue(OriginPolicy.isSameOrigin(origin, "https://DAEMON.example:443/session/1"))
        assertTrue(OriginPolicy.isSameOrigin("http://[::1]:8080", "http://[::1]:8080/?x=1"))
        for (url in listOf("https://daemon.example.evil/", "https://daemon.example@evil/", "https://user@daemon.example/", "https://daemon.example:444/", "http://daemon.example/", "javascript:alert(1)", "https://daemon.example\\@evil/")) {
            assertFalse(url, OriginPolicy.isSameOrigin(origin, url))
        }
    }

    @Test fun validatesSavedDaemonRoots() {
        for (url in listOf("https://daemon.example", "http://localhost:3000/", "http://[::1]:8080/")) assertTrue(url, OriginPolicy.isDaemonRoot(url))
        for (url in listOf("", "relative", "file:///tmp/a", "https://user:token@daemon.example", "https://daemon.example/path", "https://daemon.example?token=secret", "https://daemon.example#token=secret", "https://daemon.example:65536")) assertFalse(url, OriginPolicy.isDaemonRoot(url))
    }

    @Test fun onlyOpensKnownExternalSchemes() {
        assertTrue(OriginPolicy.isExternalLink("https://example.com/docs"))
        assertTrue(OriginPolicy.isExternalLink("mailto:help@example.com"))
        for (url in listOf("intent://example/", "javascript:alert(1)", "file:///etc/passwd", "content://provider/1", "data:text/html,hello")) assertFalse(url, OriginPolicy.isExternalLink(url))
    }
}

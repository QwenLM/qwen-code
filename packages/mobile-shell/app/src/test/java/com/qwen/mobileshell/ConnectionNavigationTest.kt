package com.qwen.mobileshell

import org.junit.Assert.*
import org.junit.Test

class ConnectionNavigationTest {
    private val origin = "https://daemon.example/"

    @Test fun retainsOnlySupportedNavigation() {
        val route = ConnectionNavigation.capture(origin, "${origin}session/session-123?workspace=work_1&context=live#token=secret")
        assertEquals("session-123", route.session)
        assertEquals("work_1", route.workspace)
        assertEquals("live", route.context)
        assertEquals("${origin}session/session-123?workspace=work_1&context=live", route.url(origin))
        assertFalse(route.toString().contains("secret"))
        assertEquals("${origin}?workspace=work_1", ConnectionNavigation.capture(origin, "${origin}?workspace=work_1").url(origin))
    }

    @Test fun untrustedOrUnsupportedNavigationFallsBackToRoot() {
        for (url in listOf(
            "https://other.example/session/s", "https://daemon.example.evil/session/s",
            "https://user@daemon.example/session/s", "http://daemon.example/session/s",
            "https://daemon.example:444/session/s", "file:///session/s", "not a URI",
            "${origin}session/", "${origin}session/a/b", "${origin}session/..",
            "${origin}session/a%2Fb", "${origin}session/%61", "${origin}settings",
            "${origin}session/a?token=secret", "${origin}session/a?daemon=https://other.example/",
            "${origin}session/a?workspace=one&workspace=two", "${origin}session/a?context=admin",
            "${origin}session/a?workspace=", "${origin}session/a?workspace=a%26token%3Ds",
            "${origin}session/a?workspace=a&", "${origin}session/${"a".repeat(129)}",
        )) assertEquals(url, ConnectionNavigation(), ConnectionNavigation.capture(origin, url))
    }

    @Test fun defaultPortAndFragmentsNeverChangeStoredOriginOrCredentials() {
        val route = ConnectionNavigation.capture(origin, "https://DAEMON.example:443/session/s#token=secret&daemon=evil")
        assertEquals("${origin}session/s", route.url(origin))
        assertEquals(ConnectionNavigation(), ConnectionNavigation.capture(origin, null))
    }

    @Test fun savedFieldsAreValidatedBeforeReconstruction() {
        assertNull(ConnectionNavigation.fromFields("a/b", null, null))
        assertNull(ConnectionNavigation.fromFields("s", "", null))
        assertNull(ConnectionNavigation.fromFields("s", "w", "arbitrary"))
        assertNull(ConnectionNavigation.fromFields("s", "a".repeat(129), "live"))
        assertEquals(ConnectionNavigation("s", "w", "standalone"), ConnectionNavigation.fromFields("s", "w", "standalone"))
    }
}

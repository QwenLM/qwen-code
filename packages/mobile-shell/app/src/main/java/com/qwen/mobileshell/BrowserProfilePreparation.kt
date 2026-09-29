package com.qwen.mobileshell

internal object BrowserProfilePreparation {
    // Only accessed on the UI thread. Activity recreation must not overlap clears.
    private val pending = mutableSetOf<String>()

    fun isPending(name: String): Boolean = name in pending
    fun reserve(name: String): Boolean = pending.add(name)
    fun release(name: String) { pending.remove(name) }
}

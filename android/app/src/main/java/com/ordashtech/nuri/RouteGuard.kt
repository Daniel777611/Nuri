package com.ordashtech.nuri

/**
 * A notification's `route` is data from outside the app. Only
 * `/notifications/<id>` may be opened; anything else is dropped and the
 * home page opens instead. Mirrors safeNotificationRoute in usePushBridge.ts.
 */
object RouteGuard {
    private val ID = Regex("^[0-9a-fA-F-]{8,64}$")
    private const val PREFIX = "/notifications/"

    fun safe(route: String?): String? {
        if (route == null || !route.startsWith(PREFIX)) return null
        if (".." in route || "://" in route || "\\" in route) return null
        return if (ID.matches(route.removePrefix(PREFIX))) route else null
    }
}

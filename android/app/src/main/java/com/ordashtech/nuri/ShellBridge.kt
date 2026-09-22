package com.ordashtech.nuri

import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Exposed to the page as `window.ReactNativeWebView`, the name the web code
 * already posts to for the iOS shell, so usePushBridge.ts needs no Android
 * branch. Called on a WebView background thread.
 */
class ShellBridge(
    private val isTrustedPage: () -> Boolean,
    private val onTokenRequested: () -> Unit,
) {
    @JavascriptInterface
    fun postMessage(message: String?) {
        if (!isTrustedPage()) return
        val type = runCatching { JSONObject(message ?: "").optString("type") }.getOrNull()
        if (type == "nuri:request-apns-token") onTokenRequested()
    }
}

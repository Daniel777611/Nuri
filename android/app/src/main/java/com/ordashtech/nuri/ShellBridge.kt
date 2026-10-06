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
    private val onGoogleSignIn: () -> Unit,
) {
    @JavascriptInterface
    fun postMessage(message: String?) {
        if (!isTrustedPage()) return
        when (runCatching { JSONObject(message ?: "").optString("type") }.getOrNull()) {
            "nuri:request-apns-token" -> onTokenRequested()
            // The page's "Continue with Google" button (see GoogleSignIn.kt).
            "nuri:google-sign-in" -> onGoogleSignIn()
        }
    }
}

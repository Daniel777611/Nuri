package com.ordashtech.nuri

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import org.json.JSONObject
import java.util.TimeZone
import java.util.UUID

/**
 * What the shell knows about push on this phone, and the one event it hands to
 * the page. The shell never calls the backend: the page holds the session and
 * registers the device itself (frontend/src/usePushBridge.ts).
 */
object PushState {
    private const val PREFS = "nuri.push"
    private const val KEY_INSTALL = "installation_id"
    private const val KEY_TOKEN = "fcm_token"
    private const val KEY_ASKED = "permission_asked"

    /** Set by MainActivity while it is alive, so a new token reaches the page. */
    @Volatile var onTokenChanged: (() -> Unit)? = null

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** One UUID per install; the backend upserts on it, so it must not change. */
    fun installationId(context: Context): String {
        val p = prefs(context)
        return p.getString(KEY_INSTALL, null) ?: UUID.randomUUID().toString().also {
            p.edit().putString(KEY_INSTALL, it).apply()
        }
    }

    fun cachedToken(context: Context): String? = prefs(context).getString(KEY_TOKEN, null)

    fun saveToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply()
        onTokenChanged?.invoke()
    }

    fun markPermissionAsked(context: Context) =
        prefs(context).edit().putBoolean(KEY_ASKED, true).apply()

    private fun permissionAsked(context: Context) = prefs(context).getBoolean(KEY_ASKED, false)

    /** Mapped onto the iOS vocabulary the backend already speaks. */
    fun permissionStatus(context: Context): String {
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context, Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            return when {
                granted && enabled -> "authorized"
                !granted && !permissionAsked(context) -> "not_determined"
                else -> "denied"
            }
        }
        return if (enabled) "authorized" else "denied"
    }

    /** False until app/google-services.json is added and the app rebuilt. */
    fun firebaseReady(context: Context) = FirebaseApp.getApps(context).isNotEmpty()

    /** Ask Firebase for the current token; the answer lands in [saveToken]. */
    fun refreshToken(context: Context) {
        if (!firebaseReady(context)) return
        val app = context.applicationContext
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            if (!token.isNullOrBlank() && token != cachedToken(app)) saveToken(app, token)
        }
    }

    /** JS that dispatches `nuri:fcm-token`, or null when there is no token yet. */
    fun tokenEventScript(context: Context): String? {
        val token = cachedToken(context) ?: return null
        val detail = JSONObject()
            .put("token", token)
            .put("installationId", installationId(context))
            .put("packageName", context.packageName)
            .put("permissionStatus", permissionStatus(context))
            .put("timeZone", TimeZone.getDefault().id)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("buildNumber", BuildConfig.VERSION_CODE.toString())
        return "window.dispatchEvent(new CustomEvent('nuri:fcm-token',{detail:$detail}));"
    }
}

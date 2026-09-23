package com.ordashtech.nuri

import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class NuriMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        PushState.saveToken(applicationContext, token)
    }

    /**
     * Only called while the app is in the foreground. In the background
     * Android draws the notification itself from the payload, on the channel
     * the payload names, and a tap opens MainActivity with `route` in extras.
     * Here we draw the same notification, so it pops up either way.
     */
    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: return
        val body = message.notification?.body.orEmpty()
        val route = message.data["route"]

        val open = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_NOTIFICATION)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(MainActivity.EXTRA_ROUTE, route)
        val tap = PendingIntent.getActivity(
            this, route.hashCode(), open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, NuriApp.CARE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ContextCompat.getColor(this, R.color.brand))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            // Pre-Oreo phones read priority from here instead of the channel.
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build()

        val manager = NotificationManagerCompat.from(this)
        if (!manager.areNotificationsEnabled()) return
        try {
            manager.notify(message.data["notification_id"]?.hashCode() ?: 0, notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS was revoked between the check and the call.
        }
    }
}

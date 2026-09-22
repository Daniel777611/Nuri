package com.ordashtech.nuri

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class NuriApp : Application() {
    override fun onCreate() {
        super.onCreate()
        createCareChannel()
    }

    // IMPORTANCE_HIGH is what makes Android pop the notification over whatever
    // is on screen (a "heads-up" notification) instead of only adding a status
    // bar icon. A channel's importance is fixed once created — to change it,
    // the id has to change, and the backend's CARE_CHANNEL_ID with it.
    private fun createCareChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CARE_CHANNEL_ID,
            getString(R.string.care_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = getString(R.string.care_channel_description)
            enableVibration(true)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        /** Must equal backend/push_fcm.py CARE_CHANNEL_ID. */
        const val CARE_CHANNEL_ID = "nuri_care"
    }
}

package com.qwen.mobileshell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Foreground service that keeps the SSE connection alive when the browser
 * process is in the background or when Android would otherwise kill it.
 *
 * Per maintainer (@wenshao, issue #11704):
 * "A foreground service that keeps the SSE connection alive when the browser
 * process is gone, and raises a native notification when a turn completes or
 * a permission request is pending."
 *
 * Currently this is a skeleton. Phase 2 will:
 * - Maintain an OkHttp SSE stream directly in this service.
 * - Parse /events responses and raise native notifications on turn complete /
 *   permission requests.
 * - Bind to MainActivity so the WebView can query SSE state.
 */
class QwenForegroundService : Service() {

    companion object {
        const val CHANNEL_ID = "qwen_daemon_service"
        const val NOTIFICATION_ID = 1

        fun start(context: Context) {
            val intent = Intent(context, QwenForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, QwenForegroundService::class.java))
        }
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())
        // TODO Phase 2: start OkHttp SSE client here, keeping SSE alive
        // while the WebView process is not in foreground.
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        // TODO Phase 2: close OkHttp SSE client here.
    }

    private fun buildNotification(): Notification {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notification_connected))
            // Using a built-in Android drawable as a placeholder until a real
            // monochrome icon is generated from the Qwen SVG logo.
            // TODO: replace with R.drawable.ic_notification (custom 24dp mono SVG)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                getString(R.string.notification_channel_name),
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = getString(R.string.notification_channel_description)
            }
            getSystemService(NotificationManager::class.java)
                ?.createNotificationChannel(channel)
        }
    }
}

package dev.danishali.fuloos.sms

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.danishali.fuloos.MainActivity
import dev.danishali.fuloos.R
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * Manages native Android Notification Channels and interactive transaction notifications.
 *
 * - High-confidence auto-added SMSes post a silent summary with an [Undo] button.
 * - Low-confidence SMSes post an actionable notification with up to 2 one-tap
 *   category quick-action buttons plus [Pick other…] deep-linking to Fuloos.
 */
object SmsNotificationHelper {

    const val CHANNEL_TX_AUTO = "fuloos_tx_auto"
    const val CHANNEL_TX_REVIEW = "fuloos_tx_review"
    const val CHANNEL_BILLS_BUDGETS = "fuloos_bills_budgets"
    const val CHANNEL_SYNC_PROGRESS = "fuloos_sync_progress"

    private const val BRAND_COLOR = 0xFF1B4A39.toInt()

    fun ensureChannels(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            ?: return

        val channels = listOf(
            NotificationChannel(
                CHANNEL_TX_AUTO,
                "Auto-added transactions",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Silent confirmation when a bank SMS is added automatically."
                setShowBadge(false)
            },
            NotificationChannel(
                CHANNEL_TX_REVIEW,
                "Needs your category",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Quick-categorise prompts when an SMS merchant has low confidence."
                setShowBadge(true)
            },
            NotificationChannel(
                CHANNEL_BILLS_BUDGETS,
                "Bills & budget alerts",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = "Upcoming recurring bills and budget threshold alerts."
            },
            NotificationChannel(
                CHANNEL_SYNC_PROGRESS,
                "SMS sync & backfill",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Background SMS catch-up sync status."
                setShowBadge(false)
            },
        )
        manager.createNotificationChannels(channels)
    }

    fun postAutoAddedNotification(
        context: Context,
        transactionId: String,
        payee: String,
        amountFils: Long,
        categoryName: String?,
        accountName: String?,
        cardLast4: String?,
    ) {
        if (!canPostNotifications(context)) return
        ensureChannels(context)

        val notifId = stableNotificationId("auto:$transactionId")
        val amountStr = formatAed(amountFils)
        val title = "Added $amountStr · ${payee.ifBlank { "Transaction" }}"
        val subtitleParts = buildList {
            if (!categoryName.isNullOrBlank()) add(categoryName)
            if (!accountName.isNullOrBlank()) add(accountName)
            if (!cardLast4.isNullOrBlank()) add("Card ••$cardLast4")
        }
        val body = subtitleParts.joinToString(" · ").ifEmpty { "Synced to Fuloos" }

        val openIntent = buildDeepLinkPendingIntent(
            context = context,
            uri = "fuloos://tx/$transactionId",
            requestCode = notifId,
        )

        val undoIntent = Intent(context, NotificationActionReceiver::class.java).apply {
            action = NotificationActionReceiver.ACTION_UNDO_TX
            putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notifId)
            putExtra(NotificationActionReceiver.EXTRA_TRANSACTION_ID, transactionId)
        }
        val undoPending = PendingIntent.getBroadcast(
            context,
            notifId + 1,
            undoIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_TX_AUTO)
            .setSmallIcon(R.drawable.ic_stat_fuloos)
            .setColor(BRAND_COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(openIntent)
            .addAction(0, "Undo", undoPending)
            .build()

        NotificationManagerCompat.from(context).notify(notifId, notification)
    }

    fun postNeedsReviewNotification(
        context: Context,
        smsHash: String,
        alertId: String?,
        txJson: JSONObject,
        merchantClean: String?,
        accountName: String?,
        cardLast4: String?,
        topSuggestions: JSONArray,
    ) {
        if (!canPostNotifications(context)) return
        ensureChannels(context)

        val notifId = stableNotificationId("review:$smsHash")
        val payee = (if (txJson.isNull("payee")) "" else txJson.optString("payee", "")).ifBlank { "Unknown merchant" }
        val amountStr = formatAed(txJson.optLong("amount", 0L))
        val title = "Categorise $amountStr at $payee?"
        val subtitleParts = buildList {
            if (!accountName.isNullOrBlank()) add(accountName)
            if (!cardLast4.isNullOrBlank()) add("Card ••$cardLast4")
            add("Synced for web & mobile review")
        }
        val body = subtitleParts.joinToString(" · ")

        val deepLinkUri = if (!alertId.isNullOrBlank()) {
            "fuloos://review/$alertId"
        } else {
            "fuloos://review"
        }
        val openIntent = buildDeepLinkPendingIntent(
            context = context,
            uri = deepLinkUri,
            requestCode = notifId,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_TX_REVIEW)
            .setSmallIcon(R.drawable.ic_stat_fuloos)
            .setColor(BRAND_COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(openIntent)

        // Add up to 2 one-tap category quick actions directly on the Android notification.
        val maxButtons = minOf(2, topSuggestions.length())
        for (i in 0 until maxButtons) {
            val suggestion = topSuggestions.optJSONObject(i) ?: continue
            val catId = if (suggestion.isNull("category_id")) "" else suggestion.optString("category_id", "")
            val catName = if (suggestion.isNull("name")) "" else suggestion.optString("name", "")
            if (catId.isEmpty() || catName.isEmpty()) continue

            val actionIntent = Intent(context, NotificationActionReceiver::class.java).apply {
                action = NotificationActionReceiver.ACTION_QUICK_CATEGORIZE
                putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notifId)
                putExtra(NotificationActionReceiver.EXTRA_ALERT_ID, alertId.orEmpty())
                putExtra(NotificationActionReceiver.EXTRA_SMS_HASH, smsHash)
                putExtra(NotificationActionReceiver.EXTRA_CATEGORY_ID, catId)
                putExtra(NotificationActionReceiver.EXTRA_CATEGORY_NAME, catName)
                putExtra(NotificationActionReceiver.EXTRA_MERCHANT_CLEAN, merchantClean.orEmpty())
                putExtra(NotificationActionReceiver.EXTRA_TX_JSON, txJson.toString())
            }
            val actionPending = PendingIntent.getBroadcast(
                context,
                notifId + 10 + i,
                actionIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(0, catName.take(22), actionPending)
        }

        // Third slot opens Fuloos directly to pick another category or split.
        builder.addAction(0, "Pick other…", openIntent)

        NotificationManagerCompat.from(context).notify(notifId, builder.build())
    }

    fun cancel(context: Context, notificationId: Int) {
        if (notificationId != 0) {
            NotificationManagerCompat.from(context).cancel(notificationId)
        }
    }

    private fun buildDeepLinkPendingIntent(
        context: Context,
        uri: String,
        requestCode: Int,
    ): PendingIntent {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uri), context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun canPostNotifications(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    private fun stableNotificationId(key: String): Int {
        return (key.hashCode() and 0x0FFFFFFF) + 1000
    }

    private fun formatAed(fils: Long): String {
        val abs = kotlin.math.abs(fils)
        val whole = abs / 100
        val frac = abs % 100
        return String.format(Locale.US, "AED %,d.%02d", whole, frac)
    }
}

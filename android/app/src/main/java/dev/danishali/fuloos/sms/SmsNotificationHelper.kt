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
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import dev.danishali.fuloos.MainActivity
import dev.danishali.fuloos.R
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale

/**
 * Manages native Android Notification Channels and interactive transaction notifications.
 *
 * - High-confidence auto-added SMSes post a silent summary with an [Undo] button.
 * - Estimated foreign-currency transactions post an interactive confirmation prompt with
 *   an inline [RemoteInput] reply ("Enter <CURR> amount") and a [Looks right] action.
 * - Low-confidence SMSes post an actionable notification with up to 2 one-tap
 *   category quick-action buttons plus [Pick other…] deep-linking to Fuloos.
 */
object SmsNotificationHelper {

    const val CHANNEL_TX_AUTO = "fuloos_tx_auto"
    const val CHANNEL_TX_REVIEW = "fuloos_tx_review"
    const val CHANNEL_BILLS_BUDGETS = "fuloos_bills_budgets"
    const val CHANNEL_SYNC_PROGRESS = "fuloos_sync_progress"

    private const val BRAND_COLOR = 0xFF1B4A39.toInt()

    private val ZERO_DECIMAL_CURRENCIES = setOf(
        "BIF", "CLP", "DJF", "GNF", "HUF", "IDR", "ISK", "JPY",
        "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
    )

    private val THREE_DECIMAL_CURRENCIES = setOf(
        "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
    )

    fun currencyDecimals(currency: String): Int {
        val code = currency.trim().uppercase(Locale.US)
        return when {
            code in ZERO_DECIMAL_CURRENCIES -> 0
            code in THREE_DECIMAL_CURRENCIES -> 3
            else -> 2
        }
    }

    fun formatCurrencyAmount(minorUnits: Long, currency: String): String {
        val code = currency.trim().uppercase(Locale.US).ifBlank { "AED" }
        val dec = currencyDecimals(code)
        val sign = if (minorUnits < 0) "-" else ""
        val abs = kotlin.math.abs(minorUnits)
        if (dec == 0) {
            return String.format(Locale.US, "%s%s %,d", sign, code, abs)
        }
        val factor = if (dec == 3) 1000L else 100L
        val whole = abs / factor
        val frac = abs % factor
        val fmt = if (dec == 3) "%s%s %,d.%03d" else "%s%s %,d.%02d"
        return String.format(Locale.US, fmt, sign, code, whole, frac)
    }

    fun parseCurrencyMinor(rawInput: String, currency: String): Long? {
        val cleaned = rawInput
            .trim()
            .replace(",", "")
            .replace(Regex("^[A-Za-z]{3}\\s*"), "")
            .replace(Regex("\\s*[A-Za-z]{3}$"), "")
            .trim()
        if (cleaned.isEmpty()) return null
        return try {
            val bd = BigDecimal(cleaned)
            if (bd <= BigDecimal.ZERO) return null
            val dec = currencyDecimals(currency)
            val scaled = bd.movePointRight(dec).setScale(0, RoundingMode.HALF_UP)
            val minor = scaled.longValueExact()
            if (minor <= 0L || minor > 1_000_000_000_000L) null else minor
        } catch (_: Exception) {
            null
        }
    }

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
                description = "Quick-categorise prompts and foreign-amount confirmations."
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
        queuedWriteId: Long = -1L,
        smsHash: String = "",
        ownerKey: String = "",
        currency: String = "AED",
        originalAmountMinor: Long? = null,
        originalCurrency: String? = null,
    ) {
        if (!canPostNotifications(context)) return
        ensureChannels(context)

        val notifKey = transactionId.ifBlank { smsHash.take(16) }
        val notifId = stableNotificationId("auto:$notifKey")
        val accCode = currency.trim().uppercase(Locale.US).ifBlank { "AED" }
        val amountStr = formatCurrencyAmount(amountFils, accCode)
        val title = "Added $amountStr · ${payee.ifBlank { "Transaction" }}"
        val origCode = originalCurrency?.trim()?.uppercase(Locale.US).orEmpty()
        val subtitleParts = buildList {
            if (origCode.isNotEmpty() && origCode != accCode && originalAmountMinor != null && originalAmountMinor > 0L) {
                add(formatCurrencyAmount(originalAmountMinor, origCode))
            }
            if (!categoryName.isNullOrBlank()) add(categoryName)
            if (!accountName.isNullOrBlank()) add(accountName)
            if (!cardLast4.isNullOrBlank()) add("Card ••$cardLast4")
            if (queuedWriteId > 0L) add("Queued for sync")
        }
        val body = subtitleParts.joinToString(" · ").ifEmpty { "Synced to Fuloos" }

        val deepLinkUri = if (transactionId.isNotBlank()) "fuloos://tx/$transactionId" else "fuloos://overview"
        val openIntent = buildDeepLinkPendingIntent(
            context = context,
            uri = deepLinkUri,
            requestCode = notifId,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_TX_AUTO)
            .setSmallIcon(R.drawable.ic_stat_fuloos)
            .setColor(BRAND_COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(openIntent)

        if (transactionId.isNotBlank() || queuedWriteId > 0L) {
            val undoIntent = Intent(context, NotificationActionReceiver::class.java).apply {
                action = NotificationActionReceiver.ACTION_UNDO_TX
                putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notifId)
                putExtra(NotificationActionReceiver.EXTRA_TRANSACTION_ID, transactionId)
                putExtra(NotificationActionReceiver.EXTRA_QUEUED_WRITE_ID, queuedWriteId)
                putExtra(NotificationActionReceiver.EXTRA_SMS_HASH, smsHash)
                putExtra(NotificationActionReceiver.EXTRA_OWNER_KEY, ownerKey)
            }
            val undoPending = PendingIntent.getBroadcast(
                context,
                notifId + 1,
                undoIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(0, "Undo", undoPending)
        }

        NotificationManagerCompat.from(context).notify(notifId, builder.build())
    }

    /**
     * Posts an actionable confirmation notification when a foreign-currency transaction
     * is saved with an estimated account amount. Supports inline numeric reply via
     * [RemoteInput] ("Enter <ACC_CURRENCY> amount") and one-tap "Looks right".
     */
    fun postConfirmForeignAmountNotification(
        context: Context,
        transactionId: String,
        payee: String,
        originalAmountMinor: Long,
        originalCurrency: String,
        estimatedAmountMinor: Long,
        accountCurrency: String,
        fxRate: Double,
        accountName: String? = null,
        cardLast4: String? = null,
        smsHash: String = "",
        ownerKey: String = "",
    ) {
        if (!canPostNotifications(context)) return
        ensureChannels(context)

        val accCode = accountCurrency.trim().uppercase(Locale.US).ifBlank { "AED" }
        val origCode = originalCurrency.trim().uppercase(Locale.US).ifBlank { accCode }
        val notifKey = transactionId.ifBlank { smsHash.take(16) }
        val notifId = stableNotificationId("fxconfirm:$notifKey")

        val merchant = payee.ifBlank { "merchant" }
        val origStr = formatCurrencyAmount(originalAmountMinor, origCode)
        val estStr = formatCurrencyAmount(estimatedAmountMinor, accCode)
        val title = "Confirm $accCode amount"
        val promptBody = if (estimatedAmountMinor > 0L) {
            "$origStr at $merchant, about $estStr. What did your account actually pay?"
        } else {
            "$origStr at $merchant. What did your account actually pay in $accCode?"
        }

        val deepLinkUri = if (transactionId.isNotBlank()) "fuloos://tx/$transactionId" else "fuloos://overview"
        val openIntent = buildDeepLinkPendingIntent(
            context = context,
            uri = deepLinkUri,
            requestCode = notifId,
        )

        val builder = NotificationCompat.Builder(context, CHANNEL_TX_REVIEW)
            .setSmallIcon(R.drawable.ic_stat_fuloos)
            .setColor(BRAND_COLOR)
            .setContentTitle(title)
            .setContentText(promptBody)
            .setStyle(NotificationCompat.BigTextStyle().bigText(promptBody))
            .setAutoCancel(true)
            .setContentIntent(openIntent)

        val subTextParts = buildList {
            if (!accountName.isNullOrBlank()) add(accountName)
            if (!cardLast4.isNullOrBlank()) add("Card ••$cardLast4")
        }
        if (subTextParts.isNotEmpty()) {
            builder.setSubText(subTextParts.joinToString(" · "))
        }

        if (transactionId.isNotBlank()) {
            val replyLabel = "Enter $accCode amount"
            val remoteInput = RemoteInput.Builder(NotificationActionReceiver.KEY_ACTUAL_AMOUNT_REPLY)
                .setLabel(replyLabel)
                .build()

            val replyIntent = Intent(context, NotificationActionReceiver::class.java).apply {
                action = NotificationActionReceiver.ACTION_CONFIRM_FX_REPLY
                putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notifId)
                putExtra(NotificationActionReceiver.EXTRA_TRANSACTION_ID, transactionId)
                putExtra(NotificationActionReceiver.EXTRA_ACCOUNT_CURRENCY, accCode)
                putExtra(NotificationActionReceiver.EXTRA_ORIGINAL_AMOUNT, originalAmountMinor)
                putExtra(NotificationActionReceiver.EXTRA_ORIGINAL_CURRENCY, origCode)
                putExtra(NotificationActionReceiver.EXTRA_ESTIMATED_AMOUNT, estimatedAmountMinor)
                putExtra(NotificationActionReceiver.EXTRA_FX_RATE, fxRate)
                putExtra(NotificationActionReceiver.EXTRA_SMS_HASH, smsHash)
                putExtra(NotificationActionReceiver.EXTRA_OWNER_KEY, ownerKey)
            }
            // RemoteInput requires FLAG_MUTABLE on Android 12+ so the system can attach reply extras.
            val replyFlags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
            } else {
                PendingIntent.FLAG_UPDATE_CURRENT
            }
            val replyPending = PendingIntent.getBroadcast(
                context,
                notifId + 20,
                replyIntent,
                replyFlags,
            )
            val replyAction = NotificationCompat.Action.Builder(0, replyLabel, replyPending)
                .addRemoteInput(remoteInput)
                .setAllowGeneratedReplies(false)
                .build()
            builder.addAction(replyAction)

            if (estimatedAmountMinor > 0L) {
                val confirmIntent = Intent(context, NotificationActionReceiver::class.java).apply {
                    action = NotificationActionReceiver.ACTION_CONFIRM_FX_ESTIMATE
                    putExtra(NotificationActionReceiver.EXTRA_NOTIFICATION_ID, notifId)
                    putExtra(NotificationActionReceiver.EXTRA_TRANSACTION_ID, transactionId)
                    putExtra(NotificationActionReceiver.EXTRA_ACCOUNT_CURRENCY, accCode)
                    putExtra(NotificationActionReceiver.EXTRA_ESTIMATED_AMOUNT, estimatedAmountMinor)
                    putExtra(NotificationActionReceiver.EXTRA_FX_RATE, fxRate)
                    putExtra(NotificationActionReceiver.EXTRA_SMS_HASH, smsHash)
                    putExtra(NotificationActionReceiver.EXTRA_OWNER_KEY, ownerKey)
                }
                val confirmPending = PendingIntent.getBroadcast(
                    context,
                    notifId + 21,
                    confirmIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                builder.addAction(0, "Looks right", confirmPending)
            }
        }

        NotificationManagerCompat.from(context).notify(notifId, builder.build())
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
        ownerKey: String = "",
        accountCurrency: String = "AED",
    ) {
        if (!canPostNotifications(context)) return
        ensureChannels(context)

        val notifId = stableNotificationId("review:$smsHash")
        val payee = (if (txJson.isNull("payee")) "" else txJson.optString("payee", "")).ifBlank { "Unknown merchant" }
        val accCode = accountCurrency.trim().uppercase(Locale.US).ifBlank { "AED" }
        val amountMinor = txJson.optLong("amount", 0L)
        val origCurr = (if (txJson.isNull("original_currency")) "" else txJson.optString("original_currency", ""))
            .trim().uppercase(Locale.US)
        val origMinor = txJson.optLong("original_amount", 0L)
        val amountStr = when {
            amountMinor > 0L && origCurr.isNotEmpty() && origCurr != accCode && origMinor > 0L ->
                "${formatCurrencyAmount(origMinor, origCurr)} (≈ ${formatCurrencyAmount(amountMinor, accCode)})"
            amountMinor <= 0L && origCurr.isNotEmpty() && origMinor > 0L ->
                formatCurrencyAmount(origMinor, origCurr)
            else -> formatCurrencyAmount(amountMinor, accCode)
        }
        val title = "Review $amountStr at $payee?"
        val subtitleParts = buildList {
            if (!accountName.isNullOrBlank()) add(accountName)
            if (!cardLast4.isNullOrBlank()) add("Card ••$cardLast4")
            if (amountMinor <= 0L && origMinor > 0L) add("Rate unavailable offline")
            else add("Synced for web & mobile review")
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
                putExtra(NotificationActionReceiver.EXTRA_OWNER_KEY, ownerKey)
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
}

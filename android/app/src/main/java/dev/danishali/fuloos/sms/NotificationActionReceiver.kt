package dev.danishali.fuloos.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Handles interactive Android notification buttons without requiring the user
 * to open the full app:
 * - [ACTION_QUICK_CATEGORIZE]: creates the transaction with the tapped category,
 *   marks the PocketBase captured alert imported, records a learning example,
 *   and dismisses the notification.
 * - [ACTION_UNDO_TX]: deletes a recently auto-added transaction in PocketBase
 *   and marks the SMS hash as dismissed.
 */
class NotificationActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val pendingResult = goAsync()
        val appContext = context.applicationContext

        CoroutineScope(Dispatchers.IO).launch {
            try {
                when (action) {
                    ACTION_QUICK_CATEGORIZE -> handleQuickCategorize(appContext, intent)
                    ACTION_UNDO_TX -> handleUndoTransaction(appContext, intent)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Notification action $action failed", e)
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun handleQuickCategorize(context: Context, intent: Intent) {
        val notifId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        val alertId = intent.getStringExtra(EXTRA_ALERT_ID).orEmpty().ifBlank { null }
        val smsHash = intent.getStringExtra(EXTRA_SMS_HASH).orEmpty()
        val categoryId = intent.getStringExtra(EXTRA_CATEGORY_ID).orEmpty()
        val categoryName = intent.getStringExtra(EXTRA_CATEGORY_NAME).orEmpty()
        val merchantClean = intent.getStringExtra(EXTRA_MERCHANT_CLEAN).orEmpty()
        val rawTxJson = intent.getStringExtra(EXTRA_TX_JSON).orEmpty()

        if (rawTxJson.isBlank() || categoryId.isBlank()) {
            SmsNotificationHelper.cancel(context, notifId)
            return
        }

        val txJson = try {
            JSONObject(rawTxJson).apply { put("category_id", categoryId) }
        } catch (_: Exception) {
            SmsNotificationHelper.cancel(context, notifId)
            return
        }

        val pb = PocketBaseBackgroundClient(context)
        val db = FuloosLocalDb.getInstance(context)
        val result = pb.importCapturedAlertOrCreateTransaction(alertId, txJson)

        val acceptedWrite = result is PocketBaseBackgroundClient.ApiResult.Success ||
            result is PocketBaseBackgroundClient.ApiResult.QueuedOffline
        val txId = (result as? PocketBaseBackgroundClient.ApiResult.Success)?.data
        val accountId = if (txJson.isNull("account_id")) "" else txJson.optString("account_id", "")

        if (acceptedWrite && smsHash.isNotEmpty()) {
            db.markProcessed(
                listOf(
                    FuloosLocalDb.ProcessedEntry(
                        smsHash = smsHash,
                        androidSmsId = null,
                        accountId = accountId.ifBlank { null },
                        transactionId = txId,
                        status = "auto_added",
                    ),
                ),
            )
        }

        if (acceptedWrite && merchantClean.isNotBlank() && hasLearningConsent(db)) {
            pb.recordMlExample(
                merchantText = merchantClean,
                payee = if (txJson.isNull("payee")) "" else txJson.optString("payee", ""),
                amountFils = txJson.optLong("amount", 0L),
                categoryId = categoryId,
                suggestedCategory = categoryName,
                accepted = true,
            )
        }

        SmsNotificationHelper.cancel(context, notifId)
        if (acceptedWrite) {
            FuloosSmsPlugin.notifySmsProcessed(
                action = "auto_add",
                transactionId = txId,
                alertId = alertId,
                accountId = accountId.ifBlank { null },
            )
        }
    }

    private fun hasLearningConsent(db: FuloosLocalDb): Boolean {
        val raw = db.getEngineContextJson() ?: return false
        return try {
            val ctx = JSONObject(raw)
            ctx.optJSONObject("learningSettings")?.optBoolean("learn_consent", false) == true
        } catch (_: Exception) {
            false
        }
    }

    private fun handleUndoTransaction(context: Context, intent: Intent) {
        val notifId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0)
        val txId = intent.getStringExtra(EXTRA_TRANSACTION_ID).orEmpty()
        var acceptedDelete = false
        if (txId.isNotBlank()) {
            val pb = PocketBaseBackgroundClient(context)
            val db = FuloosLocalDb.getInstance(context)
            val res = pb.deleteTransaction(txId)
            acceptedDelete = res is PocketBaseBackgroundClient.ApiResult.Success ||
                res is PocketBaseBackgroundClient.ApiResult.QueuedOffline
            if (acceptedDelete) {
                db.updateProcessedStatusByTransaction(txId, "dismissed")
            }
        }
        SmsNotificationHelper.cancel(context, notifId)
        if (acceptedDelete) {
            FuloosSmsPlugin.notifySmsProcessed(
                action = "auto_add",
                transactionId = txId.ifBlank { null },
                alertId = null,
                accountId = null,
            )
        }
    }

    companion object {
        private const val TAG = "NotifActionReceiver"

        const val ACTION_QUICK_CATEGORIZE = "dev.danishali.fuloos.ACTION_QUICK_CATEGORIZE"
        const val ACTION_UNDO_TX = "dev.danishali.fuloos.ACTION_UNDO_TX"

        const val EXTRA_NOTIFICATION_ID = "notification_id"
        const val EXTRA_ALERT_ID = "alert_id"
        const val EXTRA_SMS_HASH = "sms_hash"
        const val EXTRA_CATEGORY_ID = "category_id"
        const val EXTRA_CATEGORY_NAME = "category_name"
        const val EXTRA_MERCHANT_CLEAN = "merchant_clean"
        const val EXTRA_TX_JSON = "tx_json"
        const val EXTRA_TRANSACTION_ID = "transaction_id"
    }
}

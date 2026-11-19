package dev.danishali.fuloos.sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dev.danishali.fuloos.BuildConfig
import org.json.JSONArray
import org.json.JSONObject

/**
 * Background WorkManager worker powering:
 * - [MODE_SINGLE_SMS]: immediate evaluation of an incoming SMS from SmsBroadcastReceiver
 * - [MODE_CATCH_UP]: periodic / on-resume inbox scan recovering any SMS missed while OEM
 *   battery management killed the app, plus flushing the offline PocketBase queue
 * - [MODE_FLUSH_QUEUE]: retries queued PocketBase writes once connectivity returns
 */
class SmsProcessWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    private val db = FuloosLocalDb.getInstance(appContext)
    private val pb = PocketBaseBackgroundClient(appContext)
    private val engine = HeadlessSmsEngine(appContext)

    override suspend fun doWork(): Result {
        val mode = inputData.getString(KEY_MODE) ?: MODE_CATCH_UP
        return try {
            pb.flushOfflineQueue()
            when (mode) {
                MODE_SINGLE_SMS -> handleSingleSms()
                MODE_CATCH_UP -> handleCatchUp()
                MODE_FLUSH_QUEUE -> Result.success()
                else -> Result.success()
            }
        } catch (e: Exception) {
            Log.e(TAG, "SmsProcessWorker ($mode) failed", e)
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    private suspend fun handleSingleSms(): Result {
        val sender = inputData.getString(KEY_SENDER).orEmpty()
        val body = inputData.getString(KEY_BODY).orEmpty()
        val timestampMs = inputData.getLong(KEY_TIMESTAMP_MS, System.currentTimeMillis())
        if (sender.isBlank() || body.isBlank()) return Result.success()

        val ctxJson = db.buildEffectiveEngineContextJson()
        if (ctxJson.isNullOrBlank()) {
            Log.w(TAG, "Skipping background SMS: engine context not synced yet")
            return Result.success()
        }

        val rawSms = JSONObject().apply {
            put("sender", sender)
            put("body", body)
            put("timestampMs", timestampMs)
        }

        val decision = engine.processSingleSms(rawSms.toString(), ctxJson) ?: return Result.retry()
        return if (applyDecision(decision, ctxJson)) Result.retry() else Result.success()
    }

    private suspend fun handleCatchUp(): Result {
        if (!BuildConfig.SUPPORTS_DIRECT_SMS) return Result.success()
        val hasReadSms = ContextCompat.checkSelfPermission(
            applicationContext,
            Manifest.permission.READ_SMS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasReadSms) return Result.success()

        val ctxJson = db.buildEffectiveEngineContextJson() ?: return Result.success()
        val (senders, sinceTs) = db.getEnabledSendersAndWatermark()
        if (senders.isEmpty()) return Result.success()

        val inboxResult = SmsInboxReader.readMessages(
            context = applicationContext,
            senders = senders,
            sinceTimestampMs = sinceTs,
            limit = 150,
            offset = 0,
        )
        val messages = inboxResult.optJSONArray("messages") ?: return Result.success()
        if (messages.length() == 0) return Result.success()

        val decisions = engine.processBatch(messages.toString(), ctxJson) ?: return Result.success()
        var needsRetry = false
        for (i in 0 until decisions.length()) {
            val decision = decisions.optJSONObject(i) ?: continue
            if (applyDecision(decision, ctxJson)) needsRetry = true
        }
        return if (needsRetry && runAttemptCount < 3) Result.retry() else Result.success()
    }

    /**
     * Applies one SMS decision. Returns `true` if a retryable failure occurred and
     * the worker should retry without marking the SMS hash processed.
     */
    private fun applyDecision(decision: JSONObject, ctxJson: String): Boolean {
        val smsHash = decision.optNonNullString("smsHash")
        if (smsHash.isBlank() || db.isProcessed(smsHash)) return false

        val action = decision.optNonNullString("action", "skip")
        val linkId = decision.optNonNullString("linkId")
        val accountId = decision.optNonNullString("accountId")
        val androidSmsId = decision.optNonNullString("androidSmsId").ifBlank { null }
        val timestampMs = decision.optLong("timestampMs", System.currentTimeMillis())

        if (action == "skip") {
            db.markProcessed(
                listOf(
                    FuloosLocalDb.ProcessedEntry(
                        smsHash = smsHash,
                        androidSmsId = androidSmsId,
                        accountId = accountId.ifBlank { null },
                        transactionId = null,
                        status = "skipped",
                    ),
                ),
            )
            if (linkId.isNotEmpty()) db.updateLinkWatermark(linkId, timestampMs)
            return false
        }

        val txJson = decision.optJSONObject("transaction") ?: return false
        val lookups = parseLookups(ctxJson)
        val accountName = lookups.accounts[accountId]
        val cardLast4 = decision.optNonNullString("cardLast4").ifBlank { null }

        if (action == "auto_add") {
            val apiResult = pb.createTransaction(txJson, queueOnNetworkFailure = true)
            val txId = when (apiResult) {
                is PocketBaseBackgroundClient.ApiResult.Success -> apiResult.data
                is PocketBaseBackgroundClient.ApiResult.QueuedOffline -> null
                is PocketBaseBackgroundClient.ApiResult.AuthExpired -> {
                    Log.w(TAG, "PocketBase auth expired; leaving SMS hash unprocessed for later catch-up")
                    return false
                }
                is PocketBaseBackgroundClient.ApiResult.Failure -> {
                    Log.w(TAG, "PocketBase auto_add write failed (${apiResult.status}): ${apiResult.message}")
                    return isRetryableStatus(apiResult.status)
                }
            }

            db.markProcessed(
                listOf(
                    FuloosLocalDb.ProcessedEntry(
                        smsHash = smsHash,
                        androidSmsId = androidSmsId,
                        accountId = accountId.ifBlank { null },
                        transactionId = txId,
                        status = "auto_added",
                    ),
                ),
            )
            if (linkId.isNotEmpty()) db.updateLinkWatermark(linkId, timestampMs)

            val catId = txJson.optNonNullString("category_id")
            SmsNotificationHelper.postAutoAddedNotification(
                context = applicationContext,
                transactionId = txId ?: smsHash.take(12),
                payee = txJson.optNonNullString("payee"),
                amountFils = txJson.optLong("amount", 0L),
                categoryName = lookups.categories[catId],
                accountName = accountName,
                cardLast4 = cardLast4,
            )
            FuloosSmsPlugin.notifySmsProcessed(
                action = "auto_add",
                transactionId = txId,
                alertId = null,
                accountId = accountId.ifBlank { null },
            )
            return false
        }

        if (action == "needs_review") {
            val draft = decision.optJSONObject("capturedAlertDraft")
            var alertId: String? = null
            if (draft != null) {
                when (val alertRes = pb.createCapturedAlert(draft, queueOnNetworkFailure = true)) {
                    is PocketBaseBackgroundClient.ApiResult.Success -> alertId = alertRes.data
                    is PocketBaseBackgroundClient.ApiResult.QueuedOffline -> alertId = null
                    is PocketBaseBackgroundClient.ApiResult.AuthExpired -> {
                        Log.w(TAG, "PocketBase auth expired while syncing captured alert draft")
                        return false
                    }
                    is PocketBaseBackgroundClient.ApiResult.Failure -> {
                        Log.w(TAG, "PocketBase captured alert sync failed (${alertRes.status}): ${alertRes.message}")
                        return isRetryableStatus(alertRes.status)
                    }
                }
            }

            db.markProcessed(
                listOf(
                    FuloosLocalDb.ProcessedEntry(
                        smsHash = smsHash,
                        androidSmsId = androidSmsId,
                        accountId = accountId.ifBlank { null },
                        transactionId = null,
                        status = "pending_review",
                    ),
                ),
            )
            if (linkId.isNotEmpty()) db.updateLinkWatermark(linkId, timestampMs)

            val topSuggestions = decision.optJSONArray("topSuggestions") ?: JSONArray()
            SmsNotificationHelper.postNeedsReviewNotification(
                context = applicationContext,
                smsHash = smsHash,
                alertId = alertId,
                txJson = txJson,
                merchantClean = decision.optNonNullString("merchantClean").ifBlank { null },
                accountName = accountName,
                cardLast4 = cardLast4,
                topSuggestions = topSuggestions,
            )
            FuloosSmsPlugin.notifySmsProcessed(
                action = "needs_review",
                transactionId = null,
                alertId = alertId,
                accountId = accountId.ifBlank { null },
            )
        }
        return false
    }

    private fun isRetryableStatus(status: Int): Boolean {
        return status == 0 || status == 408 || status == 429 || status >= 500
    }

    private fun JSONObject.optNonNullString(key: String, fallback: String = ""): String {
        return if (isNull(key)) fallback else optString(key, fallback)
    }

    private data class ContextLookups(
        val accounts: Map<String, String>,
        val categories: Map<String, String>,
    )

    private fun parseLookups(ctxJson: String): ContextLookups {
        val accounts = mutableMapOf<String, String>()
        val categories = mutableMapOf<String, String>()
        try {
            val obj = JSONObject(ctxJson)
            val accArr = obj.optJSONArray("accounts")
            if (accArr != null) {
                for (i in 0 until accArr.length()) {
                    val a = accArr.optJSONObject(i) ?: continue
                    val id = a.optString("id", "")
                    val name = a.optString("name", "")
                    if (id.isNotEmpty() && name.isNotEmpty()) accounts[id] = name
                }
            }
            val catArr = obj.optJSONArray("categories")
            if (catArr != null) {
                for (i in 0 until catArr.length()) {
                    val c = catArr.optJSONObject(i) ?: continue
                    val id = c.optString("id", "")
                    val name = c.optString("name", "")
                    if (id.isNotEmpty() && name.isNotEmpty()) categories[id] = name
                }
            }
        } catch (_: Exception) {
            // Fallback to empty lookups
        }
        return ContextLookups(accounts, categories)
    }

    companion object {
        private const val TAG = "SmsProcessWorker"

        const val KEY_MODE = "mode"
        const val KEY_SENDER = "sender"
        const val KEY_BODY = "body"
        const val KEY_TIMESTAMP_MS = "timestamp_ms"

        const val MODE_SINGLE_SMS = "single_sms"
        const val MODE_CATCH_UP = "catch_up"
        const val MODE_FLUSH_QUEUE = "flush_queue"
    }
}

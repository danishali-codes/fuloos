package dev.danishali.fuloos.sms

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dev.danishali.fuloos.BuildConfig
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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
    private val authStore = SecureAuthStore(appContext)
    private val pb = BackgroundSyncClient(appContext, authStore, db)
    private val engine = HeadlessSmsEngine(appContext)

    override suspend fun doWork(): Result {
        val mode = inputData.getString(KEY_MODE) ?: MODE_CATCH_UP
        return try {
            processMutex.withLock {
                val session = authStore.load() ?: return@withLock Result.success()
                val ownerKey = session.ownerKey
                if (ownerKey.isBlank()) return@withLock Result.success()

                pb.flushOfflineQueue()
                when (mode) {
                    MODE_SINGLE_SMS -> handleSingleSms(ownerKey)
                    MODE_CATCH_UP -> handleCatchUp(ownerKey)
                    MODE_FLUSH_QUEUE -> Result.success()
                    else -> Result.success()
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "SmsProcessWorker ($mode) failed", e)
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    private suspend fun handleSingleSms(ownerKey: String): Result {
        val sender = inputData.getString(KEY_SENDER).orEmpty()
        val body = inputData.getString(KEY_BODY).orEmpty()
        val timestampMs = inputData.getLong(KEY_TIMESTAMP_MS, System.currentTimeMillis())
        if (sender.isBlank() || body.isBlank()) return Result.success()

        var ctxJson = db.buildEffectiveEngineContextJson(ownerKey)
        if (ctxJson.isNullOrBlank()) {
            Log.w(TAG, "Skipping background SMS: engine context not synced yet")
            return Result.success()
        }

        val rawSms = JSONObject().apply {
            put("sender", sender)
            put("body", body)
            put("timestampMs", timestampMs)
        }

        var decision = engine.processSingleSms(rawSms.toString(), ctxJson) ?: return Result.retry()
        val needsFx = decision.optJSONObject("needsFxRate")
        if (needsFx != null) {
            val from = needsFx.optNonNullString("from")
            val to = needsFx.optNonNullString("to")
            val date = needsFx.optNonNullString("date")
            if (from.isNotEmpty() && to.isNotEmpty() && date.isNotEmpty()) {
                val resolved = pb.fetchFxRate(from, to, date)
                if (resolved != null) {
                    val refreshedCtx = db.buildEffectiveEngineContextJson(ownerKey)
                    if (!refreshedCtx.isNullOrBlank()) {
                        ctxJson = refreshedCtx
                        decision = engine.processSingleSms(rawSms.toString(), ctxJson) ?: decision
                    }
                }
            }
        }
        return if (applyDecision(decision, ctxJson, ownerKey) == DecisionOutcome.FAILED_RETRYABLE) {
            Result.retry()
        } else {
            Result.success()
        }
    }

    private suspend fun handleCatchUp(ownerKey: String): Result {
        if (!BuildConfig.SUPPORTS_DIRECT_SMS) return Result.success()
        val hasReadSms = ContextCompat.checkSelfPermission(
            applicationContext,
            Manifest.permission.READ_SMS,
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasReadSms) return Result.success()

        var ctxJson = db.buildEffectiveEngineContextJson(ownerKey) ?: return Result.success()
        val (senders, sinceTs) = db.getEnabledSendersAndWatermark(ownerKey)
        if (senders.isEmpty()) return Result.success()

        val scanStartedAtMs = System.currentTimeMillis()
        var needsRetry = false
        val firstFailedTsByLink = mutableMapOf<String, Long>()
        val coveredTimestampsByLink = mutableMapOf<String, MutableList<Long>>()
        var maxScannedTs = 0L
        var offset = 0
        var hasMore = true
        var completedAllPages = false

        // Paginate across all inbox messages > sinceTs in chronological (DATE ASC) order
        // so a dormant link's older watermark can never starve newer messages on active links.
        while (hasMore) {
            val inboxResult = SmsInboxReader.readMessages(
                context = applicationContext,
                senders = senders,
                sinceTimestampMs = sinceTs,
                limit = CATCH_UP_PAGE_SIZE,
                offset = offset,
            )
            val messages = inboxResult.optJSONArray("messages") ?: break
            if (messages.length() == 0) {
                completedAllPages = true
                break
            }

            for (i in 0 until messages.length()) {
                val msgTs = messages.optJSONObject(i)?.optLong("timestampMs", 0L) ?: 0L
                if (msgTs > maxScannedTs) maxScannedTs = msgTs
            }

            var decisions = engine.processBatch(messages.toString(), ctxJson)
            if (decisions == null) {
                needsRetry = true
                break
            }

            // Prefetch any missing historical FX rates once per unique (from, to, date)
            // and re-evaluate the batch so conversions use the exact same JS engine logic.
            val missingPairs = linkedSetOf<Triple<String, String, String>>()
            for (i in 0 until decisions.length()) {
                val need = decisions.optJSONObject(i)?.optJSONObject("needsFxRate") ?: continue
                val from = need.optNonNullString("from")
                val to = need.optNonNullString("to")
                val date = need.optNonNullString("date")
                if (from.isNotEmpty() && to.isNotEmpty() && date.isNotEmpty()) {
                    missingPairs.add(Triple(from, to, date))
                }
            }
            if (missingPairs.isNotEmpty()) {
                var fetchedAny = false
                for ((from, to, date) in missingPairs) {
                    if (pb.fetchFxRate(from, to, date) != null) {
                        fetchedAny = true
                    }
                }
                if (fetchedAny) {
                    val refreshedCtx = db.buildEffectiveEngineContextJson(ownerKey)
                    if (!refreshedCtx.isNullOrBlank()) {
                        ctxJson = refreshedCtx
                        decisions = engine.processBatch(messages.toString(), ctxJson) ?: decisions
                    }
                }
            }

            for (i in 0 until decisions.length()) {
                val decision = decisions.optJSONObject(i) ?: continue
                val linkId = decision.optNonNullString("linkId")
                val ts = decision.optLong("timestampMs", 0L)
                val outcome = applyDecision(decision, ctxJson, ownerKey)
                when (outcome) {
                    DecisionOutcome.COVERED -> {
                        if (linkId.isNotEmpty() && ts > 0L && linkId !in firstFailedTsByLink) {
                            coveredTimestampsByLink.getOrPut(linkId) { mutableListOf() }.add(ts)
                        }
                    }
                    DecisionOutcome.FAILED_RETRYABLE -> {
                        needsRetry = true
                        if (linkId.isNotEmpty() && linkId !in firstFailedTsByLink) {
                            firstFailedTsByLink[linkId] = ts
                        }
                    }
                    DecisionOutcome.FAILED_HOLD -> {
                        if (linkId.isNotEmpty() && linkId !in firstFailedTsByLink) {
                            firstFailedTsByLink[linkId] = ts
                        }
                    }
                }
            }

            offset += messages.length()
            hasMore = inboxResult.optBoolean("hasMore", false)
            if (!hasMore) completedAllPages = true
        }

        for ((linkId, timestamps) in coveredTimestampsByLink) {
            val failedTs = firstFailedTsByLink[linkId]
            val safeMax = if (failedTs != null) {
                // Exclude messages sharing the exact same millisecond as the first failed SMS
                timestamps.filter { it < failedTs }.maxOrNull()
            } else {
                timestamps.maxOrNull()
            }
            if (safeMax != null && safeMax > 0L) {
                db.updateLinkWatermark(linkId, safeMax, ownerKey)
            }
        }

        // If the entire inbox scan finished cleanly with no failures, advance any quiet/dormant
        // enabled links up to a conservative snapshot floor so future catch-ups stay fast.
        if (completedAllPages && firstFailedTsByLink.isEmpty() && maxScannedTs > 0L) {
            val dormantFloor = minOf(scanStartedAtMs - 60_000L, maxScannedTs)
            if (dormantFloor > 0L) {
                val links = db.getLinksArray(ownerKey)
                for (i in 0 until links.length()) {
                    val link = links.optJSONObject(i) ?: continue
                    if (!link.optBoolean("enabled", true)) continue
                    val id = link.optNonNullString("id")
                    if (id.isNotEmpty() && id !in coveredTimestampsByLink) {
                        db.updateLinkWatermark(id, dormantFloor, ownerKey)
                    }
                }
            }
        }

        return if (needsRetry && runAttemptCount < 3) Result.retry() else Result.success()
    }

    private enum class DecisionOutcome {
        COVERED,
        FAILED_RETRYABLE,
        FAILED_HOLD,
    }

    /**
     * Applies one SMS decision without advancing catch-up watermarks (watermarks are
     * advanced exclusively by [handleCatchUp] after scanning earlier inbox messages).
     */
    private fun applyDecision(decision: JSONObject, ctxJson: String, ownerKey: String): DecisionOutcome {
        val smsHash = decision.optNonNullString("smsHash")
        if (smsHash.isBlank() || db.isProcessed(smsHash, ownerKey)) return DecisionOutcome.COVERED

        val action = decision.optNonNullString("action", "skip")
        val accountId = decision.optNonNullString("accountId")
        val androidSmsId = decision.optNonNullString("androidSmsId").ifBlank { null }

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
                ownerKey,
            )
            return DecisionOutcome.COVERED
        }

        val txJson = decision.optJSONObject("transaction") ?: return DecisionOutcome.COVERED
        val lookups = parseLookups(ctxJson)
        val accountName = lookups.accounts[accountId]
        val accountCurrency = decision.optNonNullString("accountCurrency")
            .ifBlank { lookups.accountCurrencies[accountId] ?: "AED" }
        val cardLast4 = decision.optNonNullString("cardLast4").ifBlank { null }

        if (action == "auto_add") {
            val apiResult = pb.createTransaction(txJson, queueOnNetworkFailure = true)
            val txId: String
            val queuedWriteId: Long
            when (apiResult) {
                is BackgroundSyncClient.ApiResult.Success -> {
                    txId = apiResult.data
                    queuedWriteId = -1L
                }
                is BackgroundSyncClient.ApiResult.QueuedOffline -> {
                    txId = apiResult.recordId.orEmpty()
                    queuedWriteId = apiResult.queueId
                }
                is BackgroundSyncClient.ApiResult.AuthExpired -> {
                    Log.w(TAG, "Auth expired; leaving SMS hash unprocessed for later catch-up")
                    return DecisionOutcome.FAILED_HOLD
                }
                is BackgroundSyncClient.ApiResult.Failure -> {
                    Log.w(TAG, "auto_add write failed (${apiResult.status}): ${apiResult.message}")
                    return if (isRetryableStatus(apiResult.status)) {
                        DecisionOutcome.FAILED_RETRYABLE
                    } else {
                        DecisionOutcome.FAILED_HOLD
                    }
                }
            }

            db.markProcessed(
                listOf(
                    FuloosLocalDb.ProcessedEntry(
                        smsHash = smsHash,
                        androidSmsId = androidSmsId,
                        accountId = accountId.ifBlank { null },
                        transactionId = txId.ifBlank { null },
                        status = "auto_added",
                    ),
                ),
                ownerKey,
            )

            val catId = txJson.optNonNullString("category_id")
            val fxStatus = txJson.optNonNullString("fx_status")
            val origCurr = txJson.optNonNullString("original_currency").ifBlank { accountCurrency }
            val origAmount = txJson.optLong("original_amount", txJson.optLong("amount", 0L))
            val estAmount = txJson.optLong("amount", 0L)
            val fxRate = txJson.optDouble("fx_rate", 1.0)

            if (fxStatus == "estimated" && shouldConfirmForeignAmount(estAmount, lookups)) {
                SmsNotificationHelper.postConfirmForeignAmountNotification(
                    context = applicationContext,
                    transactionId = txId,
                    payee = txJson.optNonNullString("payee"),
                    originalAmountMinor = origAmount,
                    originalCurrency = origCurr,
                    estimatedAmountMinor = estAmount,
                    accountCurrency = accountCurrency,
                    fxRate = fxRate,
                    accountName = accountName,
                    cardLast4 = cardLast4,
                    smsHash = smsHash,
                    ownerKey = ownerKey,
                )
            } else {
                SmsNotificationHelper.postAutoAddedNotification(
                    context = applicationContext,
                    transactionId = txId,
                    payee = txJson.optNonNullString("payee"),
                    amountFils = estAmount,
                    categoryName = lookups.categories[catId],
                    accountName = accountName,
                    cardLast4 = cardLast4,
                    queuedWriteId = queuedWriteId,
                    smsHash = smsHash,
                    ownerKey = ownerKey,
                    currency = accountCurrency,
                    originalAmountMinor = origAmount,
                    originalCurrency = origCurr,
                )
            }
            FuloosSmsPlugin.notifySmsProcessed(
                action = "auto_add",
                transactionId = txId.ifBlank { null },
                alertId = null,
                accountId = accountId.ifBlank { null },
            )
            return DecisionOutcome.COVERED
        }

        if (action == "needs_review") {
            val draft = decision.optJSONObject("capturedAlertDraft")
            var alertId: String? = null
            if (draft != null) {
                when (val alertRes = pb.createCapturedAlert(draft, queueOnNetworkFailure = true)) {
                    is BackgroundSyncClient.ApiResult.Success -> {
                        alertId = alertRes.data.ifBlank { null }
                    }
                    is BackgroundSyncClient.ApiResult.QueuedOffline -> {
                        alertId = alertRes.recordId?.ifBlank { null }
                    }
                    is BackgroundSyncClient.ApiResult.AuthExpired -> {
                        Log.w(TAG, "Auth expired while syncing captured alert draft")
                        return DecisionOutcome.FAILED_HOLD
                    }
                    is BackgroundSyncClient.ApiResult.Failure -> {
                        Log.w(TAG, "Captured alert sync failed (${alertRes.status}): ${alertRes.message}")
                        return if (isRetryableStatus(alertRes.status)) {
                            DecisionOutcome.FAILED_RETRYABLE
                        } else {
                            DecisionOutcome.FAILED_HOLD
                        }
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
                ownerKey,
            )

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
                ownerKey = ownerKey,
                accountCurrency = accountCurrency,
            )
            FuloosSmsPlugin.notifySmsProcessed(
                action = "needs_review",
                transactionId = null,
                alertId = alertId,
                accountId = accountId.ifBlank { null },
            )
            return DecisionOutcome.COVERED
        }
        return DecisionOutcome.COVERED
    }

    private fun shouldConfirmForeignAmount(amountMinor: Long, lookups: ContextLookups): Boolean {
        return when (lookups.confirmForeignMode) {
            "never" -> false
            "above_threshold" -> amountMinor >= lookups.confirmForeignThreshold
            else -> true
        }
    }

    private fun isRetryableStatus(status: Int): Boolean {
        return status == 0 || status == 408 || status == 429 || status >= 500
    }

    private fun JSONObject.optNonNullString(key: String, fallback: String = ""): String {
        return if (isNull(key)) fallback else optString(key, fallback)
    }

    private data class ContextLookups(
        val accounts: Map<String, String>,
        val accountCurrencies: Map<String, String>,
        val categories: Map<String, String>,
        val confirmForeignMode: String = "always",
        val confirmForeignThreshold: Long = 5000L,
    )

    private fun parseLookups(ctxJson: String): ContextLookups {
        val accounts = mutableMapOf<String, String>()
        val accountCurrencies = mutableMapOf<String, String>()
        val categories = mutableMapOf<String, String>()
        var confirmMode = "always"
        var confirmThreshold = 5000L
        try {
            val obj = JSONObject(ctxJson)
            val accArr = obj.optJSONArray("accounts")
            if (accArr != null) {
                for (i in 0 until accArr.length()) {
                    val a = accArr.optJSONObject(i) ?: continue
                    val id = a.optString("id", "")
                    val name = a.optString("name", "")
                    val curr = a.optNonNullString("currency", "AED").ifBlank { "AED" }.uppercase()
                    if (id.isNotEmpty()) {
                        if (name.isNotEmpty()) accounts[id] = name
                        accountCurrencies[id] = curr
                    }
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
            val settings = obj.optJSONObject("userSettings")
            if (settings != null) {
                confirmMode = settings.optNonNullString("confirm_foreign_amounts", "always").ifBlank { "always" }
                confirmThreshold = settings.optLong("confirm_foreign_threshold", 5000L)
            }
        } catch (_: Exception) {
            // Fallback to empty lookups
        }
        return ContextLookups(accounts, accountCurrencies, categories, confirmMode, confirmThreshold)
    }

    companion object {
        private const val TAG = "SmsProcessWorker"
        private const val CATCH_UP_PAGE_SIZE = 150
        private val processMutex = Mutex()

        const val KEY_MODE = "mode"
        const val KEY_SENDER = "sender"
        const val KEY_BODY = "body"
        const val KEY_TIMESTAMP_MS = "timestamp_ms"

        const val MODE_SINGLE_SMS = "single_sms"
        const val MODE_CATCH_UP = "catch_up"
        const val MODE_FLUSH_QUEUE = "flush_queue"
    }
}

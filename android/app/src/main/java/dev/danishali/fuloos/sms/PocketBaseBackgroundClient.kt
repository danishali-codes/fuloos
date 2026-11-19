package dev.danishali.fuloos.sms

import android.content.Context
import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.security.SecureRandom
import java.util.concurrent.TimeUnit

/**
 * Background PocketBase HTTP client authenticated via SecureAuthStore.
 *
 * Uses the exact same PocketBase REST collections as src/backend.ts and automatically
 * queues transient network failures in FuloosLocalDb.offline_queue for WorkManager retry.
 */
class PocketBaseBackgroundClient(
    private val context: Context,
    private val authStore: SecureAuthStore = SecureAuthStore(context),
    private val db: FuloosLocalDb = FuloosLocalDb.getInstance(context),
) {

    sealed class ApiResult<out T> {
        data class Success<T>(val data: T) : ApiResult<T>()
        data class QueuedOffline(val queueId: Long, val recordId: String? = null) : ApiResult<Nothing>()
        data class AuthExpired(val status: Int) : ApiResult<Nothing>()
        data class Failure(val status: Int, val message: String) : ApiResult<Nothing>()
    }

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    fun createTransaction(
        txJson: JSONObject,
        queueOnNetworkFailure: Boolean = true,
    ): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val recordId = generatePocketBaseId()
        val payload = buildTransactionPayload(txJson, session.userId).apply {
            put("id", recordId)
        }
        val path = "/api/collections/fuloos_transactions/records"
        return executeWrite(
            session = session,
            method = "POST",
            path = path,
            bodyJson = payload.toString(),
            queueOnNetworkFailure = queueOnNetworkFailure,
            queuedRecordId = recordId,
        )
    }

    fun deleteTransaction(
        transactionId: String,
        queueOnNetworkFailure: Boolean = true,
    ): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val encoded = URLEncoder.encode(transactionId, "UTF-8")
        val path = "/api/collections/fuloos_transactions/records/$encoded"
        return executeWrite(
            session = session,
            method = "DELETE",
            path = path,
            bodyJson = "",
            queueOnNetworkFailure = queueOnNetworkFailure,
        )
    }

    /**
     * Cancels a still-queued offline transaction creation before it is sent, or deletes
     * the transaction in PocketBase if it was already created (online or via queue replay).
     */
    fun cancelOrDeleteTransaction(
        transactionId: String,
        queuedWriteId: Long = -1L,
    ): ApiResult<String> {
        synchronized(queueLock) {
            if (queuedWriteId > 0L && db.removeOfflineWrite(queuedWriteId)) {
                return ApiResult.Success(transactionId)
            }
            if (transactionId.isBlank()) {
                return ApiResult.Failure(400, "Missing transaction id")
            }
            val session = authStore.load() ?: return ApiResult.AuthExpired(401)
            flushOfflineQueueLocked(session)
            val encoded = URLEncoder.encode(transactionId, "UTF-8")
            val path = "/api/collections/fuloos_transactions/records/$encoded"
            if (db.getOfflineQueue(1).isNotEmpty()) {
                val qId = db.enqueueOfflineWrite("DELETE", path, "")
                return ApiResult.QueuedOffline(qId, transactionId)
            }
            return executeWrite(
                session = session,
                method = "DELETE",
                path = path,
                bodyJson = "",
                queueOnNetworkFailure = true,
                queuedRecordId = transactionId,
            )
        }
    }

    fun createCapturedAlert(
        draftJson: JSONObject,
        queueOnNetworkFailure: Boolean = true,
    ): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val recordId = generatePocketBaseId()
        val payload = JSONObject(draftJson.toString()).apply {
            put("id", recordId)
            put("user_id", session.userId)
            put("source", "sms_native")
            if (isNull("account_id")) put("account_id", "")
            if (isNull("suggested_category_id")) put("suggested_category_id", "")
        }
        val path = "/api/collections/fuloos_captured_alerts/records"
        return executeWrite(
            session = session,
            method = "POST",
            path = path,
            bodyJson = payload.toString(),
            queueOnNetworkFailure = queueOnNetworkFailure,
            queuedRecordId = recordId,
        )
    }

    fun importCapturedAlertOrCreateTransaction(
        alertId: String?,
        txJson: JSONObject,
    ): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val txPayload = buildTransactionPayload(txJson, session.userId)

        if (!alertId.isNullOrBlank()) {
            // Serialize with queue draining so any queued alert creation runs before its import,
            // and retain the atomic endpoint's pending-status & idempotency guard.
            synchronized(queueLock) {
                flushOfflineQueueLocked(session)
                val encoded = URLEncoder.encode(alertId, "UTF-8")
                val path = "/api/fuloos/captured-alerts/$encoded/import"
                val atomicBody = JSONObject().put("transaction", txPayload).toString()
                if (db.getOfflineQueue(1).isNotEmpty()) {
                    val qId = db.enqueueOfflineWrite("POST", path, atomicBody)
                    return ApiResult.QueuedOffline(qId)
                }
                return executeWrite(
                    session = session,
                    method = "POST",
                    path = path,
                    bodyJson = atomicBody,
                    queueOnNetworkFailure = true,
                )
            }
        }

        return createTransaction(txJson, queueOnNetworkFailure = true)
    }

    fun markAlertStatus(alertId: String, status: String): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val encoded = URLEncoder.encode(alertId, "UTF-8")
        val path = "/api/collections/fuloos_captured_alerts/records/$encoded"
        val body = JSONObject().put("status", status).toString()
        return executeWrite(
            session = session,
            method = "PATCH",
            path = path,
            bodyJson = body,
            queueOnNetworkFailure = true,
        )
    }

    fun recordMlExample(
        merchantText: String,
        payee: String,
        amountFils: Long,
        categoryId: String,
        suggestedCategory: String,
        accepted: Boolean,
    ): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val payload = JSONObject().apply {
            put("user_id", session.userId)
            put("merchant_text", merchantText.take(160))
            put("payee", payee.take(120))
            put("amount", amountFils)
            put("category_id", categoryId)
            put("source", "sms")
            put("model_version", "android-sms-v1")
            put("suggested_category", suggestedCategory.take(64))
            put("accepted", accepted)
        }
        return executeWrite(
            session = session,
            method = "POST",
            path = "/api/collections/fuloos_ml_examples/records",
            bodyJson = payload.toString(),
            queueOnNetworkFailure = true,
        )
    }

    /**
     * Flushes any queued offline writes in FIFO order under a process-wide lock so
     * concurrent workers never replay the same queued row twice.
     */
    fun flushOfflineQueue(): Int {
        val session = authStore.load() ?: return 0
        synchronized(queueLock) {
            return flushOfflineQueueLocked(session)
        }
    }

    private fun flushOfflineQueueLocked(session: SecureAuthStore.AuthSession): Int {
        var flushed = 0
        val items = db.getOfflineQueue(50)
        for (item in items) {
            if (item.retryCount >= MAX_RETRIES) {
                db.removeOfflineWrite(item.id)
                continue
            }
            val result = executeWrite(
                session = session,
                method = item.method,
                path = item.path,
                bodyJson = item.bodyJson,
                queueOnNetworkFailure = false,
            )
            when (result) {
                is ApiResult.Success -> {
                    db.removeOfflineWrite(item.id)
                    flushed++
                }
                is ApiResult.AuthExpired -> break
                is ApiResult.Failure -> {
                    if (result.status in 400..499 && result.status != 408 && result.status != 429) {
                        // Permanent validation or idempotency error; drop item
                        db.removeOfflineWrite(item.id)
                    } else {
                        db.incrementRetryCount(item.id)
                        break
                    }
                }
                is ApiResult.QueuedOffline -> break
            }
        }
        return flushed
    }

    private fun buildTransactionPayload(txJson: JSONObject, userId: String): JSONObject {
        val tags = txJson.optJSONArray("tags") ?: JSONArray()
        val splits = txJson.optJSONArray("splits") ?: JSONArray()
        return JSONObject().apply {
            put("user_id", userId)
            put("type", txJson.optNonNullString("type", "expense"))
            put("amount", txJson.optLong("amount", 0L))
            put("date", txJson.optNonNullString("date"))
            put("account_id", txJson.optNonNullString("account_id"))
            put("to_account_id", txJson.optNonNullString("to_account_id"))
            put("category_id", txJson.optNonNullString("category_id"))
            put("payee", txJson.optNonNullString("payee").take(120))
            put("notes", txJson.optNonNullString("notes").take(500))
            put("tags", tags)
            put("splits", splits)
            val origCurr = txJson.optNonNullString("original_currency")
            if (origCurr.isNotEmpty() && origCurr != "AED") {
                put("original_currency", origCurr)
                if (txJson.has("original_amount") && !txJson.isNull("original_amount")) {
                    put("original_amount", txJson.optLong("original_amount", 0L))
                }
                if (txJson.has("fx_rate") && !txJson.isNull("fx_rate")) {
                    put("fx_rate", txJson.optDouble("fx_rate", 1.0))
                }
            }
        }
    }

    private fun JSONObject.optNonNullString(key: String, fallback: String = ""): String {
        return if (isNull(key)) fallback else optString(key, fallback)
    }

    private fun executeWrite(
        session: SecureAuthStore.AuthSession,
        method: String,
        path: String,
        bodyJson: String,
        queueOnNetworkFailure: Boolean,
        queuedRecordId: String? = null,
    ): ApiResult<String> {
        val url = "${session.pbUrl}$path"
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${session.token}")
            .header("Accept", "application/json")

        val request = when (method.uppercase()) {
            "POST" -> builder.post(bodyJson.toRequestBody(JSON_MEDIA_TYPE)).build()
            "PATCH" -> builder.patch(bodyJson.toRequestBody(JSON_MEDIA_TYPE)).build()
            "DELETE" -> builder.delete().build()
            else -> builder.post(bodyJson.toRequestBody(JSON_MEDIA_TYPE)).build()
        }

        return try {
            client.newCall(request).execute().use { resp ->
                val rawBody = resp.body?.string().orEmpty()
                when {
                    resp.isSuccessful -> {
                        val id = try {
                            JSONObject(rawBody).optNonNullString("id")
                        } catch (_: Exception) {
                            ""
                        }
                        ApiResult.Success(id.ifBlank { queuedRecordId.orEmpty() })
                    }
                    resp.code == 401 || resp.code == 403 -> ApiResult.AuthExpired(resp.code)
                    (resp.code == 408 || resp.code == 429 || resp.code >= 500) && queueOnNetworkFailure -> {
                        val qId = db.enqueueOfflineWrite(method, path, bodyJson)
                        ApiResult.QueuedOffline(qId, queuedRecordId)
                    }
                    else -> {
                        Log.w(TAG, "PocketBase $method $path failed (${resp.code}): ${rawBody.take(200)}")
                        ApiResult.Failure(resp.code, rawBody.take(200))
                    }
                }
            }
        } catch (e: IOException) {
            if (queueOnNetworkFailure) {
                val qId = db.enqueueOfflineWrite(method, path, bodyJson)
                ApiResult.QueuedOffline(qId, queuedRecordId)
            } else {
                ApiResult.Failure(0, e.message ?: "Network error")
            }
        }
    }

    companion object {
        private const val TAG = "PocketBaseBgClient"
        private const val MAX_RETRIES = 8
        private const val PB_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val queueLock = Any()
        private val secureRandom = SecureRandom()

        fun generatePocketBaseId(): String {
            return buildString(15) {
                repeat(15) {
                    append(PB_ID_CHARS[secureRandom.nextInt(PB_ID_CHARS.length)])
                }
            }
        }
    }
}

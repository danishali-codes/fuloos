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
        data class QueuedOffline(val queueId: Long) : ApiResult<Nothing>()
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
        val payload = buildTransactionPayload(txJson, session.userId)
        val path = "/api/collections/fuloos_transactions/records"
        return executeWrite(
            session = session,
            method = "POST",
            path = path,
            bodyJson = payload.toString(),
            queueOnNetworkFailure = queueOnNetworkFailure,
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

    fun createCapturedAlert(
        draftJson: JSONObject,
        queueOnNetworkFailure: Boolean = true,
    ): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val payload = JSONObject(draftJson.toString()).apply {
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
        )
    }

    fun importCapturedAlertOrCreateTransaction(
        alertId: String?,
        txJson: JSONObject,
    ): ApiResult<String> {
        val session = authStore.load() ?: return ApiResult.AuthExpired(401)
        val txPayload = buildTransactionPayload(txJson, session.userId)

        if (!alertId.isNullOrBlank()) {
            val encoded = URLEncoder.encode(alertId, "UTF-8")
            val atomicBody = JSONObject().put("transaction", txPayload).toString()
            val atomicResult = executeWrite(
                session = session,
                method = "POST",
                path = "/api/fuloos/captured-alerts/$encoded/import",
                bodyJson = atomicBody,
                queueOnNetworkFailure = false,
            )
            if (atomicResult is ApiResult.Success || atomicResult is ApiResult.AuthExpired) {
                return atomicResult
            }
        }

        val created = createTransaction(txJson, queueOnNetworkFailure = true)
        if (created is ApiResult.Success && !alertId.isNullOrBlank()) {
            markAlertStatus(alertId, "imported")
        }
        return created
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
     * Flushes any queued offline writes in FIFO order. Stops immediately if
     * connectivity is still down or auth has expired.
     */
    fun flushOfflineQueue(): Int {
        val session = authStore.load() ?: return 0
        val items = db.getOfflineQueue(50)
        var flushed = 0
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
                        // Permanent validation error (e.g. deleted account); drop item
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
            put("type", txJson.optString("type", "expense"))
            put("amount", txJson.optLong("amount", 0L))
            put("date", txJson.optString("date", ""))
            put("account_id", txJson.optString("account_id", ""))
            put("to_account_id", txJson.optString("to_account_id", ""))
            put("category_id", if (txJson.isNull("category_id")) "" else txJson.optString("category_id", ""))
            put("payee", txJson.optString("payee", "").take(120))
            put("notes", txJson.optString("notes", "").take(500))
            put("tags", tags)
            put("splits", splits)
            val origCurr = txJson.optString("original_currency", "")
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

    private fun executeWrite(
        session: SecureAuthStore.AuthSession,
        method: String,
        path: String,
        bodyJson: String,
        queueOnNetworkFailure: Boolean,
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
                            JSONObject(rawBody).optString("id", "")
                        } catch (_: Exception) {
                            ""
                        }
                        ApiResult.Success(id)
                    }
                    resp.code == 401 || resp.code == 403 -> ApiResult.AuthExpired(resp.code)
                    resp.code >= 500 && queueOnNetworkFailure -> {
                        val qId = db.enqueueOfflineWrite(method, path, bodyJson)
                        ApiResult.QueuedOffline(qId)
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
                ApiResult.QueuedOffline(qId)
            } else {
                ApiResult.Failure(0, e.message ?: "Network error")
            }
        }
    }

    companion object {
        private const val TAG = "PocketBaseBgClient"
        private const val MAX_RETRIES = 8
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}

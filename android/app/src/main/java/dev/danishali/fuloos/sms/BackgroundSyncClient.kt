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
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Background HTTP client for native SMS capture, authenticated via SecureAuthStore.
 *
 * Talks to whichever backend the app is signed in to:
 *  - PocketBase: the same REST collections and routes as src/backend.ts.
 *  - Supabase: PostgREST tables and RPCs as src/supabaseBackend.ts, refreshing the
 *    session shared with supabase-js when it is about to expire.
 *
 * Transient network failures are queued in FuloosLocalDb.offline_queue for WorkManager
 * retry. Queued rows store a backend-relative path and are scoped by owner key
 * (backend URL + user id), so they only replay against the backend that created them.
 */
class BackgroundSyncClient(
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

    data class FxRateResponse(
        val from: String,
        val to: String,
        val rate: Double,
        val rateDate: String,
        val provider: String,
    )

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    fun createTransaction(
        txJson: JSONObject,
        queueOnNetworkFailure: Boolean = true,
    ): ApiResult<String> {
        val session = activeSession() ?: return ApiResult.AuthExpired(401)
        val recordId = newRecordId(session)
        val payload = buildTransactionPayload(txJson, session).apply {
            put("id", recordId)
        }
        val path = tablePath(session, "fuloos_transactions")
        return executeWrite(
            session = session,
            method = "POST",
            path = path,
            bodyJson = payload.toString(),
            queueOnNetworkFailure = queueOnNetworkFailure,
            queuedRecordId = recordId,
        )
    }

    /**
     * Patches a transaction (for example confirming the actual account-charged amount
     * from an Android notification reply). Serialized with the offline queue so a PATCH
     * never overtakes an earlier queued POST for the same transaction id.
     */
    fun patchTransaction(
        transactionId: String,
        patchJson: JSONObject,
        queueOnNetworkFailure: Boolean = true,
    ): ApiResult<String> {
        if (transactionId.isBlank()) {
            return ApiResult.Failure(400, "Missing transaction id")
        }
        synchronized(queueLock) {
            val session = activeSession() ?: return ApiResult.AuthExpired(401)
            flushOfflineQueueLocked(session)
            val path = recordPath(session, "fuloos_transactions", transactionId)
            val body = patchJson.toString()
            if (queueOnNetworkFailure && db.getOfflineQueue(session.ownerKey, 1).isNotEmpty()) {
                val qId = db.enqueueOfflineWrite(session.ownerKey, "PATCH", path, body)
                return ApiResult.QueuedOffline(qId, transactionId)
            }
            return executeWrite(
                session = session,
                method = "PATCH",
                path = path,
                bodyJson = body,
                queueOnNetworkFailure = queueOnNetworkFailure,
                queuedRecordId = transactionId,
            )
        }
    }

    /**
     * Resolves an approximate historical exchange rate for (from, to, date).
     * Privacy: transmits ONLY `from`, `to`, and `date` — never SMS text, merchant,
     * amount, account, or user metadata.
     */
    fun fetchFxRate(from: String, to: String, date: String): FxRateResponse? {
        val fromCode = from.trim().uppercase()
        val toCode = to.trim().uppercase()
        val cleanDate = date.trim()
        if (fromCode.length != 3 || toCode.length != 3 || cleanDate.length != 10) return null
        if (fromCode == toCode) {
            return FxRateResponse(fromCode, toCode, 1.0, cleanDate, "identity")
        }

        db.getFxRate(fromCode, toCode, cleanDate)?.let { cached ->
            return FxRateResponse(cached.base, cached.quote, cached.rate, cached.rateDate, cached.provider)
        }

        // 1. Primary: Supabase fx-rate Edge Function (shared public cache)
        val session = activeSession()
        if (session != null && session.isSupabase) {
            val edge = fetchFromSupabaseEdge(session, fromCode, toCode, cleanDate)
            if (edge != null) {
                db.putFxRate(fromCode, toCode, edge.rateDate, edge.rate, edge.provider)
                return edge
            }
        }

        // 2. Fallback: direct public fawazahmed0 currency API (jsDelivr CDN + pages.dev)
        val direct = fetchFromFawazPublic(fromCode, toCode, cleanDate)
        if (direct != null) {
            db.putFxRate(fromCode, toCode, direct.rateDate, direct.rate, direct.provider)
            return direct
        }

        // 3. Offline fallback: latest cached rate on or before date (stays estimated)
        db.getLatestFxRate(fromCode, toCode, cleanDate)?.let { latest ->
            return FxRateResponse(latest.base, latest.quote, latest.rate, latest.rateDate, latest.provider)
        }
        return null
    }

    private fun fetchFromSupabaseEdge(
        session: SecureAuthStore.AuthSession,
        fromCode: String,
        toCode: String,
        cleanDate: String,
    ): FxRateResponse? {
        val body = JSONObject()
            .put("from", fromCode)
            .put("to", toCode)
            .put("date", cleanDate)
            .toString()
        val request = Request.Builder()
            .url("${session.baseUrl}/functions/v1/fx-rate")
            .header("Authorization", "Bearer ${session.token}")
            .header("apikey", session.anonKey)
            .header("Accept", "application/json")
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        return try {
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val raw = resp.body?.string().orEmpty()
                val obj = JSONObject(raw)
                val rate = obj.optDouble("rate", Double.NaN)
                if (!rate.isFinite() || rate <= 0.0) return null
                val rateDate = obj.optNonNullString("rate_date", cleanDate).ifBlank { cleanDate }
                val provider = obj.optNonNullString("provider", "fx-rate").ifBlank { "fx-rate" }
                FxRateResponse(fromCode, toCode, rate, rateDate, provider)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun fetchFromFawazPublic(
        fromCode: String,
        toCode: String,
        cleanDate: String,
    ): FxRateResponse? {
        val baseLower = fromCode.lowercase()
        val quoteLower = toCode.lowercase()
        val urls = listOf(
            "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@$cleanDate/v1/currencies/$baseLower.json",
            "https://$cleanDate.currency-api.pages.dev/v1/currencies/$baseLower.json",
            "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/$baseLower.json",
        )
        for (url in urls) {
            try {
                val request = Request.Builder()
                    .url(url)
                    .header("Accept", "application/json")
                    .get()
                    .build()
                client.newCall(request).execute().use { resp ->
                    if (!resp.isSuccessful) return@use
                    val raw = resp.body?.string().orEmpty()
                    val obj = JSONObject(raw)
                    val ratesObj = obj.optJSONObject(baseLower) ?: return@use
                    val rate = ratesObj.optDouble(quoteLower, Double.NaN)
                    if (rate.isFinite() && rate > 0.0) {
                        val rateDate = obj.optNonNullString("date", cleanDate).ifBlank { cleanDate }
                        return FxRateResponse(fromCode, toCode, rate, rateDate, "fawazahmed0")
                    }
                }
            } catch (_: Exception) {
                // Try next host
            }
        }
        return null
    }

    fun deleteTransaction(
        transactionId: String,
        queueOnNetworkFailure: Boolean = true,
    ): ApiResult<String> {
        val session = activeSession() ?: return ApiResult.AuthExpired(401)
        val path = recordPath(session, "fuloos_transactions", transactionId)
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
     * the transaction on the server if it was already created (online or via queue replay).
     */
    fun cancelOrDeleteTransaction(
        transactionId: String,
        queuedWriteId: Long = -1L,
    ): ApiResult<String> {
        synchronized(queueLock) {
            val session = activeSession() ?: return ApiResult.AuthExpired(401)
            if (queuedWriteId > 0L && db.removeOfflineWrite(queuedWriteId, session.ownerKey)) {
                return ApiResult.Success(transactionId)
            }
            if (transactionId.isBlank()) {
                return ApiResult.Failure(400, "Missing transaction id")
            }
            flushOfflineQueueLocked(session)
            val path = recordPath(session, "fuloos_transactions", transactionId)
            if (db.getOfflineQueue(session.ownerKey, 1).isNotEmpty()) {
                val qId = db.enqueueOfflineWrite(session.ownerKey, "DELETE", path, "")
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
        val session = activeSession() ?: return ApiResult.AuthExpired(401)
        val recordId = newRecordId(session)
        val payload = JSONObject(draftJson.toString()).apply {
            put("id", recordId)
            put("user_id", session.userId)
            put("source", "sms_native")
            if (session.isSupabase) {
                nullIfBlank(this, ALERT_NULLABLE_FIELDS)
            } else {
                if (isNull("account_id")) put("account_id", "")
                if (isNull("suggested_category_id")) put("suggested_category_id", "")
            }
        }
        val path = tablePath(session, "fuloos_captured_alerts")
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
        val session = activeSession() ?: return ApiResult.AuthExpired(401)
        val txPayload = buildTransactionPayload(txJson, session)

        if (!alertId.isNullOrBlank()) {
            // Serialize with queue draining so any queued alert creation runs before its import,
            // and retain the atomic endpoint's pending-status & idempotency guard.
            synchronized(queueLock) {
                flushOfflineQueueLocked(session)
                val path: String
                val atomicBody: String
                if (session.isSupabase) {
                    // Same RPC as SupabaseBackend.importCapturedAlert; the server sets user_id.
                    txPayload.remove("user_id")
                    path = "/rest/v1/rpc/fuloos_import_captured_alert"
                    atomicBody = JSONObject()
                        .put("alert_id", alertId)
                        .put("transaction", txPayload)
                        .toString()
                } else {
                    val encoded = URLEncoder.encode(alertId, "UTF-8")
                    path = "/api/fuloos/captured-alerts/$encoded/import"
                    atomicBody = JSONObject().put("transaction", txPayload).toString()
                }
                if (db.getOfflineQueue(session.ownerKey, 1).isNotEmpty()) {
                    val qId = db.enqueueOfflineWrite(session.ownerKey, "POST", path, atomicBody)
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
        val session = activeSession() ?: return ApiResult.AuthExpired(401)
        val path = recordPath(session, "fuloos_captured_alerts", alertId)
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
        val session = activeSession() ?: return ApiResult.AuthExpired(401)
        val payload = JSONObject().apply {
            put("user_id", session.userId)
            put("merchant_text", merchantText.take(160))
            put("payee", payee.take(120))
            put("amount", amountFils)
            put("category_id", if (session.isSupabase && categoryId.isBlank()) JSONObject.NULL else categoryId)
            put("source", "sms")
            put("model_version", "android-sms-v1")
            put("suggested_category", suggestedCategory.take(64))
            put("accepted", accepted)
        }
        return executeWrite(
            session = session,
            method = "POST",
            path = tablePath(session, "fuloos_ml_examples"),
            bodyJson = payload.toString(),
            queueOnNetworkFailure = true,
        )
    }

    /**
     * Flushes any queued offline writes in FIFO order under a process-wide lock so
     * concurrent workers never replay the same queued row twice.
     */
    fun flushOfflineQueue(): Int {
        val session = activeSession() ?: return 0
        synchronized(queueLock) {
            return flushOfflineQueueLocked(session)
        }
    }

    private fun flushOfflineQueueLocked(session: SecureAuthStore.AuthSession): Int {
        var flushed = 0
        val items = db.getOfflineQueue(session.ownerKey, 50)
        for (item in items) {
            val result = executeWrite(
                session = session,
                method = item.method,
                path = item.path,
                bodyJson = item.bodyJson,
                queueOnNetworkFailure = false,
            )
            when (result) {
                is ApiResult.Success -> {
                    db.removeOfflineWrite(item.id, session.ownerKey)
                    flushed++
                }
                is ApiResult.AuthExpired -> break
                is ApiResult.Failure -> {
                    if (result.status in 400..499 && result.status != 408 && result.status != 429) {
                        // Permanent validation or idempotency error; drop item
                        db.removeOfflineWrite(item.id, session.ownerKey)
                    } else {
                        // Retain queued financial writes durably across transient outages
                        db.incrementRetryCount(item.id)
                        if (item.retryCount >= 8) {
                            Log.w(TAG, "Queued write ${item.id} (${item.method} ${item.path}) still retrying after ${item.retryCount + 1} attempts")
                        }
                        break
                    }
                }
                is ApiResult.QueuedOffline -> break
            }
        }
        return flushed
    }

    private fun buildTransactionPayload(
        txJson: JSONObject,
        session: SecureAuthStore.AuthSession,
    ): JSONObject {
        val tags = txJson.optJSONArray("tags") ?: JSONArray()
        val splits = txJson.optJSONArray("splits") ?: JSONArray()
        return JSONObject().apply {
            put("user_id", session.userId)
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
            val origCurr = txJson.optNonNullString("original_currency").uppercase()
            if (origCurr.isNotEmpty()) {
                put("original_currency", origCurr)
            }
            if (txJson.has("original_amount") && !txJson.isNull("original_amount")) {
                put("original_amount", txJson.optLong("original_amount", txJson.optLong("amount", 0L)))
            }
            if (txJson.has("to_amount") && !txJson.isNull("to_amount")) {
                put("to_amount", txJson.optLong("to_amount", 0L))
            }
            if (txJson.has("fx_rate") && !txJson.isNull("fx_rate")) {
                val r = txJson.optDouble("fx_rate", Double.NaN)
                if (r.isFinite() && r > 0.0) {
                    put("fx_rate", r)
                }
            }
            val fxRateDate = txJson.optNonNullString("fx_rate_date")
            if (fxRateDate.isNotEmpty()) {
                put("fx_rate_date", fxRateDate)
            }
            val fxSource = txJson.optNonNullString("fx_source")
            if (fxSource.isNotEmpty()) {
                put("fx_source", fxSource)
            }
            val fxStatus = txJson.optNonNullString("fx_status")
            if (fxStatus.isNotEmpty()) {
                put("fx_status", fxStatus)
            }
            // Postgres foreign keys need NULL, not "", for "no account / category".
            if (session.isSupabase) nullIfBlank(this, TX_NULLABLE_FIELDS)
        }
    }

    private fun nullIfBlank(obj: JSONObject, keys: Array<String>) {
        for (key in keys) {
            if (obj.has(key) && (obj.isNull(key) || obj.optString(key, "").isBlank())) {
                obj.put(key, JSONObject.NULL)
            }
        }
    }

    private fun newRecordId(session: SecureAuthStore.AuthSession): String =
        if (session.isSupabase) UUID.randomUUID().toString() else generatePocketBaseId()

    private fun tablePath(session: SecureAuthStore.AuthSession, table: String): String =
        if (session.isSupabase) "/rest/v1/$table" else "/api/collections/$table/records"

    private fun recordPath(session: SecureAuthStore.AuthSession, table: String, id: String): String {
        val encoded = URLEncoder.encode(id, "UTF-8")
        return if (session.isSupabase) "/rest/v1/$table?id=eq.$encoded"
        else "/api/collections/$table/records/$encoded"
    }

    /**
     * Loads the stored session and, for Supabase, refreshes it when the access token
     * expires within [REFRESH_MARGIN_SECONDS]. The margin is shorter than supabase-js's
     * own (90s), so while the app is open the WebView refreshes first and the worker
     * just reads the rotated tokens from the shared store.
     */
    private fun activeSession(forceRefresh: Boolean = false): SecureAuthStore.AuthSession? {
        val session = authStore.load() ?: return null
        if (!session.isSupabase) return session
        val nowSeconds = System.currentTimeMillis() / 1000
        val needsRefresh = forceRefresh ||
            (session.expiresAt > 0 && session.expiresAt - nowSeconds < REFRESH_MARGIN_SECONDS)
        if (!needsRefresh) return session
        synchronized(refreshLock) {
            // Another worker (or the WebView) may have rotated the tokens meanwhile.
            val latest = authStore.load() ?: return null
            if (!latest.isSupabase) return latest
            if (latest.refreshToken != session.refreshToken &&
                latest.expiresAt - System.currentTimeMillis() / 1000 >= REFRESH_MARGIN_SECONDS
            ) {
                return latest
            }
            return refreshSupabaseSession(latest)
        }
    }

    private fun refreshSupabaseSession(session: SecureAuthStore.AuthSession): SecureAuthStore.AuthSession? {
        val body = JSONObject().put("refresh_token", session.refreshToken).toString()
        val request = Request.Builder()
            .url("${session.baseUrl}/auth/v1/token?grant_type=refresh_token")
            .header("apikey", session.anonKey)
            .header("Accept", "application/json")
            .post(body.toRequestBody(JSON_MEDIA_TYPE))
            .build()
        return try {
            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                when {
                    resp.isSuccessful -> {
                        val next = JSONObject(raw)
                        if (!next.has("expires_at") && next.has("expires_in")) {
                            next.put("expires_at", System.currentTimeMillis() / 1000 + next.optLong("expires_in", 3600L))
                        }
                        val nextUser = next.optJSONObject("user")?.optString("id", "").orEmpty()
                        if (nextUser.isNotEmpty() && nextUser != session.userId) return null
                        authStore.setItem(session.storageKey, next.toString())
                        authStore.load()
                    }
                    resp.code in 400..499 -> {
                        // Refresh token revoked or already used: the user must sign in again.
                        Log.w(TAG, "Supabase session refresh rejected (${resp.code})")
                        null
                    }
                    // Server trouble: keep the current token; the write will queue offline.
                    else -> session
                }
            }
        } catch (_: IOException) {
            session
        } catch (_: org.json.JSONException) {
            session
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
        retriedAuth: Boolean = false,
    ): ApiResult<String> {
        val url = "${session.baseUrl}$path"
        val builder = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer ${session.token}")
            .header("Accept", "application/json")
        if (session.isSupabase) {
            builder.header("apikey", session.anonKey)
            if (!path.startsWith("/rest/v1/rpc/")) {
                // Table writes use client-generated ids, so no representation is needed.
                builder.header("Prefer", "return=minimal")
            }
        }

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
                    // A replayed Supabase insert whose client-generated id already exists was
                    // saved by an earlier attempt that lost its response.
                    session.isSupabase && resp.code == 409 && method.uppercase() == "POST" &&
                        !path.startsWith("/rest/v1/rpc/") -> {
                        ApiResult.Success(queuedRecordId.orEmpty())
                    }
                    resp.code == 401 && session.isSupabase && !retriedAuth -> {
                        val refreshed = activeSession(forceRefresh = true)
                        if (refreshed == null) {
                            ApiResult.AuthExpired(resp.code)
                        } else {
                            executeWrite(
                                session = refreshed,
                                method = method,
                                path = path,
                                bodyJson = bodyJson,
                                queueOnNetworkFailure = queueOnNetworkFailure,
                                queuedRecordId = queuedRecordId,
                                retriedAuth = true,
                            )
                        }
                    }
                    // On Supabase a 403 is a row-level-security refusal, not an expired sign-in,
                    // so it falls through to Failure and is not retried forever.
                    resp.code == 401 || (resp.code == 403 && !session.isSupabase) ->
                        ApiResult.AuthExpired(resp.code)
                    (resp.code == 408 || resp.code == 429 || resp.code >= 500) && queueOnNetworkFailure -> {
                        val qId = db.enqueueOfflineWrite(session.ownerKey, method, path, bodyJson)
                        ApiResult.QueuedOffline(qId, queuedRecordId)
                    }
                    else -> {
                        Log.w(TAG, "${session.kind} $method $path failed (${resp.code}): ${rawBody.take(200)}")
                        ApiResult.Failure(resp.code, rawBody.take(200))
                    }
                }
            }
        } catch (e: IOException) {
            if (queueOnNetworkFailure) {
                val qId = db.enqueueOfflineWrite(session.ownerKey, method, path, bodyJson)
                ApiResult.QueuedOffline(qId, queuedRecordId)
            } else {
                ApiResult.Failure(0, e.message ?: "Network error")
            }
        }
    }

    companion object {
        private const val TAG = "FuloosBgClient"
        private const val REFRESH_MARGIN_SECONDS = 45L
        private val TX_NULLABLE_FIELDS = arrayOf(
            "account_id",
            "to_account_id",
            "category_id",
            "original_currency",
            "fx_rate_date",
            "fx_source",
            "fx_status",
        )
        private val ALERT_NULLABLE_FIELDS = arrayOf("account_id", "suggested_category_id", "parsed_date", "sms_sender", "card_last4")
        private const val PB_ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789"
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        private val queueLock = Any()
        private val refreshLock = Any()
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

package dev.danishali.fuloos.sms

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject

/**
 * Lightweight on-device SQLite persistence for native SMS automation.
 *
 * Stores ONLY:
 * - Linked sender/card configurations (`sms_links`)
 * - SHA-256 deduplication hashes (`processed_sms`) — never raw SMS text
 * - Offline PocketBase write queue (`offline_queue`)
 * - Serialized rules/categories/ML context (`engine_cache`) for background headless evaluation
 */
class FuloosLocalDb private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    data class ProcessedEntry(
        val smsHash: String,
        val androidSmsId: String?,
        val accountId: String?,
        val transactionId: String?,
        val status: String,
    )

    data class QueuedWrite(
        val id: Long,
        val method: String,
        val path: String,
        val bodyJson: String,
        val createdAt: Long,
        val retryCount: Int,
    )

    data class FxRateEntry(
        val base: String,
        val quote: String,
        val rateDate: String,
        val rate: Double,
        val provider: String,
        val fetchedAt: Long,
    )

    data class UnparsedSmsEntry(
        val id: Long,
        val sender: String,
        val receivedAt: String,
        val smsHash: String,
        val body: String,
        val createdAt: Long,
        val dismissed: Boolean,
    )

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS engine_cache (
                cache_key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS processed_sms (
                owner_key TEXT NOT NULL,
                sms_hash TEXT NOT NULL,
                android_sms_id TEXT,
                account_id TEXT,
                transaction_id TEXT,
                status TEXT NOT NULL,
                processed_at INTEGER NOT NULL,
                PRIMARY KEY (owner_key, sms_hash)
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX IF NOT EXISTS idx_processed_sms_owner_status
            ON processed_sms (owner_key, status, processed_at)
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS offline_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_key TEXT NOT NULL,
                method TEXT NOT NULL,
                path TEXT NOT NULL,
                body_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                retry_count INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX IF NOT EXISTS idx_offline_queue_owner
            ON offline_queue (owner_key, id)
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS fx_rates (
                base TEXT NOT NULL,
                quote TEXT NOT NULL,
                rate_date TEXT NOT NULL,
                rate REAL NOT NULL,
                provider TEXT NOT NULL,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY (base, quote, rate_date)
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX IF NOT EXISTS idx_fx_rates_pair_date
            ON fx_rates (base, quote, rate_date DESC)
            """.trimIndent(),
        )
        // Local-only "Couldn't read" SMS list. Never synced to Supabase or any remote server.
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS unparsed_sms (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                owner_key TEXT NOT NULL,
                sender TEXT NOT NULL,
                received_at TEXT NOT NULL,
                sms_hash TEXT NOT NULL,
                body TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                dismissed INTEGER NOT NULL DEFAULT 0,
                UNIQUE (owner_key, sms_hash)
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX IF NOT EXISTS idx_unparsed_sms_owner_active
            ON unparsed_sms (owner_key, dismissed, created_at DESC)
            """.trimIndent(),
        )
        // Local-only learned SMS formats (wording-only skeletons with typed slots, zero PII).
        // Never synced to Supabase or any remote server.
        db.execSQL(
            """
            CREATE TABLE IF NOT EXISTS learned_templates (
                id TEXT NOT NULL,
                owner_key TEXT NOT NULL,
                template_version INTEGER NOT NULL DEFAULT 1,
                sender_norm TEXT NOT NULL,
                skeleton_hash TEXT NOT NULL,
                pattern_json TEXT NOT NULL,
                field_map_json TEXT NOT NULL,
                direction TEXT NOT NULL,
                txn_type TEXT NOT NULL,
                bank_id TEXT,
                created_at TEXT NOT NULL,
                hits INTEGER NOT NULL DEFAULT 0,
                last_hit_at TEXT,
                PRIMARY KEY (owner_key, id)
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            CREATE INDEX IF NOT EXISTS idx_learned_templates_owner_sender
            ON learned_templates (owner_key, sender_norm, hits DESC)
            """.trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            // Recreate local-only cache/dedupe/queue tables with owner_key partitioning
            // so unscoped v1 rows cannot leak across authenticated users/servers.
            db.execSQL("DROP TABLE IF EXISTS processed_sms")
            db.execSQL("DROP TABLE IF EXISTS offline_queue")
            db.execSQL("DELETE FROM engine_cache")
        }
        // v2 -> v3 adds fx_rates; v3 -> v4 adds unparsed_sms; v4 -> v5 adds learned_templates
        // non-destructively via CREATE TABLE IF NOT EXISTS.
        onCreate(db)
    }

    @Synchronized
    fun getActiveOwnerKey(): String {
        return getCache(KEY_ACTIVE_OWNER)?.trim().orEmpty()
    }

    @Synchronized
    fun setActiveOwnerKey(ownerKey: String) {
        val clean = ownerKey.trim()
        if (clean.isEmpty()) {
            clearActiveOwnerKey()
        } else {
            putCache(KEY_ACTIVE_OWNER, clean)
        }
    }

    @Synchronized
    fun clearActiveOwnerKey() {
        writableDatabase.delete("engine_cache", "cache_key = ?", arrayOf(KEY_ACTIVE_OWNER))
    }

    @Synchronized
    fun getLinksJson(ownerKey: String = getActiveOwnerKey()): String {
        if (ownerKey.isBlank()) return "[]"
        return getCache(scopedKey(ownerKey, KEY_SMS_LINKS)) ?: "[]"
    }

    @Synchronized
    fun saveLinksJson(linksJson: String, ownerKey: String = getActiveOwnerKey()) {
        if (ownerKey.isBlank()) return
        putCache(scopedKey(ownerKey, KEY_SMS_LINKS), linksJson)
    }

    @Synchronized
    fun getEngineContextJson(ownerKey: String = getActiveOwnerKey()): String? {
        if (ownerKey.isBlank()) return null
        return getCache(scopedKey(ownerKey, KEY_ENGINE_CONTEXT))
    }

    @Synchronized
    fun saveEngineContextJson(contextJson: String, ownerKey: String = getActiveOwnerKey()) {
        if (ownerKey.isBlank()) return
        putCache(scopedKey(ownerKey, KEY_ENGINE_CONTEXT), contextJson)
    }

    @Synchronized
    fun getLinksArray(ownerKey: String = getActiveOwnerKey()): JSONArray {
        return try {
            JSONArray(getLinksJson(ownerKey))
        } catch (_: Exception) {
            JSONArray()
        }
    }

    /**
     * Fast-path filter called inside SmsBroadcastReceiver (<5ms) to decide whether
     * an incoming SMS sender matches any enabled account link before waking WorkManager.
     */
    @Synchronized
    fun hasEnabledLinkForSender(rawSender: String, ownerKey: String = getActiveOwnerKey()): Boolean {
        if (ownerKey.isBlank()) return false
        val norm = normalizeSender(rawSender)
        if (norm.isEmpty()) return false
        val links = getLinksArray(ownerKey)
        for (i in 0 until links.length()) {
            val link = links.optJSONObject(i) ?: continue
            if (!link.optBoolean("enabled", true)) continue
            val senders = link.optJSONArray("senders") ?: continue
            for (j in 0 until senders.length()) {
                if (normalizeSender(senders.optString(j, "")) == norm) {
                    return true
                }
            }
        }
        return false
    }

    /**
     * Returns all normalized sender IDs across enabled links plus the earliest
     * watermark timestamp so catch-up scans only inspect recent messages.
     */
    @Synchronized
    fun getEnabledSendersAndWatermark(ownerKey: String = getActiveOwnerKey()): Pair<List<String>, Long> {
        if (ownerKey.isBlank()) return emptyList<String>() to 0L
        val links = getLinksArray(ownerKey)
        val senders = linkedSetOf<String>()
        var minWatermark = Long.MAX_VALUE
        var hasWatermark = false

        for (i in 0 until links.length()) {
            val link = links.optJSONObject(i) ?: continue
            if (!link.optBoolean("enabled", true)) continue
            val arr = link.optJSONArray("senders") ?: continue
            for (j in 0 until arr.length()) {
                val s = normalizeSender(arr.optString(j, ""))
                if (s.isNotEmpty()) senders.add(s)
            }
            val wm = link.optLong("last_synced_at", 0L)
            if (wm > 0L) {
                hasWatermark = true
                if (wm < minWatermark) minWatermark = wm
            }
        }
        val since = if (hasWatermark) minWatermark else (System.currentTimeMillis() - DEFAULT_CATCHUP_WINDOW_MS)
        return senders.toList() to since.coerceAtLeast(0L)
    }

    @Synchronized
    fun updateLinkWatermark(linkId: String, timestampMs: Long, ownerKey: String = getActiveOwnerKey()) {
        if (ownerKey.isBlank() || linkId.isEmpty() || timestampMs <= 0L) return
        val links = getLinksArray(ownerKey)
        var changed = false
        for (i in 0 until links.length()) {
            val link = links.optJSONObject(i) ?: continue
            if (link.optString("id") == linkId) {
                val prev = link.optLong("last_synced_at", 0L)
                if (timestampMs > prev) {
                    link.put("last_synced_at", timestampMs)
                    changed = true
                }
            }
        }
        if (changed) {
            saveLinksJson(links.toString(), ownerKey)
        }
    }

    @Synchronized
    fun isProcessed(smsHash: String, ownerKey: String = getActiveOwnerKey()): Boolean {
        if (ownerKey.isBlank() || smsHash.isEmpty()) return false
        readableDatabase.rawQuery(
            "SELECT 1 FROM processed_sms WHERE owner_key = ? AND sms_hash = ? LIMIT 1",
            arrayOf(ownerKey, smsHash),
        ).use { cursor ->
            return cursor.moveToFirst()
        }
    }

    @Synchronized
    fun markProcessed(entries: List<ProcessedEntry>, ownerKey: String = getActiveOwnerKey()) {
        if (ownerKey.isBlank() || entries.isEmpty()) return
        val now = System.currentTimeMillis()
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (entry in entries) {
                if (entry.smsHash.isBlank()) continue
                val cv = ContentValues().apply {
                    put("owner_key", ownerKey)
                    put("sms_hash", entry.smsHash)
                    put("android_sms_id", entry.androidSmsId)
                    put("account_id", entry.accountId)
                    put("transaction_id", entry.transactionId)
                    put("status", entry.status)
                    put("processed_at", now)
                }
                db.insertWithOnConflict("processed_sms", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    @Synchronized
    fun updateProcessedStatusByTransaction(
        transactionId: String,
        status: String,
        ownerKey: String = getActiveOwnerKey(),
    ) {
        if (ownerKey.isBlank() || transactionId.isBlank()) return
        val cv = ContentValues().apply {
            put("status", status)
            put("processed_at", System.currentTimeMillis())
        }
        writableDatabase.update(
            "processed_sms",
            cv,
            "owner_key = ? AND transaction_id = ?",
            arrayOf(ownerKey, transactionId),
        )
    }

    @Synchronized
    fun updateProcessedStatusByHash(
        smsHash: String,
        status: String,
        ownerKey: String = getActiveOwnerKey(),
    ) {
        if (ownerKey.isBlank() || smsHash.isBlank()) return
        val cv = ContentValues().apply {
            put("status", status)
            put("processed_at", System.currentTimeMillis())
        }
        writableDatabase.update(
            "processed_sms",
            cv,
            "owner_key = ? AND sms_hash = ?",
            arrayOf(ownerKey, smsHash),
        )
    }

    @Synchronized
    fun enqueueOfflineWrite(
        ownerKey: String,
        method: String,
        path: String,
        bodyJson: String,
    ): Long {
        if (ownerKey.isBlank()) return -1L
        val cv = ContentValues().apply {
            put("owner_key", ownerKey)
            put("method", method)
            put("path", path)
            put("body_json", bodyJson)
            put("created_at", System.currentTimeMillis())
            put("retry_count", 0)
        }
        return writableDatabase.insert("offline_queue", null, cv)
    }

    @Synchronized
    fun getOfflineQueue(ownerKey: String, limit: Int = 50): List<QueuedWrite> {
        if (ownerKey.isBlank()) return emptyList()
        val result = mutableListOf<QueuedWrite>()
        readableDatabase.rawQuery(
            """
            SELECT id, method, path, body_json, created_at, retry_count
            FROM offline_queue
            WHERE owner_key = ?
            ORDER BY id ASC
            LIMIT ?
            """.trimIndent(),
            arrayOf(ownerKey, limit.toString()),
        ).use { c ->
            while (c.moveToNext()) {
                result.add(
                    QueuedWrite(
                        id = c.getLong(0),
                        method = c.getString(1),
                        path = c.getString(2),
                        bodyJson = c.getString(3),
                        createdAt = c.getLong(4),
                        retryCount = c.getInt(5),
                    ),
                )
            }
        }
        return result
    }

    @Synchronized
    fun removeOfflineWrite(id: Long, ownerKey: String? = null): Boolean {
        return if (!ownerKey.isNullOrBlank()) {
            writableDatabase.delete(
                "offline_queue",
                "id = ? AND owner_key = ?",
                arrayOf(id.toString(), ownerKey),
            ) > 0
        } else {
            writableDatabase.delete("offline_queue", "id = ?", arrayOf(id.toString())) > 0
        }
    }

    @Synchronized
    fun incrementRetryCount(id: Long) {
        writableDatabase.execSQL(
            "UPDATE offline_queue SET retry_count = retry_count + 1 WHERE id = ?",
            arrayOf(id),
        )
    }

    @Synchronized
    fun getFxRate(base: String, quote: String, rateDate: String): FxRateEntry? {
        val b = base.trim().uppercase()
        val q = quote.trim().uppercase()
        val d = rateDate.trim()
        if (b.length != 3 || q.length != 3 || d.length != 10) return null
        readableDatabase.rawQuery(
            """
            SELECT base, quote, rate_date, rate, provider, fetched_at
            FROM fx_rates
            WHERE base = ? AND quote = ? AND rate_date = ?
            LIMIT 1
            """.trimIndent(),
            arrayOf(b, q, d),
        ).use { c ->
            return if (c.moveToFirst()) {
                FxRateEntry(
                    base = c.getString(0),
                    quote = c.getString(1),
                    rateDate = c.getString(2),
                    rate = c.getDouble(3),
                    provider = c.getString(4),
                    fetchedAt = c.getLong(5),
                )
            } else {
                null
            }
        }
    }

    @Synchronized
    fun getLatestFxRate(
        base: String,
        quote: String,
        onOrBeforeDate: String? = null,
    ): FxRateEntry? {
        val b = base.trim().uppercase()
        val q = quote.trim().uppercase()
        if (b.length != 3 || q.length != 3) return null
        val cursor = if (!onOrBeforeDate.isNullOrBlank()) {
            readableDatabase.rawQuery(
                """
                SELECT base, quote, rate_date, rate, provider, fetched_at
                FROM fx_rates
                WHERE base = ? AND quote = ? AND rate_date <= ?
                ORDER BY rate_date DESC
                LIMIT 1
                """.trimIndent(),
                arrayOf(b, q, onOrBeforeDate.trim()),
            )
        } else {
            readableDatabase.rawQuery(
                """
                SELECT base, quote, rate_date, rate, provider, fetched_at
                FROM fx_rates
                WHERE base = ? AND quote = ?
                ORDER BY rate_date DESC
                LIMIT 1
                """.trimIndent(),
                arrayOf(b, q),
            )
        }
        cursor.use { c ->
            return if (c.moveToFirst()) {
                FxRateEntry(
                    base = c.getString(0),
                    quote = c.getString(1),
                    rateDate = c.getString(2),
                    rate = c.getDouble(3),
                    provider = c.getString(4),
                    fetchedAt = c.getLong(5),
                )
            } else {
                null
            }
        }
    }

    @Synchronized
    fun putFxRate(
        base: String,
        quote: String,
        rateDate: String,
        rate: Double,
        provider: String,
    ) {
        val b = base.trim().uppercase()
        val q = quote.trim().uppercase()
        val d = rateDate.trim()
        if (b.length != 3 || q.length != 3 || d.length != 10 || !rate.isFinite() || rate <= 0.0) {
            return
        }
        val cv = ContentValues().apply {
            put("base", b)
            put("quote", q)
            put("rate_date", d)
            put("rate", rate)
            put("provider", provider.ifBlank { "api" })
            put("fetched_at", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict("fx_rates", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    @Synchronized
    fun exportFxRatesJson(limit: Int = 500): JSONObject {
        val out = JSONObject()
        readableDatabase.rawQuery(
            """
            SELECT base, quote, rate_date, rate, provider
            FROM fx_rates
            ORDER BY fetched_at DESC
            LIMIT ?
            """.trimIndent(),
            arrayOf(limit.toString()),
        ).use { c ->
            while (c.moveToNext()) {
                val base = c.getString(0)
                val quote = c.getString(1)
                val rateDate = c.getString(2)
                val rate = c.getDouble(3)
                val provider = c.getString(4)
                val entry = JSONObject()
                    .put("rate", rate)
                    .put("rateDate", rateDate)
                    .put("provider", provider)
                out.put("$base|$quote|$rateDate", entry)
            }
        }
        return out
    }

    @Synchronized
    fun insertUnparsedSms(
        ownerKey: String,
        sender: String,
        receivedAt: String,
        smsHash: String,
        body: String,
    ) {
        if (ownerKey.isBlank() || smsHash.isBlank() || body.isBlank()) return
        val cv = ContentValues().apply {
            put("owner_key", ownerKey)
            put("sender", sender.take(64))
            put("received_at", receivedAt)
            put("sms_hash", smsHash)
            put("body", body.take(2000))
            put("created_at", System.currentTimeMillis())
            put("dismissed", 0)
        }
        writableDatabase.insertWithOnConflict("unparsed_sms", null, cv, SQLiteDatabase.CONFLICT_IGNORE)
    }

    @Synchronized
    fun getUnparsedSms(ownerKey: String = getActiveOwnerKey(), limit: Int = 100): List<UnparsedSmsEntry> {
        if (ownerKey.isBlank()) return emptyList()
        val result = mutableListOf<UnparsedSmsEntry>()
        readableDatabase.rawQuery(
            """
            SELECT id, sender, received_at, sms_hash, body, created_at, dismissed
            FROM unparsed_sms
            WHERE owner_key = ? AND dismissed = 0
            ORDER BY created_at DESC
            LIMIT ?
            """.trimIndent(),
            arrayOf(ownerKey, limit.toString()),
        ).use { c ->
            while (c.moveToNext()) {
                result.add(
                    UnparsedSmsEntry(
                        id = c.getLong(0),
                        sender = c.getString(1),
                        receivedAt = c.getString(2),
                        smsHash = c.getString(3),
                        body = c.getString(4),
                        createdAt = c.getLong(5),
                        dismissed = c.getInt(6) != 0,
                    ),
                )
            }
        }
        return result
    }

    @Synchronized
    fun dismissUnparsedSms(id: Long, ownerKey: String = getActiveOwnerKey()): Boolean {
        if (ownerKey.isBlank() || id <= 0L) return false
        val cv = ContentValues().apply { put("dismissed", 1) }
        return writableDatabase.update(
            "unparsed_sms",
            cv,
            "id = ? AND owner_key = ?",
            arrayOf(id.toString(), ownerKey),
        ) > 0
    }

    @Synchronized
    fun deleteUnparsedSmsByHash(smsHash: String, ownerKey: String = getActiveOwnerKey()): Boolean {
        if (ownerKey.isBlank() || smsHash.isBlank()) return false
        return writableDatabase.delete(
            "unparsed_sms",
            "owner_key = ? AND sms_hash = ?",
            arrayOf(ownerKey, smsHash),
        ) > 0
    }

    @Synchronized
    fun getLearnedTemplatesJson(ownerKey: String = getActiveOwnerKey()): JSONArray {
        val arr = JSONArray()
        if (ownerKey.isBlank()) return arr
        readableDatabase.rawQuery(
            """
            SELECT id, template_version, sender_norm, skeleton_hash, pattern_json,
                   field_map_json, direction, txn_type, bank_id, created_at, hits, last_hit_at
            FROM learned_templates
            WHERE owner_key = ?
            ORDER BY hits DESC, created_at DESC
            """.trimIndent(),
            arrayOf(ownerKey),
        ).use { c ->
            while (c.moveToNext()) {
                try {
                    val obj = JSONObject().apply {
                        put("id", c.getString(0))
                        put("template_version", c.getInt(1))
                        put("sender_norm", c.getString(2))
                        put("skeleton_hash", c.getString(3))
                        put("pattern", JSONObject(c.getString(4)))
                        put("field_map", JSONObject(c.getString(5)))
                        put("direction", c.getString(6))
                        put("txn_type", c.getString(7))
                        put("bank_id", if (c.isNull(8)) JSONObject.NULL else c.getString(8))
                        put("created_at", c.getString(9))
                        put("hits", c.getInt(10))
                        put("last_hit_at", if (c.isNull(11)) JSONObject.NULL else c.getString(11))
                    }
                    arr.put(obj)
                } catch (_: Exception) {
                    // Skip malformed template row
                }
            }
        }
        return arr
    }

    @Synchronized
    fun saveLearnedTemplate(template: JSONObject, ownerKey: String = getActiveOwnerKey()): Boolean {
        if (ownerKey.isBlank()) return false
        val id = template.optString("id", "").trim()
        val senderNorm = template.optString("sender_norm", "").trim()
        val skeletonHash = template.optString("skeleton_hash", "").trim()
        val patternObj = template.optJSONObject("pattern") ?: return false
        val fieldMapObj = template.optJSONObject("field_map") ?: return false
        val direction = template.optString("direction", "").trim()
        val txnType = template.optString("txn_type", "other").trim()
        if (id.isEmpty() || skeletonHash.isEmpty() || direction.isEmpty()) return false

        val bankIdRaw = if (template.isNull("bank_id")) null else template.optString("bank_id", "").trim().ifBlank { null }
        val lastHitRaw = if (template.isNull("last_hit_at")) null else template.optString("last_hit_at", "").trim().ifBlank { null }
        val createdAt = template.optString("created_at", "").trim()
            .ifBlank { java.time.Instant.now().toString() }

        val cv = ContentValues().apply {
            put("id", id)
            put("owner_key", ownerKey)
            put("template_version", template.optInt("template_version", 1))
            put("sender_norm", senderNorm)
            put("skeleton_hash", skeletonHash)
            put("pattern_json", patternObj.toString())
            put("field_map_json", fieldMapObj.toString())
            put("direction", direction)
            put("txn_type", txnType)
            if (bankIdRaw != null) put("bank_id", bankIdRaw) else putNull("bank_id")
            put("created_at", createdAt)
            put("hits", template.optInt("hits", 0))
            if (lastHitRaw != null) put("last_hit_at", lastHitRaw) else putNull("last_hit_at")
        }
        writableDatabase.insertWithOnConflict("learned_templates", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
        return true
    }

    @Synchronized
    fun deleteLearnedTemplate(id: String, ownerKey: String = getActiveOwnerKey()): Boolean {
        if (ownerKey.isBlank() || id.isBlank()) return false
        return writableDatabase.delete(
            "learned_templates",
            "owner_key = ? AND id = ?",
            arrayOf(ownerKey, id),
        ) > 0
    }

    @Synchronized
    fun recordTemplateHit(id: String, ownerKey: String = getActiveOwnerKey()) {
        if (ownerKey.isBlank() || id.isBlank()) return
        val nowIso = java.time.Instant.now().toString()
        writableDatabase.execSQL(
            """
            UPDATE learned_templates
            SET hits = hits + 1, last_hit_at = ?
            WHERE owner_key = ? AND id = ?
            """.trimIndent(),
            arrayOf(nowIso, ownerKey, id),
        )
    }

    /**
     * Merges the latest saved links, locally cached FX rates, and learned SMS
     * templates into the cached engine context so background workers always
     * evaluate with up-to-date routing, exchange rates, and taught formats.
     */
    @Synchronized
    fun buildEffectiveEngineContextJson(ownerKey: String = getActiveOwnerKey()): String? {
        if (ownerKey.isBlank()) return null
        val rawCtx = getEngineContextJson(ownerKey) ?: return null
        return try {
            val ctx = JSONObject(rawCtx)
            ctx.put("links", getLinksArray(ownerKey))
            val mergedFx = ctx.optJSONObject("fxRates") ?: JSONObject()
            val localFx = exportFxRatesJson()
            val keys = localFx.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                mergedFx.put(k, localFx.get(k))
            }
            ctx.put("fxRates", mergedFx)
            ctx.put("learnedTemplates", getLearnedTemplatesJson(ownerKey))
            ctx.toString()
        } catch (_: Exception) {
            rawCtx
        }
    }

    private fun scopedKey(ownerKey: String, key: String): String {
        return "$ownerKey::$key"
    }

    private fun getCache(key: String): String? {
        readableDatabase.rawQuery(
            "SELECT value_json FROM engine_cache WHERE cache_key = ? LIMIT 1",
            arrayOf(key),
        ).use { cursor ->
            return if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }

    private fun putCache(key: String, valueJson: String) {
        val cv = ContentValues().apply {
            put("cache_key", key)
            put("value_json", valueJson)
            put("updated_at", System.currentTimeMillis())
        }
        writableDatabase.insertWithOnConflict("engine_cache", null, cv, SQLiteDatabase.CONFLICT_REPLACE)
    }

    companion object {
        private const val DB_NAME = "fuloos_sms_local.db"
        private const val DB_VERSION = 5
        private const val KEY_ACTIVE_OWNER = "active_owner_key"
        private const val KEY_SMS_LINKS = "sms_links"
        private const val KEY_ENGINE_CONTEXT = "engine_context"
        private const val DEFAULT_CATCHUP_WINDOW_MS = 1000L * 60 * 60 * 48 // 48 hours

        @Volatile
        private var instance: FuloosLocalDb? = null

        fun getInstance(context: Context): FuloosLocalDb {
            return instance ?: synchronized(this) {
                instance ?: FuloosLocalDb(context).also { instance = it }
            }
        }

        fun ownerKeyFor(pbUrl: String, userId: String): String {
            val cleanUrl = pbUrl.trim().trimEnd('/')
            val cleanUser = userId.trim()
            return if (cleanUrl.isEmpty() || cleanUser.isEmpty()) "" else "$cleanUrl|$cleanUser"
        }

        fun normalizeSender(raw: String): String {
            return raw.trim()
                .replace(Regex("^[A-Za-z]{2}-"), "")
                .replace(Regex("\\s+"), " ")
                .uppercase()
        }
    }
}

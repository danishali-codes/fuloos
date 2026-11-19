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
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) {
            // Recreate local-only cache/dedupe/queue tables with owner_key partitioning
            // so unscoped v1 rows cannot leak across authenticated users/servers.
            db.execSQL("DROP TABLE IF EXISTS processed_sms")
            db.execSQL("DROP TABLE IF EXISTS offline_queue")
            db.execSQL("DELETE FROM engine_cache")
        }
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

    /**
     * Merges the latest saved links into the cached engine context so background
     * workers always evaluate with up-to-date sender & card routing links.
     */
    @Synchronized
    fun buildEffectiveEngineContextJson(ownerKey: String = getActiveOwnerKey()): String? {
        if (ownerKey.isBlank()) return null
        val rawCtx = getEngineContextJson(ownerKey) ?: return null
        return try {
            val ctx = JSONObject(rawCtx)
            ctx.put("links", getLinksArray(ownerKey))
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
        private const val DB_VERSION = 2
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

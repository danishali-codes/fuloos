package dev.danishali.fuloos.sms

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject

/**
 * Hardware-backed Android Keystore storage for the background sync credentials,
 * so SMS workers can sync transactions without exposing them in plain preferences
 * or backups.
 *
 * Two backends are supported:
 *  - PocketBase: the WebView pushes its auth token here (`savePocketBase`).
 *  - Supabase: supabase-js in the WebView uses this store as its session storage
 *    (`getItem` / `setItem` / `removeItem`), so the app and the background workers
 *    share one session and one refresh token. The WebView only registers the
 *    project URL, publishable key, storage key and user id (`saveSupabase`).
 *    Background workers refresh that shared session when it expires and write
 *    the rotated tokens back, which supabase-js reads on its next request.
 */
class SecureAuthStore(context: Context) {

    data class AuthSession(
        val kind: String,
        val baseUrl: String,
        val token: String,
        val userId: String,
        val anonKey: String = "",
        val storageKey: String = "",
        val refreshToken: String = "",
        /** Unix seconds; 0 when unknown (PocketBase). */
        val expiresAt: Long = 0L,
    ) {
        val ownerKey: String
            get() = FuloosLocalDb.ownerKeyFor(baseUrl, userId)

        val isSupabase: Boolean
            get() = kind == KIND_SUPABASE
    }

    private val appContext = context.applicationContext

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(appContext)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            appContext,
            PREFS_FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun savePocketBase(pbUrl: String, token: String, userId: String) {
        val cleanUrl = pbUrl.trim().trimEnd('/')
        if (cleanUrl.isEmpty() || token.isBlank() || userId.isBlank()) return
        prefs.edit()
            .putString(KEY_KIND, KIND_POCKETBASE)
            .putString(KEY_PB_URL, cleanUrl)
            .putString(KEY_TOKEN, token.trim())
            .putString(KEY_USER_ID, userId.trim())
            .remove(KEY_ANON_KEY)
            .remove(KEY_STORAGE_KEY)
            .apply()
    }

    fun saveSupabase(url: String, anonKey: String, storageKey: String, userId: String) {
        val cleanUrl = url.trim().trimEnd('/')
        if (cleanUrl.isEmpty() || anonKey.isBlank() || !isSessionKey(storageKey) || userId.isBlank()) {
            return
        }
        prefs.edit()
            .putString(KEY_KIND, KIND_SUPABASE)
            .putString(KEY_PB_URL, cleanUrl)
            .putString(KEY_ANON_KEY, anonKey.trim())
            .putString(KEY_STORAGE_KEY, storageKey.trim())
            .putString(KEY_USER_ID, userId.trim())
            .remove(KEY_TOKEN)
            .apply()
    }

    fun load(): AuthSession? {
        return try {
            val kind = prefs.getString(KEY_KIND, null) ?: KIND_POCKETBASE
            val baseUrl = prefs.getString(KEY_PB_URL, null)?.trim().orEmpty()
            val userId = prefs.getString(KEY_USER_ID, null)?.trim().orEmpty()
            if (baseUrl.isEmpty() || userId.isEmpty()) return null
            if (kind == KIND_SUPABASE) {
                loadSupabase(baseUrl, userId)
            } else {
                val token = prefs.getString(KEY_TOKEN, null)?.trim().orEmpty()
                if (token.isEmpty()) null
                else AuthSession(kind = KIND_POCKETBASE, baseUrl = baseUrl, token = token, userId = userId)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun loadSupabase(baseUrl: String, userId: String): AuthSession? {
        val anonKey = prefs.getString(KEY_ANON_KEY, null)?.trim().orEmpty()
        val storageKey = prefs.getString(KEY_STORAGE_KEY, null)?.trim().orEmpty()
        if (anonKey.isEmpty() || storageKey.isEmpty()) return null
        val raw = getItem(storageKey) ?: return null
        val json = JSONObject(raw)
        val token = json.optString("access_token", "")
        val refreshToken = json.optString("refresh_token", "")
        val sessionUser = json.optJSONObject("user")?.optString("id", "").orEmpty()
        // supabase-js may already hold a different account (sign-in switched users
        // before the WebView re-registered); never write as the wrong owner.
        if (token.isEmpty() || refreshToken.isEmpty() || (sessionUser.isNotEmpty() && sessionUser != userId)) {
            return null
        }
        return AuthSession(
            kind = KIND_SUPABASE,
            baseUrl = baseUrl,
            token = token,
            userId = userId,
            anonKey = anonKey,
            storageKey = storageKey,
            refreshToken = refreshToken,
            expiresAt = json.optLong("expires_at", 0L),
        )
    }

    /** Clears the background sync registration. Supabase session items stay owned by supabase-js. */
    fun clear() {
        try {
            prefs.edit()
                .remove(KEY_KIND)
                .remove(KEY_PB_URL)
                .remove(KEY_TOKEN)
                .remove(KEY_USER_ID)
                .remove(KEY_ANON_KEY)
                .remove(KEY_STORAGE_KEY)
                .apply()
        } catch (_: Exception) {
            // Ignore keystore wipe errors during sign-out
        }
    }

    // --- Supabase session storage shared with supabase-js -------------------------

    fun getItem(key: String): String? {
        if (!isSessionKey(key)) return null
        return try {
            prefs.getString(KV_PREFIX + key, null)
        } catch (_: Exception) {
            null
        }
    }

    fun setItem(key: String, value: String) {
        if (!isSessionKey(key)) return
        prefs.edit().putString(KV_PREFIX + key, value).commit()
    }

    fun removeItem(key: String) {
        if (!isSessionKey(key)) return
        prefs.edit().remove(KV_PREFIX + key).commit()
    }

    companion object {
        const val KIND_POCKETBASE = "pocketbase"
        const val KIND_SUPABASE = "supabase"

        /** Only supabase-js auth items may be stored through the WebView bridge. */
        const val SESSION_KEY_PREFIX = "fuloos-supabase-auth"

        fun isSessionKey(key: String): Boolean {
            val k = key.trim()
            return k.startsWith(SESSION_KEY_PREFIX) && k.length <= 128
        }

        private const val PREFS_FILE = "fuloos_secure_auth"
        private const val KEY_KIND = "backend_kind"
        private const val KEY_PB_URL = "pb_url"
        private const val KEY_TOKEN = "auth_token"
        private const val KEY_USER_ID = "user_id"
        private const val KEY_ANON_KEY = "supabase_anon_key"
        private const val KEY_STORAGE_KEY = "supabase_storage_key"
        private const val KV_PREFIX = "kv:"
    }
}

package dev.danishali.fuloos.sms

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Hardware-backed Android Keystore storage for the PocketBase session token,
 * user ID, and server origin so background SMS workers can sync transactions
 * securely without exposing credentials in plain preferences or backups.
 */
class SecureAuthStore(context: Context) {

    data class AuthSession(
        val pbUrl: String,
        val token: String,
        val userId: String,
    ) {
        val ownerKey: String
            get() = FuloosLocalDb.ownerKeyFor(pbUrl, userId)
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

    fun save(pbUrl: String, token: String, userId: String) {
        val cleanUrl = pbUrl.trim().trimEnd('/')
        if (cleanUrl.isEmpty() || token.isBlank() || userId.isBlank()) return
        prefs.edit()
            .putString(KEY_PB_URL, cleanUrl)
            .putString(KEY_TOKEN, token.trim())
            .putString(KEY_USER_ID, userId.trim())
            .apply()
    }

    fun load(): AuthSession? {
        return try {
            val pbUrl = prefs.getString(KEY_PB_URL, null)?.trim().orEmpty()
            val token = prefs.getString(KEY_TOKEN, null)?.trim().orEmpty()
            val userId = prefs.getString(KEY_USER_ID, null)?.trim().orEmpty()
            if (pbUrl.isEmpty() || token.isEmpty() || userId.isEmpty()) {
                null
            } else {
                AuthSession(pbUrl = pbUrl, token = token, userId = userId)
            }
        } catch (_: Exception) {
            null
        }
    }

    fun clear() {
        try {
            prefs.edit()
                .remove(KEY_PB_URL)
                .remove(KEY_TOKEN)
                .remove(KEY_USER_ID)
                .apply()
        } catch (_: Exception) {
            // Ignore keystore wipe errors during sign-out
        }
    }

    companion object {
        private const val PREFS_FILE = "fuloos_secure_auth"
        private const val KEY_PB_URL = "pb_url"
        private const val KEY_TOKEN = "auth_token"
        private const val KEY_USER_ID = "user_id"
    }
}

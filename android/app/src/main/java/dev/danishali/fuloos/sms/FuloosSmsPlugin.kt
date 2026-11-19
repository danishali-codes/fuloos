package dev.danishali.fuloos.sms

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import dev.danishali.fuloos.BuildConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.TimeUnit

/**
 * Capacitor bridge exposing Android native SMS automation, Notification Channel
 * shortcuts, Battery Optimization settings, Keystore auth sync, BiometricPrompt,
 * and deep links to the shared Fuloos React UI (`src/mobile/platformBridge.ts`).
 */
@CapacitorPlugin(
    name = "FuloosSms",
    permissions = [
        Permission(
            alias = "sms",
            strings = [
                Manifest.permission.READ_SMS,
                Manifest.permission.RECEIVE_SMS,
            ],
        ),
        Permission(
            alias = "notifications",
            strings = [Manifest.permission.POST_NOTIFICATIONS],
        ),
    ],
)
class FuloosSmsPlugin : Plugin() {

    private val db: FuloosLocalDb by lazy { FuloosLocalDb.getInstance(context) }
    private val authStore: SecureAuthStore by lazy { SecureAuthStore(context) }

    override fun load() {
        super.load()
        activeInstance = WeakReference(this)
        SmsNotificationHelper.ensureChannels(context)
        schedulePeriodicCatchUpIfNeeded(context)
    }

    override fun handleOnDestroy() {
        if (activeInstance?.get() === this) {
            activeInstance = null
        }
        super.handleOnDestroy()
    }

    @PluginMethod
    fun getPermissionStatus(call: PluginCall) {
        call.resolve(buildPermissionStatus())
    }

    @PluginMethod
    fun requestSmsPermissions(call: PluginCall) {
        val aliases = mutableListOf<String>()
        if (BuildConfig.SUPPORTS_DIRECT_SMS) {
            if (!hasPermission(Manifest.permission.READ_SMS) ||
                !hasPermission(Manifest.permission.RECEIVE_SMS)
            ) {
                aliases.add("sms")
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            !hasPermission(Manifest.permission.POST_NOTIFICATIONS)
        ) {
            aliases.add("notifications")
        }

        if (aliases.isEmpty()) {
            call.resolve(buildPermissionStatus())
            return
        }
        requestPermissionForAliases(aliases.toTypedArray(), call, "onPermissionsCallback")
    }

    @PermissionCallback
    private fun onPermissionsCallback(call: PluginCall) {
        call.resolve(buildPermissionStatus())
    }

    @PluginMethod
    fun listSmsSenders(call: PluginCall) {
        if (!BuildConfig.SUPPORTS_DIRECT_SMS || !hasPermission(Manifest.permission.READ_SMS)) {
            call.resolve(JSObject().put("senders", JSArray()))
            return
        }
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val senders = SmsInboxReader.listSenders(context)
                val out = JSObject().put("senders", JSArray(senders.toString()))
                call.resolve(out)
            } catch (e: Exception) {
                call.reject("Failed to list SMS senders: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun readHistoricalSms(call: PluginCall) {
        if (!BuildConfig.SUPPORTS_DIRECT_SMS || !hasPermission(Manifest.permission.READ_SMS)) {
            call.resolve(
                JSObject()
                    .put("messages", JSArray())
                    .put("total", 0)
                    .put("hasMore", false),
            )
            return
        }
        val sendersArr = call.getArray("senders") ?: JSArray()
        val senders = mutableListOf<String>()
        for (i in 0 until sendersArr.length()) {
            val s = sendersArr.optString(i, "")
            if (s.isNotBlank()) senders.add(s)
        }
        val sinceTs = call.getLong("sinceTimestampMs") ?: 0L
        val limit = (call.getInt("limit") ?: 500).coerceIn(1, 2000)
        val offset = (call.getInt("offset") ?: 0).coerceAtLeast(0)

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val res = SmsInboxReader.readMessages(
                    context = context,
                    senders = senders,
                    sinceTimestampMs = sinceTs,
                    limit = limit,
                    offset = offset,
                )
                call.resolve(JSObject(res.toString()))
            } catch (e: Exception) {
                call.reject("Failed to read historical SMS: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun getLinks(call: PluginCall) {
        val raw = db.getLinksJson()
        val arr = try {
            JSArray(raw)
        } catch (_: Exception) {
            JSArray()
        }
        call.resolve(JSObject().put("links", arr))
    }

    @PluginMethod
    fun saveLinks(call: PluginCall) {
        val links = call.getArray("links") ?: JSArray()
        db.saveLinksJson(links.toString())
        schedulePeriodicCatchUpIfNeeded(context)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun syncEngineContext(call: PluginCall) {
        val ctxJson = call.getString("contextJson").orEmpty()
        if (ctxJson.isNotBlank()) {
            db.saveEngineContextJson(ctxJson)
        }
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun syncAuthSession(call: PluginCall) {
        val pbUrl = call.getString("pbUrl").orEmpty()
        val token = call.getString("token").orEmpty()
        val userId = call.getString("userId").orEmpty()
        if (pbUrl.isNotBlank() && token.isNotBlank() && userId.isNotBlank()) {
            authStore.save(pbUrl, token, userId)
            enqueueOneOffWorker(context, SmsProcessWorker.MODE_FLUSH_QUEUE)
        }
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun clearAuthSession(call: PluginCall) {
        authStore.clear()
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun markHashesProcessed(call: PluginCall) {
        val entriesArr = call.getArray("entries") ?: JSArray()
        val list = mutableListOf<FuloosLocalDb.ProcessedEntry>()
        for (i in 0 until entriesArr.length()) {
            val obj = entriesArr.optJSONObject(i) ?: continue
            val hash = if (obj.isNull("smsHash")) "" else obj.optString("smsHash", "")
            if (hash.isBlank()) continue
            list.add(
                FuloosLocalDb.ProcessedEntry(
                    smsHash = hash,
                    androidSmsId = if (obj.isNull("androidSmsId")) null else obj.optString("androidSmsId", "").ifBlank { null },
                    accountId = if (obj.isNull("accountId")) null else obj.optString("accountId", "").ifBlank { null },
                    transactionId = if (obj.isNull("transactionId")) null else obj.optString("transactionId", "").ifBlank { null },
                    status = if (obj.isNull("status")) "backfilled" else obj.optString("status", "backfilled"),
                ),
            )
        }
        db.markProcessed(list)
        call.resolve(JSObject().put("ok", true))
    }

    @PluginMethod
    fun triggerCatchUpSync(call: PluginCall) {
        val enqueued = enqueueOneOffWorker(context, SmsProcessWorker.MODE_CATCH_UP)
        call.resolve(JSObject().put("enqueued", enqueued))
    }

    @PluginMethod
    fun openNotificationSettings(call: PluginCall) {
        val channelId = call.getString("channelId")?.ifBlank { null }
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && channelId != null) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                putExtra(Settings.EXTRA_CHANNEL_ID, channelId)
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            }
        } else {
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(fallback)
        }
        call.resolve()
    }

    @PluginMethod
    fun openBatteryOptimizationSettings(call: PluginCall) {
        val intent = if (BuildConfig.SUPPORTS_DIRECT_SMS && !isIgnoringBatteryOptimizations()) {
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${context.packageName}")
            }
        } else {
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            context.startActivity(intent)
        } catch (_: Exception) {
            val fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(fallback)
        }
        call.resolve()
    }

    @PluginMethod
    fun isBiometricAvailable(call: PluginCall) {
        val authenticators =
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        val status = BiometricManager.from(context).canAuthenticate(authenticators)
        call.resolve(JSObject().put("available", status == BiometricManager.BIOMETRIC_SUCCESS))
    }

    @PluginMethod
    fun authenticateBiometric(call: PluginCall) {
        val hostActivity = activity as? FragmentActivity
        if (hostActivity == null) {
            call.resolve(JSObject().put("authenticated", false))
            return
        }
        val title = call.getString("title") ?: "Unlock Fuloos"
        val subtitle = call.getString("subtitle") ?: "Verify your identity to continue"
        val authenticators =
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL

        hostActivity.runOnUiThread {
            try {
                val executor = ContextCompat.getMainExecutor(hostActivity)
                var settled = false
                val prompt = BiometricPrompt(
                    hostActivity,
                    executor,
                    object : BiometricPrompt.AuthenticationCallback() {
                        override fun onAuthenticationSucceeded(
                            result: BiometricPrompt.AuthenticationResult,
                        ) {
                            if (!settled) {
                                settled = true
                                call.resolve(JSObject().put("authenticated", true))
                            }
                        }

                        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                            if (!settled) {
                                settled = true
                                call.resolve(JSObject().put("authenticated", false))
                            }
                        }
                    },
                )
                val info = BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .setSubtitle(subtitle)
                    .setAllowedAuthenticators(authenticators)
                    .build()
                prompt.authenticate(info)
            } catch (_: Exception) {
                call.resolve(JSObject().put("authenticated", false))
            }
        }
    }

    @PluginMethod
    fun getPendingDeepLink(call: PluginCall) {
        val event = pendingDeepLink
        pendingDeepLink = null
        val out = JSObject()
        if (event != null) {
            out.put("event", event)
        } else {
            out.put("event", JSONObject.NULL)
        }
        call.resolve(out)
    }

    private fun buildPermissionStatus(): JSObject {
        val readSms = BuildConfig.SUPPORTS_DIRECT_SMS && hasPermission(Manifest.permission.READ_SMS)
        val receiveSms = BuildConfig.SUPPORTS_DIRECT_SMS && hasPermission(Manifest.permission.RECEIVE_SMS)
        val postNotifications = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            hasPermission(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            true
        }
        return JSObject().apply {
            put("readSms", readSms)
            put("receiveSms", receiveSms)
            put("postNotifications", postNotifications)
            put("ignoringBatteryOptimizations", isIgnoringBatteryOptimizations())
            put("supportsDirectSms", BuildConfig.SUPPORTS_DIRECT_SMS)
            put("buildFlavor", BuildConfig.BUILD_FLAVOR)
        }
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(context, permission) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    private fun dispatchDeepLink(payload: JSObject) {
        notifyListeners("deepLink", payload, true)
    }

    private fun dispatchSmsProcessed(payload: JSObject) {
        notifyListeners("smsProcessed", payload, false)
    }

    companion object {
        private const val PERIODIC_CATCHUP_WORK = "fuloos_periodic_sms_catchup"

        @Volatile
        private var activeInstance: WeakReference<FuloosSmsPlugin>? = null

        @Volatile
        private var pendingDeepLink: JSObject? = null

        @JvmStatic
        fun handleIntent(intent: Intent?) {
            val data = intent?.data ?: return
            if (data.scheme != "fuloos") return
            val host = data.host.orEmpty().lowercase()
            val firstSegment = data.pathSegments.firstOrNull().orEmpty()

            val payload = when (host) {
                "review" -> JSObject().apply {
                    put("action", "open_review")
                    if (firstSegment.isNotEmpty()) put("alertId", firstSegment)
                }
                "tx" -> JSObject().apply {
                    put("action", "open_transaction")
                    if (firstSegment.isNotEmpty()) put("transactionId", firstSegment)
                }
                "sms" -> JSObject().apply {
                    put("action", "open_sms_settings")
                }
                else -> return
            }

            val plugin = activeInstance?.get()
            if (plugin != null) {
                plugin.dispatchDeepLink(payload)
            } else {
                pendingDeepLink = payload
            }
        }

        fun notifySmsProcessed(
            action: String,
            transactionId: String?,
            alertId: String?,
            accountId: String?,
        ) {
            val plugin = activeInstance?.get() ?: return
            val payload = JSObject().apply {
                put("action", action)
                if (!transactionId.isNullOrBlank()) put("transactionId", transactionId)
                if (!alertId.isNullOrBlank()) put("alertId", alertId)
                if (!accountId.isNullOrBlank()) put("accountId", accountId)
            }
            plugin.dispatchSmsProcessed(payload)
        }

        private fun schedulePeriodicCatchUpIfNeeded(context: Context) {
            val db = FuloosLocalDb.getInstance(context)
            val links = db.getLinksArray()
            val hasEnabled = (0 until links.length()).any { i ->
                links.optJSONObject(i)?.optBoolean("enabled", true) == true
            }
            val wm = WorkManager.getInstance(context.applicationContext)
            if (!hasEnabled) {
                wm.cancelUniqueWork(PERIODIC_CATCHUP_WORK)
                return
            }

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val input = Data.Builder()
                .putString(SmsProcessWorker.KEY_MODE, SmsProcessWorker.MODE_CATCH_UP)
                .build()
            val request = PeriodicWorkRequestBuilder<SmsProcessWorker>(4, TimeUnit.HOURS)
                .setConstraints(constraints)
                .setInputData(input)
                .build()

            wm.enqueueUniquePeriodicWork(
                PERIODIC_CATCHUP_WORK,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        private fun enqueueOneOffWorker(context: Context, mode: String): Boolean {
            return try {
                val input = Data.Builder()
                    .putString(SmsProcessWorker.KEY_MODE, mode)
                    .build()
                val request = OneTimeWorkRequestBuilder<SmsProcessWorker>()
                    .setInputData(input)
                    .build()
                WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                    "fuloos_oneoff_$mode",
                    ExistingWorkPolicy.REPLACE,
                    request,
                )
                true
            } catch (_: Exception) {
                false
            }
        }
    }
}

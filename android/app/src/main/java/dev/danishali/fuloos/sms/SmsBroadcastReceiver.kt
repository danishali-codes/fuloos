package dev.danishali.fuloos.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import dev.danishali.fuloos.BuildConfig

/**
 * Lightweight broadcast receiver registered ONLY in the `direct` flavor manifest.
 *
 * Reassembles multi-part SMS PDUs per sender, performs a fast (<5ms) sender check
 * against FuloosLocalDb enabled links, and immediately hands off matching messages
 * to an expedited WorkManager job (`SmsProcessWorker`).
 */
class SmsBroadcastReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        if (!BuildConfig.SUPPORTS_DIRECT_SMS) return
        if (intent?.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val pdus = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (pdus.isEmpty()) return

        // Concatenate multi-part SMS segments grouped by originating sender address.
        val groupedBodies = linkedMapOf<String, StringBuilder>()
        val groupedTimestamps = linkedMapOf<String, Long>()

        for (msg in pdus) {
            val sender = msg.displayOriginatingAddress?.trim().orEmpty()
            val body = msg.messageBody.orEmpty()
            if (sender.isEmpty() || body.isEmpty()) continue
            groupedBodies.getOrPut(sender) { StringBuilder() }.append(body)
            val ts = msg.timestampMillis.takeIf { it > 0L } ?: System.currentTimeMillis()
            val prev = groupedTimestamps[sender] ?: 0L
            if (ts > prev) groupedTimestamps[sender] = ts
        }

        if (groupedBodies.isEmpty()) return
        val db = FuloosLocalDb.getInstance(context)
        val workManager = WorkManager.getInstance(context.applicationContext)

        for ((sender, bodyBuilder) in groupedBodies) {
            if (!db.hasEnabledLinkForSender(sender)) continue
            val timestampMs = groupedTimestamps[sender] ?: System.currentTimeMillis()
            val input = Data.Builder()
                .putString(SmsProcessWorker.KEY_MODE, SmsProcessWorker.MODE_SINGLE_SMS)
                .putString(SmsProcessWorker.KEY_SENDER, sender)
                .putString(SmsProcessWorker.KEY_BODY, bodyBuilder.toString())
                .putLong(SmsProcessWorker.KEY_TIMESTAMP_MS, timestampMs)
                .build()

            val request = OneTimeWorkRequestBuilder<SmsProcessWorker>()
                .setInputData(input)
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()

            workManager.enqueueUniqueWork(
                "fuloos_sms_${sender.hashCode()}_$timestampMs",
                ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}

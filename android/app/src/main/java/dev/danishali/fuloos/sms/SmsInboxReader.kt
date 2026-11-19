package dev.danishali.fuloos.sms

import android.content.Context
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject

/**
 * Reads the device SMS inbox via Android ContentResolver for:
 * 1. Sender discovery (`listSenders`) with message counts, masked preview,
 *    detected UAE bank template, and detected 4-digit card suffixes.
 * 2. Paginated historical backfill (`readMessages`) filtered by linked senders.
 */
object SmsInboxReader {

    private data class SenderAccumulator(
        var address: String,
        val normalized: String,
        var count: Int = 0,
        var latestTimestamp: Long = 0L,
        var latestBody: String = "",
        val cards: MutableSet<String> = linkedSetOf(),
    )

    private val CARD_PATTERNS = listOf(
        Regex("""(?:card|debit|credit|visa|mastercard|mc|acct?|a/c)[^0-9\n]{0,20}(?:ending(?:\s+(?:in|with))?|no\.?|#|x{2,}|\*{2,}|•{2,})\s*(\d{4})\b""", RegexOption.IGNORE_CASE),
        Regex("""(?:x{2,}|\*{2,}|•{2,})[-\s]?(\d{4})\b""", RegexOption.IGNORE_CASE),
        Regex("""\bending(?:\s+(?:in|with))?\s*(\d{4})\b""", RegexOption.IGNORE_CASE),
    )

    private val BANK_BY_SENDER = listOf(
        "LIV" to "Liv",
        "ADCB" to "ADCB",
        "FAB" to "FAB",
        "ENBD" to "ENBD",
        "EMIRATESNBD" to "ENBD",
        "DIB" to "DIB",
        "DUBAIISLAMIC" to "DIB",
        "MASHREQ" to "Mashreq",
        "ADIB" to "ADIB",
        "WIO" to "Wio",
        "RAKBANK" to "RAKBANK",
        "CBD" to "CBD",
        "HSBC" to "HSBC",
        "EIB" to "Emirates Islamic",
        "EMIRATESISLAMIC" to "Emirates Islamic",
        "SIB" to "SIB",
    )

    private val DIGIT_RUN_PATTERN = Regex("""\b\d{6,}\b""")
    private val OTP_PATTERN = Regex("""\b(?:otp|code|pin|password|passcode)\s*(?:is|:)?\s*\d{4,8}\b""", RegexOption.IGNORE_CASE)

    fun listSenders(context: Context): JSONArray {
        val map = linkedMapOf<String, SenderAccumulator>()
        val projection = arrayOf(
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
        )

        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            null,
            null,
            "${Telephony.Sms.DATE} DESC",
        )?.use { cursor ->
            val addrIdx = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyIdx = cursor.getColumnIndex(Telephony.Sms.BODY)
            val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)

            while (cursor.moveToNext()) {
                val rawAddr = if (addrIdx >= 0) cursor.getString(addrIdx).orEmpty().trim() else ""
                if (rawAddr.isEmpty()) continue
                val norm = FuloosLocalDb.normalizeSender(rawAddr)
                if (norm.isEmpty()) continue
                val body = if (bodyIdx >= 0) cursor.getString(bodyIdx).orEmpty() else ""
                val ts = if (dateIdx >= 0) cursor.getLong(dateIdx) else 0L

                val acc = map.getOrPut(norm) {
                    SenderAccumulator(address = rawAddr, normalized = norm)
                }
                acc.count += 1
                if (ts >= acc.latestTimestamp) {
                    acc.latestTimestamp = ts
                    acc.latestBody = body
                    acc.address = rawAddr
                }
                extractCardLast4(body)?.let { acc.cards.add(it) }
            }
        }

        val sorted = map.values.sortedWith(
            compareByDescending<SenderAccumulator> { detectBank(it.normalized, it.latestBody) != null }
                .thenByDescending { it.latestTimestamp },
        )

        val result = JSONArray()
        for (item in sorted) {
            val cardsArr = JSONArray()
            item.cards.sorted().forEach { cardsArr.put(it) }
            result.put(
                JSONObject().apply {
                    put("address", item.address)
                    put("normalized", item.normalized)
                    put("messageCount", item.count)
                    put("latestTimestamp", item.latestTimestamp)
                    put("sampleMasked", maskPreview(item.latestBody))
                    val bank = detectBank(item.normalized, item.latestBody)
                    if (bank != null) put("detectedBank", bank) else put("detectedBank", JSONObject.NULL)
                    put("detectedCardLast4s", cardsArr)
                },
            )
        }
        return result
    }

    fun readMessages(
        context: Context,
        senders: List<String>,
        sinceTimestampMs: Long = 0L,
        limit: Int = 500,
        offset: Int = 0,
    ): JSONObject {
        val targetSenders = senders.map { FuloosLocalDb.normalizeSender(it) }.filter { it.isNotEmpty() }.toSet()
        val messages = JSONArray()
        if (targetSenders.isEmpty()) {
            return JSONObject()
                .put("messages", messages)
                .put("total", 0)
                .put("hasMore", false)
        }

        val projection = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
        )
        val selection = if (sinceTimestampMs > 0L) "${Telephony.Sms.DATE} > ?" else null
        val selectionArgs = if (sinceTimestampMs > 0L) arrayOf(sinceTimestampMs.toString()) else null

        var matchedCount = 0
        var collected = 0

        context.contentResolver.query(
            Telephony.Sms.Inbox.CONTENT_URI,
            projection,
            selection,
            selectionArgs,
            "${Telephony.Sms.DATE} ASC",
        )?.use { cursor ->
            val idIdx = cursor.getColumnIndex(Telephony.Sms._ID)
            val addrIdx = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
            val bodyIdx = cursor.getColumnIndex(Telephony.Sms.BODY)
            val dateIdx = cursor.getColumnIndex(Telephony.Sms.DATE)

            while (cursor.moveToNext()) {
                val rawAddr = if (addrIdx >= 0) cursor.getString(addrIdx).orEmpty().trim() else ""
                if (rawAddr.isEmpty()) continue
                if (FuloosLocalDb.normalizeSender(rawAddr) !in targetSenders) continue

                if (matchedCount >= offset && collected < limit) {
                    val id = if (idIdx >= 0) cursor.getString(idIdx).orEmpty() else ""
                    val body = if (bodyIdx >= 0) cursor.getString(bodyIdx).orEmpty() else ""
                    val ts = if (dateIdx >= 0) cursor.getLong(dateIdx) else 0L
                    messages.put(
                        JSONObject().apply {
                            put("id", id)
                            put("sender", rawAddr)
                            put("body", body)
                            put("timestampMs", ts)
                        },
                    )
                    collected++
                }
                matchedCount++
            }
        }

        return JSONObject()
            .put("messages", messages)
            .put("total", matchedCount)
            .put("hasMore", offset + collected < matchedCount)
    }

    private fun extractCardLast4(body: String): String? {
        for (rx in CARD_PATTERNS) {
            val match = rx.find(body)
            val digits = match?.groupValues?.getOrNull(1)
            if (digits != null && digits.length == 4) return digits
        }
        return null
    }

    private fun detectBank(normalizedSender: String, sampleBody: String): String? {
        for ((key, bank) in BANK_BY_SENDER) {
            if (normalizedSender == key || normalizedSender.contains(key)) {
                return bank
            }
        }
        val upperBody = sampleBody.uppercase()
        for ((key, bank) in BANK_BY_SENDER) {
            if (key.length >= 4 && upperBody.contains(key)) {
                return bank
            }
        }
        return null
    }

    private fun maskPreview(body: String): String {
        val masked = body
            .replace(OTP_PATTERN, "[OTP REDACTED]")
            .replace(DIGIT_RUN_PATTERN) { m -> "••••${m.value.takeLast(4)}" }
            .replace(Regex("""\s+"""), " ")
            .trim()
        return masked.take(120)
    }
}

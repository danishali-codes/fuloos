package dev.danishali.fuloos.sms

import android.content.Context
import android.util.Log
import androidx.javascriptengine.JavaScriptSandbox
import kotlinx.coroutines.guava.await
import org.json.JSONArray
import org.json.JSONObject

/**
 * Evaluates the shared Fuloos TypeScript SMS + ML bundle (`assets/fuloos-sms-engine.js`)
 * inside Android Jetpack's isolated V8 JavaScriptSandbox so background SMS processing
 * uses 100% identical parsing, card routing, rules, and ML categorisation as the Web UI.
 */
class HeadlessSmsEngine(private val context: Context) {

    private val engineSource: String by lazy {
        context.assets.open(ASSET_FILE).bufferedReader(Charsets.UTF_8).use { it.readText() }
    }

    suspend fun processSingleSms(rawSmsJson: String, contextJson: String): JSONObject? {
        val resultJson = evaluateCall(
            methodName = "processSmsJson",
            arg1Json = rawSmsJson,
            arg2Json = contextJson,
        ) ?: return null
        return try {
            JSONObject(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse processSmsJson result", e)
            null
        }
    }

    suspend fun processBatch(rawListJson: String, contextJson: String): JSONArray? {
        val resultJson = evaluateCall(
            methodName = "processBatchJson",
            arg1Json = rawListJson,
            arg2Json = contextJson,
        ) ?: return null
        return try {
            JSONObject(resultJson).optJSONArray("decisions")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse processBatchJson result", e)
            null
        }
    }

    private suspend fun evaluateCall(
        methodName: String,
        arg1Json: String,
        arg2Json: String,
    ): String? {
        if (!JavaScriptSandbox.isSupported()) {
            Log.w(TAG, "Jetpack JavaScriptSandbox is not supported on this device")
            return null
        }

        val sandbox = JavaScriptSandbox.createConnectedInstanceAsync(context.applicationContext).await()
        try {
            val isolate = sandbox.createIsolate()
            try {
                // Load the pure IIFE engine bundle into the isolate.
                isolate.evaluateJavaScriptAsync(engineSource).await()

                // Pass large JSON strings safely via JSONObject.quote to prevent JS syntax injection.
                val invocation = buildString {
                    append("globalThis.FuloosSmsEngine.")
                    append(methodName)
                    append("(")
                    append(JSONObject.quote(arg1Json))
                    append(",")
                    append(JSONObject.quote(arg2Json))
                    append(");")
                }
                return isolate.evaluateJavaScriptAsync(invocation).await()
            } finally {
                isolate.close()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Headless SMS engine execution failed for $methodName", e)
            return null
        } finally {
            sandbox.close()
        }
    }

    companion object {
        private const val TAG = "HeadlessSmsEngine"
        private const val ASSET_FILE = "fuloos-sms-engine.js"
    }
}

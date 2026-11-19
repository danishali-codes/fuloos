/**
 * Headless JS entry point bundled into `android/app/src/main/assets/fuloos-sms-engine.js`
 * and executed inside Android Jetpack JavaScriptEngine by SmsProcessWorker.
 *
 * Exposes `globalThis.FuloosSmsEngine` with pure JSON-in / JSON-out functions so Kotlin
 * and the Web/Capacitor UI share 100% identical SMS parsing, routing, and ML categorisation.
 */
import { matchSmsToLink, extractCardLast4, type SmsAccountLink } from "./smsLinks.ts";
import {
  buildCapturedAlertDraft,
  prepareEngineState,
  processSingleSms,
  type RawNativeSms,
  type SmsEngineContext,
} from "./smsPipeline.ts";

export interface HeadlessBatchResult {
  decisions: Array<
    ReturnType<typeof processSingleSms> & {
      capturedAlertDraft?: ReturnType<typeof buildCapturedAlertDraft>;
    }
  >;
}

function processSmsJson(rawSmsJson: string, contextJson: string): string {
  const raw = JSON.parse(rawSmsJson) as RawNativeSms;
  const ctx = JSON.parse(contextJson) as SmsEngineContext;
  const decision = processSingleSms(raw, ctx);
  const capturedAlertDraft =
    decision.action === "needs_review"
      ? buildCapturedAlertDraft(decision)
      : undefined;
  return JSON.stringify({ ...decision, capturedAlertDraft });
}

function processBatchJson(rawListJson: string, contextJson: string): string {
  const list = JSON.parse(rawListJson) as RawNativeSms[];
  const ctx = JSON.parse(contextJson) as SmsEngineContext;
  const prepared = prepareEngineState(ctx);
  const decisions = list.map((raw) => {
    const decision = processSingleSms(raw, ctx, prepared);
    const capturedAlertDraft =
      decision.action === "needs_review"
        ? buildCapturedAlertDraft(decision)
        : undefined;
    return { ...decision, capturedAlertDraft };
  });
  return JSON.stringify({ decisions } satisfies HeadlessBatchResult);
}

function matchSenderJson(
  sender: string,
  body: string,
  linksJson: string,
): string {
  const links = JSON.parse(linksJson) as SmsAccountLink[];
  const card = extractCardLast4(body, null);
  const matched = matchSmsToLink(sender, card, links);
  return JSON.stringify({ matched: Boolean(matched), linkId: matched?.id ?? null, cardLast4: card });
}

const api = {
  version: "1.0.0",
  processSmsJson,
  processBatchJson,
  matchSenderJson,
};

(globalThis as unknown as { FuloosSmsEngine: typeof api }).FuloosSmsEngine = api;
export default api;

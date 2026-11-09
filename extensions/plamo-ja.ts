import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { addRun, buildPrompt, configFromEnv, emptyRun, JAPANESE_REPLY_WARNING, restoreEnabled, runNotice, splitMarkdown, STATE_ENTRY, translateQuestionsWithStats, translationSection, translateReply, withEnglishReminder } from "./plamo-ja-core.ts";

const START = "launchctl kickstart -k gui/$(id -u)/io.github.akitana-airtanker.t3code-pi-plamo-ja (log: ~/Library/Logs/t3code-pi-plamo-ja.log)";

export default function (pi: ExtensionAPI) {
  const config = configFromEnv(process.env);
  let enabled = config.enabled;
  let notified = false;
  let warnedJapanese = false;
  let run = emptyRun();
  // The switch lives in the session so a restarted Pi process (a model change in T3 Code restarts it) keeps it.
  pi.on("session_start", async (_event, ctx) => {
    const saved = restoreEnabled(ctx.sessionManager.getBranch());
    if (saved === undefined) return;
    enabled = saved;
    if (enabled) ctx.ui.notify("PLaMo 日本語表示: 有効（このスレッドの設定を引き継ぎました）", "info");
  });
  pi.on("agent_start", async () => { run = emptyRun(); });
  pi.on("agent_end", async (_event, ctx) => { if (enabled) ctx.ui.notify(runNotice(run), "info"); });
  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;
    if (!options) return;
    if (enabled) (options.sections ??= {}).reply_language = translationSection();
    else if (options.sections) delete options.sections.reply_language;
  });
  // Only the request is changed; the session keeps the user's messages as written. context_with_system,
  // not context: a changed list from context makes Pi fold mid-conversation prompt and tool patches
  // into one head, which would rewrite the cached prefix whenever a tool or section changes.
  pi.on("context_with_system", async (event) => (enabled ? { messages: withEnglishReminder(event.messages) } : undefined));
  pi.on("message_update", async (event, ctx) => {
    const streamEvent = event.assistantMessageEvent;
    if (!enabled || event.message?.role !== "assistant" || streamEvent?.type !== "text_end") return;
    // T3 Code currently forwards the mutated assistantMessageEvent after awaiting handlers; this is undocumented and is intentionally limited to text_end, not message_end, so both stored histories keep what the model wrote.
    // translateReply never throws: a part that times out is split and retried, and a piece that still fails stays English.
    const english = streamEvent.content;
    const parts = splitMarkdown(english);
    const started = performance.now();
    const result = await translateReply(parts, translate);
    streamEvent.content = result.text;
    run = addRun(run, {
      parts: result.translatedParts,
      untranslatedPieces: result.untranslatedPieces,
      japaneseParts: result.japaneseParts,
      ms: performance.now() - started,
    });
    warnIfJapanese(result.japaneseParts, ctx);
    if (result.untranslatedPieces > 0 && !notified) {
      notified = true;
      const all = result.translatedParts === 0;
      ctx.ui.notify(all
        ? `PLaMo 翻訳に失敗しました。英語のまま表示します（サーバ: ${config.endpoint}）`
        : `PLaMo 翻訳が一部終わらなかったため、${result.untranslatedPieces} か所を英語のまま表示します`, "warning");
    }
  });
  // Questions to the user are tool arguments, not reply text, so text_end never sees them.
  // Pi documents mutating event.input in place as the way to change a call's arguments.
  pi.on("tool_call", async (event, ctx) => {
    if (!enabled || event.toolName !== "ask_user_question" || !Array.isArray(event.input?.questions)) return undefined;
    const started = performance.now();
    const { questions, stats } = await translateQuestionsWithStats(event.input.questions, translate);
    event.input.questions = questions;
    run = addRun(run, { parts: stats.translated, untranslatedPieces: stats.english, japaneseParts: stats.japanese, ms: performance.now() - started });
    warnIfJapanese(stats.japanese, ctx);
    return undefined;
  });

  function warnIfJapanese(count: number, ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): void {
    if (count === 0 || warnedJapanese) return;
    warnedJapanese = true;
    ctx.ui.notify(JAPANESE_REPLY_WARNING, "warning");
  }
  pi.registerCommand("plamo", {
    description: "PLaMo 日本語表示を切り替える (on|off|status)",
    handler: async (arg, ctx) => {
      const command = arg.trim();
      if (command === "on" || command === "off") {
        enabled = command === "on";
        if (!enabled) { notified = false; warnedJapanese = false; }
        pi.appendEntry(STATE_ENTRY, { enabled });
        // Rebuild the next prompt through before_agent_start; do not rewrite prompt-captured systemPrompt.
        if (enabled) {
          try {
            const response = await fetch(`${new URL(config.endpoint).origin}/health`, { signal: AbortSignal.timeout(10_000) });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
          } catch (error) {
            // A busy server answers late; only a refused or failed connection means it is not running.
            const busy = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
            ctx.ui.notify(busy
              ? "PLaMo 日本語表示: 有効（サーバの応答が遅れています。混雑しているときは翻訳に時間がかかります）"
              : `PLaMo サーバに接続できません。翻訳は有効のままです。起動: ${START}`, "warning");
            return;
          }
        }
        ctx.ui.notify(`PLaMo 日本語表示: ${enabled ? "有効" : "無効"}`, "info");
      } else if (command === "status" || command === "") {
        ctx.ui.notify(`PLaMo 日本語表示: ${enabled ? "有効" : "無効"} / endpoint: ${config.endpoint}`, "info");
      } else ctx.ui.notify("使い方: /plamo on|off|status", "warning");
    },
  });

  async function translate(text: string): Promise<string> {
    const response = await fetch(`${config.endpoint}/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(config.model ? { model: config.model } : {}),
        prompt: buildPrompt(text, config.form), temperature: 0, max_tokens: 8192,
        stop: ["<|plamo:tag|>", "<|plamo:bos|>"],
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || !("choices" in data) || !Array.isArray(data.choices)) throw new Error("invalid response");
    const choice: unknown = data.choices[0];
    if (typeof choice !== "object" || choice === null || !("text" in choice) || typeof choice.text !== "string") throw new Error("invalid completion");
    return choice.text.trim();
  }
}

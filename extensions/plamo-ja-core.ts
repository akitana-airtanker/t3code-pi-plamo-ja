export type Form = "polite" | "plain";
export interface Config {
  endpoint: string;
  model?: string;
  form: Form;
  enabled: boolean;
  /** Limit for one translation request. */
  timeoutMs: number;
}
export type Part = { kind: "translate"; text: string } | { kind: "keep"; text: string };

export function configFromEnv(env: Record<string, string | undefined>): Config {
  const form = env.PLAMO_JA_FORM === "plain" ? "plain" : "polite";
  return {
    endpoint: (env.PLAMO_JA_ENDPOINT || "http://127.0.0.1:18080/v1").replace(/\/+$/, ""),
    ...(env.PLAMO_JA_MODEL ? { model: env.PLAMO_JA_MODEL } : {}),
    form,
    enabled: env.PLAMO_JA === "1",
    timeoutMs: Number(env.PLAMO_JA_TIMEOUT_MS) > 0 ? Number(env.PLAMO_JA_TIMEOUT_MS) : 90_000,
  };
}

/** Appended to every user message in the context sent to the model, never to the stored history.
 *  The system prompt section alone loses to a conversation, context files, and skills written in
 *  Japanese; this sits next to the newest message. It goes on every user message, not only the
 *  newest, so the request prefix stays the same from turn to turn and prompt caching keeps working. */
export const ENGLISH_REMINDER = "(Reply in English. The user reads a Japanese machine translation of your reply.)";

/** Pure and idempotent: each user message ends with exactly one reminder text block (string content
 *  becomes one text block first), and every other message, and every earlier block of a user
 *  message, is returned unchanged. System messages keep their places, so prompt and tool patches in
 *  the middle of a conversation are not folded into the head. */
export function withEnglishReminder<T extends { role: string; content?: unknown }>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    if (message.role !== "user") return message;
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    if (!Array.isArray(content)) return message;
    const last: unknown = content[content.length - 1];
    const done = typeof last === "object" && last !== null && (last as { type?: unknown }).type === "text" && (last as { text?: unknown }).text === ENGLISH_REMINDER;
    return done ? message : { ...message, content: [...content, { type: "text", text: ENGLISH_REMINDER }] };
  });
}

export function translationSection(): string {
  return "Always write your answer in English. This instruction takes precedence over any other language preference, including a request to respond in Japanese. The user reads a Japanese translation shown in the interface; your actual response must remain English. A small machine translator reads it, so write complete, explicit sentences and do not leave out words: write 'Check that X is still true.', not 'X still holds.' Prefer plain words to idioms and figures of speech.";
}

export function escapePfmlText(text: string): string {
  return text.replaceAll("<|plamo:", "<|plamo :");
}

export function buildPrompt(text: string, form: Form): string {
  return `<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>${escapePfmlText(text)}<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>ja<|plamo:key|>form<|plamo:val|>${form}<|plamo:msg|>`;
}

function fencedEnd(lines: string[], start: number): number | undefined {
  const opener = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(lines[start].replace(/\n$/, ""));
  if (!opener || (opener[2][0] === "`" && opener[3].includes("`"))) return undefined;
  const marker = opener[2][0];
  const width = opener[2].length;
  for (let i = start + 1; i < lines.length; i++) {
    const close = new RegExp(`^ {0,3}${marker === "`" ? "`" : "~"}{${width},}\\s*$`);
    if (close.test(lines[i].replace(/\n$/, ""))) return i;
  }
  return lines.length - 1;
}

export function splitMarkdown(text: string): Part[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const parts: Part[] = [];
  let plain = "";
  const flush = () => { if (plain) parts.push({ kind: "translate", text: plain }); plain = ""; };
  for (let i = 0; i < lines.length; i++) {
    const end = fencedEnd(lines, i);
    if (end !== undefined) {
      flush();
      parts.push({ kind: "keep", text: lines.slice(i, end + 1).join("") });
      i = end;
    } else plain += lines[i];
  }
  flush();
  return parts;
}

/** Japanese characters (kana, CJK ideographs, Japanese punctuation and full-width forms) and Latin
 *  letters, counted outside inline code and URLs, which are English in either language. */
export function scriptCounts(text: string): { japanese: number; latin: number } {
  const count = (prose: string) => ({
    japanese: (prose.match(/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/g) ?? []).length,
    latin: (prose.match(/[A-Za-z]/g) ?? []).length,
  });
  const prose = text.replace(/`[^`\n]*`/g, "").replace(/https?:\/\/\S+/g, "");
  // An English reply that discusses Japanese text quotes it in 「」『』 or as a > block. Those quotes
  // say nothing about the language of the reply, so they are left out unless nothing else is left.
  const outside = count(prose.replace(/「[^「」]*」|『[^『』]*』/g, "").replace(/^[ \t]*>.*$/gm, ""));
  return outside.japanese + outside.latin > 0 ? outside : count(prose);
}

/** Text the model already wrote in Japanese, which happens when another language rule outranks the
 *  English instruction. A tie or text without either script counts as English: translating Japanese
 *  costs one request, while skipping English would leave it on screen. */
export function isMostlyJapanese(text: string): boolean {
  const { japanese, latin } = scriptCounts(text);
  return japanese > latin;
}

export interface Segment {
  japanese: boolean;
  text: string;
}

/** Splits prose into runs of paragraphs, each run either already Japanese or to be translated, so
 *  an English reply with one Japanese paragraph still gets its English translated. A paragraph with
 *  neither script (a rule, a list of numbers) joins the run before it. Joining the runs gives the
 *  text back, and neighbouring runs always differ. */
export function segmentByLanguage(text: string): Segment[] {
  const chunks = text.split(/(\n[ \t]*\n)/);
  const segments: Segment[] = [];
  for (let i = 0; i < chunks.length; i += 2) {
    const unit = chunks[i] + (chunks[i + 1] ?? "");
    if (unit === "") continue;
    const { japanese, latin } = scriptCounts(unit);
    const last = segments[segments.length - 1];
    const kind = japanese + latin === 0 ? last?.japanese : japanese > latin;
    if (last && (kind === undefined || kind === last.japanese)) last.text += unit;
    else segments.push({ japanese: kind ?? false, text: unit });
  }
  // A leading paragraph with neither script was given a kind before it had a neighbour; merge it on.
  if (segments.length > 1 && segments[0].japanese !== segments[1].japanese) {
    const { japanese, latin } = scriptCounts(segments[0].text);
    if (japanese + latin === 0) segments.splice(0, 2, { japanese: segments[1].japanese, text: segments[0].text + segments[1].text });
  }
  return segments;
}

export interface Question {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect?: boolean;
}

/** ask_user_question's schema limits. A translation that breaks one keeps the English text. */
export const HEADER_MAX = 16;
export const LABEL_MAX = 60;

/** What happened to the text fields of the question dialogs, counted per field. */
export interface QuestionStats {
  /** Fields shown as a translation. */
  translated: number;
  /** Fields the model wrote in Japanese, shown as written and never sent. */
  japanese: number;
  /** Fields shown in English: the translation failed, was empty, broke a limit, or collided. */
  english: number;
}

/** Returns translated copies of the questions. `preview` (code, mockups) is never translated.
 *  A field falls back to English when its translation fails, is empty, or breaks a limit,
 *  and a question keeps its English labels when two translated labels would collide. */
export async function translateQuestionsWithStats(
  questions: Question[],
  translate: (text: string) => Promise<string>,
): Promise<{ questions: Question[]; stats: QuestionStats }> {
  type Field = { text: string; outcome: "translated" | "japanese" | "english" | "blank" };
  const safe = async (text: string, max = Infinity): Promise<Field> => {
    if (text.trim() === "") return { text, outcome: "blank" };
    if (isMostlyJapanese(text)) return { text, outcome: "japanese" };
    try {
      const japanese = (await translate(text.trim())).trim();
      return japanese !== "" && [...japanese].length <= max ? { text: japanese, outcome: "translated" } : { text, outcome: "english" };
    } catch {
      return { text, outcome: "english" };
    }
  };
  const fields: Field[] = [];
  const out = await Promise.all(questions.map(async (q) => {
    const [question, header, translatedLabels, descriptions] = await Promise.all([
      safe(q.question),
      safe(q.header, HEADER_MAX),
      Promise.all(q.options.map((o) => safe(o.label, LABEL_MAX))),
      Promise.all(q.options.map((o) => safe(o.description))),
    ]);
    const unique = new Set(translatedLabels.map((l) => l.text)).size === translatedLabels.length;
    const labels = unique ? translatedLabels : q.options.map((o, i): Field => ({
      text: o.label,
      outcome: translatedLabels[i].outcome === "translated" ? "english" : translatedLabels[i].outcome,
    }));
    fields.push(question, header, ...labels, ...descriptions);
    return {
      ...q,
      question: question.text,
      header: header.text,
      options: q.options.map((o, i) => ({ ...o, label: labels[i].text, description: descriptions[i].text })),
    };
  }));
  const count = (outcome: Field["outcome"]) => fields.filter((f) => f.outcome === outcome).length;
  return { questions: out, stats: { translated: count("translated"), japanese: count("japanese"), english: count("english") } };
}

/** translateQuestionsWithStats without the report. */
export async function translateQuestions(questions: Question[], translate: (text: string) => Promise<string>): Promise<Question[]> {
  return (await translateQuestionsWithStats(questions, translate)).questions;
}

/** A piece longer than this is split into lines when the whole part has to be split. */
export const PIECE_MAX = 600;
/** Pieces translated at the same time after a fallback. */
export const FALLBACK_CONCURRENCY = 4;

/** Paragraphs, and lines of any paragraph longer than PIECE_MAX. Joining the pieces gives the text back. */
export function splitProse(text: string): string[] {
  return text
    .split(/(\n[ \t]*\n)/)
    .flatMap((chunk) => (chunk.length > PIECE_MAX ? chunk.split(/(\n)/) : [chunk]))
    .filter((piece) => piece !== "");
}

/** Translates only the non-blank core. The surrounding whitespace stays as written, because the
 *  translator trims it and a fence must still start its own line. An empty result is a failure. */
async function translateCore(text: string, translate: (text: string) => Promise<string>): Promise<string> {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  const japanese = (await translate(core)).trim();
  if (japanese === "") throw new Error("empty translation");
  return `${lead}${japanese}${trail}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ReplyTranslation {
  text: string;
  /** Runs of prose shown translated, in whole or in part. */
  translatedParts: number;
  /** Runs whose one-request translation failed and were split. */
  splitParts: number;
  /** Pieces left in English because their own translation failed too. */
  untranslatedPieces: number;
  /** Runs of paragraphs the model wrote in Japanese, shown as written and never sent. */
  japaneseParts: number;
}

/** Prose between code blocks is cut into runs with segmentByLanguage. A run already in Japanese is
 *  shown as written. Any other run is translated in one request first, which keeps the most context.
 *  When that request fails (timeout, error, or empty output), the run is split with splitProse and
 *  the pieces are translated FALLBACK_CONCURRENCY at a time; a piece that still fails stays in English.
 *  Fenced code blocks and blank parts are never sent. */
export async function translateReply(parts: Part[], translate: (text: string) => Promise<string>): Promise<ReplyTranslation> {
  let translatedParts = 0;
  let splitParts = 0;
  let untranslatedPieces = 0;
  let japaneseParts = 0;
  const out: string[] = [];
  for (const part of parts) {
    if (part.kind === "keep" || part.text.trim() === "") {
      out.push(part.text);
      continue;
    }
    for (const segment of segmentByLanguage(part.text)) {
      if (segment.text.trim() === "") {
        out.push(segment.text);
        continue;
      }
      if (segment.japanese) {
        japaneseParts++;
        out.push(segment.text);
        continue;
      }
      try {
        out.push(await translateCore(segment.text, translate));
        translatedParts++;
        continue;
      } catch {
        splitParts++;
      }
      let failed = 0;
      const pieces = splitProse(segment.text);
      const translated = await mapLimit(pieces, FALLBACK_CONCURRENCY, async (piece) => {
        if (piece.trim() === "") return piece;
        try {
          return await translateCore(piece, translate);
        } catch {
          failed++;
          return piece;
        }
      });
      untranslatedPieces += failed;
      if (failed < pieces.filter((piece) => piece.trim() !== "").length) translatedParts++;
      out.push(translated.join(""));
    }
  }
  return { text: out.join(""), translatedParts, splitParts, untranslatedPieces, japaneseParts };
}

/** translateReply without the report. */
export async function translateParts(parts: Part[], translate: (text: string) => Promise<string>): Promise<string> {
  return (await translateReply(parts, translate)).text;
}

/** customType of the session entry that records /plamo on|off. Pi keeps custom entries out of the model's context. */
export const STATE_ENTRY = "plamo-ja-state";

/** The switch saved last on the given branch, or undefined when this session never saved one. */
export function restoreEnabled(entries: readonly unknown[]): boolean | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (typeof e !== "object" || e === null) continue;
    const { type, customType, data } = e as { type?: unknown; customType?: unknown; data?: unknown };
    if (type !== "custom" || customType !== STATE_ENTRY || typeof data !== "object" || data === null) continue;
    const enabled = (data as { enabled?: unknown }).enabled;
    if (typeof enabled === "boolean") return enabled;
  }
  return undefined;
}

/** What one agent run translated, summed over its text blocks and question dialogs. */
export interface RunStats {
  /** Parts sent to the translator. */
  parts: number;
  untranslatedPieces: number;
  /** Parts the model wrote in Japanese and that were shown without translation. */
  japaneseParts: number;
  ms: number;
}

export function emptyRun(): RunStats {
  return { parts: 0, untranslatedPieces: 0, japaneseParts: 0, ms: 0 };
}

export function addRun(a: RunStats, b: RunStats): RunStats {
  return {
    parts: a.parts + b.parts,
    untranslatedPieces: a.untranslatedPieces + b.untranslatedPieces,
    japaneseParts: a.japaneseParts + b.japaneseParts,
    ms: a.ms + b.ms,
  };
}

/** The line shown at the end of each run while translation is on. Japanese parts are reported so that
 *  a model ignoring the English instruction is visible instead of looking like a translated reply. */
export function runNotice(run: RunStats): string {
  const items = [
    run.parts > 0 ? `${run.parts}か所を訳し、${(run.ms / 1000).toFixed(1)}秒` : "",
    run.untranslatedPieces > 0 ? `${run.untranslatedPieces}か所は英語のまま` : "",
    run.japaneseParts > 0 ? `${run.japaneseParts}か所は日本語で返ってきたため訳していません` : "",
  ].filter((item) => item !== "");
  return `PLaMo 翻訳: 有効（${items.join("。") || "この返答で訳した文はありません"}）`;
}

/** Shown once per Pi process while on (reset by /plamo off) when the model answers in Japanese
 *  although the English instruction is on. */
export const JAPANESE_REPLY_WARNING =
  "PLaMo 翻訳: モデルが英語ではなく日本語で返答したため、その部分は訳さずに表示します。" +
  "日本語の会話や指示に引っ張られたか、英語で答える指示より優先される言語の設定（Claude Code の ~/.claude/settings.json の language など）がある可能性があります";

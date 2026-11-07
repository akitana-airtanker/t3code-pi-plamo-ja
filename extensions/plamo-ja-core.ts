export type Form = "polite" | "plain";
export interface Config {
  endpoint: string;
  model?: string;
  form: Form;
  enabled: boolean;
}
export type Part = { kind: "translate"; text: string } | { kind: "keep"; text: string };

export function configFromEnv(env: Record<string, string | undefined>): Config {
  const form = env.PLAMO_JA_FORM === "plain" ? "plain" : "polite";
  return {
    endpoint: (env.PLAMO_JA_ENDPOINT || "http://127.0.0.1:18080/v1").replace(/\/+$/, ""),
    ...(env.PLAMO_JA_MODEL ? { model: env.PLAMO_JA_MODEL } : {}),
    form,
    enabled: env.PLAMO_JA === "1",
  };
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

export interface Question {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect?: boolean;
}

/** ask_user_question's schema limits. A translation that breaks one keeps the English text. */
export const HEADER_MAX = 16;
export const LABEL_MAX = 60;

/** Returns translated copies of the questions. `preview` (code, mockups) is never translated.
 *  A field falls back to English when its translation fails, is empty, or breaks a limit,
 *  and a question keeps its English labels when two translated labels would collide. */
export async function translateQuestions(questions: Question[], translate: (text: string) => Promise<string>): Promise<Question[]> {
  const safe = async (text: string, max = Infinity): Promise<string> => {
    if (text.trim() === "") return text;
    try {
      const japanese = (await translate(text.trim())).trim();
      return japanese !== "" && [...japanese].length <= max ? japanese : text;
    } catch {
      return text;
    }
  };
  return Promise.all(questions.map(async (q) => {
    const [question, header, labels, descriptions] = await Promise.all([
      safe(q.question),
      safe(q.header, HEADER_MAX),
      Promise.all(q.options.map((o) => safe(o.label, LABEL_MAX))),
      Promise.all(q.options.map((o) => safe(o.description))),
    ]);
    const unique = new Set(labels).size === labels.length;
    return {
      ...q,
      question,
      header,
      options: q.options.map((o, i) => ({ ...o, label: unique ? labels[i] : o.label, description: descriptions[i] })),
    };
  }));
}

/** Translates only the non-blank core of each prose part. The surrounding whitespace stays
 *  as written, because the translator trims it and a fence must still start its own line. */
export async function translateParts(parts: Part[], translate: (text: string) => Promise<string>): Promise<string> {
  const translated: string[] = [];
  for (const part of parts) {
    if (part.kind === "keep" || part.text.trim() === "") {
      translated.push(part.text);
      continue;
    }
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part.text)!;
    const japanese = (await translate(core)).trim();
    if (japanese === "") throw new Error("empty translation");
    translated.push(`${lead}${japanese}${trail}`);
  }
  return translated.join("");
}

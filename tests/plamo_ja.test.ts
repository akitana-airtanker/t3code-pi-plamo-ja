import assert from "node:assert/strict";
import { test } from "node:test";
import { addRun, buildPrompt, emptyRun, ENGLISH_REMINDER, isMostlyJapanese, withEnglishReminder, restoreEnabled, runNotice, scriptCounts, segmentByLanguage, STATE_ENTRY, configFromEnv, escapePfmlText, HEADER_MAX, LABEL_MAX, PIECE_MAX, splitMarkdown, splitProse, translateParts, translateReply, translateQuestions, translateQuestionsWithStats, type Part, type Question } from "../extensions/plamo-ja-core.ts";

/** The runs of prose the extension sends to the translator, in order. */
const sentRuns = (parts: Part[]) => parts.flatMap((part) =>
  part.kind === "translate" && part.text.trim() !== "" ? segmentByLanguage(part.text).filter((s) => !s.japanese && s.text.trim() !== "").map((s) => s.text) : []);

function generated(seed: number): string {
  let state = seed;
  const rand = (n: number) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n; };
  const atoms = ["words ", "日本語? ", "\n", "  ", "`inline` ", "<|plamo:tag|>"];
  const chunks: string[] = [];
  for (let i = 0; i < 40; i++) {
    if (rand(4) === 0) {
      const fence = rand(2) ? "```ts\nconst x = 1;\n```\n" : "~~~\nraw <|plamo:tag|>\n~~~\n";
      chunks.push(fence);
    } else chunks.push(atoms[rand(atoms.length)]);
  }
  return chunks.join("");
}

test("generated markdown partitions reconstruct exactly, preserve fenced bytes and ordering", async () => {
  for (let seed = 1; seed <= 250; seed++) {
    const source = generated(seed);
    const parts = splitMarkdown(source);
    assert.equal(parts.map((part) => part.text).join(""), source);
    const translatedInputs: string[] = [];
    const output = await translateParts(parts, async (text) => { translatedInputs.push(text); return `[${text}]`; });
    for (const input of translatedInputs) assert.equal(input, input.trim());
    assert.equal(output.replace(/[[\]]/g, "").replace(/\s/g, ""), source.replace(/\s/g, ""));
    assert.equal(translatedInputs.length, sentRuns(parts).length);
  }
});

test("a translator that trims its output cannot move a fence off its line or drop surrounding whitespace", async () => {
  for (let seed = 1; seed <= 250; seed++) {
    const source = generated(seed);
    const parts = splitMarkdown(source);
    const output = await translateParts(parts, async (text) => `<${text.trim()}>`);
    const expected = parts.map((part) => {
      if (part.kind === "keep" || part.text.trim() === "") return part.text;
      return segmentByLanguage(part.text).map((segment) => {
        if (segment.japanese || segment.text.trim() === "") return segment.text;
        const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(segment.text)!;
        return `${lead}<${core}>${trail}`;
      }).join("");
    }).join("");
    assert.equal(output, expected);
  }
});

test("an empty translation is a failure, so the text stays English", async () => {
  const r = await translateReply([{ kind: "translate", text: "Hello." }], async () => "  ");
  assert.deepEqual(r, { text: "Hello.", translatedParts: 0, splitParts: 1, untranslatedPieces: 1, japaneseParts: 0 });
});

test("splitProse pieces join back to the input and only an unbreakable line exceeds the limit", () => {
  for (let seed = 1; seed <= 250; seed++) {
    const source = generated(seed).repeat(1 + (seed % 30));
    const pieces = splitProse(source);
    assert.equal(pieces.join(""), source);
    for (const piece of pieces) assert.ok(piece.length <= PIECE_MAX || !piece.includes("\n"), "a long piece must be a single line");
  }
});

test("a part whose one-request translation fails falls back to pieces, and only failed pieces stay English", async () => {
  for (let seed = 1; seed <= 250; seed++) {
    const source = generated(seed).repeat(1 + (seed % 20));
    const parts = splitMarkdown(source);
    const limit = 40 + (seed % 7) * 60; // a "timeout" for long requests
    const failEvery = 2 + (seed % 5); // and some pieces fail on their own
    let calls = 0;
    const translate = async (t: string) => {
      calls++;
      if (t.length > limit || calls % failEvery === 0) throw new Error("timeout");
      return `<${t}>`;
    };
    const r = await translateReply(parts, translate);
    // Removing the markers gives the source back: every piece is either its translation or the original.
    assert.equal(r.text.replace(/[<>]/g, ""), source.replace(/[<>]/g, ""));
    const fences = parts.filter((p) => p.kind === "keep").map((p) => p.text);
    let at = 0;
    for (const f of fences) {
      const i = r.text.indexOf(f, at);
      assert.ok(i >= 0, "fences survive in order");
      at = i + f.length;
    }
    assert.ok(r.untranslatedPieces === 0 || r.splitParts > 0);
  }
});

test("when nothing fails, nothing is split", async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const r = await translateReply(splitMarkdown(generated(seed)), async (t) => `[${t}]`);
    assert.equal(r.splitParts, 0);
    assert.equal(r.untranslatedPieces, 0);
  }
});

function questions(seed: number): Question[] {
  let state = seed;
  const rand = (n: number) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n; };
  const word = () => ["Model", "Scope", "2B (Recommended)", "", "Use it", "x".repeat(rand(80))][rand(6)];
  return Array.from({ length: 1 + rand(4) }, () => ({
    question: `${word()} ?`,
    header: word(),
    multiSelect: rand(2) === 0,
    options: Array.from({ length: 2 + rand(3) }, (_, i) => ({
      label: `${word()} ${i}`,
      description: word(),
      ...(rand(2) ? { preview: "```ts\nconst a = 1;\n```" } : {}),
    })),
  }));
}

test("translated questions keep their shape, previews, and the tool's limits", async () => {
  // A translator that sometimes fails, sometimes returns nothing, sometimes expands the text,
  // and sometimes maps different labels to the same text.
  const translators = [
    async (t: string) => `訳:${t}`,
    async (t: string) => `訳:${t}${t}${t}`,
    async () => "同じ",
    async () => "  ",
    async () => { throw new Error("down"); },
  ];
  for (let seed = 1; seed <= 200; seed++) {
    const source = questions(seed);
    const before = JSON.stringify(source);
    const out = await translateQuestions(source, translators[seed % translators.length]);
    assert.equal(JSON.stringify(source), before, "input must not be mutated");
    assert.equal(out.length, source.length);
    out.forEach((q, qi) => {
      const s = source[qi];
      assert.equal(q.multiSelect, s.multiSelect);
      assert.equal(q.options.length, s.options.length);
      assert.ok([...q.header].length <= Math.max(HEADER_MAX, [...s.header].length));
      assert.equal(new Set(q.options.map((o) => o.label)).size, new Set(s.options.map((o) => o.label)).size);
      q.options.forEach((o, i) => {
        assert.equal(o.preview, s.options[i].preview);
        assert.ok([...o.label].length <= Math.max(LABEL_MAX, [...s.options[i].label].length));
        assert.ok(o.label.trim() !== "", "a label never becomes blank");
      });
    });
  }
});

test("PFML3 prompt escapes embedded control prefix and configuration defaults are closed", () => {
  const value = "A <|plamo:msg|> B";
  assert.equal(escapePfmlText(value), "A <|plamo :msg|> B");
  assert.ok(buildPrompt(value, "polite").includes("A <|plamo :msg|> B"));
  assert.deepEqual(configFromEnv({}), { endpoint: "http://127.0.0.1:18080/v1", form: "polite", enabled: false, timeoutMs: 90_000 });
  assert.deepEqual(configFromEnv({ PLAMO_JA_ENDPOINT: "http://localhost:4///", PLAMO_JA_MODEL: "m", PLAMO_JA_FORM: "plain", PLAMO_JA: "1", PLAMO_JA_TIMEOUT_MS: "5000" }), {
    endpoint: "http://localhost:4", model: "m", form: "plain", enabled: true, timeoutMs: 5000,
  });
});

test("the latest saved switch on the current branch wins, and only this extension's entries count", () => {
  const entry = (customType: string, data: unknown) => ({ type: "custom", customType, data });
  assert.equal(restoreEnabled([]), undefined);
  assert.equal(restoreEnabled([{ type: "message" }, entry("other", { enabled: true })]), undefined);
  for (let seed = 1; seed <= 200; seed++) {
    let state = seed;
    const rand = (n: number) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n; };
    const entries: unknown[] = [];
    let last: boolean | undefined;
    for (let i = 0; i < 12; i++) {
      const k = rand(4);
      if (k === 0) { const v = rand(2) === 0; entries.push(entry(STATE_ENTRY, { enabled: v })); last = v; }
      else if (k === 1) entries.push(entry("other", { enabled: rand(2) === 0 }));
      else if (k === 2) entries.push(entry(STATE_ENTRY, { broken: true }));
      else entries.push({ type: "message" });
    }
    assert.equal(restoreEnabled(entries), last);
  }
});

test("a run notice reports what was translated, what stayed English, and what came back in Japanese", () => {
  assert.equal(runNotice(emptyRun()), "PLaMo 翻訳: 有効（この返答で訳した文はありません）");
  let run = addRun(emptyRun(), { parts: 3, untranslatedPieces: 0, japaneseParts: 0, ms: 2100 });
  assert.equal(runNotice(run), "PLaMo 翻訳: 有効（3か所を訳し、2.1秒）");
  run = addRun(run, { parts: 2, untranslatedPieces: 1, japaneseParts: 0, ms: 900 });
  assert.equal(runNotice(run), "PLaMo 翻訳: 有効（5か所を訳し、3.0秒。1か所は英語のまま）");
  run = addRun(run, { parts: 0, untranslatedPieces: 0, japaneseParts: 2, ms: 0 });
  assert.equal(runNotice(run), "PLaMo 翻訳: 有効（5か所を訳し、3.0秒。1か所は英語のまま。2か所は日本語で返ってきたため訳していません）");
  assert.equal(runNotice({ ...emptyRun(), japaneseParts: 1 }), "PLaMo 翻訳: 有効（1か所は日本語で返ってきたため訳していません）");
  // Nothing translated: failures and Japanese parts are still reported.
  assert.equal(runNotice({ ...emptyRun(), untranslatedPieces: 3 }), "PLaMo 翻訳: 有効（3か所は英語のまま）");
  assert.equal(runNotice({ ...emptyRun(), untranslatedPieces: 2, japaneseParts: 1 }), "PLaMo 翻訳: 有効（2か所は英語のまま。1か所は日本語で返ってきたため訳していません）");
});

function scriptText(seed: number): { text: string; rand: (n: number) => number } {
  let state = seed;
  const rand = (n: number) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n; };
  const atoms = ["の", "翻訳", "スレッド", "。", "、", "（例）", "word ", "T3 Code ", "x", "\n", " ", "1. ", "**", "Ａ"];
  return { text: Array.from({ length: rand(60) }, () => atoms[rand(atoms.length)]).join(""), rand };
}

test("the Japanese check counts only the two scripts, ignores inline code and URLs, and is monotone", () => {
  const extras = ["`someVeryLongEnglishIdentifier()`", "https://example.com/a/long/english/path?query=value", "`a b c`"];
  for (let seed = 1; seed <= 500; seed++) {
    const { text, rand } = scriptText(seed);
    const { japanese, latin } = scriptCounts(text);
    assert.equal(isMostlyJapanese(text), japanese > latin);
    // Inline code and URLs are English in either language, so inserting them never changes the decision.
    const at = rand(text.length + 1);
    const withExtra = `${text.slice(0, at)} ${extras[rand(extras.length)]} ${text.slice(at)}`;
    assert.equal(isMostlyJapanese(withExtra), isMostlyJapanese(text));
    // More Japanese never turns Japanese into English, and more English never turns English into Japanese.
    if (isMostlyJapanese(text)) assert.ok(isMostlyJapanese(`${text}日本語`));
    else assert.ok(!isMostlyJapanese(`${text}English`));
  }
  assert.ok(isMostlyJapanese("未対応の必須作業はありません。今後の Pi や T3 Code の更新で動作が変わる可能性はあります。"));
  assert.ok(!isMostlyJapanese("The notice says 「有効」 when translation is on."));
  assert.ok(!isMostlyJapanese("1. 2. 3."), "text without either script counts as English and is translated");
});

test("parts the model wrote in Japanese are shown byte for byte, never sent, and counted", async () => {
  const japanese = "この返答は日本語で書かれています。`git stash` を使います。\n";
  for (let seed = 1; seed <= 250; seed++) {
    const source = generated(seed).split("```").map((chunk, i) => (i % 3 === 0 && seed % 2 ? japanese + chunk : chunk)).join("```");
    const parts = splitMarkdown(source);
    const inputs: string[] = [];
    const r = await translateReply(parts, async (t) => { inputs.push(t); return `<${t}>`; });
    assert.ok(inputs.every((t) => !isMostlyJapanese(t)), "a Japanese run is never sent");
    const runs = parts.flatMap((p) => (p.kind === "translate" && p.text.trim() !== "" ? segmentByLanguage(p.text) : []));
    const japaneseRuns = runs.filter((s) => s.japanese && s.text.trim() !== "");
    assert.equal(r.japaneseParts, japaneseRuns.length);
    for (const s of japaneseRuns) assert.ok(r.text.includes(s.text), "a Japanese run is shown byte for byte");
    assert.equal(r.translatedParts, runs.filter((s) => !s.japanese && s.text.trim() !== "").length);
  }
});

test("the English reminder ends every user message once, leaves everything else alone, and is idempotent", () => {
  for (let seed = 1; seed <= 300; seed++) {
    let state = seed;
    const rand = (n: number) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n; };
    const content = (): unknown => [
      `質問 ${seed}`,
      [{ type: "text", text: "これを直して" }],
      [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "see" }],
      [],
      undefined,
    ][rand(5)];
    const roles = ["user", "assistant", "toolResult", "custom", "system"];
    const messages = Array.from({ length: rand(12) }, (_, i) => ({ role: roles[rand(roles.length)], content: content(), timestamp: i }));
    const before = JSON.stringify(messages);
    const out = withEnglishReminder(messages);
    assert.equal(JSON.stringify(messages), before, "input must not be mutated");
    assert.deepEqual(withEnglishReminder(out), out, "idempotent");
    assert.equal(out.length, messages.length);
    out.forEach((m, i) => {
      const s = messages[i];
      if (s.role !== "user" || !(typeof s.content === "string" || Array.isArray(s.content))) return assert.equal(m, s);
      assert.equal(m.timestamp, s.timestamp);
      const blocks = m.content as { type: string; text?: string }[];
      const original = typeof s.content === "string" ? [{ type: "text", text: s.content }] : s.content;
      assert.deepEqual(blocks.slice(0, -1), original, "earlier blocks are unchanged");
      assert.deepEqual(blocks.at(-1), { type: "text", text: ENGLISH_REMINDER });
      assert.equal(blocks.filter((b) => b.text === ENGLISH_REMINDER).length, 1);
    });
  }
});

test("question fields already in Japanese are never sent", async () => {
  const q: Question = { question: "どちらにしますか？", header: "モデル", options: [{ label: "2Bを使う", description: "精度を優先" }, { label: "Use 0.8B", description: "Faster" }] };
  const inputs: string[] = [];
  const [out] = await translateQuestions([q], async (t) => { inputs.push(t); return `訳:${t}`; });
  assert.deepEqual(inputs.sort(), ["Faster", "Use 0.8B"]);
  assert.equal(out.question, q.question);
  assert.equal(out.options[0].label, "2Bを使う");
  assert.equal(out.options[1].label, "訳:Use 0.8B");
});

test("language runs join back to the text, alternate, and contain only paragraphs of their kind", () => {
  const paragraphs = ["This is English.", "これは日本語の段落です。", "---", "1. 2. 3.", "「日本語の引用」 is quoted here.", "> 引用した日本語の行\nand an English comment.", "`code` だけではなく日本語もあります。", ""];
  for (let seed = 1; seed <= 400; seed++) {
    let state = seed;
    const rand = (n: number) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n; };
    const seps = ["\n\n", "\n \n", "\n\t\n\n"];
    const text = Array.from({ length: rand(9) }, () => paragraphs[rand(paragraphs.length)]).join(seps[rand(seps.length)]) + (rand(2) ? "\n" : "");
    const segments = segmentByLanguage(text);
    assert.equal(segments.map((s) => s.text).join(""), text);
    for (let i = 1; i < segments.length; i++) assert.notEqual(segments[i].japanese, segments[i - 1].japanese);
    for (const s of segments) {
      for (const unit of s.text.split(/\n[ \t]*\n/)) {
        const { japanese, latin } = scriptCounts(unit);
        if (japanese + latin === 0) continue;
        assert.equal(japanese > latin, s.japanese, `paragraph ${JSON.stringify(unit)} is in a run of the other kind`);
      }
    }
  }
});

// Hand-labelled examples. Expected kinds are written by hand, not computed with the classifier.
test("labelled replies: quotes of Japanese do not make an English reply Japanese", () => {
  const kinds = (text: string) => segmentByLanguage(text).filter((s) => s.text.trim() !== "").map((s) => (s.japanese ? "ja" : "en"));
  assert.deepEqual(kinds("The sentence 「コードブロックを含む33回答では、すべてのコードが1バイトも変わりませんでした。」 packs two results into one line. Split it."), ["en"]);
  assert.deepEqual(kinds("Here is the original:\n> AI特有の言い回しは1,000字あたり0.10回から0.01〜0.02回に減りました。\n> コードブロックはそのまま保たれました。\nThe second sentence repeats the first."), ["en"]);
  assert.deepEqual(kinds("First, read the file.\n\nこの段落はモデルが日本語で書いたものです。\n\nThen run the tests."), ["en", "ja", "en"]);
  assert.deepEqual(kinds("未対応の必須作業はありません。今後の Pi や T3 Code の更新で動作が変わる可能性はありますが、既知の制限です。"), ["ja"]);
  assert.deepEqual(kinds("「〜に効く」「刺さる」といった言い回しが気になることがあります。"), ["ja"]);
  assert.deepEqual(kinds("> 引用だけの段落です。"), ["ja"], "a quote with nothing else around it is judged by the quote");
  // Japanese prose that is mostly product names is sent to the translator; PLaMo returns it nearly unchanged.
  assert.deepEqual(kinds("TypeScript と JavaScript の GitHub Actions を設定します。"), ["en"]);
});

test("question stats count each field once by what is shown", async () => {
  const q = (question: string, labels: string[]): Question => ({ question, header: "", options: labels.map((label) => ({ label, description: "" })) });
  const all = await translateQuestionsWithStats([q("どれにしますか？", ["はい", "いいえ"])], async (t) => `訳:${t}`);
  assert.deepEqual(all.stats, { translated: 0, japanese: 3, english: 0 });
  const collide = await translateQuestionsWithStats([q("Which one?", ["Yes", "No"])], async () => "同じ");
  assert.deepEqual(collide.stats, { translated: 1, japanese: 0, english: 2 });
  assert.deepEqual(collide.questions[0].options.map((o) => o.label), ["Yes", "No"]);
  const down = await translateQuestionsWithStats([q("Which one?", ["Yes"])], async () => { throw new Error("down"); });
  assert.deepEqual(down.stats, { translated: 0, japanese: 0, english: 2 });
});

test("the extension's hooks: reminder in requests only, Japanese runs kept, notices count outcomes", async () => {
  process.env.PLAMO_JA = "1";
  const handlers = new Map<string, (event: any, ctx: any) => Promise<any>>();
  const notes: string[] = [];
  const ctx = { ui: { notify: (m: string) => notes.push(m) }, sessionManager: { getBranch: () => [] } };
  const sentTexts: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const prompt: string = JSON.parse(init.body).prompt;
    sentTexts.push(prompt);
    return { ok: true, json: async () => ({ choices: [{ text: "訳文" }] }) };
  }) as unknown as typeof fetch;
  try {
    const { default: extension } = await import("../extensions/plamo-ja.ts");
    extension({ on: (name: string, f: any) => handlers.set(name, f), registerCommand() {}, appendEntry() {} } as any);

    const system = { role: "system", content: "prompt" };
    const patch = { role: "system", content: "tool patch" };
    const messages = [system, { role: "user", content: "質問" }, { role: "assistant", content: [] }, patch, { role: "user", content: [{ type: "text", text: "次" }] }];
    const { messages: out } = await handlers.get("context_with_system")!({ messages }, ctx);
    assert.equal(out[0], system, "system messages keep their place and identity");
    assert.equal(out[3], patch);
    assert.deepEqual(out[1].content.at(-1), { type: "text", text: ENGLISH_REMINDER });
    assert.deepEqual(out[4].content.at(-1), { type: "text", text: ENGLISH_REMINDER });
    assert.equal(messages[1].content, "質問", "the session's message is not changed");

    await handlers.get("agent_start")!({}, ctx);
    const streamEvent = { type: "text_end", content: "English paragraph.\n\n日本語の段落です。\n\n```sh\nls\n```\nAnother English paragraph." };
    await handlers.get("message_update")!({ message: { role: "assistant" }, assistantMessageEvent: streamEvent }, ctx);
    assert.equal(streamEvent.content, "訳文\n\n日本語の段落です。\n\n```sh\nls\n```\n訳文");
    assert.equal(sentTexts.length, 2);
    assert.ok(sentTexts.every((p) => !p.includes("日本語の段落")), "the Japanese paragraph is never sent");

    const input = { questions: [{ question: "どちらにしますか？", header: "", options: [{ label: "Use 2B", description: "" }] }] };
    await handlers.get("tool_call")!({ toolName: "ask_user_question", input }, ctx);
    assert.equal(input.questions[0].question, "どちらにしますか？");
    assert.equal(input.questions[0].options[0].label, "訳文");

    await handlers.get("agent_end")!({}, ctx);
    const warnings = notes.filter((n) => n.includes("日本語で返答した"));
    assert.equal(warnings.length, 1, "the warning is shown once");
    assert.match(notes.at(-1)!, /^PLaMo 翻訳: 有効（3か所を訳し、\d+\.\d秒。2か所は日本語で返ってきたため訳していません）$/);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.PLAMO_JA;
  }
});

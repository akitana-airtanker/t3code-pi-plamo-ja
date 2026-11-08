import assert from "node:assert/strict";
import { test } from "node:test";
import { addRun, buildPrompt, emptyRun, restoreEnabled, runNotice, STATE_ENTRY, configFromEnv, escapePfmlText, HEADER_MAX, LABEL_MAX, PIECE_MAX, splitMarkdown, splitProse, translateParts, translateReply, translateQuestions, type Question } from "../extensions/plamo-ja-core.ts";

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
    assert.equal(translatedInputs.length, parts.filter((part) => part.kind === "translate" && part.text.trim()).length);
  }
});

test("a translator that trims its output cannot move a fence off its line or drop surrounding whitespace", async () => {
  for (let seed = 1; seed <= 250; seed++) {
    const source = generated(seed);
    const parts = splitMarkdown(source);
    const output = await translateParts(parts, async (text) => `<${text.trim()}>`);
    const expected = parts.map((part) => {
      if (part.kind === "keep" || part.text.trim() === "") return part.text;
      const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(part.text)!;
      return `${lead}<${core}>${trail}`;
    }).join("");
    assert.equal(output, expected);
  }
});

test("an empty translation is a failure, so the text stays English", async () => {
  const r = await translateReply([{ kind: "translate", text: "Hello." }], async () => "  ");
  assert.deepEqual(r, { text: "Hello.", splitParts: 1, untranslatedPieces: 1 });
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

test("a run notice reports what was translated, and what stayed English", () => {
  assert.equal(runNotice(emptyRun()), "PLaMo 翻訳: 有効（この返答で訳した文はありません）");
  let run = addRun(emptyRun(), { parts: 3, untranslatedPieces: 0, ms: 2100 });
  assert.equal(runNotice(run), "PLaMo 翻訳: 有効（3か所を訳し、2.1秒）");
  run = addRun(run, { parts: 2, untranslatedPieces: 1, ms: 900 });
  assert.equal(runNotice(run), "PLaMo 翻訳: 有効（5か所を訳し、3.0秒。1か所は英語のまま）");
});

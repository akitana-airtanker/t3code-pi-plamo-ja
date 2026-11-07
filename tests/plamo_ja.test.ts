import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, configFromEnv, escapePfmlText, HEADER_MAX, LABEL_MAX, splitMarkdown, translateParts, translateQuestions, type Question } from "../extensions/plamo-ja-core.ts";

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

test("an empty translation is a failure, so the caller keeps the English text", async () => {
  await assert.rejects(translateParts([{ kind: "translate", text: "Hello." }], async () => "  "));
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
  assert.deepEqual(configFromEnv({}), { endpoint: "http://127.0.0.1:18080/v1", form: "polite", enabled: false });
  assert.deepEqual(configFromEnv({ PLAMO_JA_ENDPOINT: "http://localhost:4///", PLAMO_JA_MODEL: "m", PLAMO_JA_FORM: "plain", PLAMO_JA: "1" }), {
    endpoint: "http://localhost:4", model: "m", form: "plain", enabled: true,
  });
});

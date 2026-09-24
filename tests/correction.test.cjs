const test = require("node:test");
const assert = require("node:assert/strict");
const { promptFor, applyCorrection, conservativeText } = require("../electron/correction.cjs");

test("keeps timestamps and raw text while correcting one word", () => {
  const records = [{ start: 12.5, end: 15.2, speaker: "", text: "今天要講機汽學。" }];
  const output = '[{"id":0,"text":"今天要講機器學。"}]';
  const [result] = applyCorrection(records, output);
  assert.equal(result.text, "今天要講機器學。");
  assert.equal(result.rawText, records[0].text);
  assert.equal(result.start, 12.5);
  assert.equal(result.end, 15.2);
  assert.equal(result.corrected, true);
});

test("rejects changed numbers and broad rewrites", () => {
  assert.equal(conservativeText("今天有 12 位學生。", "今天有 21 位學生。"), "今天有 12 位學生。");
  assert.equal(conservativeText("今天我們來介紹聲音傳播。", "聲音是振動產生的，接下來有三個實驗。"), "今天我們來介紹聲音傳播。");
});

test("allows a small English correction and filler removal", () => {
  assert.equal(conservativeText("We study machine leaning.", "We study machine learning."), "We study machine learning.");
  assert.equal(conservativeText("呃，我們開始介紹。", "我們開始介紹。"), "我們開始介紹。");
});

test("rejects malformed model output without dropping original records", () => {
  const records = [{ start: 0, end: 3, text: "原句一" }, { start: 3, end: 6, text: "原句二" }];
  const result = applyCorrection(records, '[{"id":0,"text":"改寫"}]');
  assert.deepEqual(result.map(item => item.text), ["原句一", "原句二"]);
  assert.deepEqual(result.map(item => item.start), [0, 3]);
});

test("prompt asks for local corrections without rearrangement", () => {
  const prompt = promptFor([{ text: "Hello word" }]);
  assert.match(prompt, /禁止重寫/);
  assert.match(prompt, /英文單字/);
  assert.match(prompt, /Hello word/);
});

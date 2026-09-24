"use strict";

const FILLER_ONLY = /^(?:嗯+|呃+|啊+|那個|就是|you know|um+|uh+|erm+)[，,。.!！?？\s]*$/iu;

function promptFor(records) {
  const lines = records.map((record, index) => ({ id: index, text: record.text }));
  return [
    "/no_think",
    "你是逐字稿校對員。依據同批句子的上下文，僅修正明顯的語音辨識錯字、錯誤英文單字與少量無意義語助詞。",
    "禁止重寫、摘要、合併、拆分、翻譯或補充資訊；保持原來的語氣、句序、專名與數字。若不確定，就保留原句。",
    "只輸出 JSON 陣列，長度、順序、id 必須與輸入相同；每項僅有 id 與 text。不要 Markdown。",
    `輸入：${JSON.stringify(lines)}`,
    "輸出："
  ].join("\n");
}

function schemaFor(count) {
  return {
    type: "array",
    minItems: count,
    maxItems: count,
    items: {
      type: "object",
      required: ["id", "text"],
      additionalProperties: false,
      properties: {
        id: { type: "integer", minimum: 0, maximum: count - 1 },
        text: { type: "string" }
      }
    }
  };
}

function extractCandidates(output, expected) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1));
    if (!Array.isArray(parsed) || parsed.length !== expected) return null;
    return parsed.every((item, index) => item?.id === index && typeof item.text === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function distance(a, b) {
  const first = [...a];
  const second = [...b];
  let previous = Array.from({ length: second.length + 1 }, (_, index) => index);
  for (let i = 1; i <= first.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= second.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (first[i - 1] === second[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[second.length];
}

function conservativeText(original, candidate) {
  const from = String(original || "").trim();
  const to = String(candidate || "").trim();
  if (!from || !to || to === from) return from;
  if (to.length < from.length * 0.55 || to.length > from.length * 1.45) return from;
  const numbers = text => text.match(/\d+(?:[.,]\d+)*/g) || [];
  if (JSON.stringify(numbers(from)) !== JSON.stringify(numbers(to))) return from;
  if (FILLER_ONLY.test(from)) return to.length <= from.length ? to : from;
  const edits = distance(from, to);
  if (edits > Math.max(3, Math.ceil([...from].length * 0.32))) return from;
  return to;
}

function applyCorrection(records, output) {
  const candidates = extractCandidates(output, records.length);
  return records.map((record, index) => {
    const rawText = record.rawText || record.text;
    const text = candidates ? conservativeText(rawText, candidates[index].text) : rawText;
    return { ...record, rawText, text, corrected: text !== rawText };
  });
}

module.exports = { promptFor, schemaFor, extractCandidates, conservativeText, applyCorrection };

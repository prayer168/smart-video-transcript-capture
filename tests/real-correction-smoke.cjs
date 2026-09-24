const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { promptFor, schemaFor, extractCandidates, applyCorrection } = require("../electron/correction.cjs");

const binary = process.env.LLAMA_CLI_PATH;
const model = process.env.CORRECTION_MODEL_PATH;
if (!binary || !model) throw new Error("LLAMA_CLI_PATH and CORRECTION_MODEL_PATH are required.");

const records = [
  { start: 0, end: 3, text: "今天有 12 位學聲。" },
  { start: 3, end: 6, text: "We study machine leaning." }
];
const args = ["-m", model, "-cnv", "--simple-io", "--single-turn", "--no-display-prompt", "--no-warmup", "--no-show-timings", "-n", "1024", "-c", "4096", "--temp", "0.1", "--json-schema", JSON.stringify(schemaFor(records.length)), "-p", promptFor(records)];
const result = spawnSync(binary, args, { encoding: "utf8", timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
const parsed = extractCandidates(result.stdout, records.length);
assert.ok(parsed, `Model output was not valid JSON: ${result.stdout.slice(0, 500)}`);
const corrected = applyCorrection(records, result.stdout);
assert.deepEqual(corrected.map(item => item.start), [0, 3]);
assert.match(corrected[0].text, /12/);
assert.deepEqual(corrected.map(item => item.rawText), records.map(item => item.text));
console.log(JSON.stringify({ modelOutput: parsed, applied: corrected.map(item => item.text) }, null, 2));

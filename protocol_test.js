const assert = require("assert");
const zlib = require("zlib");
const receiver = require("./app.js");

function qCompressJson(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, zlib.deflateSync(json)]);
}

function base64Url(bytes) {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function makeFrames(payload, partChars = 80) {
  const encoded = base64Url(qCompressJson(payload));
  const partCount = Math.max(1, Math.ceil(encoded.length / partChars));
  const frames = [];
  for (let i = 0; i < partCount; i += 1) {
    const partIndex = i + 1;
    const payloadPart = encoded.slice(i * partChars, (i + 1) * partChars);
    const material = `${payload.id}|${partIndex}|${partCount}|${payloadPart}`;
    const checksum = (await receiver.sha256Hex(material)).slice(0, 12);
    frames.push(`PFRT1|${payload.id}|${partIndex}|${partCount}|${payloadPart}|${checksum}`);
  }
  return frames;
}

function minimalPng() {
  return new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 0,
    73, 69, 78, 68,
    174, 66, 96, 130
  ]);
}

async function main() {
  const sample = {
    v: 1,
    type: "phyfit.report",
    id: "lateral_raise_20260706_101010",
    actionId: "lateral_raise",
    actionName: "侧平举",
    createdAt: "2026-07-06 10:10:10",
    selectedSets: 3,
    targetRepsPerSet: 10,
    averageScoreAllSets: 0.86,
    sets: [
      { index: 1, reps: 10, durationSec: 36.2, score: 0.84 },
      { index: 2, reps: 10, durationSec: 35.8, score: 0.88 }
    ],
    frequentHints: ["耸肩代偿", "下放过快"],
    reportText: "本次训练完成稳定，动作控制较好。"
  };

  const oneFrame = await makeFrames(sample, 5000);
  assert.strictEqual(oneFrame.length, 1);
  const parsed = receiver.parseFrame(oneFrame[0]);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(await receiver.verifyFrame(parsed.frame), true);

  const singleState = receiver.createReceiverState();
  const singleResult = await receiver.collectFrame(singleState, oneFrame[0]);
  assert.strictEqual(singleResult.complete, true);
  const singleDecoded = await receiver.decodePayload(singleState.parts);
  assert.strictEqual(singleDecoded.actionName, "侧平举");

  const multiFrame = await makeFrames(sample, 70);
  assert.ok(multiFrame.length > 1);
  const state = receiver.createReceiverState();
  for (const frame of multiFrame) {
    await receiver.collectFrame(state, frame);
  }
  await receiver.collectFrame(state, multiFrame[0]);
  assert.strictEqual(state.parts.size, multiFrame.length);
  assert.deepStrictEqual(receiver.missingIndexes(state), []);
  const decoded = await receiver.decodePayload(state.parts);
  assert.strictEqual(decoded.reportText, sample.reportText);

  const missingState = receiver.createReceiverState();
  for (const frame of multiFrame.slice(1)) {
    await receiver.collectFrame(missingState, frame);
  }
  assert.ok(receiver.missingIndexes(missingState).includes(1));

  const badChecksum = multiFrame[0].replace(/\|[0-9a-f]{12}$/, "|000000000000");
  const badState = receiver.createReceiverState();
  const badResult = await receiver.collectFrame(badState, badChecksum);
  assert.strictEqual(badResult.accepted, false);
  assert.match(badResult.error, /checksum/);

  const other = { ...sample, id: "other_report" };
  const otherFrame = (await makeFrames(other, 5000))[0];
  const mixedResult = await receiver.collectFrame(state, otherFrame);
  assert.strictEqual(mixedResult.accepted, false);
  assert.match(mixedResult.error, /其他报告/);

  const archive = await receiver.encodeReportArchive(sample);
  const png = receiver.insertPngChunkBeforeIend(minimalPng(), "pfRt", archive);
  const restored = await receiver.decodeReportArchive(png);
  assert.strictEqual(restored.id, sample.id);
  assert.strictEqual(restored.reportText, sample.reportText);

  const corrupted = new Uint8Array(png);
  corrupted[corrupted.length - 70] ^= 0xff;
  await assert.rejects(() => receiver.decodeReportArchive(corrupted), /损坏|invalid|incorrect|invalid distance|invalid stored/);

  console.log("report_receiver protocol tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

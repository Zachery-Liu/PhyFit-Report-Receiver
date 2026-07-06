(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PhyFitReportReceiver = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FRAME_PREFIX = "PFRT1";
  const ARCHIVE_SIGNATURE = "PHYFIT_REPORT_ARCHIVE_V1\n";
  const ARCHIVE_CHUNK = "pfRt";
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text));
  }

  function utf8Text(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  function concatBytes(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function readUint32BE(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
  }

  function writeUint32BE(value) {
    return new Uint8Array([
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    ]);
  }

  function bytesEqualPrefix(bytes, prefix, offset = 0) {
    if (bytes.length < offset + prefix.length) return false;
    for (let i = 0; i < prefix.length; i += 1) {
      if (bytes[offset + i] !== prefix[i]) return false;
    }
    return true;
  }

  async function sha256Hex(input) {
    const bytes = typeof input === "string" ? utf8Bytes(input) : input;
    if (globalThis.crypto && globalThis.crypto.subtle) {
      const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
    }
    if (typeof require === "function") {
      return require("crypto").createHash("sha256").update(Buffer.from(bytes)).digest("hex");
    }
    throw new Error("当前浏览器不支持 SHA-256 校验");
  }

  function base64UrlToBytes(text) {
    let base64 = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const remainder = base64.length % 4;
    if (remainder) base64 += "=".repeat(4 - remainder);

    if (typeof atob === "function") {
      const raw = atob(base64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      return bytes;
    }
    return new Uint8Array(Buffer.from(base64, "base64"));
  }

  async function streamToBytes(stream) {
    const reader = stream.getReader();
    const chunks = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    return concatBytes(chunks);
  }

  async function inflateBytes(bytes) {
    if (typeof DecompressionStream === "function") {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
      return streamToBytes(stream);
    }
    if (typeof require === "function") {
      return new Uint8Array(require("zlib").inflateSync(Buffer.from(bytes)));
    }
    throw new Error("当前浏览器不支持解压报告数据");
  }

  async function deflateBytes(bytes) {
    if (typeof CompressionStream === "function") {
      const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
      return streamToBytes(stream);
    }
    if (typeof require === "function") {
      return new Uint8Array(require("zlib").deflateSync(Buffer.from(bytes)));
    }
    throw new Error("当前浏览器不支持生成可恢复报告图片");
  }

  function parseFrame(text) {
    const parts = String(text || "").trim().split("|");
    if (parts.length !== 6 || parts[0] !== FRAME_PREFIX) {
      return { ok: false, error: "不是 PhyFit 报告码" };
    }
    const partIndex = Number(parts[2]);
    const partCount = Number(parts[3]);
    if (!Number.isInteger(partIndex) || !Number.isInteger(partCount) || partIndex <= 0 || partCount <= 0 || partIndex > partCount) {
      return { ok: false, error: "分片编号无效" };
    }
    if (!parts[1] || !parts[4] || !parts[5]) {
      return { ok: false, error: "二维码字段不完整" };
    }
    return {
      ok: true,
      frame: {
        reportId: parts[1],
        partIndex,
        partCount,
        payloadPart: parts[4],
        checksum: parts[5],
        text
      }
    };
  }

  async function expectedFrameChecksum(frame) {
    const material = `${frame.reportId}|${frame.partIndex}|${frame.partCount}|${frame.payloadPart}`;
    return (await sha256Hex(material)).slice(0, 12);
  }

  async function verifyFrame(frame) {
    return frame.checksum === await expectedFrameChecksum(frame);
  }

  function createReceiverState() {
    return {
      reportId: "",
      partCount: 0,
      parts: new Map(),
      lastError: ""
    };
  }

  function missingIndexes(state) {
    const missing = [];
    for (let i = 1; i <= state.partCount; i += 1) {
      if (!state.parts.has(i)) missing.push(i);
    }
    return missing;
  }

  async function collectFrame(state, text) {
    const parsed = parseFrame(text);
    if (!parsed.ok) {
      state.lastError = parsed.error;
      return { accepted: false, complete: false, error: parsed.error };
    }

    const frame = parsed.frame;
    if (!(await verifyFrame(frame))) {
      state.lastError = "checksum 不匹配，已丢弃该帧";
      return { accepted: false, complete: false, error: state.lastError };
    }

    if (!state.reportId) {
      state.reportId = frame.reportId;
      state.partCount = frame.partCount;
    } else if (state.reportId !== frame.reportId || state.partCount !== frame.partCount) {
      state.lastError = "检测到其他报告的二维码，请重新开始接收";
      return { accepted: false, complete: false, error: state.lastError };
    }

    const wasDuplicate = state.parts.has(frame.partIndex);
    state.parts.set(frame.partIndex, frame.payloadPart);
    state.lastError = "";
    return {
      accepted: true,
      duplicate: wasDuplicate,
      complete: state.parts.size === state.partCount,
      received: state.parts.size,
      total: state.partCount,
      missing: missingIndexes(state)
    };
  }

  async function decodePayload(partsByIndex) {
    const indexes = Array.from(partsByIndex.keys()).sort((a, b) => a - b);
    if (!indexes.length) throw new Error("没有可解码的报告分片");

    const partCount = indexes[indexes.length - 1];
    for (let i = 1; i <= partCount; i += 1) {
      if (!partsByIndex.has(i)) throw new Error(`缺少分片 ${i}`);
    }

    const encoded = indexes.map((index) => partsByIndex.get(index)).join("");
    const compressedWithQtHeader = base64UrlToBytes(encoded);
    if (compressedWithQtHeader.length <= 4) throw new Error("报告压缩数据无效");

    const expectedLength = readUint32BE(compressedWithQtHeader, 0);
    const deflated = compressedWithQtHeader.slice(4);
    const jsonBytes = await inflateBytes(deflated);
    if (expectedLength && jsonBytes.length !== expectedLength) {
      throw new Error("报告长度校验失败");
    }

    const payload = JSON.parse(utf8Text(jsonBytes));
    if (!payload || payload.type !== "phyfit.report" || payload.v !== 1) {
      throw new Error("不是有效 PhyFit 报告");
    }
    return payload;
  }

  function renderReportModel(payload) {
    const sets = Array.isArray(payload.sets) ? payload.sets.map((set) => ({
      index: Number(set.index) || 0,
      reps: Number(set.reps) || 0,
      durationSec: Number(set.durationSec) || 0,
      score: Number(set.score) || 0
    })) : [];
    return {
      id: String(payload.id || ""),
      actionName: String(payload.actionName || payload.actionId || "讝练动作"),
      createdAt: String(payload.createdAt || ""),
      selectedSets: Number(payload.selectedSets) || sets.length,
      targetRepsPerSet: Number(payload.targetRepsPerSet) || 0,
      averageScoreAllSets: Number(payload.averageScoreAllSets) || 0,
      sets,
      frequentHints: Array.isArray(payload.frequentHints) ? payload.frequentHints.map(String).filter(Boolean) : [],
      reportText: String(payload.reportText || "")
    };
  }

  function makeDownload(filename, bytes, type) {
    const blob = new Blob([bytes], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function makePngChunk(type, data) {
    const typeBytes = utf8Bytes(type);
    const length = writeUint32BE(data.length);
    const crc = writeUint32BE(crc32(concatBytes([typeBytes, data])));
    return concatBytes([length, typeBytes, data, crc]);
  }

  function insertPngChunkBeforeIend(pngBytes, type, data) {
    if (!bytesEqualPrefix(pngBytes, PNG_SIGNATURE)) throw new Error("不是有效 PNG 文件");
    let offset = PNG_SIGNATURE.length;
    while (offset + 12 <= pngBytes.length) {
      const length = readUint32BE(pngBytes, offset);
      const chunkType = utf8Text(pngBytes.slice(offset + 4, offset + 8));
      if (chunkType === "IEND") {
        const before = pngBytes.slice(0, offset);
        const after = pngBytes.slice(offset);
        return concatBytes([before, makePngChunk(type, data), after]);
      }
      offset += 12 + length;
    }
    throw new Error("PNG 缺少 IEND chunk");
  }

  function findPngChunk(pngBytes, type) {
    if (!bytesEqualPrefix(pngBytes, PNG_SIGNATURE)) throw new Error("不是有效 PNG 文件");
    let offset = PNG_SIGNATURE.length;
    while (offset + 12 <= pngBytes.length) {
      const length = readUint32BE(pngBytes, offset);
      const chunkType = utf8Text(pngBytes.slice(offset + 4, offset + 8));
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > pngBytes.length) throw new Error("PNG chunk 长度无效");
      if (chunkType === type) return pngBytes.slice(dataStart, dataEnd);
      offset = dataEnd + 4;
    }
    return null;
  }

  async function encodeReportArchive(report) {
    const archive = {
      archiveV: 1,
      type: "phyfit.report.archive",
      createdAt: new Date().toISOString(),
      report
    };
    const compressed = await deflateBytes(utf8Bytes(JSON.stringify(archive)));
    const checksum = utf8Bytes(await sha256Hex(compressed));
    return concatBytes([
      utf8Bytes(ARCHIVE_SIGNATURE),
      writeUint32BE(compressed.length),
      compressed,
      checksum
    ]);
  }

  async function decodeReportArchive(pngBytes) {
    const data = findPngChunk(pngBytes, ARCHIVE_CHUNK);
    if (!data) throw new Error("未找到可恢复的 PhyFit 报告数据。请使用从本页面导出的原始 PNG，或改用 JSON 文件恢复。");
    const signature = utf8Bytes(ARCHIVE_SIGNATURE);
    if (!bytesEqualPrefix(data, signature)) throw new Error("报告图片归档签名无效");

    const lengthOffset = signature.length;
    const compressedLength = readUint32BE(data, lengthOffset);
    const compressedStart = lengthOffset + 4;
    const compressedEnd = compressedStart + compressedLength;
    const checksumEnd = compressedEnd + 64;
    if (checksumEnd > data.length) throw new Error("报告图片归档长度无效");

    const compressed = data.slice(compressedStart, compressedEnd);
    const checksum = utf8Text(data.slice(compressedEnd, checksumEnd));
    if (checksum !== await sha256Hex(compressed)) throw new Error("报告图片归档数据损坏");

    const archive = JSON.parse(utf8Text(await inflateBytes(compressed)));
    if (!archive || archive.archiveV !== 1 || archive.type !== "phyfit.report.archive" || !archive.report) {
      throw new Error("报告图片归档版本不支持");
    }
    if (archive.report.type !== "phyfit.report") throw new Error("归档中没有有效 PhyFit 报告");
    return archive.report;
  }

  async function canvasToBytes(canvas) {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("无法生成 PNG 报告图片");
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function buildReportCardPng(report) {
    const model = renderReportModel(report);
    const canvas = document.createElement("canvas");
    canvas.width = 1080;
    canvas.height = 1440;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f3f7f6";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(64, 64, 952, 1312);
    ctx.fillStyle = "#12786c";
    ctx.fillRect(64, 64, 952, 14);
    ctx.fillStyle = "#1c2522";
    ctx.font = "700 58px sans-serif";
    ctx.fillText("PhyFit 训练报告", 112, 160);
    ctx.font = "700 44px sans-serif";
    ctx.fillText(model.actionName, 112, 240);
    ctx.font = "32px sans-serif";
    ctx.fillStyle = "#66736f";
    ctx.fillText(model.createdAt || "未记录时间", 112, 298);

    const metricY = 390;
    const metrics = [
      ["训练组数", `${model.selectedSets} 组`],
      ["每组目标", `${model.targetRepsPerSet} 次`],
      ["平均分", model.averageScoreAllSets.toFixed(2)]
    ];
    metrics.forEach((item, index) => {
      const x = 112 + index * 300;
      ctx.fillStyle = "#eef4f2";
      ctx.fillRect(x, metricY, 250, 128);
      ctx.fillStyle = "#66736f";
      ctx.font = "26px sans-serif";
      ctx.fillText(item[0], x + 24, metricY + 44);
      ctx.fillStyle = "#1c2522";
      ctx.font = "700 42px sans-serif";
      ctx.fillText(item[1], x + 24, metricY + 96);
    });

    ctx.fillStyle = "#1c2522";
    ctx.font = "700 34px sans-serif";
    ctx.fillText("主要提示", 112, 600);
    ctx.font = "30px sans-serif";
    ctx.fillStyle = "#66736f";
    const hints = model.frequentHints.length ? model.frequentHints.join("、") : "暂无明显高频提示";
    wrapCanvasText(ctx, hints, 112, 652, 850, 42, 3);

    ctx.fillStyle = "#1c2522";
    ctx.font = "700 34px sans-serif";
    ctx.fillText("报告摘要", 112, 830);
    ctx.font = "31px sans-serif";
    ctx.fillStyle = "#24312d";
    wrapCanvasText(ctx, model.reportText || "报告正文为空", 112, 882, 850, 44, 8);

    ctx.fillStyle = "#66736f";
    ctx.font = "24px sans-serif";
    ctx.fillText("原始 PNG 内含可恢复报告数据，请妥善保存。", 112, 1310);

    const png = await canvasToBytes(canvas);
    const archive = await encodeReportArchive(report);
    return insertPngChunkBeforeIend(png, ARCHIVE_CHUNK, archive);
  }

  function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
    const chars = String(text).replace(/\s+/g, " ").trim().split("");
    let line = "";
    let lines = 0;
    for (const char of chars) {
      const next = line + char;
      if (ctx.measureText(next).width > maxWidth && line) {
        ctx.fillText(line, x, y + lines * lineHeight);
        lines += 1;
        if (lines >= maxLines) return;
        line = char;
      } else {
        line = next;
      }
    }
    if (line && lines < maxLines) ctx.fillText(line, x, y + lines * lineHeight);
  }

  function initBrowserApp() {
    if (typeof document === "undefined") return;

    const views = {
      intro: document.getElementById("introView"),
      scan: document.getElementById("scanView"),
      report: document.getElementById("reportView"),
      import: document.getElementById("importView")
    };
    const els = {
      stateBadge: document.getElementById("stateBadge"),
      message: document.getElementById("messageBox"),
      video: document.getElementById("cameraPreview"),
      scanStatus: document.getElementById("scanStatus"),
      receivedCount: document.getElementById("receivedCount"),
      reportIdText: document.getElementById("reportIdText"),
      missingFrames: document.getElementById("missingFrames"),
      reportTitle: document.getElementById("reportTitle"),
      reportScore: document.getElementById("reportScore"),
      createdAtText: document.getElementById("createdAtText"),
      setTargetText: document.getElementById("setTargetText"),
      reportReadyId: document.getElementById("reportReadyId"),
      setsBody: document.getElementById("setsBody"),
      hintsList: document.getElementById("hintsList"),
      reportText: document.getElementById("reportText"),
      imageFileInput: document.getElementById("imageFileInput")
    };

    let receiver = createReceiverState();
    let currentReport = null;
    let stream = null;
    let detector = null;
    let scanning = false;
    let lastFrameText = "";
    let lastFrameAt = 0;

    function showView(name) {
      Object.entries(views).forEach(([key, node]) => node.classList.toggle("hidden", key !== name));
      const labels = { intro: "待接收", scan: "扫码中", report: "已完成", import: "导入图片" };
      els.stateBadge.textContent = labels[name] || "";
    }

    function setMessage(text, kind = "") {
      els.message.textContent = text || "";
      els.message.className = `message ${kind}`.trim();
    }

    function updateReceiveStatus(text) {
      els.scanStatus.textContent = text;
      els.receivedCount.textContent = `${receiver.parts.size} / ${receiver.partCount || 0}`;
      els.reportIdText.textContent = receiver.reportId || "-";
      const missing = missingIndexes(receiver);
      els.missingFrames.textContent = missing.length ? `缺失：${missing.join(", ")}` : "缺失：-";
    }

    function stopCamera() {
      scanning = false;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
      }
      els.video.srcObject = null;
    }

    async function startScan() {
      setMessage("");
      if (!("BarcodeDetector" in window)) {
        setMessage("当前浏览器不支持直接扫码，请使用 Chrome/Edge，或等待兼容版扫码库。", "warn");
        return;
      }
      try {
        detector = new BarcodeDetector({ formats: ["qr_code"] });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        });
        els.video.srcObject = stream;
        await els.video.play();
        scanning = true;
        receiver = createReceiverState();
        updateReceiveStatus("等待二维码");
        showView("scan");
        requestAnimationFrame(scanLoop);
      } catch (error) {
        setMessage(`无法打开摄像头：${error.message || error}`, "error");
      }
    }

    async function scanLoop() {
      if (!scanning || !detector) return;
      try {
        const codes = await detector.detect(els.video);
        for (const code of codes) {
          const text = code.rawValue || "";
          const now = Date.now();
          if (text && (text !== lastFrameText || now - lastFrameAt > 500)) {
            lastFrameText = text;
            lastFrameAt = now;
            await handleFrameText(text);
          }
        }
      } catch (error) {
        setMessage(`扫码失败：${error.message || error}`, "warn");
      }
      if (scanning) requestAnimationFrame(scanLoop);
    }

    async function handleFrameText(text) {
      const result = await collectFrame(receiver, text);
      if (!result.accepted) {
        updateReceiveStatus(result.error || "等待下一帧");
        return;
      }
      updateReceiveStatus(result.complete ? "分片已集齐，正在解析" : "正在接收分片");
      if (result.complete) {
        try {
          currentReport = await decodePayload(receiver.parts);
          stopCamera();
          renderReport(currentReport);
          showView("report");
          setMessage("报告接收完成");
        } catch (error) {
          setMessage(`报告解析失败：${error.message || error}`, "error");
        }
      }
    }

    function renderReport(report) {
      const model = renderReportModel(report);
      els.reportTitle.textContent = model.actionName;
      els.reportScore.textContent = `平均分 ${model.averageScoreAllSets.toFixed(2)}`;
      els.createdAtText.textContent = model.createdAt || "-";
      els.setTargetText.textContent = `${model.selectedSets} 组 / 每组 ${model.targetRepsPerSet} 次`;
      els.reportReadyId.textContent = model.id || "-";
      els.reportText.textContent = model.reportText || "报告正文为空。";
      els.setsBody.innerHTML = "";
      for (const set of model.sets) {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${set.index}</td><td>${set.reps}</td><td>${set.durationSec.toFixed(1)} 秒</td><td>${set.score.toFixed(2)}</td>`;
        els.setsBody.appendChild(tr);
      }
      if (!model.sets.length) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td colspan=\"4\">暂无分组数据</td>";
        els.setsBody.appendChild(tr);
      }
      els.hintsList.innerHTML = "";
      const hints = model.frequentHints.length ? model.frequentHints : ["暂无明显高频提示"];
      for (const hint of hints) {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = hint;
        els.hintsList.appendChild(chip);
      }
    }

    async function copyReportText() {
      if (!currentReport) return;
      const text = renderReportModel(currentReport).reportText;
      await navigator.clipboard.writeText(text);
      setMessage("报告正文已复制");
    }

    function downloadJson() {
      if (!currentReport) return;
      const id = renderReportModel(currentReport).id || "report";
      makeDownload(`phyfit-report-${id}.json`, utf8Bytes(JSON.stringify(currentReport, null, 2)), "application/json");
    }

    async function exportPng() {
      if (!currentReport) return;
      try {
        const id = renderReportModel(currentReport).id || "report";
        const png = await buildReportCardPng(currentReport);
        makeDownload(`phyfit-report-${id}.png`, png, "image/png");
        setMessage("报告图片已导出，请保存原始 PNG 文件");
      } catch (error) {
        setMessage(`导出报告图片失败：${error.message || error}`, "error");
      }
    }

    async function importImageFile(file) {
      if (!file) return;
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        currentReport = await decodeReportArchive(bytes);
        renderReport(currentReport);
        showView("report");
        setMessage("报告图片已恢复");
      } catch (error) {
        setMessage(error.message || String(error), "error");
      }
    }

    document.getElementById("startScanBtn").addEventListener("click", startScan);
    document.getElementById("showImportBtn").addEventListener("click", () => {
      stopCamera();
      setMessage("");
      showView("import");
    });
    document.getElementById("resetScanBtn").addEventListener("click", () => {
      receiver = createReceiverState();
      updateReceiveStatus("等待二维码");
      setMessage("");
    });
    document.getElementById("backIntroBtn").addEventListener("click", () => {
      stopCamera();
      setMessage("");
      showView("intro");
    });
    document.getElementById("newScanBtn").addEventListener("click", startScan);
    document.getElementById("copyReportBtn").addEventListener("click", copyReportText);
    document.getElementById("downloadJsonBtn").addEventListener("click", downloadJson);
    document.getElementById("exportPngBtn").addEventListener("click", exportPng);
    document.getElementById("importBackBtn").addEventListener("click", () => {
      setMessage("");
      showView("intro");
    });
    els.imageFileInput.addEventListener("change", (event) => importImageFile(event.target.files[0]));

    showView("intro");
  }

  const api = {
    parseFrame,
    verifyFrame,
    expectedFrameChecksum,
    createReceiverState,
    collectFrame,
    missingIndexes,
    decodePayload,
    renderReportModel,
    encodeReportArchive,
    decodeReportArchive,
    insertPngChunkBeforeIend,
    findPngChunk,
    sha256Hex
  };

  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", initBrowserApp);
  }

  return api;
});

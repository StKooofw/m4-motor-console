export const WIRELESS_BAUD_RATE = 115200;

export class WirelessConsoleError extends Error {}

const CALIBRATION_RESULTS = Object.freeze([
  "未开始", "通过", "检测到移动", "IMU 读取失败", "无有效响应", "阶段超时",
  "已中止", "电机反馈中断", "电机或编码器故障", "双向差异过大",
  "差速模型无效", "角度超调过大", "角度无法稳定", "轮速跟踪不合格",
]);

export function wirelessCalibrationResultText(result) {
  return CALIBRATION_RESULTS[result] || `未知结果 ${result}`;
}

function parseFields(line) {
  const fields = {};
  for (const match of line.matchAll(/(?:^| )([A-Z_]+)=([^ ]+)/g)) {
    fields[match[1]] = match[2];
  }
  return fields;
}

function numberField(fields, name, fallback = null) {
  if (!(name in fields)) return fallback;
  const value = Number(fields[name]);
  return Number.isFinite(value) ? value : fallback;
}

function requiredNumberFields(fields, names) {
  const values = {};
  for (const name of names) {
    const value = numberField(fields, name);
    if (value == null) return null;
    values[name] = value;
  }
  return values;
}

function otherReply() {
  return Object.freeze({ kind: "other" });
}

function pairField(fields, name) {
  const match = /^(\d+)\/(\d+)$/.exec(fields[name] || "");
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

export function isAllowedWirelessCommand(command) {
  return ["STATUS", "GYRO", "ARM ANGLE", "ABORT", "ESTOP"].includes(command)
    || /^CONFIRM ANGLE [0-9A-F]{8}$/.test(command);
}

export function parseWirelessReply(line) {
  const armed = /^OK ARMED ANGLE TOKEN=([0-9A-F]{8}) EXPIRES=(\d+)$/.exec(line);
  if (armed) {
    return Object.freeze({
      kind: "armed",
      token: armed[1],
      expiresMs: Number(armed[2]),
    });
  }
  if (line.startsWith("OK STATUS ")) {
    const fields = parseFields(line);
    const values = requiredNumberFields(fields, ["STATE", "CAL", "PROGRESS", "RESULT"]);
    const readyMask = Number.parseInt(fields.READY || "", 16);
    if (!values || !Number.isInteger(readyMask) || !/^[01]$/.test(fields.IMU || "")) {
      return otherReply();
    }
    const [stageIndex, stageTotal] = pairField(fields, "STAGE");
    return Object.freeze({
      kind: "status",
      state: values.STATE,
      readyMask,
      imuCalibrated: fields.IMU === "1",
      calibrationState: values.CAL,
      progress: values.PROGRESS,
      result: values.RESULT,
      stageIndex,
      stageTotal,
    });
  }
  if (line.startsWith("PROGRESS ")) {
    const fields = parseFields(line);
    const values = requiredNumberFields(fields, ["KIND", "STATE", "VALUE", "TARGET"]);
    if (!values) return otherReply();
    const [stageIndex, stageTotal] = pairField(fields, "STAGE");
    return Object.freeze({
      kind: "progress",
      calibrationKind: values.KIND,
      state: values.STATE,
      progress: values.VALUE,
      stageIndex,
      stageTotal,
      targetDeg: values.TARGET,
    });
  }
  if (line.startsWith("MODEL ")) {
    const fields = parseFields(line);
    const values = requiredNumberFields(fields, ["TRACK", "CW", "CCW", "ASYM", "PEAK", "RESP"]);
    if (!values) return otherReply();
    return Object.freeze({
      kind: "model",
      trackMm: values.TRACK,
      clockwiseGain: values.CW,
      counterclockwiseGain: values.CCW,
      asymmetryPercent: values.ASYM,
      peakGyroDps: values.PEAK,
      responseTimeMs: values.RESP,
    });
  }
  if (line.startsWith("CANDIDATE ")) {
    const fields = parseFields(line);
    const values = requiredNumberFields(fields, ["KP", "KI", "KD"]);
    if (!values) return otherReply();
    return Object.freeze({
      kind: "candidate",
      kp: values.KP,
      ki: values.KI,
      kd: values.KD,
    });
  }
  if (line.startsWith("SAMPLE ")) {
    const fields = parseFields(line);
    const values = requiredNumberFields(fields, ["STAGE", "TARGET", "YAW", "GYRO", "TL", "TR", "L", "R"]);
    if (!values) return otherReply();
    return Object.freeze({
      kind: "sample",
      stageIndex: values.STAGE,
      targetDeg: values.TARGET,
      yawDeg: values.YAW,
      gyroDps: values.GYRO,
      leftTargetMrpm: values.TL,
      rightTargetMrpm: values.TR,
      leftActualMrpm: values.L,
      rightActualMrpm: values.R,
    });
  }
  if (line.startsWith("DIAG STEP ")) {
    const fields = parseFields(line);
    const values = requiredNumberFields(fields, ["TARGET", "YAW", "GYRO", "RISE", "OVR", "WERR"]);
    if (!values || !/^\d+\/\d+$/.test(fields.SAT || "")) return otherReply();
    const [saturationCount, controlCount] = pairField(fields, "SAT");
    return Object.freeze({
      kind: "step-diagnostic",
      targetDeg: values.TARGET,
      yawDeg: values.YAW,
      gyroDps: values.GYRO,
      riseTimeMs: values.RISE,
      overshootDeg: values.OVR,
      saturationCount,
      controlCount,
      wheelErrorRatio: values.WERR,
    });
  }
  if (line.startsWith("DIAG STAGE=")) {
    const fields = parseFields(line);
    return Object.freeze({ kind: "stage-diagnostic", fields: Object.freeze(fields) });
  }
  if (line.startsWith("DIAG MODEL ")) {
    const fields = parseFields(line);
    return Object.freeze({ kind: "model-diagnostic", fields: Object.freeze(fields) });
  }
  if (line.startsWith("DIAG LINK ")) {
    const fields = parseFields(line);
    return Object.freeze({ kind: "link-diagnostic", fields: Object.freeze(fields) });
  }
  const done = /^DONE (ANGLE|GYRO) /.exec(line);
  if (done) {
    const fields = parseFields(line);
    const result = numberField(fields, "RESULT");
    if (result == null) return otherReply();
    return Object.freeze({
      kind: "done",
      calibrationKind: done[1].toLowerCase(),
      result,
      resultText: wirelessCalibrationResultText(result),
      ok: result === 1,
      kp: numberField(fields, "KP"),
      ki: numberField(fields, "KI"),
      kd: numberField(fields, "KD"),
      trackMm: numberField(fields, "TRACK"),
      asymmetryPercent: numberField(fields, "ASYM"),
      settleTimeMs: numberField(fields, "SETTLE"),
      overshootDeg: numberField(fields, "OVR"),
    });
  }
  const started = /^OK (ANGLE|GYRO) START$/.exec(line);
  if (started) {
    return Object.freeze({ kind: "started", calibrationKind: started[1].toLowerCase() });
  }
  if (line.startsWith("ERR ")) {
    return Object.freeze({ kind: "error", code: line.slice(4) });
  }
  if (line.startsWith("OK ")) return Object.freeze({ kind: "ok" });
  return otherReply();
}

export class WirelessLineDecoder {
  constructor(maxLength = 160) {
    this.maxLength = maxLength;
    this.line = "";
    this.discard = false;
  }

  push(text) {
    const lines = [];
    for (const character of text) {
      if (character === "\r") continue;
      if (character === "\n") {
        if (!this.discard && this.line.length > 0) lines.push(this.line);
        this.line = "";
        this.discard = false;
        continue;
      }
      const code = character.charCodeAt(0);
      if (this.discard) continue;
      if (code < 0x20 || code > 0x7e || this.line.length >= this.maxLength) {
        this.line = "";
        this.discard = true;
        continue;
      }
      this.line += character;
    }
    return lines;
  }
}

export class WirelessCalibrationSession {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.readTask = null;
    this.closing = false;
    this.onLine = null;
    this.onUnexpectedClose = null;
    this.decoder = new WirelessLineDecoder();
    this.textDecoder = new TextDecoder();
    this.textEncoder = new TextEncoder();
  }

  get adapterLabel() {
    const info = this.port.getInfo();
    if (info.usbVendorId == null) return "已授权串口";
    const hex = (value) => (value || 0).toString(16).toUpperCase().padStart(4, "0");
    return `VID ${hex(info.usbVendorId)} · PID ${hex(info.usbProductId)}`;
  }

  async open() {
    await this.port.open({
      baudRate: WIRELESS_BAUD_RATE,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 255,
    });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.closing = false;
    this.readTask = this.readLoop();
  }

  async readLoop() {
    let unexpectedError = null;
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        const text = this.textDecoder.decode(value, { stream: true });
        for (const line of this.decoder.push(text)) this.onLine?.(line);
      }
    } catch (error) {
      if (!this.closing) unexpectedError = error;
    } finally {
      try { this.reader?.releaseLock(); } catch { /* already released */ }
      this.reader = null;
      if (!this.closing) this.onUnexpectedClose?.(unexpectedError);
    }
  }

  async sendCommand(command) {
    const normalized = String(command).trim().toUpperCase();
    if (!isAllowedWirelessCommand(normalized)) {
      throw new WirelessConsoleError("无线口命令不在安全白名单中");
    }
    if (!this.writer) throw new WirelessConsoleError("无线串口尚未连接");
    await this.writer.write(this.textEncoder.encode(`${normalized}\r\n`));
  }

  async close() {
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* port may already be gone */ }
    try { await this.readTask; } catch { /* handled by readLoop */ }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* already released */ }
      this.writer = null;
    }
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

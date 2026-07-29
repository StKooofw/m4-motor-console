export const WIRELESS_BAUD_RATE = 115200;
export const WIRELESS_RUN_HEARTBEAT_MS = 200;
export const WIRELESS_CAP_RUN = 1 << 0;
export const WIRELESS_CAP_TUNE = 1 << 1;

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
  const decimal = "[+]?(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)";
  return [
    "STATUS", "GYRO", "ARM ANGLE", "ARM RUN", "KEEP RUN", "STOP RUN",
    "GET TUNE", "SAVE TUNE", "ABORT", "ESTOP",
  ].includes(command)
    || /^CONFIRM (?:ANGLE|RUN) [0-9A-F]{8}$/.test(command)
    || new RegExp(`^SET (?:DRIVE|LINE|ANGLE) ${decimal} ${decimal} ${decimal}$`).test(command);
}

function finiteInRange(value, minimum, maximum, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new WirelessConsoleError(`${name} 必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return number;
}

export function makeWirelessTuneCommand(group, values) {
  const normalized = String(group).trim().toUpperCase();
  let ranges;
  let names;
  if (normalized === "DRIVE") {
    ranges = [[0, 1000], [10, 1500], [0, 1000]];
    names = ["基础速度", "最高速度", "最大差速"];
  } else if (normalized === "LINE") {
    ranges = [[0, 20], [0, 20], [0, 20]];
    names = ["灰度 Kp", "灰度 Ki", "灰度 Kd"];
  } else if (normalized === "ANGLE") {
    ranges = [[0, 100], [0, 100], [0, 100]];
    names = ["角度 Kp", "角度 Ki", "角度 Kd"];
  } else {
    throw new WirelessConsoleError("未知无线调参分组");
  }
  if (!Array.isArray(values) || values.length !== 3) {
    throw new WirelessConsoleError("无线调参需要三个数值");
  }
  const checked = values.map((value, index) => finiteInRange(
    value, ranges[index][0], ranges[index][1], names[index]));
  return `SET ${normalized} ${checked.map((value) => value.toFixed(4)).join(" ")}`;
}

export function parseWirelessReply(line) {
  const armed = /^OK ARMED (ANGLE|RUN) TOKEN=([0-9A-F]{8}) EXPIRES=(\d+)$/.exec(line);
  if (armed) {
    return Object.freeze({
      kind: "armed",
      armKind: armed[1].toLowerCase(),
      token: armed[2],
      expiresMs: Number(armed[3]),
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
    const firmwareVersion = /^[0-9A-F]{8}$/.test(fields.VER || "")
      ? Number.parseInt(fields.VER, 16) : null;
    const wirelessCapabilities = /^[0-9A-F]{2}$/.test(fields.WCAP || "")
      ? Number.parseInt(fields.WCAP, 16) : 0;
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
      firmwareVersion,
      wirelessCapabilities,
      runActive: fields.RUN === "1",
    });
  }
  if (line.startsWith("TUNE ")) {
    const group = /^(?:TUNE) (DRIVE|LINE|ANGLE) /.exec(line)?.[1]?.toLowerCase();
    const fields = parseFields(line);
    if (group === "drive") {
      const values = requiredNumberFields(fields, ["BASE", "MAX", "STEER"]);
      return values ? Object.freeze({ kind: "tune", group,
        values: Object.freeze([values.BASE, values.MAX, values.STEER]) }) : otherReply();
    }
    if (group === "line" || group === "angle") {
      const values = requiredNumberFields(fields, ["KP", "KI", "KD"]);
      return values ? Object.freeze({ kind: "tune", group,
        values: Object.freeze([values.KP, values.KI, values.KD]) }) : otherReply();
    }
    return otherReply();
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
  const runStarted = /^OK RUN START LEASE=(\d+)$/.exec(line);
  if (runStarted) {
    return Object.freeze({ kind: "run-started", leaseMs: Number(runStarted[1]) });
  }
  if (line === "OK RUN STOP") return Object.freeze({ kind: "run-stopped", reason: "command" });
  const runStopped = /^STOP RUN REASON=(TIMEOUT|FAULT)$/.exec(line);
  if (runStopped) return Object.freeze({ kind: "run-stopped", reason: runStopped[1].toLowerCase() });
  if (line === "OK TUNE RAM") return Object.freeze({ kind: "tune-applied" });
  if (line === "OK TUNE SAVED") return Object.freeze({ kind: "tune-saved" });
  if (line === "OK TUNE END") return Object.freeze({ kind: "tune-end" });
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

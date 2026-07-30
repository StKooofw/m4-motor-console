const textEncoder = new TextEncoder();

export const QDRIVE_CONFIG_SPECS = Object.freeze({
  "pid.speed.kp": { min: -1e6, max: 1e6 },
  "pid.speed.ki": { min: -1e6, max: 1e6 },
  "pid.speed.kd": { min: -1e6, max: 1e6 },
  "pid.angle.kp": { min: -1e6, max: 1e6 },
  "pid.angle.ki": { min: -1e6, max: 1e6 },
  "pid.angle.kd": { min: -1e6, max: 1e6 },
  "limit.speed": { min: 0, max: 1000 },
  "limit.current": { min: 0, max: 1.65 },
  "can.id": { min: 0, max: 7, integer: true },
  timeout: { min: 0, max: 3600 },
  "uart.baud_rate": { min: 10000, max: 10000000, integer: true },
});

export const QDRIVE_CONTROL_SPECS = Object.freeze({
  current: { min: -1.65, max: 1.65, unit: "A" },
  speed: { min: -1000, max: 1000, unit: "rpm" },
  low_speed: { min: -1000, max: 1000, unit: "rpm" },
  angle: { min: -2 * Math.PI, max: 2 * Math.PI, unit: "rad" },
  step_angle: { min: -2 * Math.PI, max: 2 * Math.PI, unit: "rad" },
});

export function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\u001b(?:[@-Z\\-_]|\[[0-?]*[-/]*[@-~])/g, "")
    .replace(/\0/g, "");
}

function parseFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError(`${label} 必须是有限数值`);
  return number;
}

function validateNumber(value, spec, label) {
  const number = parseFinite(value, label);
  if (number < spec.min || number > spec.max) {
    throw new RangeError(`${label} 超出范围 ${spec.min}..${spec.max}`);
  }
  if (spec.integer && !Number.isInteger(number)) throw new RangeError(`${label} 必须是整数`);
  return number;
}

export function formatConfigCommand(key, value) {
  const spec = QDRIVE_CONFIG_SPECS[key];
  if (!spec) throw new RangeError(`不支持的 QDrive 参数：${key}`);
  const number = validateNumber(value, spec, key);
  return `config ${key} ${number}`;
}

export function formatControlCommand(mode, value) {
  const spec = QDRIVE_CONTROL_SPECS[mode];
  if (!spec) throw new RangeError(`不支持的 QDrive 控制模式：${mode}`);
  const number = validateNumber(value, spec, mode);
  return `ctrl ${mode} ${number}`;
}

export function parseQDriveStatus(raw) {
  const text = stripAnsi(raw);
  const patterns = {
    canId: /CAN\s+ID\s*:\s*(\d+)/i,
    state: /Status\s*:\s*(enabled|disabled)/i,
    mode: /CtrlMode\s*:\s*([A-Za-z_]+)(?:\s+ctrl)?/i,
    current: /Current\s*:\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*A\b/i,
    speed: /Speed\s*:\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*rpm\b/i,
    angle: /Angle\s*:\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*rad\b/i,
    voltage: /Voltage\s*:\s*([-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*V\b/i,
  };
  const matches = Object.fromEntries(Object.entries(patterns).map(([key, pattern]) => [key, pattern.exec(text)]));
  if (!matches.current || !matches.speed || !matches.angle || !matches.voltage) return null;
  return {
    can_id: matches.canId ? Number(matches.canId[1]) : null,
    enabled: matches.state ? matches.state[1].toLowerCase() === "enabled" : null,
    state: matches.state?.[1]?.toLowerCase() ?? "unknown",
    mode: matches.mode?.[1] ?? "Unknown",
    current_a: Number(matches.current[1]),
    speed_rpm: Number(matches.speed[1]),
    angle_rad: Number(matches.angle[1]),
    voltage_v: Number(matches.voltage[1]),
  };
}

export function isCompleteQDriveStatus(raw) {
  const text = stripAnsi(raw);
  return Boolean(parseQDriveStatus(text)) && /QDrive:\/\$\s*$/.test(text.trim());
}

export function parseQDriveConfig(raw) {
  const values = {};
  const known = new Set(Object.keys(QDRIVE_CONFIG_SPECS));
  for (let line of stripAnsi(raw).split(/\r?\n/)) {
    line = line.trim();
    const match = /^([\w.]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match || !known.has(match[1])) continue;
    if (/^no\s+limit$/i.test(match[2])) {
      values[match[1]] = null;
      continue;
    }
    const numberMatch = /^([-+]?\d+(?:\.\d*)?|[-+]?\.\d+)(?:e[-+]?\d+)?/i.exec(match[2]);
    if (!numberMatch) continue;
    const number = Number(numberMatch[0]);
    if (Number.isFinite(number)) values[match[1]] = number;
  }
  return values;
}

export function parseQDriveIdentity(versionRaw, infoRaw = "") {
  const versionText = stripAnsi(versionRaw);
  const infoText = stripAnsi(infoRaw);
  const hardware = /Hardware\s+version\s+([^\r\n]+)/i.exec(versionText)?.[1]?.trim() ?? null;
  const software = /Software\s+version\s+([^\r\n]+)/i.exec(versionText)?.[1]?.trim() ?? null;
  if (!hardware || !software) return null;
  const info = {};
  for (const line of infoText.split(/\r?\n/)) {
    const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (match) info[match[1].trim()] = match[2].trim();
  }
  return { hardware, software, info };
}

export function qdriveSamplesCsv(samples) {
  const rows = ["time_s,current_A,speed_rpm,angle_rad,voltage_V"];
  for (const sample of samples) {
    rows.push([
      Number(sample.time_s).toFixed(6),
      sample.current_a,
      sample.speed_rpm,
      sample.angle_rad,
      sample.voltage_v,
    ].join(","));
  }
  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

function delay(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

export class QDriveSerialSession {
  constructor(port, events = {}) {
    this.port = port;
    this.events = events;
    this.reader = null;
    this.writer = null;
    this.decoder = new TextDecoder();
    this.readTask = null;
    this.closing = false;
    this.activeCapture = null;
    this.captureChain = Promise.resolve();
  }

  isConnected() {
    return Boolean(this.writer) && !this.closing;
  }

  async open(baudRate = 115200) {
    await this.port.open({ baudRate, bufferSize: 8192 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }

  async readLoop() {
    let unexpected = false;
    try {
      while (!this.closing && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          unexpected = !this.closing;
          break;
        }
        if (!value?.byteLength) continue;
        const chunk = this.decoder.decode(value, { stream: true });
        if (chunk) this.receive(chunk);
      }
    } catch (error) {
      if (!this.closing) {
        unexpected = true;
        this.events.onReadError?.(error);
      }
    } finally {
      try { this.reader?.releaseLock(); } catch { /* already released */ }
      this.reader = null;
      if (unexpected) this.events.onUnexpectedClose?.();
    }
  }

  receive(chunk) {
    if (this.activeCapture) {
      this.activeCapture.text += chunk;
      this.activeCapture.lastRx = Date.now();
      this.activeCapture.received = true;
    }
    if (!this.activeCapture?.silent) this.events.onChunk?.(chunk);
  }

  async sendRaw(value) {
    if (!this.writer || this.closing) throw new Error("QDrive 串口未连接");
    const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
    await this.writer.write(bytes);
  }

  async sendLine(line) {
    await this.sendRaw(`${String(line).replace(/[\r\n]+$/g, "")}\r\n`);
  }

  async waitForCapture() {
    await this.captureChain.catch(() => {});
  }

  captureUntilIdle(action, idleMs = 35, timeoutMs = 1000, options = {}) {
    const task = async () => {
      if (!this.isConnected()) throw new Error("QDrive 串口未连接");
      const capture = { text: "", lastRx: Date.now(), received: false, silent: options.silent === true };
      this.activeCapture = capture;
      try {
        await action();
        const started = Date.now();
        while (Date.now() - started < timeoutMs) {
          await delay(Math.min(20, Math.max(5, Math.floor(idleMs / 2))));
          if (options.isComplete?.(capture.text)) return capture.text;
          if (capture.received && Date.now() - capture.lastRx >= idleMs) return capture.text;
        }
        if (capture.received) return capture.text;
        throw new Error("QDrive 响应超时");
      } finally {
        if (this.activeCapture === capture) this.activeCapture = null;
      }
    };
    const result = this.captureChain.then(task, task);
    this.captureChain = result.catch(() => {});
    return result;
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    try { await this.reader?.cancel(); } catch { /* disconnected */ }
    try { await this.readTask; } catch { /* read loop reports errors */ }
    this.readTask = null;
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    this.writer = null;
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

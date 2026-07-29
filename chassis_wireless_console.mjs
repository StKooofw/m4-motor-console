export const WIRELESS_BAUD_RATE = 115200;

export class WirelessConsoleError extends Error {}

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
  if (line.startsWith("PROGRESS ")) return Object.freeze({ kind: "progress" });
  if (line.startsWith("DONE ")) {
    const result = /(?:^| )RESULT=(\d+)(?: |$)/.exec(line);
    return Object.freeze({ kind: "done", ok: result?.[1] === "1" });
  }
  if (line.startsWith("ERR ")) return Object.freeze({ kind: "error" });
  if (line.startsWith("OK ")) return Object.freeze({ kind: "ok" });
  return Object.freeze({ kind: "other" });
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

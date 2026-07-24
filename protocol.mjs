export const PROTOCOL_VERSION = 1;
export const FLAG_RESPONSE = 1;
export const MAX_PAYLOAD = 256;

export const COMMAND = Object.freeze({
  PING: 0x01,
  GET_STATUS: 0x02,
  SET_ENABLE: 0x10,
  SET_OPEN_LOOP: 0x11,
  SET_SPEED: 0x12,
  ESTOP: 0x13,
  CLEAR_ESTOP: 0x14,
  GET_PARAMS: 0x20,
  SET_PARAMS: 0x21,
  SAVE_PARAMS: 0x22,
  ENTER_UPDATE: 0x30,
  ACK: 0x7e,
  NACK: 0x7f,
});

export const ERROR_NAMES = Object.freeze({
  0: "成功",
  1: "协议版本不匹配",
  2: "数据长度错误",
  3: "CRC 错误",
  4: "未知命令",
  5: "电机编号错误",
  6: "参数值错误",
  7: "急停已锁存",
  8: "设备忙",
  9: "Flash 操作失败",
  10: "序号错误",
});

export const PARAM_MAGIC = 0x4d50524d;
export const PARAM_VERSION = 1;
export const PARAM_SIZE = 200;

const SOF0 = 0xa5;
const SOF1 = 0x5a;

export class ProtocolError extends Error {}

export function crc32Msp(input, seed = 0xffffffff) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  let crc = seed >>> 0;
  for (const value of data) {
    crc = (crc ^ value) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)) >>> 0;
    }
  }
  return crc >>> 0;
}

export function encodeFrame(sequence, command, payload = new Uint8Array(), flags = 0) {
  const body = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (body.length > MAX_PAYLOAD) {
    throw new RangeError("payload exceeds protocol limit");
  }
  const packet = new Uint8Array(10 + body.length + 4);
  const view = new DataView(packet.buffer);
  packet[0] = SOF0;
  packet[1] = SOF1;
  packet[2] = PROTOCOL_VERSION;
  packet[3] = flags;
  view.setUint16(4, sequence & 0xffff, true);
  packet[6] = command;
  packet[7] = 0;
  view.setUint16(8, body.length, true);
  packet.set(body, 10);
  view.setUint32(10 + body.length, crc32Msp(packet.subarray(2, 10 + body.length)), true);
  return packet;
}

export class FrameDecoder {
  constructor() {
    this.buffer = new Uint8Array();
    this.errorCount = 0;
  }

  feed(chunk) {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const combined = new Uint8Array(this.buffer.length + incoming.length);
    combined.set(this.buffer);
    combined.set(incoming, this.buffer.length);
    this.buffer = combined;
    const frames = [];

    while (this.buffer.length > 0) {
      let start = -1;
      for (let index = 0; index + 1 < this.buffer.length; index += 1) {
        if (this.buffer[index] === SOF0 && this.buffer[index + 1] === SOF1) {
          start = index;
          break;
        }
      }
      if (start < 0) {
        this.buffer = this.buffer.at(-1) === SOF0
          ? this.buffer.slice(-1)
          : new Uint8Array();
        break;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < 10) break;

      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const payloadLength = view.getUint16(8, true);
      if (payloadLength > MAX_PAYLOAD) {
        this.errorCount += 1;
        this.buffer = this.buffer.slice(1);
        continue;
      }
      const total = 10 + payloadLength + 4;
      if (this.buffer.length < total) break;
      const packet = this.buffer.slice(0, total);
      this.buffer = this.buffer.slice(total);
      const packetView = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      const expected = packetView.getUint32(total - 4, true);
      if (crc32Msp(packet.subarray(2, total - 4)) !== expected) {
        this.errorCount += 1;
        continue;
      }
      frames.push({
        version: packet[2],
        flags: packet[3],
        sequence: packetView.getUint16(4, true),
        command: packet[6],
        payload: packet.slice(10, 10 + payloadLength),
      });
    }
    return frames;
  }
}

export function decodeCommandResponse(frame, expectedCommand) {
  if (frame.version !== PROTOCOL_VERSION || !(frame.flags & FLAG_RESPONSE) ||
      ![COMMAND.ACK, COMMAND.NACK].includes(frame.command) || frame.payload.length < 2) {
    throw new ProtocolError("设备响应帧格式错误");
  }
  const originalCommand = frame.payload[0];
  const errorCode = frame.payload[1];
  if (originalCommand !== expectedCommand) {
    throw new ProtocolError("响应命令与请求不匹配");
  }
  if (frame.command === COMMAND.NACK || errorCode !== 0) {
    throw new ProtocolError(ERROR_NAMES[errorCode] || `设备错误 ${errorCode}`);
  }
  return frame.payload.slice(2);
}

export function decodeStatus(payload) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (data.length !== 96) throw new ProtocolError(`状态长度为 ${data.length}，应为 96`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const motors = [];
  for (let motor = 0; motor < 4; motor += 1) {
    const offset = 16 + motor * 20;
    motors.push({
      index: motor,
      encoderCount: view.getInt32(offset, true),
      speedMrpm: view.getInt32(offset + 4, true),
      targetMrpm: view.getInt32(offset + 8, true),
      outputPermille: view.getInt16(offset + 12, true),
      enabled: view.getUint8(offset + 14) !== 0,
      mode: view.getUint8(offset + 15),
      encoderErrors: view.getUint32(offset + 16, true),
    });
  }
  return {
    uptimeMs: view.getUint32(0, true),
    faults: view.getUint32(4, true),
    lastCommandMs: view.getUint32(8, true),
    estopLatched: view.getUint8(12) !== 0,
    motors,
  };
}

export function decodeParams(payload) {
  const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (data.length !== PARAM_SIZE) throw new ProtocolError(`参数长度为 ${data.length}，应为 ${PARAM_SIZE}`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const storedCrc = view.getUint32(196, true);
  if (crc32Msp(data.subarray(0, 196)) !== storedCrc) throw new ProtocolError("参数 CRC 错误");
  if (view.getUint32(0, true) !== PARAM_MAGIC ||
      view.getUint16(4, true) !== PARAM_VERSION ||
      view.getUint16(6, true) !== PARAM_SIZE) {
    throw new ProtocolError("参数格式不受支持");
  }

  const motors = [];
  for (let motor = 0; motor < 4; motor += 1) {
    const offset = 20 + motor * 40;
    motors.push({
      kpQ16: view.getInt32(offset, true),
      kiQ16: view.getInt32(offset + 4, true),
      kdQ16: view.getInt32(offset + 8, true),
      kawQ16: view.getInt32(offset + 12, true),
      derivativeAlphaQ16: view.getInt32(offset + 16, true),
      encoderCountsPerRev: view.getUint32(offset + 20, true),
      gearRatioQ16: view.getUint32(offset + 24, true),
      maxSpeedMrpm: view.getInt32(offset + 28, true),
      maxDutyPermille: view.getUint16(offset + 32, true),
      accelMrpmPerTick: view.getUint16(offset + 34, true),
      invertMotor: view.getUint8(offset + 36),
      invertEncoder: view.getUint8(offset + 37),
      reserved: view.getUint16(offset + 38, true),
    });
  }
  return {
    magic: PARAM_MAGIC,
    version: PARAM_VERSION,
    size: PARAM_SIZE,
    sequence: view.getUint32(8, true),
    controlTimeoutMs: view.getUint32(12, true),
    lowSpeedWindowMs: view.getUint32(16, true),
    motors,
    reserved: [
      view.getUint32(180, true),
      view.getUint32(184, true),
      view.getUint32(188, true),
      view.getUint32(192, true),
    ],
    crc32: storedCrc,
  };
}

export function encodeParams(params) {
  if (!params || !Array.isArray(params.motors) || params.motors.length !== 4) {
    throw new ProtocolError("参数必须包含四路电机");
  }
  const data = new Uint8Array(PARAM_SIZE);
  const view = new DataView(data.buffer);
  view.setUint32(0, PARAM_MAGIC, true);
  view.setUint16(4, PARAM_VERSION, true);
  view.setUint16(6, PARAM_SIZE, true);
  view.setUint32(8, params.sequence >>> 0, true);
  view.setUint32(12, params.controlTimeoutMs >>> 0, true);
  view.setUint32(16, params.lowSpeedWindowMs >>> 0, true);
  params.motors.forEach((motor, index) => {
    const offset = 20 + index * 40;
    view.setInt32(offset, motor.kpQ16, true);
    view.setInt32(offset + 4, motor.kiQ16, true);
    view.setInt32(offset + 8, motor.kdQ16, true);
    view.setInt32(offset + 12, motor.kawQ16, true);
    view.setInt32(offset + 16, motor.derivativeAlphaQ16, true);
    view.setUint32(offset + 20, motor.encoderCountsPerRev >>> 0, true);
    view.setUint32(offset + 24, motor.gearRatioQ16 >>> 0, true);
    view.setInt32(offset + 28, motor.maxSpeedMrpm, true);
    view.setUint16(offset + 32, motor.maxDutyPermille, true);
    view.setUint16(offset + 34, motor.accelMrpmPerTick, true);
    view.setUint8(offset + 36, motor.invertMotor ? 1 : 0);
    view.setUint8(offset + 37, motor.invertEncoder ? 1 : 0);
    view.setUint16(offset + 38, motor.reserved || 0, true);
  });
  (params.reserved || [0, 0, 0, 0]).forEach((value, index) => {
    view.setUint32(180 + index * 4, value >>> 0, true);
  });
  view.setUint32(196, crc32Msp(data.subarray(0, 196)), true);
  return data;
}

export function makeIntPayload(byteLength, writer) {
  const data = new Uint8Array(byteLength);
  writer(new DataView(data.buffer), data);
  return data;
}

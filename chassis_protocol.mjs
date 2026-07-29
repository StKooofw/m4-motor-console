import {
  PROTOCOL_VERSION,
  FLAG_RESPONSE,
  FrameDecoder,
  ProtocolError,
  crc32Msp,
  encodeFrame,
} from "./protocol.mjs";

export { FrameDecoder, ProtocolError, crc32Msp, encodeFrame };

export const PRODUCT_ID = 0x53414843;
export const PARAM_MAGIC = 0x50534843;
export const PARAM_VERSION = 3;
export const PARAM_SIZE = 64;
export const ANGLE_AUTOTUNE_SAFETY_TOKEN = 0x45464153;
export const CAP_MOTOR_BRIDGE = 1 << 5;
export const CAP_MOTOR_LIMITS = 1 << 6;
export const CAP_IMU_FUSION = 1 << 7;
export const CAP_DIFF_CALIBRATION = 1 << 8;

export function normalizeHeadingDegrees(angle) {
  if (!Number.isFinite(angle)) return Number.NaN;
  const normalized = angle % 360;
  if (normalized === 0) return 0;
  return normalized < 0 ? normalized + 360 : normalized;
}

export const COMMAND = Object.freeze({
  PING: 0x01,
  GET_TELEMETRY: 0x02,
  SET_RUN: 0x10,
  SET_WHEELS: 0x11,
  ESTOP: 0x12,
  CLEAR_ESTOP: 0x13,
  ZERO_YAW: 0x14,
  CALIBRATE_GYRO: 0x15,
  START_ANGLE_AUTOTUNE: 0x16,
  ABORT_CALIBRATION: 0x17,
  GET_PARAMS: 0x20,
  SET_PARAMS: 0x21,
  SAVE_PARAMS: 0x22,
  GET_MOTOR_LIMITS: 0x23,
  GET_IMU_TELEMETRY: 0x24,
  ENTER_UPDATE: 0x30,
  ENTER_MOTOR_BRIDGE: 0x31,
  ACK: 0x7e,
  NACK: 0x7f,
});

const ERROR_NAMES = Object.freeze({
  0: "成功",
  1: "协议版本不匹配",
  2: "数据长度错误",
  3: "CRC 错误",
  4: "未知命令",
  5: "参数值无效",
  6: "设备尚未就绪",
  7: "设备忙",
  8: "安全确认无效",
  9: "Flash 操作失败",
});

export function decodeCommandResponse(frame, expectedCommand) {
  if (frame.version !== PROTOCOL_VERSION || !(frame.flags & FLAG_RESPONSE) ||
      ![COMMAND.ACK, COMMAND.NACK].includes(frame.command) || frame.payload.length < 2) {
    throw new ProtocolError("底盘响应帧格式错误");
  }
  if (frame.payload[0] !== expectedCommand) throw new ProtocolError("响应命令不匹配");
  const errorCode = frame.payload[1];
  if (frame.command === COMMAND.NACK || errorCode !== 0) {
    throw new ProtocolError(ERROR_NAMES[errorCode] || `底盘错误 ${errorCode}`);
  }
  return frame.payload.slice(2);
}

export function decodeIdentity(payload) {
  if (payload.length !== 16) throw new ProtocolError("底盘身份长度错误");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const identity = {
    version: view.getUint32(0, true),
    productId: view.getUint32(4, true),
    capabilities: view.getUint32(8, true),
    protocolVersion: view.getUint32(12, true),
  };
  if (identity.productId !== PRODUCT_ID) throw new ProtocolError("所选串口不是灰度循迹底盘");
  return Object.freeze(identity);
}

export function decodeTelemetry(payload) {
  if (![100, 148].includes(payload.length)) {
    throw new ProtocolError(`底盘遥测长度为 ${payload.length}，应为 100 或 148`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = view.getUint8(7);
  const extended = payload.length === 148;
  return Object.freeze({
    uptimeMs: view.getUint32(0, true),
    state: view.getUint8(4),
    mode: view.getUint8(5),
    activeCount: view.getUint8(6),
    lineVisible: Boolean(flags & (1 << 0)),
    lineLost: Boolean(flags & (1 << 1)),
    imuCalibrated: Boolean(flags & (1 << 2)),
    calibrationBusy: Boolean(flags & (1 << 3)),
    candidateValid: Boolean(flags & (1 << 4)),
    rawGrayBits: view.getUint16(8, true),
    activeGrayBits: view.getUint16(10, true),
    linePositionMm: view.getInt32(12, true) / 1000,
    gyroZDps: view.getInt32(16, true) / 1000,
    yawDeg: view.getInt32(20, true) / 1000,
    yawReferenceDeg: view.getInt32(24, true) / 1000,
    angleErrorDeg: view.getInt32(28, true) / 1000,
    steerMmS: view.getInt32(32, true) / 1000,
    leftSpeedMmS: view.getInt32(36, true) / 1000,
    rightSpeedMmS: view.getInt32(40, true) / 1000,
    leftTargetMrpm: view.getInt32(44, true),
    rightTargetMrpm: view.getInt32(48, true),
    imuBiasDps: view.getInt32(52, true) / 1000,
    sensorFailures: view.getUint32(56, true),
    imuFailures: view.getUint32(60, true),
    motorFailures: view.getUint32(64, true),
    protocolErrors: view.getUint32(68, true),
    lastValidCommandMs: view.getUint32(72, true),
    calibrationState: view.getUint8(76),
    calibrationProgress: view.getUint8(77),
    calibrationResult: view.getUint16(78, true),
    candidateAngleKp: view.getFloat32(80, true),
    candidateAngleKi: view.getFloat32(84, true),
    candidateAngleKd: view.getFloat32(88, true),
    peakGyroDps: view.getFloat32(92, true),
    responseTimeMs: view.getUint32(96, true),
    differentialCalibrationTelemetry: extended,
    effectiveTrackMm: extended ? view.getFloat32(100, true) : null,
    clockwiseGainDpsPerMmS: extended ? view.getFloat32(104, true) : null,
    counterclockwiseGainDpsPerMmS: extended ? view.getFloat32(108, true) : null,
    directionAsymmetryPercent: extended ? view.getFloat32(112, true) : null,
    stepTargetDeg: extended ? view.getFloat32(116, true) : null,
    worstStepOvershootDeg: extended ? view.getFloat32(120, true) : null,
    worstStepSettleTimeMs: extended ? view.getUint32(124, true) : null,
    leftActualMrpm: extended ? view.getInt32(128, true) : null,
    rightActualMrpm: extended ? view.getInt32(132, true) : null,
    leftOutputPermille: extended ? view.getInt16(136, true) : null,
    rightOutputPermille: extended ? view.getInt16(138, true) : null,
    motorBoardFaults: extended ? view.getUint32(140, true) : null,
    calibrationStageIndex: extended ? view.getUint8(144) : 0,
    calibrationStageTotal: extended ? view.getUint8(145) : 0,
    motorStatusValid: extended ? view.getUint8(146) === 1 : false,
  });
}

export function decodeParams(payload) {
  if (payload.length !== PARAM_SIZE) throw new ProtocolError("底盘参数长度错误");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const version = view.getUint16(4, true);
  if (view.getUint32(0, true) !== PARAM_MAGIC ||
      ![1, 2, PARAM_VERSION].includes(version) || view.getUint16(6, true) !== PARAM_SIZE ||
      view.getUint32(60, true) !== crc32Msp(payload.subarray(0, 60))) {
    throw new ProtocolError("底盘参数格式或 CRC 错误");
  }
  if (version >= 3 && view.getUint8(54) > 1) {
    throw new ProtocolError("底盘灰度极性参数错误");
  }
  return Object.freeze({
    parameterVersion: version,
    baseSpeedMmS: view.getFloat32(12, true),
    maxSpeedMmS: view.getFloat32(16, true),
    maxSteerMmS: view.getFloat32(20, true),
    lineKp: view.getFloat32(24, true),
    lineKi: view.getFloat32(28, true),
    lineKd: view.getFloat32(32, true),
    angleKp: view.getFloat32(36, true),
    angleKi: view.getFloat32(40, true),
    angleKd: view.getFloat32(44, true),
    commandTimeoutMs: view.getUint32(48, true),
    leftMotorChannel: version >= 2 ? view.getUint8(52) : 0,
    rightMotorChannel: version >= 2 ? view.getUint8(53) : 2,
    grayActiveHigh: version >= 3 ? view.getUint8(54) === 1 : true,
  });
}

export function decodeImuTelemetry(payload) {
  if (payload.length !== 96) {
    throw new ProtocolError(`IMU 遥测长度为 ${payload.length}，应为 96`);
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const flags = view.getUint32(4, true);
  const vector = (offset) => Object.freeze([0, 1, 2].map((axis) =>
    view.getFloat32(offset + axis * 4, true)));
  return Object.freeze({
    sampleSequence: view.getUint32(0, true),
    fusionInitialized: Boolean(flags & (1 << 0)),
    stationary: Boolean(flags & (1 << 1)),
    biasTracking: Boolean(flags & (1 << 2)),
    calibrated: Boolean(flags & (1 << 3)),
    rawGyroDps: vector(8),
    gyroDps: vector(20),
    accelG: vector(32),
    rollDeg: view.getFloat32(44, true),
    pitchDeg: view.getFloat32(48, true),
    yawDeg: view.getFloat32(52, true),
    temperatureC: view.getFloat32(56, true),
    gyroBiasDps: vector(60),
    accelNormG: view.getFloat32(72, true),
    gyroNoiseRmsDps: view.getFloat32(76, true),
    accelNoiseRmsG: view.getFloat32(80, true),
    stationaryTimeS: view.getFloat32(84, true),
    yawUnwrappedDeg: view.getFloat32(88, true),
  });
}

export function decodeMotorLimits(payload) {
  if (payload.length !== 20) throw new ProtocolError("Motor limit payload length is invalid");
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const syncedValue = view.getUint8(0);
  if (syncedValue > 1 || view.getUint8(1) !== 4 ||
      view.getUint16(2, true) !== 0) {
    throw new ProtocolError("Motor limit payload format is invalid");
  }
  const limitsMrpm = Object.freeze(Array.from({ length: 4 }, (_, index) =>
    view.getInt32(4 + index * 4, true)));
  if (syncedValue && limitsMrpm.some((limit) => limit <= 0)) {
    throw new ProtocolError("Motor Flash speed limit is invalid");
  }
  return Object.freeze({ synced: Boolean(syncedValue), limitsMrpm });
}

export function encodeParams(params, version = PARAM_VERSION) {
  const leftMotorChannel = Number(params.leftMotorChannel);
  const rightMotorChannel = Number(params.rightMotorChannel);
  const grayActiveHigh = Number(params.grayActiveHigh);
  if (!Number.isInteger(leftMotorChannel) || !Number.isInteger(rightMotorChannel) ||
      leftMotorChannel < 0 || leftMotorChannel > 3 ||
      rightMotorChannel < 0 || rightMotorChannel > 3 ||
      leftMotorChannel === rightMotorChannel) {
    throw new ProtocolError("左右轮必须选择两个不同的 A/B/C/D 通道");
  }
  if (!Number.isInteger(grayActiveHigh) || grayActiveHigh < 0 ||
      grayActiveHigh > 1) {
    throw new ProtocolError("灰度黑线有效电平只能选择低电平或高电平");
  }
  if (![1, 2, PARAM_VERSION].includes(version)) throw new ProtocolError("不支持的底盘参数版本");
  if (version === 1 && (leftMotorChannel !== 0 || rightMotorChannel !== 2)) {
    throw new ProtocolError("自选电机通道需要先升级到 CHAS v1.0.3 或更高版本");
  }
  if (version < 3 && grayActiveHigh !== 1) {
    throw new ProtocolError("灰度反相需要先升级到 CHAS v1.0.9 或更高版本");
  }
  const data = new Uint8Array(PARAM_SIZE);
  const view = new DataView(data.buffer);
  view.setUint32(0, PARAM_MAGIC, true);
  view.setUint16(4, version, true);
  view.setUint16(6, PARAM_SIZE, true);
  view.setFloat32(12, Number(params.baseSpeedMmS), true);
  view.setFloat32(16, Number(params.maxSpeedMmS), true);
  view.setFloat32(20, Number(params.maxSteerMmS), true);
  view.setFloat32(24, Number(params.lineKp), true);
  view.setFloat32(28, Number(params.lineKi), true);
  view.setFloat32(32, Number(params.lineKd), true);
  view.setFloat32(36, Number(params.angleKp), true);
  view.setFloat32(40, Number(params.angleKi), true);
  view.setFloat32(44, Number(params.angleKd), true);
  view.setUint32(48, Number(params.commandTimeoutMs) >>> 0, true);
  if (version >= 2) {
    view.setUint8(52, leftMotorChannel);
    view.setUint8(53, rightMotorChannel);
  }
  if (version >= 3) view.setUint8(54, grayActiveHigh);
  view.setUint32(60, crc32Msp(data.subarray(0, 60)), true);
  return data;
}

export function makeIntPayload(length, writer) {
  const data = new Uint8Array(length);
  writer(new DataView(data.buffer), data);
  return data;
}

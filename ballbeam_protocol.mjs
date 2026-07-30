export const PROTOCOL_VERSION = 1;
export const PRODUCT_ID = "BBK230";
export const MAX_LINE_BYTES = 2048;

export const COMMANDS = Object.freeze([
  "ping", "heartbeat", "estop", "clear_fault", "arm", "disarm",
  "set_target", "set_mode", "set_config", "set_policy",
  "start_sequence", "start_episode", "stop_episode",
]);

export const DEFAULT_CONFIG = Object.freeze({
  left_px: Object.freeze([90, 250]),
  right_px: Object.freeze([710, 250]),
  left_cm: -12,
  right_cm: 12,
  roi: Object.freeze([40, 170, 720, 160]),
  vision_timeout_ms: 180,
  qdrive_timeout_ms: 90,
  lease_timeout_ms: 600,
  motor_min_deg: 17.826,
  motor_neutral_deg: 60,
  motor_max_deg: 92.817,
  beam_min_deg: -6,
  beam_max_deg: 6,
  max_motor_step_deg: 2,
  max_current_a: 1.5,
  max_ball_speed_cm_s: 80,
  kp: 0.55,
  ki: 0.04,
  kd: 0.18,
  integral_limit: 12,
  control_sign: 1,
});

export const DEFAULT_POLICY = Object.freeze({
  weights: Object.freeze([0, 0, 0, 0]),
  bias_deg: 0,
  max_residual_deg: 1,
});

export class ProtocolError extends Error {}

function finite(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ProtocolError(`${name} 必须是有限数值`);
  return parsed;
}

function finiteOrNull(value, name) {
  if (value === null || value === undefined) return null;
  return finite(value, name);
}

function point(value, name) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ProtocolError(`${name} 必须包含 x/y`);
  }
  return [finite(value[0], name), finite(value[1], name)];
}

export function validateConfig(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ProtocolError("配置必须是对象");
  }
  for (const key of Object.keys(candidate)) {
    if (!(key in DEFAULT_CONFIG)) throw new ProtocolError(`未知配置字段：${key}`);
  }
  const config = { ...DEFAULT_CONFIG };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (Object.hasOwn(candidate, key)) config[key] = candidate[key];
  }
  config.left_px = point(config.left_px, "左端像素");
  config.right_px = point(config.right_px, "右端像素");
  const dx = config.right_px[0] - config.left_px[0];
  const dy = config.right_px[1] - config.left_px[1];
  if (dx * dx + dy * dy < 10000) throw new ProtocolError("标定端点距离过近");
  if (!Array.isArray(config.roi) || config.roi.length !== 4) {
    throw new ProtocolError("ROI 必须包含 x/y/宽/高");
  }
  config.roi = config.roi.map((value) => Math.trunc(finite(value, "ROI")));
  if (config.roi[0] < 0 || config.roi[1] < 0 || config.roi[2] < 32 || config.roi[3] < 32) {
    throw new ProtocolError("ROI 范围无效");
  }
  for (const key of [
    "left_cm", "right_cm", "motor_min_deg", "motor_neutral_deg", "motor_max_deg",
    "beam_min_deg", "beam_max_deg", "max_motor_step_deg", "max_current_a",
    "max_ball_speed_cm_s", "kp", "ki", "kd", "integral_limit", "control_sign",
  ]) config[key] = finite(config[key], key);
  for (const key of ["vision_timeout_ms", "qdrive_timeout_ms", "lease_timeout_ms"]) {
    config[key] = Math.trunc(finite(config[key], key));
  }
  if (config.right_cm - config.left_cm < 10) throw new ProtocolError("摆杆长度标定无效");
  if (config.vision_timeout_ms < 80 || config.vision_timeout_ms > 1000) throw new ProtocolError("视觉超时应为 80..1000 ms");
  if (config.qdrive_timeout_ms < 30 || config.qdrive_timeout_ms > 500) throw new ProtocolError("QDrive 超时应为 30..500 ms");
  if (config.lease_timeout_ms < 300 || config.lease_timeout_ms > 2000) throw new ProtocolError("网页租约应为 300..2000 ms");
  if (config.max_motor_step_deg < 0.1 || config.max_motor_step_deg > 8) throw new ProtocolError("电机单步应为 0.1..8°");
  if (config.max_current_a < 0.1 || config.max_current_a > 5) throw new ProtocolError("电流门限应为 0.1..5 A");
  if (config.max_ball_speed_cm_s < 5 || config.max_ball_speed_cm_s > 300) throw new ProtocolError("球速门限应为 5..300 cm/s");
  if (![-1, 1].includes(config.control_sign)) throw new ProtocolError("控制方向只能为 -1 或 1");
  if (!(config.motor_min_deg < config.motor_neutral_deg && config.motor_neutral_deg < config.motor_max_deg)) {
    throw new ProtocolError("电机角度范围无效");
  }
  if (!(config.beam_min_deg < 0 && config.beam_max_deg > 0)) throw new ProtocolError("摆杆角度范围无效");
  if ([config.kp, config.ki, config.kd].some((value) => value < 0 || value > 20)) {
    throw new ProtocolError("控制增益应为 0..20");
  }
  if (config.integral_limit <= 0 || config.integral_limit > 100) throw new ProtocolError("积分限幅应为 0..100");
  return Object.freeze(config);
}

export function validatePolicy(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new ProtocolError("策略必须是对象");
  }
  if (!Array.isArray(candidate.weights) || candidate.weights.length !== 4) {
    throw new ProtocolError("策略权重必须为 4 项");
  }
  const policy = {
    weights: candidate.weights.map((value) => finite(value, "策略权重")),
    bias_deg: finite(candidate.bias_deg ?? 0, "策略偏置"),
    max_residual_deg: finite(candidate.max_residual_deg ?? 1, "策略残差限幅"),
  };
  if (policy.weights.some((value) => Math.abs(value) > 10)) throw new ProtocolError("策略权重绝对值不得超过 10");
  if (Math.abs(policy.bias_deg) > 3) throw new ProtocolError("策略偏置绝对值不得超过 3°");
  if (policy.max_residual_deg < 0 || policy.max_residual_deg > 3) throw new ProtocolError("策略残差限幅应为 0..3°");
  return Object.freeze(policy);
}

export function encodeCommand(sequence, command, data = {}) {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0x7fffffff) {
    throw new ProtocolError("命令序号无效");
  }
  if (!COMMANDS.includes(command)) throw new ProtocolError("未知命令");
  const message = {
    v: PROTOCOL_VERSION,
    product: PRODUCT_ID,
    seq: sequence,
    type: "command",
    command,
    data,
  };
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

function validateEnvelope(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) throw new ProtocolError("消息不是对象");
  if (message.v !== PROTOCOL_VERSION) throw new ProtocolError("协议版本不匹配");
  if (message.product !== PRODUCT_ID) throw new ProtocolError("所选串口不是滚球 K230 控制器");
  return message;
}

export function decodeMessage(message) {
  validateEnvelope(message);
  if (message.type === "ack") {
    if (!Number.isInteger(message.seq) || !COMMANDS.includes(message.command) || typeof message.ok !== "boolean") {
      throw new ProtocolError("ACK 格式错误");
    }
    return message;
  }
  if (message.type === "event") {
    if (typeof message.event !== "string" || typeof message.data !== "object") throw new ProtocolError("事件格式错误");
    return message;
  }
  if (message.type === "telemetry") return {
    ...message,
    data: normalizeTelemetry(message.data),
  };
  throw new ProtocolError("未知消息类型");
}

export function normalizeTelemetry(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ProtocolError("遥测格式错误");
  const state = String(data.state || "");
  const mode = String(data.mode || "");
  if (!['SAFE', 'READY', 'ARMED', 'FAULT', 'ESTOP'].includes(state)) throw new ProtocolError("控制状态无效");
  if (!['baseline', 'policy'].includes(mode)) throw new ProtocolError("控制模式无效");
  return Object.freeze({
    ...data,
    state,
    mode,
    sample: Math.trunc(finite(data.sample, "sample")),
    timestamp_ms: Math.trunc(finite(data.timestamp_ms, "timestamp_ms")),
    target_cm: finite(data.target_cm, "target_cm"),
    ball_valid: Boolean(data.ball_valid),
    ball_cm: finiteOrNull(data.ball_cm, "ball_cm"),
    ball_velocity_cm_s: finite(data.ball_velocity_cm_s, "ball_velocity_cm_s"),
    vision_confidence: finite(data.vision_confidence, "vision_confidence"),
    vision_age_ms: finiteOrNull(data.vision_age_ms, "vision_age_ms"),
    beam_target_deg: finite(data.beam_target_deg, "beam_target_deg"),
    baseline_deg: finite(data.baseline_deg, "baseline_deg"),
    policy_residual_deg: finite(data.policy_residual_deg, "policy_residual_deg"),
    motor_target_deg: finite(data.motor_target_deg, "motor_target_deg"),
    qdrive_online: Boolean(data.qdrive_online),
    qdrive_enabled: Boolean(data.qdrive_enabled),
    qdrive_age_ms: finiteOrNull(data.qdrive_age_ms, "qdrive_age_ms"),
    motor_angle_deg: finiteOrNull(data.motor_angle_deg, "motor_angle_deg"),
    motor_speed_rpm: finiteOrNull(data.motor_speed_rpm, "motor_speed_rpm"),
    motor_current_a: finiteOrNull(data.motor_current_a, "motor_current_a"),
    lease_age_ms: finiteOrNull(data.lease_age_ms, "lease_age_ms"),
  });
}

export class LineDecoder {
  constructor(maxLineBytes = MAX_LINE_BYTES) {
    this.maxLineBytes = maxLineBytes;
    this.buffer = new Uint8Array();
    this.errors = 0;
  }

  feed(chunk) {
    if (!chunk?.length) return [];
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;
    const messages = [];
    while (true) {
      const newline = this.buffer.indexOf(10);
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.length) continue;
      if (line.length > this.maxLineBytes) { this.errors += 1; continue; }
      try {
        messages.push(decodeMessage(JSON.parse(new TextDecoder().decode(line))));
      } catch { this.errors += 1; }
    }
    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = new Uint8Array();
      this.errors += 1;
    }
    return messages;
  }
}

export function summarizeEpisode(samples) {
  const usable = samples.filter((sample) => sample.ball_valid && sample.ball_cm !== null);
  if (!usable.length) return null;
  const errors = usable.map((sample) => Math.abs(sample.target_cm - sample.ball_cm));
  const durationMs = Math.max(0, usable.at(-1).timestamp_ms - usable[0].timestamp_ms);
  const currents = usable.map((sample) => Math.abs(sample.motor_current_a || 0));
  const speeds = usable.map((sample) => Math.abs(sample.ball_velocity_cm_s));
  return Object.freeze({
    samples: usable.length,
    duration_ms: durationMs,
    mean_abs_error_cm: errors.reduce((sum, value) => sum + value, 0) / errors.length,
    max_abs_error_cm: Math.max(...errors),
    within_1cm_ratio: errors.filter((value) => value <= 1).length / errors.length,
    max_current_a: Math.max(...currents),
    max_ball_speed_cm_s: Math.max(...speeds),
  });
}

export function episodeCsv(samples) {
  const fields = [
    "sample", "timestamp_ms", "state", "mode", "target_cm", "ball_valid", "ball_cm",
    "ball_velocity_cm_s", "vision_confidence", "beam_target_deg", "baseline_deg",
    "policy_residual_deg", "motor_target_deg", "motor_angle_deg", "motor_speed_rpm",
    "motor_current_a", "qdrive_age_ms", "lease_age_ms", "fault",
  ];
  const value = (item) => item === null || item === undefined ? "" : String(item);
  return [fields.join(","), ...samples.map((sample) => fields.map((field) => value(sample[field])).join(","))].join("\n");
}

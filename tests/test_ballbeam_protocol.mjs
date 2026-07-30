import assert from "node:assert/strict";

import {
  LineDecoder,
  ProtocolError,
  decodeMessage,
  encodeCommand,
  episodeCsv,
  summarizeEpisode,
  validateConfig,
  validatePolicy,
} from "../ballbeam_protocol.mjs";

const command = encodeCommand(7, "set_target", { target_cm: 5 });
const parsedCommand = JSON.parse(new TextDecoder().decode(command));
assert.equal(parsedCommand.product, "BBK230");
assert.equal(parsedCommand.seq, 7);
assert.equal(parsedCommand.data.target_cm, 5);

const ack = { v: 1, product: "BBK230", seq: 7, type: "ack", command: "set_target", ok: true, data: {} };
const telemetry = {
  v: 1, product: "BBK230", type: "telemetry", data: {
    sample: 1, timestamp_ms: 1000, state: "ARMED", mode: "baseline", fault: "",
    target_cm: 5, ball_valid: true, ball_cm: 4.5, ball_velocity_cm_s: 1,
    vision_confidence: 0.9, vision_age_ms: 10, beam_target_deg: 1,
    baseline_deg: 1, policy_residual_deg: 0, motor_target_deg: 65,
    qdrive_online: true, qdrive_enabled: true, qdrive_age_ms: 3,
    motor_angle_deg: 64.8, motor_speed_rpm: 1, motor_current_a: 0.2,
    lease_age_ms: 20,
  },
};
const decoder = new LineDecoder();
const bytes = new TextEncoder().encode(`${JSON.stringify(ack)}\ninvalid\n${JSON.stringify(telemetry)}\n`);
assert.deepEqual(decoder.feed(bytes.slice(0, 12)), []);
const messages = decoder.feed(bytes.slice(12));
assert.equal(messages.length, 2);
assert.equal(messages[1].data.ball_cm, 4.5);
assert.equal(decoder.errors, 1);

assert.throws(() => decodeMessage({ ...ack, product: "CHAS" }), /不是滚球/);
assert.throws(() => encodeCommand(1, "raw_motor", {}), ProtocolError);

const config = validateConfig({});
assert.equal(config.motor_neutral_deg, 60);
assert.throws(() => validateConfig({ lease_timeout_ms: 2500 }), /租约/);
assert.throws(() => validateConfig({ motor_min_deg: 70 }), /角度/);
assert.throws(() => validateConfig({ exposure_us: 8000 }), /未知配置字段/);
assert.throws(() => validateConfig({ min_radius_px: 8 }), /未知配置字段/);

const policy = validatePolicy({ weights: [1, 2, 3, 4], bias_deg: 0.2, max_residual_deg: 1 });
assert.deepEqual(policy.weights, [1, 2, 3, 4]);
assert.throws(() => validatePolicy({ weights: [1, 2], bias_deg: 0, max_residual_deg: 1 }));

const sampleA = { ...telemetry.data, timestamp_ms: 1000, ball_cm: 4, motor_current_a: 0.2 };
const sampleB = { ...telemetry.data, sample: 2, timestamp_ms: 1200, ball_cm: 5.5, motor_current_a: -0.4 };
const summary = summarizeEpisode([sampleA, sampleB]);
assert.equal(summary.samples, 2);
assert.equal(summary.duration_ms, 200);
assert.equal(summary.mean_abs_error_cm, 0.75);
assert.equal(summary.max_current_a, 0.4);
assert.match(episodeCsv([sampleA, sampleB]), /^sample,timestamp_ms/);

console.log("ball-beam protocol web tests passed");

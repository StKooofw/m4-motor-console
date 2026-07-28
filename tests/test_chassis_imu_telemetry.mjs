import assert from "node:assert/strict";

import {
  CAP_IMU_FUSION,
  COMMAND,
  ProtocolError,
  decodeImuTelemetry,
} from "../chassis_protocol.mjs";

assert.equal(CAP_IMU_FUSION, 1 << 7);
assert.equal(COMMAND.GET_IMU_TELEMETRY, 0x24);

const payload = new Uint8Array(96);
const view = new DataView(payload.buffer);
view.setUint32(0, 1234, true);
view.setUint32(4, 0x0f, true);
[1.25, -2.5, 3.75].forEach((value, axis) =>
  view.setFloat32(8 + axis * 4, value, true));
[0.1, -0.2, 0.3].forEach((value, axis) =>
  view.setFloat32(20 + axis * 4, value, true));
[0.01, -0.02, 0.999].forEach((value, axis) =>
  view.setFloat32(32 + axis * 4, value, true));
view.setFloat32(44, 4.5, true);
view.setFloat32(48, -6.5, true);
view.setFloat32(52, 90.25, true);
view.setFloat32(56, 31.75, true);
[0.02, -0.03, 0.4].forEach((value, axis) =>
  view.setFloat32(60 + axis * 4, value, true));
view.setFloat32(72, 1.001, true);
view.setFloat32(76, 0.08, true);
view.setFloat32(80, 0.004, true);
view.setFloat32(84, 2.5, true);
view.setFloat32(88, 450.25, true);

const decoded = decodeImuTelemetry(payload);
assert.equal(decoded.sampleSequence, 1234);
assert.equal(decoded.fusionInitialized, true);
assert.equal(decoded.stationary, true);
assert.equal(decoded.biasTracking, true);
assert.equal(decoded.calibrated, true);
assert.ok(Math.abs(decoded.rawGyroDps[2] - 3.75) < 1e-6);
assert.ok(Math.abs(decoded.gyroDps[2] - 0.3) < 1e-6);
assert.ok(Math.abs(decoded.accelG[2] - 0.999) < 1e-6);
assert.ok(Math.abs(decoded.rollDeg - 4.5) < 1e-6);
assert.ok(Math.abs(decoded.pitchDeg + 6.5) < 1e-6);
assert.ok(Math.abs(decoded.yawDeg - 90.25) < 1e-6);
assert.ok(Math.abs(decoded.temperatureC - 31.75) < 1e-6);
assert.ok(Math.abs(decoded.yawUnwrappedDeg - 450.25) < 1e-6);
assert.throws(() => decodeImuTelemetry(new Uint8Array(95)), ProtocolError);

console.log("chassis IMU telemetry web tests passed");

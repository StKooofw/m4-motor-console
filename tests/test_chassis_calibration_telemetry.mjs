import assert from "node:assert/strict";

import {
  CAP_DIFF_CALIBRATION,
  ProtocolError,
  decodeTelemetry,
} from "../chassis_protocol.mjs";

assert.equal(CAP_DIFF_CALIBRATION, 1 << 8);

const payload = new Uint8Array(148);
const view = new DataView(payload.buffer);
view.setUint8(76, 13);
view.setUint8(77, 74);
view.setUint16(78, 0, true);
view.setFloat32(100, 160.5, true);
view.setFloat32(104, 0.72, true);
view.setFloat32(108, 0.69, true);
view.setFloat32(112, 4.2553, true);
view.setFloat32(116, -60, true);
view.setFloat32(120, 3.5, true);
view.setUint32(124, 2180, true);
view.setInt32(128, -40250, true);
view.setInt32(132, 39875, true);
view.setInt16(136, -123, true);
view.setInt16(138, 118, true);
view.setUint32(140, 0x10, true);
view.setUint8(144, 9);
view.setUint8(145, 12);
view.setUint8(146, 1);

const decoded = decodeTelemetry(payload);
assert.equal(decoded.differentialCalibrationTelemetry, true);
assert.ok(Math.abs(decoded.effectiveTrackMm - 160.5) < 1e-5);
assert.ok(Math.abs(decoded.clockwiseGainDpsPerMmS - 0.72) < 1e-5);
assert.equal(decoded.stepTargetDeg, -60);
assert.equal(decoded.worstStepSettleTimeMs, 2180);
assert.equal(decoded.leftActualMrpm, -40250);
assert.equal(decoded.rightOutputPermille, 118);
assert.equal(decoded.motorBoardFaults, 0x10);
assert.equal(decoded.calibrationStageIndex, 9);
assert.equal(decoded.calibrationStageTotal, 12);
assert.equal(decoded.motorStatusValid, true);

const legacy = decodeTelemetry(new Uint8Array(100));
assert.equal(legacy.differentialCalibrationTelemetry, false);
assert.equal(legacy.effectiveTrackMm, null);
assert.equal(legacy.leftActualMrpm, null);
assert.throws(() => decodeTelemetry(new Uint8Array(147)), ProtocolError);

console.log("chassis differential calibration telemetry tests passed");

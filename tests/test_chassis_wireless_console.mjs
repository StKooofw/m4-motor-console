import assert from "node:assert/strict";

import {
  WirelessLineDecoder,
  isAllowedWirelessCommand,
  makeWirelessTuneCommand,
  parseWirelessReply,
  wirelessCalibrationResultText,
} from "../chassis_wireless_console.mjs";

const decoder = new WirelessLineDecoder(32);
assert.deepEqual(decoder.push("OK ARM"), []);
assert.deepEqual(decoder.push("ED\r\nPROG"), ["OK ARMED"]);
assert.deepEqual(decoder.push("RESS\n"), ["PROGRESS"]);
assert.deepEqual(decoder.push(`${"X".repeat(33)}\nSTATUS\n`), ["STATUS"]);

assert.equal(isAllowedWirelessCommand("STATUS"), true);
assert.equal(isAllowedWirelessCommand("CONFIRM ANGLE 12AB34CD"), true);
assert.equal(isAllowedWirelessCommand("CONFIRM RUN 12AB34CD"), true);
assert.equal(isAllowedWirelessCommand("KEEP RUN"), true);
assert.equal(isAllowedWirelessCommand("SET LINE 0.0450 0.0000 0.0020"), true);
assert.equal(isAllowedWirelessCommand("SAVE TUNE"), true);
assert.equal(isAllowedWirelessCommand("SET WHEELS 150 150"), false);
assert.equal(isAllowedWirelessCommand("CLEAR ESTOP"), false);
assert.equal(isAllowedWirelessCommand("SAVE PARAMS"), false);
assert.equal(isAllowedWirelessCommand("UPDATE"), false);
assert.equal(makeWirelessTuneCommand("drive", [180, 600, 420]),
  "SET DRIVE 180.0000 600.0000 420.0000");
assert.equal(makeWirelessTuneCommand("line", [0.045, 0, 0.002]),
  "SET LINE 0.0450 0.0000 0.0020");
assert.throws(() => makeWirelessTuneCommand("angle", [101, 0, 0]));
assert.throws(() => makeWirelessTuneCommand("line", [Number.NaN, 0, 0]));

assert.deepEqual(parseWirelessReply(
  "OK ARMED ANGLE TOKEN=12AB34CD EXPIRES=5000"), {
  kind: "armed", armKind: "angle", token: "12AB34CD", expiresMs: 5000,
});
assert.deepEqual(parseWirelessReply(
  "OK ARMED RUN TOKEN=89ABCDEF EXPIRES=5000"), {
  kind: "armed", armKind: "run", token: "89ABCDEF", expiresMs: 5000,
});
assert.deepEqual(parseWirelessReply(
  "OK STATUS STATE=1 READY=07 IMU=1 CAL=6 PROGRESS=100 RESULT=1 STAGE=12/12 VER=00010018 WCAP=03 RUN=1"), {
  kind: "status", state: 1, readyMask: 7, imuCalibrated: true,
  calibrationState: 6, progress: 100, result: 1, stageIndex: 12, stageTotal: 12,
  firmwareVersion: 0x00010018, wirelessCapabilities: 3, runActive: true,
});
assert.deepEqual(parseWirelessReply(
  "OK STATUS STATE=1 READY=07 IMU=1 CAL=0 PROGRESS=0 RESULT=0 STAGE=0/12"), {
  kind: "status", state: 1, readyMask: 7, imuCalibrated: true,
  calibrationState: 0, progress: 0, result: 0, stageIndex: 0, stageTotal: 12,
  firmwareVersion: null, wirelessCapabilities: 0, runActive: false,
});
assert.deepEqual(parseWirelessReply(
  "TUNE DRIVE BASE=180.0000 MAX=600.0000 STEER=420.0000"), {
  kind: "tune", group: "drive", values: [180, 600, 420],
});
assert.deepEqual(parseWirelessReply(
  "TUNE LINE KP=0.0450 KI=0.0000 KD=0.0020"), {
  kind: "tune", group: "line", values: [0.045, 0, 0.002],
});
assert.deepEqual(parseWirelessReply("OK RUN START LEASE=600"),
  { kind: "run-started", leaseMs: 600 });
assert.deepEqual(parseWirelessReply("OK RUN STOP"),
  { kind: "run-stopped", reason: "command" });
assert.deepEqual(parseWirelessReply("STOP RUN REASON=TIMEOUT"),
  { kind: "run-stopped", reason: "timeout" });
assert.deepEqual(parseWirelessReply("STOP RUN REASON=FAULT"),
  { kind: "run-stopped", reason: "fault" });
assert.deepEqual(parseWirelessReply("OK TUNE SAVED"), { kind: "tune-saved" });
assert.deepEqual(parseWirelessReply(
  "PROGRESS KIND=2 STATE=13 VALUE=50 STAGE=7/12 TARGET=30.0000"), {
  kind: "progress", calibrationKind: 2, state: 13, progress: 50,
  stageIndex: 7, stageTotal: 12, targetDeg: 30,
});
assert.deepEqual(parseWirelessReply(
  "MODEL TRACK=161.0384 CW=0.7125 CCW=0.7118 ASYM=0.0945 PEAK=112.5753 RESP=569"), {
  kind: "model", trackMm: 161.0384, clockwiseGain: 0.7125,
  counterclockwiseGain: 0.7118, asymmetryPercent: 0.0945,
  peakGyroDps: 112.5753, responseTimeMs: 569,
});
assert.deepEqual(parseWirelessReply(
  "CANDIDATE KP=1.8723 KI=0.0000 KD=0.3159"), {
  kind: "candidate", kp: 1.8723, ki: 0, kd: 0.3159,
});
assert.deepEqual(parseWirelessReply(
  "SAMPLE STAGE=7 TARGET=30.0000 YAW=17.2070 GYRO=12.3400 TL=-7979 TR=7979 L=-7417 R=7417"), {
  kind: "sample", stageIndex: 7, targetDeg: 30, yawDeg: 17.207,
  gyroDps: 12.34, leftTargetMrpm: -7979, rightTargetMrpm: 7979,
  leftActualMrpm: -7417, rightActualMrpm: 7417,
});
assert.deepEqual(parseWirelessReply(
  "DIAG STEP TARGET=30.0000 YAW=141.8422 GYRO=-61.2393 RISE=2683 OVR=148.9623 SAT=103/164 WERR=0.6282"), {
  kind: "step-diagnostic", targetDeg: 30, yawDeg: 141.8422,
  gyroDps: -61.2393, riseTimeMs: 2683, overshootDeg: 148.9623,
  saturationCount: 103, controlCount: 164, wheelErrorRatio: 0.6282,
});
assert.deepEqual(parseWirelessReply("DONE ANGLE RESULT=1 KP=2.0000"), {
  kind: "done", calibrationKind: "angle", result: 1, resultText: "通过",
  ok: true, kp: 2, ki: null, kd: null, trackMm: null,
  asymmetryPercent: null, settleTimeMs: null, overshootDeg: null,
});
assert.deepEqual(parseWirelessReply("DONE ANGLE RESULT=12"), {
  kind: "done", calibrationKind: "angle", result: 12,
  resultText: "角度无法稳定", ok: false, kp: null, ki: null, kd: null,
  trackMm: null, asymmetryPercent: null, settleTimeMs: null, overshootDeg: null,
});
assert.deepEqual(parseWirelessReply("ERR TOKEN"), { kind: "error", code: "TOKEN" });
assert.equal(wirelessCalibrationResultText(13), "轮速跟踪不合格");

for (const malformed of [
  "OK STATUS STATE=1 READY=ZZ IMU=1 CAL=0 PROGRESS=0 RESULT=0 STAGE=0/12",
  "PROGRESS KIND=2 STATE=13 VALUE=50 STAGE=7/12",
  "MODEL TRACK=161.0384 CW=0.7125",
  "CANDIDATE KP=1.8723 KI=0.0000",
  "SAMPLE STAGE=7 TARGET=30 YAW=17 GYRO=12 TL=-7979 TR=7979 L=-7417",
  "DIAG STEP TARGET=30 YAW=17 GYRO=12 RISE=500 OVR=0 SAT=bad WERR=0.1",
  "DONE ANGLE KP=1.8723",
  "TUNE DRIVE BASE=180 MAX=600",
]) {
  assert.deepEqual(parseWirelessReply(malformed), { kind: "other" });
}

console.log("chassis wireless console tests passed");

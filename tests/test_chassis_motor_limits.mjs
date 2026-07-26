import assert from "node:assert/strict";

import { decodeMotorLimits } from "../chassis_protocol.mjs";
import {
  applyWheelInputBounds,
  resolveWheelLimits,
  wheelTargetsWithinLimits,
} from "../chassis_wheel_limits.mjs";

const payload = new Uint8Array(20);
const view = new DataView(payload.buffer);
view.setUint8(0, 1);
view.setUint8(1, 4);
[145000, 220000, 175000, 410000].forEach((limit, index) =>
  view.setInt32(4 + index * 4, limit, true));

const decoded = decodeMotorLimits(payload);
assert.equal(decoded.synced, true);
assert.deepEqual(decoded.limitsMrpm, [145000, 220000, 175000, 410000]);

const ac = resolveWheelLimits(decoded,
  { leftMotorChannel: 0, rightMotorChannel: 2 });
assert.equal(ac.leftRpm, 145);
assert.equal(ac.rightRpm, 175);
assert.equal(wheelTargetsWithinLimits(145000, -175000, ac), true);
assert.equal(wheelTargetsWithinLimits(145001, 0, ac), false);

const bd = resolveWheelLimits(decoded,
  { leftMotorChannel: 1, rightMotorChannel: 3 });
assert.equal(bd.leftRpm, 220);
assert.equal(bd.rightRpm, 410);

const leftInput = { min: "", max: "", value: "300" };
const rightInput = { min: "", max: "", value: "-500" };
applyWheelInputBounds(leftInput, rightInput, decoded,
  { leftMotorChannel: 1, rightMotorChannel: 3 });
assert.deepEqual(leftInput, { min: "-220", max: "220", value: "220" });
assert.deepEqual(rightInput, { min: "-410", max: "410", value: "-410" });
applyWheelInputBounds(leftInput, rightInput, decoded,
  { leftMotorChannel: 0, rightMotorChannel: 2 });
assert.equal(leftInput.max, "145");
assert.equal(rightInput.max, "175");

payload[0] = 0;
const unsynced = resolveWheelLimits(decodeMotorLimits(payload),
  { leftMotorChannel: 0, rightMotorChannel: 2 });
assert.equal(unsynced.synced, false);
assert.equal(unsynced.leftRpm, 120);

console.log("chassis motor limit web tests passed");

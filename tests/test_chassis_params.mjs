import assert from "node:assert/strict";

import {
  PARAM_VERSION,
  ProtocolError,
  crc32Msp,
  decodeParams,
  encodeParams,
} from "../chassis_protocol.mjs";

const baseParams = Object.freeze({
  baseSpeedMmS: 180,
  maxSpeedMmS: 600,
  maxSteerMmS: 420,
  lineKp: 0.045,
  lineKi: 0,
  lineKd: 0.002,
  angleKp: 6,
  angleKi: 0,
  angleKd: 0.15,
  commandTimeoutMs: 600,
  leftMotorChannel: 0,
  rightMotorChannel: 2,
  grayActiveHigh: 0,
});

assert.equal(PARAM_VERSION, 3);
const v3Low = encodeParams(baseParams);
assert.equal(v3Low.length, 64);
assert.equal(new DataView(v3Low.buffer).getUint16(4, true), 3);
assert.equal(v3Low[54], 0);
assert.equal(decodeParams(v3Low).grayActiveHigh, false);

const v3High = encodeParams({ ...baseParams, grayActiveHigh: 1 });
assert.equal(v3High[54], 1);
assert.equal(decodeParams(v3High).grayActiveHigh, true);

const v2 = encodeParams({ ...baseParams, grayActiveHigh: 1 }, 2);
assert.equal(decodeParams(v2).parameterVersion, 2);
assert.equal(decodeParams(v2).grayActiveHigh, true);

const v1 = encodeParams({ ...baseParams, grayActiveHigh: 1 }, 1);
const decodedV1 = decodeParams(v1);
assert.equal(decodedV1.leftMotorChannel, 0);
assert.equal(decodedV1.rightMotorChannel, 2);
assert.equal(decodedV1.grayActiveHigh, true);

assert.throws(() => encodeParams({ ...baseParams, grayActiveHigh: 0 }, 2),
  /CHAS v1\.0\.9/);
assert.throws(() => encodeParams({ ...baseParams, grayActiveHigh: 2 }),
  ProtocolError);

const invalidPolarity = v3Low.slice();
invalidPolarity[54] = 2;
new DataView(invalidPolarity.buffer).setUint32(60,
  crc32Msp(invalidPolarity.subarray(0, 60)), true);
assert.throws(() => decodeParams(invalidPolarity), /灰度极性/);

console.log("chassis parameter web tests passed");

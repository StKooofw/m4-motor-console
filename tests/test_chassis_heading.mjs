import assert from "node:assert/strict";
import { normalizeHeadingDegrees } from "../chassis_protocol.mjs";

assert.equal(normalizeHeadingDegrees(0), 0);
assert.equal(normalizeHeadingDegrees(180), 180);
assert.equal(normalizeHeadingDegrees(-180), 180);
assert.equal(normalizeHeadingDegrees(181), 181);
assert.equal(normalizeHeadingDegrees(-179), 181);
assert.equal(normalizeHeadingDegrees(360), 0);
assert.equal(normalizeHeadingDegrees(721.25), 1.25);
assert.ok(Number.isNaN(normalizeHeadingDegrees(Number.NaN)));

console.log("chassis heading display tests passed");

import assert from "node:assert/strict";

import {
  WirelessLineDecoder,
  isAllowedWirelessCommand,
  parseWirelessReply,
} from "../chassis_wireless_console.mjs";

const decoder = new WirelessLineDecoder(32);
assert.deepEqual(decoder.push("OK ARM"), []);
assert.deepEqual(decoder.push("ED\r\nPROG"), ["OK ARMED"]);
assert.deepEqual(decoder.push("RESS\n"), ["PROGRESS"]);
assert.deepEqual(decoder.push(`${"X".repeat(33)}\nSTATUS\n`), ["STATUS"]);

assert.equal(isAllowedWirelessCommand("STATUS"), true);
assert.equal(isAllowedWirelessCommand("CONFIRM ANGLE 12AB34CD"), true);
assert.equal(isAllowedWirelessCommand("SET WHEELS 150 150"), false);
assert.equal(isAllowedWirelessCommand("CLEAR ESTOP"), false);
assert.equal(isAllowedWirelessCommand("SAVE PARAMS"), false);
assert.equal(isAllowedWirelessCommand("UPDATE"), false);

assert.deepEqual(parseWirelessReply(
  "OK ARMED ANGLE TOKEN=12AB34CD EXPIRES=5000"), {
  kind: "armed", token: "12AB34CD", expiresMs: 5000,
});
assert.deepEqual(parseWirelessReply("DONE ANGLE RESULT=1 KP=2.0000"), {
  kind: "done", ok: true,
});
assert.deepEqual(parseWirelessReply("ERR TOKEN"), { kind: "error" });

console.log("chassis wireless console tests passed");

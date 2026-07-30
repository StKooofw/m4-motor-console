import assert from "node:assert/strict";
import test from "node:test";

import {
  QDriveSerialSession,
  formatConfigCommand,
  formatControlCommand,
  isCompleteQDriveStatus,
  parseQDriveConfig,
  parseQDriveIdentity,
  parseQDriveStatus,
  qdriveSamplesCsv,
  stripAnsi,
} from "../qdrive_shell.mjs";
import { parseDfuMemoryMap, parseDfuSeFile } from "../qdrive_dfu.mjs";

const STATUS = `Motor Status:\r\n
  CAN ID       : 000\r\n
  Status       : enabled\r\n
  CtrlMode     : AngleCtrl\r\n
  Current      : 0.12 A\r\n
  Speed        : -3.50 rpm\r\n
  Angle        : 1.57 rad\r\n
  Voltage      : 23.80 V\r\n
QDrive:/$ `;

test("QDrive status parser extracts all telemetry fields", () => {
  assert.deepEqual(parseQDriveStatus(STATUS), {
    can_id: 0,
    enabled: true,
    state: "enabled",
    mode: "AngleCtrl",
    current_a: 0.12,
    speed_rpm: -3.5,
    angle_rad: 1.57,
    voltage_v: 23.8,
  });
  assert.equal(isCompleteQDriveStatus(STATUS), true);
  assert.equal(parseQDriveStatus("Current: 1 A"), null);
});

test("QDrive config parser supports 6.2.2 and current timeout output", () => {
  const values = parseQDriveConfig(`Current Configuration:\n
pid.speed.kp = 0.003\n
limit.speed = no limit\n
limit.current = 1.5 A\n
can.id = 003\n
timeout = 0.25 s\n
uart.baud_rate = 115200\n`);
  assert.deepEqual(values, {
    "pid.speed.kp": 0.003,
    "limit.speed": null,
    "limit.current": 1.5,
    "can.id": 3,
    timeout: 0.25,
    "uart.baud_rate": 115200,
  });
});

test("QDrive identity parser rejects unrelated serial text", () => {
  assert.deepEqual(parseQDriveIdentity(
    "Hardware version 4310_6.2.1\r\nSoftware version 6.2.2\r\n",
    "Hardware Info:\r\n  Pole pairs : 14\r\n  Max current : 1.65 A\r\n",
  ), {
    hardware: "4310_6.2.1",
    software: "6.2.2",
    info: { "Hardware Info": "", "Pole pairs": "14", "Max current": "1.65 A" },
  });
  assert.equal(parseQDriveIdentity("BBK230"), null);
});

test("QDrive command formatters enforce documented hardware ranges", () => {
  assert.equal(formatConfigCommand("can.id", 7), "config can.id 7");
  assert.equal(formatConfigCommand("timeout", 0), "config timeout 0");
  assert.equal(formatControlCommand("step_angle", -Math.PI), `ctrl step_angle ${-Math.PI}`);
  assert.throws(() => formatConfigCommand("can.id", 8), /超出范围/);
  assert.throws(() => formatControlCommand("current", 2), /超出范围/);
});

test("ANSI stripping and waveform CSV stay deterministic", () => {
  assert.equal(stripAnsi("\u001b[31mQDrive\u001b[0m\0"), "QDrive");
  assert.equal(qdriveSamplesCsv([{
    time_s: 0.25,
    current_a: 0.1,
    speed_rpm: 2,
    angle_rad: 3,
    voltage_v: 24,
  }]), "\uFEFFtime_s,current_A,speed_rpm,angle_rad,voltage_V\r\n0.250000,0.1,2,3,24\r\n");
});

test("QDrive serial session captures split LetterShell responses", async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let readableController;
  const writes = [];
  const port = {
    readable: null,
    writable: null,
    async open() {
      this.readable = new ReadableStream({ start(controller) { readableController = controller; } });
      this.writable = new WritableStream({
        write(bytes) {
          const line = decoder.decode(bytes);
          writes.push(line);
          if (line.includes("status")) {
            readableController.enqueue(encoder.encode(STATUS.slice(0, 70)));
            queueMicrotask(() => readableController.enqueue(encoder.encode(STATUS.slice(70))));
          }
        },
      });
    },
    async close() {},
  };
  const chunks = [];
  const session = new QDriveSerialSession(port, { onChunk: (chunk) => chunks.push(chunk) });
  await session.open(115200);
  const response = await session.captureUntilIdle(
    () => session.sendLine("status"),
    5,
    200,
    { isComplete: isCompleteQDriveStatus },
  );
  assert.equal(parseQDriveStatus(response)?.enabled, true);
  assert.deepEqual(writes, ["status\r\n"]);
  assert.equal(chunks.join(""), STATUS);
  await session.close();
});

function makeDfuFile() {
  const payload = new Uint8Array([1, 2, 3, 4]);
  const targetSize = 8 + payload.length;
  const length = 11 + 274 + targetSize + 16;
  const buffer = new ArrayBuffer(length);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set(new TextEncoder().encode("DfuSe"), 0);
  view.setUint8(5, 1);
  view.setUint32(6, length, true);
  view.setUint8(10, 1);
  let offset = 11;
  bytes.set(new TextEncoder().encode("Target"), offset);
  view.setUint8(offset + 6, 0);
  view.setUint32(offset + 7, 1, true);
  bytes.set(new TextEncoder().encode("Internal Flash"), offset + 11);
  view.setUint32(offset + 266, targetSize, true);
  view.setUint32(offset + 270, 1, true);
  offset += 274;
  view.setUint32(offset, 0x08000000, true);
  view.setUint32(offset + 4, payload.length, true);
  bytes.set(payload, offset + 8);
  offset += targetSize;
  view.setUint16(offset, 0x2200, true);
  view.setUint16(offset + 2, 0xdf11, true);
  view.setUint16(offset + 4, 0x0483, true);
  view.setUint16(offset + 6, 0x011a, true);
  bytes.set(new TextEncoder().encode("UFD"), offset + 8);
  view.setUint8(offset + 11, 16);
  return buffer;
}

test("DfuSe parser validates targets, suffix identity and memory maps", () => {
  const parsed = parseDfuSeFile(makeDfuFile());
  assert.equal(parsed.suffix.vendor, 0x0483);
  assert.equal(parsed.suffix.product, 0xdf11);
  assert.equal(parsed.targets[0].alternate, 0);
  assert.equal(parsed.targets[0].elements[0].address, 0x08000000);
  assert.deepEqual([...new Uint8Array(parsed.targets[0].elements[0].data)], [1, 2, 3, 4]);
  const sectors = parseDfuMemoryMap("@Internal Flash /0x08000000/04*016Kg,01*064Kg");
  assert.equal(sectors.length, 5);
  assert.equal(sectors[0].start, 0x08000000);
  assert.equal(sectors[0].erasable, true);
  assert.equal(sectors[0].writable, true);
});

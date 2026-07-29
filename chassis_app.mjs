import {
  ANGLE_AUTOTUNE_SAFETY_TOKEN,
  CAP_DIFF_CALIBRATION,
  CAP_IMU_FUSION,
  CAP_MOTOR_LIMITS,
  COMMAND,
  FrameDecoder,
  PARAM_VERSION,
  ProtocolError,
  decodeCommandResponse,
  decodeIdentity,
  decodeImuTelemetry,
  decodeMotorLimits,
  decodeParams,
  decodeTelemetry,
  encodeFrame,
  encodeParams,
  makeIntPayload,
} from "./chassis_protocol.mjs?v=20260729-3";
import {
  LEGACY_SAFE_LIMIT_MRPM,
  applyWheelInputBounds,
  resolveWheelLimits,
  wheelTargetsWithinLimits,
} from "./chassis_wheel_limits.mjs?v=20260726-6";
import {
  registerSerialReleaseHandler,
  requestSerialHandoff,
  serialConnectionMessage,
} from "./serial_handoff.mjs";
import {
  BslError,
  TiUartBsl,
  validateApplicationImage,
} from "./chassis_firmware_update.mjs";
import * as THREE from "./vendor/three.module.min.js";
import {
  WirelessCalibrationSession,
  parseWirelessReply,
} from "./chassis_wireless_console.mjs?v=20260729-1";

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "connection-state", "connection-label", "connect-button", "clear-estop-button", "estop-button",
  "support-banner", "device-name", "firmware-version", "uptime-value", "state-value",
  "line-error", "yaw-value", "angle-error", "gyro-value", "steer-value", "line-state",
  "gray-bits", "sensor-track", "line-cursor", "line-chart", "yaw-chart", "gyro-chart",
  "gyro-chart-range", "imu-error-chart-range", "imu-yaw-chart", "imu-error-chart", "imu-state",
  "yaw-needle", "yaw-dial-value", "yaw-reference", "imu-bias", "peak-gyro", "response-time",
  "zero-yaw-button", "gyro-cal-button", "control-mode", "left-wheel-target", "right-wheel-target",
  "left-wheel-label", "right-wheel-label", "left-wheel-status-label", "right-wheel-status-label",
  "send-wheels-button", "stop-wheels-button", "start-tracking-button", "stop-tracking-button",
  "left-wheel-live", "right-wheel-live", "sensor-failures", "imu-failures", "motor-failures",
  "read-params-button", "apply-params-button", "save-params-button", "parameter-form",
  "gyro-cal-state", "cal-bias-value", "gyro-still-confirm", "start-gyro-cal-button",
  "angle-cal-state", "candidate-kp", "candidate-ki", "candidate-kd", "calibration-progress",
  "calibration-stage", "effective-track", "direction-gain", "direction-asymmetry",
  "step-target", "step-overshoot", "step-settle-time", "motor-feedback-state",
  "imu-mounted-confirm", "ground-confirm", "direction-confirm", "direction-confirm-label", "start-angle-cal-button",
  "abort-cal-button", "apply-candidate-button", "update-file-input", "select-update-file-button",
  "update-file-name", "update-file-size", "update-file-state", "update-image-version",
  "update-board-id", "update-image-length", "update-image-crc", "update-state", "stage-file",
  "stage-bsl", "stage-program", "stage-restart", "update-progress", "update-confirm",
  "update-start-button", "update-recovery-button", "imu-console-state", "imu-console-gyro",
  "imu-console-raw-gyro", "imu-console-roll", "imu-console-pitch", "imu-console-yaw",
  "imu-console-temperature", "imu-console-reference", "imu-console-error", "imu-console-bias",
  "imu-console-failures", "imu-console-stationary", "imu-console-accel-norm", "imu-console-noise",
  "imu-orientation-canvas", "imu-model-roll", "imu-model-pitch", "imu-model-yaw", "imu-console-cal-state",
  "imu-console-progress", "imu-console-progress-value", "imu-console-peak", "imu-console-response",
  "imu-console-zero-button", "imu-console-still-confirm",
  "imu-console-cal-button", "wireless-state", "wireless-connect-button", "wireless-token",
  "wireless-status-button", "wireless-gyro-button", "wireless-arm-button",
  "wireless-confirm-button", "wireless-abort-button", "wireless-estop-button",
  "wireless-log", "toast",
].map((id) => [id.replaceAll("-", "_"), $(id)]));

const stateNames = ["SAFE", "READY", "RUNNING", "FAULT"];
const modeNames = ["已停止", "循迹", "手动双轮", "角度标定"];
const calibrationNames = ["待机", "陀螺仪静置", "陀螺仪采样", "底盘静置", "旧版正向阶跃", "旧版回正", "完成", "失败", "已中止", "差速轮速稳定", "差速模型采样", "双轮停稳", "角度阶跃准备", "角度阶跃执行"];
const calibrationResults = ["--", "通过", "检测到移动", "IMU 读取失败", "无有效响应", "阶段超时", "已中止", "电机反馈中断", "电机或编码器故障", "双向差异过大", "差速模型无效", "角度超调过大", "角度无法稳定", "轮速跟踪不合格"];
const motorChannelNames = ["A", "B", "C", "D"];

let activeSession = null;
let latestTelemetry = null;
let latestImuTelemetry = null;
let latestParams = null;
let latestMotorLimits = null;
let pollingToken = 0;
let updateBusy = false;
let connectionBusy = false;
let wirelessSession = null;
let wirelessConnectionBusy = false;
let wirelessConfirmToken = null;
const wirelessLogLines = [];
let selectedUpdate = null;
let toastTimer = null;
const lineHistory = [];
const yawHistory = [];
const gyroHistory = [];
const angleErrorHistory = [];
let orientationRenderer = null;
let orientationScene = null;
let orientationCamera = null;
let orientationModel = null;
let orientationRoll = 0;
let orientationPitch = 0;
let orientationYaw = 0;
let targetOrientationRoll = 0;
let targetOrientationPitch = 0;
let targetOrientationYaw = 0;

function sleep(ms) { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
function hex(value, width = 8) { return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, "0")}`; }
function firmwareLabel(value) { return `v${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`; }
function durationLabel(ms) {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function toast(message, kind = "info") {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3600);
}
function setConnection(state, label) {
  elements.connection_state.dataset.state = state;
  elements.connection_label.textContent = label;
}

function setWirelessState(label, state = "") {
  elements.wireless_state.textContent = label;
  elements.wireless_state.dataset.state = state;
}

function appendWirelessLog(direction, line) {
  wirelessLogLines.push(`${direction} ${line}`);
  if (wirelessLogLines.length > 7) wirelessLogLines.shift();
  elements.wireless_log.textContent = wirelessLogLines.join("\n");
}

function updateWirelessAvailability() {
  const supported = "serial" in navigator && window.isSecureContext;
  const online = Boolean(wirelessSession) && !wirelessConnectionBusy;
  const gyroConfirmed = elements.gyro_still_confirm.checked
    || elements.imu_console_still_confirm.checked;
  const angleConfirmed = elements.imu_mounted_confirm.checked
    && elements.ground_confirm.checked && elements.direction_confirm.checked;
  elements.wireless_connect_button.disabled = !supported || wirelessConnectionBusy;
  elements.wireless_connect_button.textContent = wirelessSession ? "断开无线" : "连接无线";
  elements.wireless_status_button.disabled = !online;
  elements.wireless_gyro_button.disabled = !online || !gyroConfirmed;
  elements.wireless_arm_button.disabled = !online || !angleConfirmed;
  elements.wireless_confirm_button.disabled = !online || !wirelessConfirmToken;
  elements.wireless_abort_button.disabled = !online;
  elements.wireless_estop_button.disabled = !online;
  elements.wireless_token.textContent = wirelessConfirmToken || "--";
}

function handleWirelessLine(line) {
  appendWirelessLog("RX", line);
  const reply = parseWirelessReply(line);
  if (reply.kind === "armed") {
    wirelessConfirmToken = reply.token;
    setWirelessState("等待确认", "busy");
  } else if (line === "OK ANGLE START" || line === "OK GYRO START"
      || reply.kind === "progress") {
    wirelessConfirmToken = null;
    setWirelessState("标定中", "busy");
  } else if (reply.kind === "done") {
    wirelessConfirmToken = null;
    setWirelessState(reply.ok ? "标定完成" : "标定失败", reply.ok ? "ok" : "fault");
  } else if (reply.kind === "error") {
    if (line.includes("ARM") || line.includes("TOKEN") || line.includes("NOT_ARMED")) {
      wirelessConfirmToken = null;
    }
    setWirelessState("命令被拒绝", "fault");
  } else if (reply.kind === "ok") {
    setWirelessState("无线在线", "ok");
  }
  updateWirelessAvailability();
}

async function endWirelessSession() {
  const session = wirelessSession;
  wirelessSession = null;
  wirelessConfirmToken = null;
  if (session) await session.close();
  setWirelessState("未连接");
  updateWirelessAvailability();
}

async function connectWirelessPort(port) {
  if (wirelessConnectionBusy) return;
  wirelessConnectionBusy = true;
  setWirelessState("正在连接", "busy");
  updateWirelessAvailability();
  const session = new WirelessCalibrationSession(port);
  try {
    session.onLine = handleWirelessLine;
    session.onUnexpectedClose = async () => {
      if (wirelessSession === session) {
        toast("无线串口已断开", "error");
        await endWirelessSession();
      }
    };
    await session.open();
    wirelessSession = session;
    wirelessLogLines.length = 0;
    appendWirelessLog("SYS", `${session.adapterLabel} · 115200-8-N-1`);
    setWirelessState("无线在线", "ok");
  } catch (error) {
    try { await session.close(); } catch { /* open may have failed */ }
    setWirelessState("连接失败", "fault");
    throw error;
  } finally {
    wirelessConnectionBusy = false;
    updateWirelessAvailability();
  }
}

async function sendWirelessCommand(command) {
  if (!wirelessSession) throw new ProtocolError("无线串口尚未连接");
  appendWirelessLog("TX", command);
  await wirelessSession.sendCommand(command);
}

async function runWirelessCommand(command) {
  try {
    await sendWirelessCommand(command);
  } catch (error) {
    toast(error.message, "error");
  }
}

class SerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
    this.sequence = 1;
    this.closing = false;
    this.readTask = null;
    this.onUnexpectedClose = null;
  }
  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    await this.attach();
  }
  async attach() {
    this.closing = false;
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }
  async readLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        for (const frame of this.decoder.feed(value)) {
          const pending = this.pending.get(frame.sequence);
          if (!pending) continue;
          this.pending.delete(frame.sequence);
          window.clearTimeout(pending.timer);
          try { pending.resolve(decodeCommandResponse(frame, pending.command)); }
          catch (error) { pending.reject(error); }
        }
      }
    } catch (error) {
      if (!this.closing) this.onUnexpectedClose?.(error);
    } finally {
      try { this.reader?.releaseLock(); } catch { /* released during detach */ }
      this.reader = null;
    }
  }
  async request(command, payload = new Uint8Array(), timeoutMs = 900) {
    if (!this.writer || this.closing) throw new ProtocolError("串口未连接");
    const sequence = this.sequence;
    this.sequence = (this.sequence + 1) & 0xffff || 1;
    const response = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(sequence);
        reject(new ProtocolError(`命令 ${hex(command, 2)} 响应超时`));
      }, timeoutMs);
      this.pending.set(sequence, { command, resolve, reject, timer });
    });
    try { await this.writer.write(encodeFrame(sequence, command, payload)); }
    catch (error) {
      const pending = this.pending.get(sequence);
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pending.delete(sequence);
        pending.reject(error);
      }
    }
    return response;
  }
  async releaseLocks(reason = "串口已断开") {
    this.closing = true;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new ProtocolError(reason));
    }
    this.pending.clear();
    const reader = this.reader;
    if (reader) {
      try { await reader.cancel(); } catch { /* device may be removed */ }
      try { reader.releaseLock(); } catch { /* read loop owns release */ }
    }
    try { await this.readTask; } catch { /* read loop already handled */ }
    this.readTask = null;
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* already released */ }
      this.writer = null;
    }
  }
  async detach() { await this.releaseLocks("正在切换到底盘 BSL"); }
  async close() {
    await this.releaseLocks();
    try { await this.port.close(); } catch { /* device may be gone */ }
  }
}

class RawSerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.readTask = null;
    this.input = new Uint8Array();
    this.waiter = null;
    this.closing = false;
  }
  async attach() {
    this.closing = false;
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }
  async readLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value?.length) continue;
        const combined = new Uint8Array(this.input.length + value.length);
        combined.set(this.input);
        combined.set(value, this.input.length);
        this.input = combined;
        this.resolveWaiter();
      }
    } catch (error) {
      if (this.waiter) {
        window.clearTimeout(this.waiter.timer);
        this.waiter.reject(error);
        this.waiter = null;
      }
    } finally {
      try { this.reader?.releaseLock(); } catch { /* released during detach */ }
      this.reader = null;
    }
  }
  resolveWaiter() {
    if (!this.waiter || this.input.length < this.waiter.length) return;
    const waiter = this.waiter;
    this.waiter = null;
    window.clearTimeout(waiter.timer);
    const output = this.input.slice(0, waiter.length);
    this.input = this.input.slice(waiter.length);
    waiter.resolve(output);
  }
  clearInput() { this.input = new Uint8Array(); }
  async readExact(length, timeoutMs) {
    if (this.input.length >= length) {
      const output = this.input.slice(0, length);
      this.input = this.input.slice(length);
      return output;
    }
    if (this.waiter) throw new BslError("BSL 并发读取");
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiter = null;
        reject(new BslError(`BSL 响应超时 ${this.input.length}/${length}`));
      }, timeoutMs);
      this.waiter = { length, resolve, reject, timer };
    });
  }
  async write(packet) {
    if (!this.writer || this.closing) throw new BslError("BSL 串口未连接");
    await this.writer.write(packet);
    return packet.length;
  }
  async detach() {
    this.closing = true;
    if (this.waiter) {
      window.clearTimeout(this.waiter.timer);
      this.waiter.reject(new BslError("BSL 串口已关闭"));
      this.waiter = null;
    }
    try { await this.reader?.cancel(); } catch { /* device may be resetting */ }
    try { await this.readTask; } catch { /* handled */ }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* already released */ }
      this.writer = null;
    }
  }
}

class ChassisSession {
  constructor(transport, identity) {
    this.transport = transport;
    this.identity = identity;
    this.version = identity.version;
  }
  static async create(port, alreadyOpen = false) {
    const transport = new SerialTransport(port);
    try {
      if (alreadyOpen) await transport.attach(); else await transport.open();
      const identity = decodeIdentity(await transport.request(COMMAND.PING));
      return new ChassisSession(transport, identity);
    } catch (error) {
      if (alreadyOpen) await transport.detach(); else await transport.close();
      throw error;
    }
  }
  get adapterLabel() {
    const info = this.transport.port.getInfo();
    if (info.usbVendorId == null) return "已授权系统串口";
    return `VID ${hex(info.usbVendorId, 4)} · PID ${hex(info.usbProductId || 0, 4)}`;
  }
  async telemetry() { return decodeTelemetry(await this.transport.request(COMMAND.GET_TELEMETRY)); }
  async imuTelemetry() { return decodeImuTelemetry(await this.transport.request(COMMAND.GET_IMU_TELEMETRY)); }
  async setRun(run) { await this.transport.request(COMMAND.SET_RUN, Uint8Array.of(run ? 1 : 0)); }
  async setWheels(leftMrpm, rightMrpm) {
    const payload = makeIntPayload(8, (view) => {
      view.setInt32(0, leftMrpm, true);
      view.setInt32(4, rightMrpm, true);
    });
    await this.transport.request(COMMAND.SET_WHEELS, payload);
  }
  async estop() { await this.transport.request(COMMAND.ESTOP); }
  async clearEstop() { await this.transport.request(COMMAND.CLEAR_ESTOP); }
  async zeroYaw() { await this.transport.request(COMMAND.ZERO_YAW); }
  async calibrateGyro() { await this.transport.request(COMMAND.CALIBRATE_GYRO); }
  async startAngleAutotune() {
    const payload = makeIntPayload(4, (view) => view.setUint32(0, ANGLE_AUTOTUNE_SAFETY_TOKEN, true));
    await this.transport.request(COMMAND.START_ANGLE_AUTOTUNE, payload);
  }
  async abortCalibration() { await this.transport.request(COMMAND.ABORT_CALIBRATION); }
  async getParams() {
    const params = decodeParams(await this.transport.request(COMMAND.GET_PARAMS));
    this.parameterVersion = params.parameterVersion;
    return params;
  }
  async getMotorLimits() {
    return decodeMotorLimits(await this.transport.request(
      COMMAND.GET_MOTOR_LIMITS));
  }
  async setParams(params) {
    await this.transport.request(COMMAND.SET_PARAMS,
      encodeParams(params, this.parameterVersion || PARAM_VERSION));
  }
  async saveParams() { await this.transport.request(COMMAND.SAVE_PARAMS, new Uint8Array(), 1800); }
  async enterUpdate() { await this.transport.request(COMMAND.ENTER_UPDATE, new Uint8Array(), 1800); }
  async detach() { await this.transport.detach(); }
  async close() { await this.transport.close(); }
}

function createSensors() {
  for (let index = 0; index < 16; index += 1) {
    const cell = document.createElement("span");
    cell.className = "sensor-cell";
    cell.dataset.sensor = String(index);
    cell.textContent = String(index + 1).padStart(2, "0");
    elements.sensor_track.append(cell);
  }
}

function initializeOrientationView() {
  const canvas = elements.imu_orientation_canvas;
  orientationRenderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true,
  });
  orientationRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  orientationRenderer.setClearColor(0x171b1c, 1);
  orientationRenderer.outputColorSpace = THREE.SRGBColorSpace;

  orientationScene = new THREE.Scene();
  orientationCamera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
  orientationCamera.position.set(6.8, 4.6, 7.6);
  orientationCamera.lookAt(0, 0, 0);

  orientationScene.add(new THREE.HemisphereLight(0xffffff, 0x273033, 2.4));
  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  keyLight.position.set(3, 7, 5);
  orientationScene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8fc7ff, 1.2);
  fillLight.position.set(-5, 2, -4);
  orientationScene.add(fillLight);

  const grid = new THREE.GridHelper(13, 13, 0x596366, 0x2d3436);
  grid.position.y = -0.78;
  orientationScene.add(grid);
  const headingRing = new THREE.Mesh(
    new THREE.RingGeometry(3.75, 3.79, 96),
    new THREE.MeshBasicMaterial({ color: 0x6e787a, side: THREE.DoubleSide }),
  );
  headingRing.rotation.x = -Math.PI / 2;
  headingRing.position.y = -0.76;
  orientationScene.add(headingRing);

  orientationModel = new THREE.Group();
  orientationModel.rotation.order = "YXZ";
  orientationScene.add(orientationModel);
  const boardMaterial = new THREE.MeshStandardMaterial({ color: 0x246746, roughness: 0.72, metalness: 0.08 });
  const board = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.2, 2.65), boardMaterial);
  board.castShadow = true;
  orientationModel.add(board);

  const chipMaterial = new THREE.MeshStandardMaterial({ color: 0x141718, roughness: 0.48, metalness: 0.22 });
  const chip = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.38, 1.48), chipMaterial);
  chip.position.y = 0.29;
  orientationModel.add(chip);
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.1, 0.025, 24),
    new THREE.MeshStandardMaterial({ color: 0xc5ccce, roughness: 0.55 }),
  );
  marker.position.set(-0.53, 0.5, -0.53);
  orientationModel.add(marker);

  const pinMaterial = new THREE.MeshStandardMaterial({ color: 0xb7c0c2, roughness: 0.35, metalness: 0.72 });
  for (let index = -2; index <= 2; index += 1) {
    for (const side of [-1, 1]) {
      const sidePin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.08, 0.23), pinMaterial);
      sidePin.position.set(index * 0.27, 0.18, side * 0.83);
      orientationModel.add(sidePin);
      const endPin = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.08, 0.12), pinMaterial);
      endPin.position.set(side * 0.83, 0.18, index * 0.27);
      orientationModel.add(endPin);
    }
  }

  const connectorMaterial = new THREE.MeshStandardMaterial({ color: 0xe2e5e6, roughness: 0.3, metalness: 0.55 });
  for (const side of [-1, 1]) {
    const connector = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 1.35), connectorMaterial);
    connector.position.set(side * 1.68, 0.23, 0);
    orientationModel.add(connector);
  }

  const axisOrigin = new THREE.Vector3(0, 0.64, 0);
  orientationModel.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), axisOrigin, 2.8, 0xe1484e, 0.28, 0.15));
  orientationModel.add(new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), axisOrigin, 2.15, 0x47b36b, 0.28, 0.15));
  orientationModel.add(new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), axisOrigin, 2.05, 0x4387dd, 0.28, 0.15));

  window.requestAnimationFrame(animateOrientationView);
}

function resizeOrientationView() {
  if (!orientationRenderer || !orientationCamera) return;
  const bounds = elements.imu_orientation_canvas.getBoundingClientRect();
  if (bounds.width < 2 || bounds.height < 2) return;
  orientationRenderer.setSize(Math.round(bounds.width), Math.round(bounds.height), false);
  orientationCamera.aspect = bounds.width / bounds.height;
  orientationCamera.updateProjectionMatrix();
}

function animateOrientationView() {
  window.requestAnimationFrame(animateOrientationView);
  if (!orientationRenderer || !orientationModel || !document.querySelector('[data-panel="imu"].is-active')) return;
  const delta = ((targetOrientationYaw - orientationYaw + 540) % 360) - 180;
  orientationYaw += delta * 0.14;
  orientationRoll += (targetOrientationRoll - orientationRoll) * 0.14;
  orientationPitch += (targetOrientationPitch - orientationPitch) * 0.14;
  orientationModel.rotation.y = THREE.MathUtils.degToRad(-orientationYaw);
  orientationModel.rotation.x = THREE.MathUtils.degToRad(orientationRoll);
  orientationModel.rotation.z = THREE.MathUtils.degToRad(orientationPitch);
  orientationRenderer.render(orientationScene, orientationCamera);
}

function setBadge(element, label, state = "") {
  element.textContent = label;
  if (state) element.dataset.state = state; else delete element.dataset.state;
}

function symmetricChartRange(rows, minimumAbs, maximumAbs) {
  let observedAbs = minimumAbs;
  for (const row of rows) {
    for (const value of row) {
      if (Number.isFinite(value)) observedAbs = Math.max(observedAbs, Math.abs(value));
    }
  }
  const step = observedAbs <= 20 ? 5 : observedAbs <= 100 ? 10 : 50;
  return Math.min(maximumAbs, Math.ceil(observedAbs / step) * step);
}

function renderTelemetry(value, legacyImu = false) {
  latestTelemetry = value;
  elements.uptime_value.textContent = durationLabel(value.uptimeMs);
  elements.state_value.textContent = stateNames[value.state] || `STATE ${value.state}`;
  elements.line_error.textContent = `${value.linePositionMm.toFixed(2)} mm`;
  elements.yaw_value.textContent = `${value.yawDeg.toFixed(2)}°`;
  elements.angle_error.textContent = `${value.angleErrorDeg.toFixed(2)}°`;
  elements.gyro_value.textContent = `${value.gyroZDps.toFixed(2)} °/s`;
  elements.steer_value.textContent = `${value.steerMmS.toFixed(1)} mm/s`;
  elements.gray_bits.textContent = hex(value.rawGrayBits, 4);
  elements.line_state.textContent = value.lineLost ? "丢线" : value.lineVisible ? `${value.activeCount} 路有效` : "暂未识别";
  elements.line_cursor.style.left = `${Math.max(0, Math.min(100, (value.linePositionMm + 60) / 120 * 100))}%`;
  document.querySelectorAll(".sensor-cell").forEach((cell) => {
    cell.classList.toggle("is-active", Boolean(value.activeGrayBits & (1 << Number(cell.dataset.sensor))));
  });
  setBadge(elements.imu_state, value.imuCalibrated ? "已标定" : "未标定", value.imuCalibrated ? "ok" : "fault");
  elements.yaw_needle.style.transform = `rotate(${value.yawDeg}deg)`;
  elements.yaw_dial_value.textContent = `${value.yawDeg.toFixed(1)}°`;
  elements.yaw_reference.textContent = `${value.yawReferenceDeg.toFixed(2)}°`;
  elements.imu_bias.textContent = `${value.imuBiasDps.toFixed(4)} °/s`;
  elements.cal_bias_value.textContent = `${value.imuBiasDps.toFixed(4)} °/s`;
  elements.peak_gyro.textContent = `${value.peakGyroDps.toFixed(2)} °/s`;
  elements.response_time.textContent = `${value.responseTimeMs} ms`;
  elements.imu_console_reference.textContent = `${value.yawReferenceDeg.toFixed(2)}°`;
  elements.imu_console_error.textContent = `${value.angleErrorDeg.toFixed(2)}°`;
  elements.imu_console_bias.textContent = `${value.imuBiasDps.toFixed(4)} °/s`;
  elements.imu_console_failures.textContent = String(value.imuFailures);
  elements.imu_console_peak.textContent = `${value.peakGyroDps.toFixed(2)} °/s`;
  elements.imu_console_response.textContent = `${value.responseTimeMs} ms`;
  if (legacyImu) {
    elements.imu_console_gyro.textContent = `${value.gyroZDps.toFixed(2)} °/s`;
    elements.imu_console_raw_gyro.textContent = `${value.gyroZDps.toFixed(2)} °/s`;
    elements.imu_console_roll.textContent = "--°";
    elements.imu_console_pitch.textContent = "--°";
    elements.imu_console_yaw.textContent = `${value.yawDeg.toFixed(2)}°`;
    elements.imu_console_temperature.textContent = "-- °C";
    elements.imu_console_stationary.textContent = "旧固件未提供";
    elements.imu_console_accel_norm.textContent = "-- g";
    elements.imu_console_noise.textContent = "-- °/s";
    elements.imu_model_roll.textContent = "0.0°";
    elements.imu_model_pitch.textContent = "0.0°";
    elements.imu_model_yaw.textContent = `${value.yawDeg.toFixed(1)}°`;
    targetOrientationRoll = 0;
    targetOrientationPitch = 0;
    targetOrientationYaw = value.yawDeg;
  }
  setBadge(elements.control_mode, modeNames[value.mode] || `MODE ${value.mode}`, value.state === 3 ? "fault" : value.mode ? "ok" : "");
  const leftActual = value.leftActualMrpm == null ? "--" : (value.leftActualMrpm / 1000).toFixed(1);
  const rightActual = value.rightActualMrpm == null ? "--" : (value.rightActualMrpm / 1000).toFixed(1);
  elements.left_wheel_live.textContent = `${(value.leftTargetMrpm / 1000).toFixed(1)} / ${leftActual} rpm`;
  elements.right_wheel_live.textContent = `${(value.rightTargetMrpm / 1000).toFixed(1)} / ${rightActual} rpm`;
  elements.sensor_failures.textContent = String(value.sensorFailures);
  elements.imu_failures.textContent = String(value.imuFailures);
  elements.motor_failures.textContent = String(value.motorFailures);

  const calibrationLabel = calibrationNames[value.calibrationState] || `状态 ${value.calibrationState}`;
  const resultLabel = value.calibrationState >= 6 ? calibrationResults[value.calibrationResult] || calibrationLabel : calibrationLabel;
  setBadge(elements.gyro_cal_state, resultLabel, value.calibrationBusy ? "busy" : value.calibrationResult === 1 ? "ok" : value.calibrationState >= 7 ? "fault" : "");
  setBadge(elements.angle_cal_state, resultLabel, value.calibrationBusy ? "busy" : value.candidateValid ? "ok" : value.calibrationState >= 7 ? "fault" : "");
  if (!(activeSession?.identity.capabilities & CAP_DIFF_CALIBRATION) &&
      !value.calibrationBusy) {
    setBadge(elements.angle_cal_state, "需升级至 v1.0.18", "fault");
  }
  if (legacyImu) setBadge(elements.imu_console_state,
    value.imuCalibrated ? "在线 · 已标定" : "在线 · 旧版 IMU",
    value.imuCalibrated ? "ok" : "fault");
  setBadge(elements.imu_console_cal_state, resultLabel, value.calibrationBusy ? "busy" : value.calibrationResult === 1 ? "ok" : value.calibrationState >= 7 ? "fault" : "");
  elements.calibration_progress.value = value.calibrationProgress;
  elements.imu_console_progress.value = value.calibrationProgress;
  elements.imu_console_progress_value.textContent = `${value.calibrationProgress}%`;
  elements.candidate_kp.textContent = value.candidateValid ? value.candidateAngleKp.toFixed(4) : "--";
  elements.candidate_ki.textContent = value.candidateValid ? value.candidateAngleKi.toFixed(4) : "--";
  elements.candidate_kd.textContent = value.candidateValid ? value.candidateAngleKd.toFixed(4) : "--";
  elements.calibration_stage.textContent = value.calibrationStageTotal
    ? `${value.calibrationStageIndex} / ${value.calibrationStageTotal}` : "--";
  elements.effective_track.textContent = value.effectiveTrackMm > 0
    ? `${value.effectiveTrackMm.toFixed(1)} mm` : "--";
  elements.direction_gain.textContent = value.clockwiseGainDpsPerMmS > 0
    ? `${value.clockwiseGainDpsPerMmS.toFixed(3)} / ${value.counterclockwiseGainDpsPerMmS.toFixed(3)}` : "--";
  elements.direction_asymmetry.textContent = value.directionAsymmetryPercent == null
    ? "--" : `${value.directionAsymmetryPercent.toFixed(1)}%`;
  elements.step_target.textContent = value.stepTargetDeg == null
    ? "--" : `${value.stepTargetDeg.toFixed(0)}°`;
  elements.step_overshoot.textContent = value.worstStepOvershootDeg == null
    ? "--" : `${value.worstStepOvershootDeg.toFixed(2)}°`;
  elements.step_settle_time.textContent = value.worstStepSettleTimeMs == null
    ? "--" : `${value.worstStepSettleTimeMs} ms`;
  setBadge(elements.motor_feedback_state,
    value.motorStatusValid ? `在线 · 故障 ${hex(value.motorBoardFaults || 0)}` : "无有效反馈",
    value.motorStatusValid && !value.motorBoardFaults ? "ok" : "fault");

  lineHistory.push([value.linePositionMm]);
  yawHistory.push([value.yawDeg, value.yawReferenceDeg]);
  if (legacyImu) gyroHistory.push([value.gyroZDps, value.gyroZDps]);
  angleErrorHistory.push([value.angleErrorDeg]);
  if (lineHistory.length > 160) lineHistory.shift();
  if (yawHistory.length > 160) yawHistory.shift();
  if (gyroHistory.length > 160) gyroHistory.shift();
  if (angleErrorHistory.length > 160) angleErrorHistory.shift();
  renderCharts();
  updateControlAvailability();
}

function renderImuTelemetry(value) {
  latestImuTelemetry = value;
  elements.imu_console_gyro.textContent = `${value.gyroDps[2].toFixed(2)} °/s`;
  elements.imu_console_raw_gyro.textContent = `${value.rawGyroDps[2].toFixed(2)} °/s`;
  elements.imu_console_roll.textContent = `${value.rollDeg.toFixed(2)}°`;
  elements.imu_console_pitch.textContent = `${value.pitchDeg.toFixed(2)}°`;
  elements.imu_console_yaw.textContent = `${value.yawDeg.toFixed(2)}°`;
  elements.imu_console_temperature.textContent = `${value.temperatureC.toFixed(1)} °C`;
  elements.imu_console_accel_norm.textContent = `${value.accelNormG.toFixed(3)} g`;
  elements.imu_console_noise.textContent = `${value.gyroNoiseRmsDps.toFixed(3)} °/s`;
  elements.imu_console_bias.textContent = `${value.gyroBiasDps[2].toFixed(4)} °/s`;
  elements.imu_console_stationary.textContent = value.biasTracking ? "静止 · 跟踪零偏" :
    value.stationary ? "静止" : "运动";
  elements.imu_model_roll.textContent = `${value.rollDeg.toFixed(1)}°`;
  elements.imu_model_pitch.textContent = `${value.pitchDeg.toFixed(1)}°`;
  elements.imu_model_yaw.textContent = `${value.yawDeg.toFixed(1)}°`;
  targetOrientationRoll = value.rollDeg;
  targetOrientationPitch = value.pitchDeg;
  targetOrientationYaw = value.yawDeg;
  setBadge(elements.imu_console_state,
    value.calibrated ? "六轴融合 · 已标定" : "六轴融合 · 待标定",
    value.fusionInitialized ? (value.calibrated ? "ok" : "busy") : "fault");
  gyroHistory.push([value.rawGyroDps[2], value.gyroDps[2]]);
  if (gyroHistory.length > 160) gyroHistory.shift();
  renderCharts();
}

function renderCharts() {
  const gyroRange = symmetricChartRange(gyroHistory, 5, 1000);
  const yawRange = symmetricChartRange(yawHistory, 45, 360);
  const errorRange = symmetricChartRange(angleErrorHistory, 5, 180);
  elements.gyro_chart_range.textContent = `±${gyroRange} °/s`;
  elements.imu_error_chart_range.textContent = `±${errorRange}°`;
  drawChart(elements.line_chart, lineHistory, ["#246746"], 65);
  drawChart(elements.yaw_chart, yawHistory, ["#26343d", "#b33a42"], yawRange);
  drawChart(elements.gyro_chart, gyroHistory, ["#9aa3a7", "#2f64d6"], gyroRange);
  drawChart(elements.imu_yaw_chart, yawHistory, ["#26343d", "#b33a42"], yawRange);
  drawChart(elements.imu_error_chart, angleErrorHistory, ["#aa3037"], errorRange);
}

function drawChart(canvas, rows, colors, fixedAbs) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(280, Math.round(bounds.width * ratio));
  const height = Math.max(120, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#f8f9f9";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#dfe3e5";
  context.lineWidth = 1;
  for (let line = 1; line < 4; line += 1) {
    const y = line * height / 4;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  context.strokeStyle = "#aab3b8";
  context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();
  if (rows.length < 2) return;
  colors.forEach((color, series) => {
    context.strokeStyle = color;
    context.lineWidth = 1.5 * ratio;
    context.beginPath();
    rows.forEach((row, index) => {
      const x = index / 159 * width;
      const y = height / 2 - (row[series] / fixedAbs) * (height * .44);
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  });
}

function clearDisplay() {
  latestTelemetry = null;
  latestImuTelemetry = null;
  latestParams = null;
  latestMotorLimits = null;
  applyWheelInputLimits();
  elements.device_name.textContent = "等待连接";
  elements.firmware_version.textContent = "--";
  elements.uptime_value.textContent = "--";
  elements.state_value.textContent = "离线";
  for (const key of ["line_error", "yaw_value", "angle_error", "gyro_value", "steer_value"]) elements[key].textContent = "--";
  document.querySelectorAll(".sensor-cell").forEach((cell) => cell.classList.remove("is-active"));
  lineHistory.length = 0;
  yawHistory.length = 0;
  gyroHistory.length = 0;
  angleErrorHistory.length = 0;
  for (const key of ["imu_console_gyro", "imu_console_raw_gyro", "imu_console_roll", "imu_console_pitch",
    "imu_console_yaw", "imu_console_temperature", "imu_console_reference", "imu_console_error",
    "imu_console_bias", "imu_console_failures", "imu_console_peak", "imu_console_response",
    "imu_console_stationary", "imu_console_accel_norm",
    "imu_console_noise"]) elements[key].textContent = "--";
  elements.imu_console_progress.value = 0;
  elements.imu_console_progress_value.textContent = "0%";
  elements.imu_console_still_confirm.checked = false;
  elements.imu_model_roll.textContent = "0.0°";
  elements.imu_model_pitch.textContent = "0.0°";
  elements.imu_model_yaw.textContent = "0.0°";
  targetOrientationRoll = 0;
  targetOrientationPitch = 0;
  targetOrientationYaw = 0;
  setBadge(elements.imu_console_state, "等待连接");
  setBadge(elements.imu_console_cal_state, "待机");
  renderCharts();
  updateControlAvailability();
}

function captureParams() {
  const data = new FormData(elements.parameter_form);
  const result = {};
  for (const [key, value] of data.entries()) result[key] = Number(value);
  if (result.leftMotorChannel === result.rightMotorChannel) {
    throw new ProtocolError("左右轮不能使用同一个电机通道");
  }
  return result;
}
function renderMotorMapping(params) {
  const left = motorChannelNames[params?.leftMotorChannel] || "?";
  const right = motorChannelNames[params?.rightMotorChannel] || "?";
  elements.left_wheel_label.textContent = `左轮 ${left}`;
  elements.right_wheel_label.textContent = `右轮 ${right}`;
  elements.left_wheel_status_label.textContent = `左轮 ${left} 目标 / 实际`;
  elements.right_wheel_status_label.textContent = `右轮 ${right} 目标 / 实际`;
  elements.direction_confirm_label.textContent = `左轮 ${left}、右轮 ${right} 的正值均朝前`;
}
function applyWheelInputLimits(params = latestParams ||
    { leftMotorChannel: 0, rightMotorChannel: 2 }) {
  return applyWheelInputBounds(elements.left_wheel_target,
    elements.right_wheel_target, latestMotorLimits, params);
}
function updateChannelOptions() {
  const left = elements.parameter_form.elements.namedItem("leftMotorChannel");
  const right = elements.parameter_form.elements.namedItem("rightMotorChannel");
  for (const option of left.options) option.disabled = option.value === right.value;
  for (const option of right.options) option.disabled = option.value === left.value;
}
function populateParams(params) {
  latestParams = params;
  for (const [key, value] of Object.entries(params)) {
    const input = elements.parameter_form.elements.namedItem(key);
    if (input) input.value = ["commandTimeoutMs", "leftMotorChannel", "rightMotorChannel", "grayActiveHigh"].includes(key) ?
      String(Number(value)) : Number(value).toFixed(4);
  }
  updateChannelOptions();
  renderMotorMapping(params);
  applyWheelInputLimits(params);
}

function updateControlAvailability() {
  const online = Boolean(activeSession) && !updateBusy;
  const motorLimitsReady = Boolean(latestMotorLimits?.synced && latestParams);
  const differentialCalibrationReady = Boolean(activeSession?.identity.capabilities & CAP_DIFF_CALIBRATION);
  const calibrationBusy = Boolean(latestTelemetry?.calibrationBusy);
  elements.estop_button.disabled = !online;
  elements.clear_estop_button.disabled = !online || calibrationBusy;
  for (const element of [elements.zero_yaw_button, elements.gyro_cal_button, elements.imu_console_zero_button,
    elements.send_wheels_button,
    elements.stop_wheels_button, elements.start_tracking_button, elements.stop_tracking_button,
    elements.read_params_button, elements.apply_params_button, elements.save_params_button]) {
    element.disabled = !online || calibrationBusy;
  }
  for (const element of [elements.send_wheels_button,
    elements.stop_wheels_button, elements.start_tracking_button]) {
    element.disabled = !online || calibrationBusy || !motorLimitsReady;
  }
  elements.start_gyro_cal_button.disabled = !online || calibrationBusy || !elements.gyro_still_confirm.checked;
  elements.imu_console_cal_button.disabled = !online || calibrationBusy || !elements.imu_console_still_confirm.checked;
  const angleConfirmed = elements.imu_mounted_confirm.checked && elements.ground_confirm.checked && elements.direction_confirm.checked;
  elements.start_angle_cal_button.disabled = !online || calibrationBusy ||
    !motorLimitsReady || !latestTelemetry?.imuCalibrated || !angleConfirmed ||
    !differentialCalibrationReady;
  elements.abort_cal_button.disabled = !online || !calibrationBusy;
  elements.apply_candidate_button.disabled = !online || calibrationBusy || !latestTelemetry?.candidateValid;
  setUpdateControls();
  updateWirelessAvailability();
}

async function pollLoop(session, token) {
  let failures = 0;
  const hasImuFusion = Boolean(session.identity.capabilities & CAP_IMU_FUSION);
  while (activeSession === session && pollingToken === token && !updateBusy) {
    try {
      renderTelemetry(await session.telemetry(), !hasImuFusion);
      if (hasImuFusion) renderImuTelemetry(await session.imuTelemetry());
      failures = 0;
    } catch (error) {
      failures += 1;
      if (failures >= 3) {
        toast(`底盘遥测中断：${error.message}`, "error");
        await endSession(false);
        return;
      }
    }
    await sleep(80);
  }
}

async function activateSession(session) {
  activeSession = session;
  pollingToken += 1;
  session.transport.onUnexpectedClose = async () => {
    if (activeSession === session) {
      toast("底盘串口已断开", "error");
      await endSession(false);
    }
  };
  elements.device_name.textContent = "MSPM0 灰度循迹底盘";
  elements.firmware_version.textContent = firmwareLabel(session.version);
  elements.connect_button.textContent = "断开底盘";
  setConnection("online", "底盘在线");
  let params = null;
  try { params = await session.getParams(); }
  catch (error) { toast(`参数读取失败：${error.message}`, "error"); }
  try {
    latestMotorLimits = (session.identity.capabilities & CAP_MOTOR_LIMITS) ?
      await session.getMotorLimits() : Object.freeze({ synced: true,
        limitsMrpm: Object.freeze(Array(4).fill(LEGACY_SAFE_LIMIT_MRPM)) });
    if (!latestMotorLimits.synced) {
      toast("电机板 Flash 参数尚未同步，双轮控制已锁定", "error");
    }
  } catch (error) {
    latestMotorLimits = null;
    toast(`电机限速读取失败：${error.message}`, "error");
  }
  if (params) populateParams(params); else applyWheelInputLimits();
  updateControlAvailability();
  void pollLoop(session, pollingToken);
}

async function endSession(safeStop = true) {
  const session = activeSession;
  if (!session) return;
  activeSession = null;
  pollingToken += 1;
  if (safeStop) {
    try { await session.estop(); } catch { /* firmware lease remains active */ }
  }
  await session.close();
  elements.connect_button.textContent = "连接底盘";
  setConnection("offline", "未连接");
  clearDisplay();
}

async function connectPort(port, alreadyOpen = false) {
  if (connectionBusy) return;
  connectionBusy = true;
  setConnection("busy", "识别 CHAS");
  elements.connect_button.disabled = true;
  try {
    if (!alreadyOpen) {
      const handoff = await requestSerialHandoff();
      if (!handoff.released) {
        throw new ProtocolError("另一个上位机页面正在执行升级或整定，暂时不能释放串口");
      }
      if (handoff.delayMs > 0) {
        setConnection("busy", "等待退出电机透传");
        await sleep(handoff.delayMs);
      }
    }
    const session = await ChassisSession.create(port, alreadyOpen);
    await activateSession(session);
    toast("灰度循迹底盘已连接");
  } catch (error) {
    setConnection("fault", "识别失败");
    toast(`未识别到底盘固件：${serialConnectionMessage(error)}`, "error");
  } finally {
    connectionBusy = false;
    elements.connect_button.disabled = updateBusy;
  }
}

function setUpdateStage(element, state = "") {
  if (state) element.dataset.state = state; else delete element.dataset.state;
}
function resetUpdateStages() {
  [elements.stage_file, elements.stage_bsl, elements.stage_program, elements.stage_restart].forEach((element) => setUpdateStage(element));
  if (selectedUpdate) setUpdateStage(elements.stage_file, "done");
  elements.update_progress.value = 0;
}
function setUpdateControls() {
  const hasImage = Boolean(selectedUpdate);
  const confirmed = elements.update_confirm.checked;
  const newer = activeSession && selectedUpdate && selectedUpdate.header.imageVersion > activeSession.version;
  elements.select_update_file_button.disabled = updateBusy;
  elements.update_confirm.disabled = updateBusy || !hasImage;
  elements.update_start_button.disabled = updateBusy || !activeSession || !confirmed || !newer;
  elements.update_recovery_button.disabled = updateBusy || Boolean(activeSession) || !confirmed || !hasImage;
}
async function selectUpdateFile(file) {
  selectedUpdate = null;
  elements.update_file_name.textContent = file?.name || "选择 application_update.bin";
  elements.update_file_size.textContent = file ? `${file.size} B` : "仅接受 CHAS 板型镜像";
  for (const key of ["update_image_version", "update_board_id", "update_image_length", "update_image_crc"]) elements[key].textContent = "--";
  elements.update_confirm.checked = false;
  resetUpdateStages();
  if (!file) { setUpdateControls(); return; }
  try {
    const image = new Uint8Array(await file.arrayBuffer());
    const header = validateApplicationImage(image);
    selectedUpdate = { image, header };
    elements.update_image_version.textContent = firmwareLabel(header.imageVersion);
    elements.update_board_id.textContent = hex(header.boardId);
    elements.update_image_length.textContent = `${header.totalLength} B`;
    elements.update_image_crc.textContent = hex(header.imageCrc32);
    elements.update_file_state.textContent = "校验通过";
    elements.update_file_state.dataset.state = "ok";
    setUpdateStage(elements.stage_file, "done");
  } catch (error) {
    elements.update_file_state.textContent = "镜像无效";
    elements.update_file_state.dataset.state = "fault";
    toast(`升级包拒绝：${error.message}`, "error");
  }
  setUpdateControls();
}
function updateProgress(status) {
  if (status.phase === "connect") setUpdateStage(elements.stage_bsl, "active");
  if (status.phase === "erase" || status.phase === "program" || status.phase === "commit") {
    setUpdateStage(elements.stage_bsl, "done");
    setUpdateStage(elements.stage_program, "active");
  }
  if (status.phase === "verify") {
    setUpdateStage(elements.stage_program, "done");
    setUpdateStage(elements.stage_restart, "active");
  }
  elements.update_progress.value = status.total ? Math.round(status.written / status.total * 100) : 0;
}

async function reconnectApplication(port, expectedVersion) {
  let lastError;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await sleep(120);
    try {
      const session = await ChassisSession.create(port, true);
      if (session.version !== expectedVersion) {
        await session.detach();
        throw new ProtocolError("重启后的底盘版本不匹配");
      }
      return session;
    } catch (error) { lastError = error; }
  }
  throw new ProtocolError(`固件已写入，但底盘重连失败：${lastError?.message || "无响应"}`);
}

async function performUpdate(recoveryMode) {
  if (!selectedUpdate || updateBusy || !elements.update_confirm.checked) return;
  updateBusy = true;
  updateControlAvailability();
  document.querySelectorAll(".tab").forEach((tab) => { tab.disabled = true; });
  resetUpdateStages();
  let port;
  let raw;
  try {
    if (recoveryMode) {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200, bufferSize: 4096 });
    } else {
      port = activeSession.transport.port;
      await activeSession.estop();
      await activeSession.enterUpdate();
      const oldSession = activeSession;
      activeSession = null;
      pollingToken += 1;
      await oldSession.detach();
      await sleep(180);
    }
    raw = new RawSerialTransport(port);
    await raw.attach();
    const bsl = new TiUartBsl(raw);
    elements.update_state.textContent = "正在写入底盘应用区";
    const result = await bsl.upload(selectedUpdate.image, { onProgress: updateProgress });
    await raw.detach();
    raw = null;
    const session = await reconnectApplication(port, selectedUpdate.header.imageVersion);
    await activateSession(session);
    setUpdateStage(elements.stage_restart, "done");
    elements.update_progress.value = 100;
    elements.update_state.textContent = `升级完成 · BSL ${hex(result.identity.pluginVersion, 4)}`;
    toast(`底盘已升级到 ${firmwareLabel(session.version)}`);
  } catch (error) {
    const activeStage = document.querySelector(".update-stages li[data-state='active']");
    if (activeStage) setUpdateStage(activeStage, "error");
    elements.update_state.textContent = `升级中断：${error.message}`;
    toast(elements.update_state.textContent, "error");
    try { await raw?.detach(); } catch { /* preserve primary error */ }
    if (port && !activeSession) { try { await port.close(); } catch { /* may still reset */ } }
  } finally {
    updateBusy = false;
    document.querySelectorAll(".tab").forEach((tab) => { tab.disabled = false; });
    elements.connect_button.textContent = activeSession ? "断开底盘" : "连接底盘";
    elements.connect_button.disabled = false;
    updateControlAvailability();
  }
}

async function command(action, successLabel) {
  if (!activeSession || updateBusy) return;
  try { await action(activeSession); if (successLabel) toast(successLabel); }
  catch (error) { toast(error.message, "error"); }
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((candidate) => {
      const active = candidate === tab;
      candidate.classList.toggle("is-active", active);
      candidate.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".view").forEach((view) => view.classList.toggle("is-active", view.dataset.panel === tab.dataset.view));
    window.requestAnimationFrame(() => {
      renderCharts();
      resizeOrientationView();
    });
  }));
  elements.connect_button.addEventListener("click", async () => {
    if (activeSession) { await endSession(true); return; }
    try { await connectPort(await navigator.serial.requestPort()); }
    catch (error) { if (error.name !== "NotFoundError") toast(error.message, "error"); }
  });
  elements.estop_button.addEventListener("click", () => command((session) => session.estop(), "底盘急停已锁存"));
  elements.clear_estop_button.addEventListener("click", () => command((session) => session.clearEstop(), "底盘已回到 READY"));
  elements.zero_yaw_button.addEventListener("click", () => command((session) => session.zeroYaw(), "航向已清零"));
  elements.gyro_cal_button.addEventListener("click", () => command((session) => session.calibrateGyro(), "静态标定已开始"));
  elements.imu_console_zero_button.addEventListener("click", () => command((session) => session.zeroYaw(), "航向已清零"));
  elements.imu_console_still_confirm.addEventListener("change", updateControlAvailability);
  elements.imu_console_cal_button.addEventListener("click", () => command((session) => session.calibrateGyro(), "静态标定已开始"));
  elements.send_wheels_button.addEventListener("click", () => command(async (session) => {
    const leftMrpm = Math.round(Number(elements.left_wheel_target.value) * 1000);
    const rightMrpm = Math.round(Number(elements.right_wheel_target.value) * 1000);
    const limits = resolveWheelLimits(latestMotorLimits, latestParams);
    if (!limits.synced) throw new ProtocolError("电机板 Flash 参数尚未同步");
    if (!wheelTargetsWithinLimits(leftMrpm, rightMrpm, limits)) {
      throw new ProtocolError(`目标超过当前通道上限：左 ${limits.leftRpm} rpm，右 ${limits.rightRpm} rpm`);
    }
    await session.setWheels(leftMrpm, rightMrpm);
  }, "双轮目标已发送"));
  elements.stop_wheels_button.addEventListener("click", () => command((session) => session.setWheels(0, 0), "双轮已停止"));
  elements.start_tracking_button.addEventListener("click", () => command((session) => session.setRun(true), "循迹已启动"));
  elements.stop_tracking_button.addEventListener("click", () => command((session) => session.setRun(false), "循迹已停止"));
  elements.read_params_button.addEventListener("click", () => command(async (session) => populateParams(await session.getParams()), "参数已读取"));
  elements.apply_params_button.addEventListener("click", () => command(async (session) => {
    await session.setParams(captureParams());
    populateParams(await session.getParams());
  }, "参数已写入 RAM"));
  elements.save_params_button.addEventListener("click", () => command(async (session) => {
    await session.setParams(captureParams());
    await session.saveParams();
    populateParams(await session.getParams());
  }, "参数已保存到 Flash"));
  for (const name of ["leftMotorChannel", "rightMotorChannel"]) {
    elements.parameter_form.elements.namedItem(name).addEventListener("change", updateChannelOptions);
  }
  elements.gyro_still_confirm.addEventListener("change", updateControlAvailability);
  elements.start_gyro_cal_button.addEventListener("click", () => command((session) => session.calibrateGyro(), "静态标定已开始"));
  [elements.imu_mounted_confirm, elements.ground_confirm, elements.direction_confirm].forEach((input) => input.addEventListener("change", updateControlAvailability));
  elements.start_angle_cal_button.addEventListener("click", () => command((session) => session.startAngleAutotune(), "角度环标定已开始"));
  elements.abort_cal_button.addEventListener("click", () => command((session) => session.abortCalibration(), "标定已中止"));
  elements.apply_candidate_button.addEventListener("click", () => command(async (session) => {
    const params = { ...await session.getParams() };
    params.angleKp = latestTelemetry.candidateAngleKp;
    params.angleKi = latestTelemetry.candidateAngleKi;
    params.angleKd = latestTelemetry.candidateAngleKd;
    await session.setParams(params);
    populateParams(await session.getParams());
  }, "角度环候选参数已写入 RAM"));
  elements.wireless_connect_button.addEventListener("click", async () => {
    if (wirelessSession) { await endWirelessSession(); return; }
    try { await connectWirelessPort(await navigator.serial.requestPort()); }
    catch (error) { if (error.name !== "NotFoundError") toast(error.message, "error"); }
  });
  elements.wireless_status_button.addEventListener("click", () => runWirelessCommand("STATUS"));
  elements.wireless_gyro_button.addEventListener("click", () => runWirelessCommand("GYRO"));
  elements.wireless_arm_button.addEventListener("click", async () => {
    wirelessConfirmToken = null;
    updateWirelessAvailability();
    await runWirelessCommand("ARM ANGLE");
  });
  elements.wireless_confirm_button.addEventListener("click", async () => {
    const token = wirelessConfirmToken;
    if (!token) return;
    wirelessConfirmToken = null;
    updateWirelessAvailability();
    await runWirelessCommand(`CONFIRM ANGLE ${token}`);
  });
  elements.wireless_abort_button.addEventListener("click", async () => {
    wirelessConfirmToken = null;
    updateWirelessAvailability();
    await runWirelessCommand("ABORT");
  });
  elements.wireless_estop_button.addEventListener("click", async () => {
    wirelessConfirmToken = null;
    updateWirelessAvailability();
    await runWirelessCommand("ESTOP");
  });
  elements.select_update_file_button.addEventListener("click", () => elements.update_file_input.click());
  elements.update_file_input.addEventListener("change", () => selectUpdateFile(elements.update_file_input.files?.[0]));
  elements.update_confirm.addEventListener("change", setUpdateControls);
  elements.update_start_button.addEventListener("click", () => performUpdate(false));
  elements.update_recovery_button.addEventListener("click", () => performUpdate(true));
  window.addEventListener("resize", () => window.requestAnimationFrame(() => {
    renderCharts();
    resizeOrientationView();
  }));
}

function initialize() {
  createSensors();
  bindEvents();
  try { initializeOrientationView(); }
  catch (error) { console.error("3D IMU 初始化失败", error); }
  updateChannelOptions();
  renderMotorMapping({ leftMotorChannel: 0, rightMotorChannel: 2 });
  clearDisplay();
  const supported = "serial" in navigator && window.isSecureContext;
  elements.support_banner.hidden = supported;
  elements.connect_button.disabled = !supported;
  updateWirelessAvailability();
  setUpdateControls();
  registerSerialReleaseHandler(async () => {
    if (connectionBusy || wirelessConnectionBusy || updateBusy) return false;
    if (activeSession) await endSession(true);
    if (wirelessSession) await endWirelessSession();
    return true;
  });
}

initialize();

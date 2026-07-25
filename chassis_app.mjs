import {
  ANGLE_AUTOTUNE_SAFETY_TOKEN,
  COMMAND,
  FrameDecoder,
  ProtocolError,
  decodeCommandResponse,
  decodeIdentity,
  decodeParams,
  decodeTelemetry,
  encodeFrame,
  encodeParams,
  makeIntPayload,
} from "./chassis_protocol.mjs";
import {
  isSerialPortAlreadyOpen,
  registerSerialReleaseHandler,
  requestSerialHandoff,
  serialConnectionMessage,
} from "./serial_handoff.mjs";
import {
  BslError,
  TiUartBsl,
  validateApplicationImage,
} from "./chassis_firmware_update.mjs";

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "connection-state", "connection-label", "connect-button", "clear-estop-button", "estop-button",
  "support-banner", "device-name", "firmware-version", "uptime-value", "state-value",
  "line-error", "yaw-value", "angle-error", "gyro-value", "steer-value", "line-state",
  "gray-bits", "sensor-track", "line-cursor", "line-chart", "yaw-chart", "imu-state",
  "yaw-needle", "yaw-dial-value", "yaw-reference", "imu-bias", "peak-gyro", "response-time",
  "zero-yaw-button", "gyro-cal-button", "control-mode", "left-wheel-target", "right-wheel-target",
  "left-wheel-label", "right-wheel-label", "left-wheel-status-label", "right-wheel-status-label",
  "send-wheels-button", "stop-wheels-button", "start-tracking-button", "stop-tracking-button",
  "left-wheel-live", "right-wheel-live", "sensor-failures", "imu-failures", "motor-failures",
  "read-params-button", "apply-params-button", "save-params-button", "parameter-form",
  "gyro-cal-state", "cal-bias-value", "gyro-still-confirm", "start-gyro-cal-button",
  "angle-cal-state", "candidate-kp", "candidate-ki", "candidate-kd", "calibration-progress",
  "imu-mounted-confirm", "ground-confirm", "direction-confirm", "direction-confirm-label", "start-angle-cal-button",
  "abort-cal-button", "apply-candidate-button", "update-file-input", "select-update-file-button",
  "update-file-name", "update-file-size", "update-file-state", "update-image-version",
  "update-board-id", "update-image-length", "update-image-crc", "update-state", "stage-file",
  "stage-bsl", "stage-program", "stage-restart", "update-progress", "update-confirm",
  "update-start-button", "update-recovery-button", "toast",
].map((id) => [id.replaceAll("-", "_"), $(id)]));

const stateNames = ["SAFE", "READY", "RUNNING", "FAULT"];
const modeNames = ["已停止", "循迹", "手动双轮", "角度标定"];
const calibrationNames = ["待机", "静置", "采样", "静置", "正向阶跃", "回正", "完成", "失败", "已中止"];
const calibrationResults = ["--", "通过", "检测到移动", "IMU 读取失败", "无有效响应", "回正超时", "已中止"];
const motorChannelNames = ["A", "B", "C", "D"];

let activeSession = null;
let latestTelemetry = null;
let latestParams = null;
let pollingToken = 0;
let updateBusy = false;
let connectionBusy = false;
let selectedUpdate = null;
let toastTimer = null;
const lineHistory = [];
const yawHistory = [];

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
    try {
      await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    } catch (error) {
      if (!isSerialPortAlreadyOpen(error) ||
          !this.port.readable || !this.port.writable) throw error;
    }
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
  async setParams(params) {
    await this.transport.request(COMMAND.SET_PARAMS,
      encodeParams(params, this.parameterVersion || 2));
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

function setBadge(element, label, state = "") {
  element.textContent = label;
  if (state) element.dataset.state = state; else delete element.dataset.state;
}

function renderTelemetry(value) {
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
  setBadge(elements.control_mode, modeNames[value.mode] || `MODE ${value.mode}`, value.state === 3 ? "fault" : value.mode ? "ok" : "");
  elements.left_wheel_live.textContent = `${(value.leftTargetMrpm / 1000).toFixed(1)} rpm`;
  elements.right_wheel_live.textContent = `${(value.rightTargetMrpm / 1000).toFixed(1)} rpm`;
  elements.sensor_failures.textContent = String(value.sensorFailures);
  elements.imu_failures.textContent = String(value.imuFailures);
  elements.motor_failures.textContent = String(value.motorFailures);

  const calibrationLabel = calibrationNames[value.calibrationState] || `状态 ${value.calibrationState}`;
  const resultLabel = value.calibrationState >= 6 ? calibrationResults[value.calibrationResult] || calibrationLabel : calibrationLabel;
  setBadge(elements.gyro_cal_state, resultLabel, value.calibrationBusy ? "busy" : value.calibrationResult === 1 ? "ok" : value.calibrationState >= 7 ? "fault" : "");
  setBadge(elements.angle_cal_state, resultLabel, value.calibrationBusy ? "busy" : value.candidateValid ? "ok" : value.calibrationState >= 7 ? "fault" : "");
  elements.calibration_progress.value = value.calibrationProgress;
  elements.candidate_kp.textContent = value.candidateValid ? value.candidateAngleKp.toFixed(4) : "--";
  elements.candidate_ki.textContent = value.candidateValid ? value.candidateAngleKi.toFixed(4) : "--";
  elements.candidate_kd.textContent = value.candidateValid ? value.candidateAngleKd.toFixed(4) : "--";

  lineHistory.push([value.linePositionMm]);
  yawHistory.push([value.yawDeg, value.yawReferenceDeg]);
  if (lineHistory.length > 160) lineHistory.shift();
  if (yawHistory.length > 160) yawHistory.shift();
  drawChart(elements.line_chart, lineHistory, ["#246746"], 65);
  drawChart(elements.yaw_chart, yawHistory, ["#26343d", "#b33a42"], 45);
  updateControlAvailability();
}

function drawChart(canvas, rows, colors, fixedAbs) {
  const bounds = canvas.getBoundingClientRect();
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
  elements.device_name.textContent = "等待连接";
  elements.firmware_version.textContent = "--";
  elements.uptime_value.textContent = "--";
  elements.state_value.textContent = "离线";
  for (const key of ["line_error", "yaw_value", "angle_error", "gyro_value", "steer_value"]) elements[key].textContent = "--";
  document.querySelectorAll(".sensor-cell").forEach((cell) => cell.classList.remove("is-active"));
  lineHistory.length = 0;
  yawHistory.length = 0;
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
  elements.left_wheel_status_label.textContent = `左轮 ${left} 目标`;
  elements.right_wheel_status_label.textContent = `右轮 ${right} 目标`;
  elements.direction_confirm_label.textContent = `左轮 ${left}、右轮 ${right} 的正值均朝前`;
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
    if (input) input.value = ["commandTimeoutMs", "leftMotorChannel", "rightMotorChannel"].includes(key) ?
      String(Number(value)) : Number(value).toFixed(4);
  }
  updateChannelOptions();
  renderMotorMapping(params);
}

function updateControlAvailability() {
  const online = Boolean(activeSession) && !updateBusy;
  const calibrationBusy = Boolean(latestTelemetry?.calibrationBusy);
  elements.estop_button.disabled = !online;
  elements.clear_estop_button.disabled = !online || calibrationBusy;
  for (const element of [elements.zero_yaw_button, elements.gyro_cal_button, elements.send_wheels_button,
    elements.stop_wheels_button, elements.start_tracking_button, elements.stop_tracking_button,
    elements.read_params_button, elements.apply_params_button, elements.save_params_button]) {
    element.disabled = !online || calibrationBusy;
  }
  elements.start_gyro_cal_button.disabled = !online || calibrationBusy || !elements.gyro_still_confirm.checked;
  const angleConfirmed = elements.imu_mounted_confirm.checked && elements.ground_confirm.checked && elements.direction_confirm.checked;
  elements.start_angle_cal_button.disabled = !online || calibrationBusy || !latestTelemetry?.imuCalibrated || !angleConfirmed;
  elements.abort_cal_button.disabled = !online || !calibrationBusy;
  elements.apply_candidate_button.disabled = !online || calibrationBusy || !latestTelemetry?.candidateValid;
  setUpdateControls();
}

async function pollLoop(session, token) {
  let failures = 0;
  while (activeSession === session && pollingToken === token && !updateBusy) {
    try {
      renderTelemetry(await session.telemetry());
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
  try { populateParams(await session.getParams()); } catch (error) { toast(`参数读取失败：${error.message}`, "error"); }
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

async function connectPort(port, alreadyOpen = false, automatic = false) {
  if (connectionBusy) return;
  connectionBusy = true;
  setConnection("busy", "识别 CHAS");
  elements.connect_button.disabled = true;
  try {
    if (!alreadyOpen && !automatic) {
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
  elements.send_wheels_button.addEventListener("click", () => command((session) => session.setWheels(
    Math.round(Number(elements.left_wheel_target.value) * 1000), Math.round(Number(elements.right_wheel_target.value) * 1000)), "双轮目标已发送"));
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
  elements.select_update_file_button.addEventListener("click", () => elements.update_file_input.click());
  elements.update_file_input.addEventListener("change", () => selectUpdateFile(elements.update_file_input.files?.[0]));
  elements.update_confirm.addEventListener("change", setUpdateControls);
  elements.update_start_button.addEventListener("click", () => performUpdate(false));
  elements.update_recovery_button.addEventListener("click", () => performUpdate(true));
}

async function autoConnect() {
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length === 1 && !activeSession) {
      await connectPort(ports[0], false, true);
    }
  } catch { /* explicit connection remains available */ }
}

function initialize() {
  createSensors();
  bindEvents();
  updateChannelOptions();
  renderMotorMapping({ leftMotorChannel: 0, rightMotorChannel: 2 });
  clearDisplay();
  const supported = "serial" in navigator && window.isSecureContext;
  elements.support_banner.hidden = supported;
  elements.connect_button.disabled = !supported;
  setUpdateControls();
  registerSerialReleaseHandler(async () => {
    if (connectionBusy || updateBusy) return false;
    if (activeSession) await endSession(true);
    return true;
  });
  if (supported) void autoConnect();
}

initialize();

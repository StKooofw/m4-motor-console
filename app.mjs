import {
  COMMAND,
  FrameDecoder,
  ProtocolError,
  decodeCommandResponse,
  decodeParams,
  decodeStatus,
  encodeFrame,
  encodeParams,
  makeIntPayload,
} from "./protocol.mjs";
import {
  BslError,
  TiUartBsl,
  validateApplicationImage,
  validateBslPassword,
} from "./firmware_update.mjs";

const PRODUCT_NAME = "MSPM0G3507 四路电机控制器";
const POLL_INTERVAL_MS = 50;
const MOTOR_NAMES = ["A", "B", "C", "D"];
const MODE_NAMES = ["关闭", "开环", "速度闭环"];

const elements = Object.fromEntries([
  "connection-state", "connection-label", "connect-button",
  "estop-button", "clear-estop-button", "support-banner", "device-name",
  "adapter-name", "firmware-version", "uptime-value", "fault-value",
  "link-rate", "motor-selector", "parameter-motor-selector", "window-select",
  "pause-button", "clear-chart-button", "export-button", "speed-chart",
  "encoder-chart", "duty-chart", "speed-live", "encoder-live", "duty-live",
  "control-motor-title", "enable-switch", "mode-control", "target-label",
  "target-input", "target-unit", "target-slider", "apply-control-button",
  "stop-motor-button", "control-speed", "control-target", "control-encoder",
  "control-output", "control-mode-readback", "control-errors", "status-body",
  "sample-state", "read-params-button", "apply-params-button",
  "save-params-button", "param-kp", "param-ki", "param-kd", "param-kaw",
  "param-alpha", "param-cpr", "param-gear", "param-max-speed",
  "param-max-duty", "param-accel", "param-invert-motor",
  "param-invert-encoder", "param-timeout", "param-window", "param-version",
  "param-sequence", "param-crc", "update-file-input", "select-update-file-button",
  "update-file-name", "update-file-size", "update-current-version",
  "update-image-version", "update-board-id", "update-image-length",
  "update-image-crc", "update-key-file-input", "select-update-key-button",
  "update-key-name", "update-key-size", "update-confirm", "update-start-button",
  "update-recovery-button", "update-progress", "update-progress-label",
  "update-state", "update-stage-file", "update-stage-bsl", "update-stage-program",
  "update-stage-restart", "toast",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

let session = null;
let selectedMotor = 0;
let controlMode = "open";
let currentStatus = null;
let currentParams = null;
let history = [];
let paused = false;
let pollGeneration = 0;
let sampleHz = 0;
let previousSampleTime = 0;
let toastTimer = 0;
let selectedUpdate = null;
let selectedUpdateKey = null;
let updateInProgress = false;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clone(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, "0")}`;
}

function firmwareLabel(version) {
  const major = (version >>> 16) & 0xffff;
  const minor = (version >>> 8) & 0xff;
  const patch = version & 0xff;
  return `v${major}.${minor}.${patch} · ${hex(version)}`;
}

function durationLabel(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function toast(message, kind = "info") {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function setConnectionState(state, label) {
  elements.connection_state.dataset.state = state;
  elements.connection_label.textContent = label;
}

function setInteractive(enabled) {
  [
    elements.estop_button, elements.enable_switch, elements.target_input,
    elements.target_slider, elements.apply_control_button,
    elements.stop_motor_button, elements.read_params_button,
  ].forEach((control) => {
    control.disabled = !enabled;
  });
  const parameterControls = [
    elements.param_kp, elements.param_ki, elements.param_kd, elements.param_kaw,
    elements.param_alpha, elements.param_cpr, elements.param_gear,
    elements.param_max_speed, elements.param_max_duty, elements.param_accel,
    elements.param_invert_motor, elements.param_invert_encoder,
    elements.param_timeout, elements.param_window,
  ];
  parameterControls.forEach((control) => {
    control.disabled = !enabled || !currentParams;
  });
  elements.apply_params_button.disabled = !enabled || !currentParams;
  elements.save_params_button.disabled = !enabled || !currentParams;
  if (!enabled) elements.clear_estop_button.disabled = true;
  setUpdateControls();
}

function fileSizeLabel(size) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KiB`;
}

function setUpdateStage(element, state, label = null) {
  element.dataset.state = state;
  if (label) element.querySelector("[data-role='status']").textContent = label;
}

function resetUpdateProgress() {
  [
    elements.update_stage_file, elements.update_stage_bsl,
    elements.update_stage_program, elements.update_stage_restart,
  ].forEach((stage) => setUpdateStage(stage, "pending", "等待"));
  if (selectedUpdate) setUpdateStage(elements.update_stage_file, "done", "已校验");
  elements.update_progress.value = 0;
  elements.update_progress_label.textContent = "0%";
}

function setUpdatePercent(written, total) {
  const percent = total ? Math.min(100, Math.round((written * 100) / total)) : 0;
  elements.update_progress.value = percent;
  elements.update_progress_label.textContent = `${percent}%`;
}

function setUpdateControls() {
  const confirmed = elements.update_confirm.checked;
  const hasImage = selectedUpdate !== null;
  const hasKey = selectedUpdateKey !== null;
  const isNewer = hasImage && session && selectedUpdate.header.imageVersion > session.version;
  elements.select_update_file_button.disabled = updateInProgress;
  elements.update_file_input.disabled = updateInProgress;
  elements.select_update_key_button.disabled = updateInProgress;
  elements.update_key_file_input.disabled = updateInProgress;
  elements.update_confirm.disabled = updateInProgress || !hasImage || !hasKey;
  elements.update_start_button.disabled = updateInProgress || !confirmed || !hasKey || !isNewer;
  elements.update_recovery_button.disabled = updateInProgress || !confirmed || !hasImage || !hasKey || Boolean(session);
  elements.update_current_version.textContent = session ? firmwareLabel(session.version) : "未连接";

  if (updateInProgress) return;
  if (!hasImage) elements.update_state.textContent = "请选择应用升级包";
  else if (!hasKey) elements.update_state.textContent = "请选择本机更新密钥";
  else if (!session) elements.update_state.textContent = "连接设备升级，或使用恢复模式";
  else if (!isNewer) elements.update_state.textContent = "普通升级要求固件版本高于当前版本";
  else elements.update_state.textContent = "镜像与设备已就绪";
}

async function selectUpdateFile(file) {
  selectedUpdate = null;
  resetUpdateProgress();
  elements.update_file_name.textContent = file?.name || "未选择文件";
  elements.update_file_size.textContent = file ? fileSizeLabel(file.size) : "--";
  elements.update_image_version.textContent = "--";
  elements.update_board_id.textContent = "--";
  elements.update_image_length.textContent = "--";
  elements.update_image_crc.textContent = "--";
  elements.update_confirm.checked = false;
  if (!file) {
    setUpdateControls();
    return;
  }
  try {
    const image = new Uint8Array(await file.arrayBuffer());
    const header = validateApplicationImage(image);
    selectedUpdate = { file, image, header };
    elements.update_image_version.textContent = firmwareLabel(header.imageVersion);
    elements.update_board_id.textContent = hex(header.boardId);
    elements.update_image_length.textContent = `${header.totalLength} B`;
    elements.update_image_crc.textContent = hex(header.imageCrc32);
    setUpdateStage(elements.update_stage_file, "done", "已校验");
    elements.update_state.textContent = "固件本地校验通过";
  } catch (error) {
    setUpdateStage(elements.update_stage_file, "error", "无效");
    elements.update_state.textContent = error.message;
    toast(`固件拒绝：${error.message}`, "error");
  }
  setUpdateControls();
}

async function selectUpdateKey(file) {
  selectedUpdateKey = null;
  elements.update_key_name.textContent = file?.name || "未选择密钥";
  elements.update_key_size.textContent = file ? fileSizeLabel(file.size) : "--";
  elements.update_confirm.checked = false;
  if (!file) {
    setUpdateControls();
    return;
  }
  try {
    const password = validateBslPassword(new Uint8Array(await file.arrayBuffer()));
    selectedUpdateKey = { file, password };
    elements.update_key_size.textContent = `${password.length} B · 已加载`;
    elements.update_state.textContent = selectedUpdate ? "镜像与本机密钥已就绪" : "更新密钥已加载";
  } catch (error) {
    elements.update_key_file_input.value = "";
    elements.update_key_name.textContent = "密钥无效";
    elements.update_key_size.textContent = "--";
    elements.update_state.textContent = error.message;
    toast(`密钥拒绝：${error.message}`, "error");
  }
  setUpdateControls();
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
        for (const frame of this.decoder.feed(value)) this.handleFrame(frame);
      }
    } catch (error) {
      if (!this.closing && this.onUnexpectedClose) this.onUnexpectedClose(error);
    } finally {
      if (this.reader) {
        try { this.reader.releaseLock(); } catch { /* already released */ }
        this.reader = null;
      }
    }
  }

  handleFrame(frame) {
    const pending = this.pending.get(frame.sequence);
    if (!pending) return;
    this.pending.delete(frame.sequence);
    window.clearTimeout(pending.timer);
    try {
      pending.resolve(decodeCommandResponse(frame, pending.command));
    } catch (error) {
      pending.reject(error);
    }
  }

  async request(command, payload = new Uint8Array(), timeoutMs = 900) {
    if (!this.writer || this.closing) throw new ProtocolError("串口未连接");
    const sequence = this.sequence;
    this.sequence = (this.sequence + 1) & 0xffff;
    const response = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(sequence);
        reject(new ProtocolError(`命令 ${hex(command, 2)} 响应超时`));
      }, timeoutMs);
      this.pending.set(sequence, { command, resolve, reject, timer });
    });
    try {
      await this.writer.write(encodeFrame(sequence, command, payload));
    } catch (error) {
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
    if (this.closing && !this.reader && !this.writer) return;
    this.closing = true;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new ProtocolError(reason));
    }
    this.pending.clear();
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        try { await reader.cancel(); } catch { /* 设备可能已经移除 */ }
        try { reader.releaseLock(); } catch { /* readLoop 可能已经释放 */ }
      }
    }
    const readTask = this.readTask;
    this.readTask = null;
    if (readTask) {
      try { await readTask; } catch { /* readLoop 已处理 */ }
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* already released */ }
      this.writer = null;
    }
  }

  async detach() {
    await this.releaseLocks("串口协议正在切换");
  }

  async close() {
    await this.releaseLocks();
    try { await this.port.close(); } catch { /* device may be gone */ }
  }
}

/**
 * BSL 使用顺序字节流，后台持续读取可以在超时后保留串口本身，便于恢复重试。
 */
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
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }

  async readLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.length) this.feed(value);
      }
    } catch (error) {
      if (!this.closing && this.waiter) {
        window.clearTimeout(this.waiter.timer);
        this.waiter.reject(error);
        this.waiter = null;
      }
    } finally {
      if (this.reader) {
        try { this.reader.releaseLock(); } catch { /* 已释放 */ }
        this.reader = null;
      }
    }
  }

  feed(chunk) {
    const combined = new Uint8Array(this.input.length + chunk.length);
    combined.set(this.input);
    combined.set(chunk, this.input.length);
    this.input = combined;
    this.resolveWaiter();
  }

  take(length) {
    const output = this.input.slice(0, length);
    this.input = this.input.slice(length);
    return output;
  }

  resolveWaiter() {
    if (!this.waiter || this.input.length < this.waiter.length) return;
    const waiter = this.waiter;
    this.waiter = null;
    window.clearTimeout(waiter.timer);
    waiter.resolve(this.take(waiter.length));
  }

  clearInput() {
    this.input = new Uint8Array();
  }

  async readExact(length, timeoutMs) {
    if (this.input.length >= length) return this.take(length);
    if (this.waiter) throw new BslError("BSL 串口发生并发读取");
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiter = null;
        reject(new BslError(`BSL 响应超时：${this.input.length}/${length} 字节`));
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
    if (this.closing) return;
    this.closing = true;
    if (this.waiter) {
      window.clearTimeout(this.waiter.timer);
      this.waiter.reject(new BslError("BSL 串口已关闭"));
      this.waiter = null;
    }
    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        reader.releaseLock();
      } catch {
        try { await reader.cancel(); } catch { /* 设备可能已经移除 */ }
        try { reader.releaseLock(); } catch { /* readLoop 可能已经释放 */ }
      }
    }
    const readTask = this.readTask;
    this.readTask = null;
    if (readTask) {
      try { await readTask; } catch { /* readLoop 已处理 */ }
    }
    if (this.writer) {
      try { this.writer.releaseLock(); } catch { /* 已释放 */ }
      this.writer = null;
    }
  }
}

class HardwareSession {
  constructor(transport, version) {
    this.kind = "hardware";
    this.transport = transport;
    this.version = version;
  }

  static async create(port, alreadyOpen = false) {
    const transport = new SerialTransport(port);
    try {
      if (alreadyOpen) await transport.attach();
      else await transport.open();
      const payload = await transport.request(COMMAND.PING);
      if (payload.length !== 4) throw new ProtocolError("PING 响应长度错误");
      const version = new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0, true);
      return new HardwareSession(transport, version);
    } catch (error) {
      if (alreadyOpen) await transport.detach();
      else await transport.close();
      throw error;
    }
  }

  get adapterLabel() {
    const info = this.transport.port.getInfo();
    if (info.usbVendorId == null) return "已授权系统串口";
    const vendor = info.usbVendorId.toString(16).toUpperCase().padStart(4, "0");
    const product = info.usbProductId?.toString(16).toUpperCase().padStart(4, "0") || "----";
    return `USB VID ${vendor} · PID ${product}`;
  }

  async getStatus() {
    return decodeStatus(await this.transport.request(COMMAND.GET_STATUS));
  }

  async setEnable(motor, enabled) {
    await this.transport.request(COMMAND.SET_ENABLE, new Uint8Array([motor, enabled ? 1 : 0]));
  }

  async setOpenLoop(motor, dutyPermille) {
    const payload = makeIntPayload(3, (view, data) => {
      data[0] = motor;
      view.setInt16(1, dutyPermille, true);
    });
    await this.transport.request(COMMAND.SET_OPEN_LOOP, payload);
  }

  async setSpeed(motor, targetMrpm) {
    const payload = makeIntPayload(5, (view, data) => {
      data[0] = motor;
      view.setInt32(1, targetMrpm, true);
    });
    await this.transport.request(COMMAND.SET_SPEED, payload);
  }

  async estop() { await this.transport.request(COMMAND.ESTOP); }
  async clearEstop() { await this.transport.request(COMMAND.CLEAR_ESTOP); }
  async getParams() { return decodeParams(await this.transport.request(COMMAND.GET_PARAMS)); }
  async setParams(params) { await this.transport.request(COMMAND.SET_PARAMS, encodeParams(params)); }
  async saveParams() { await this.transport.request(COMMAND.SAVE_PARAMS, new Uint8Array(), 1800); }
  async enterUpdate() { await this.transport.request(COMMAND.ENTER_UPDATE, new Uint8Array(), 1800); }
  async detach() { await this.transport.detach(); }
  async close() { await this.transport.close(); }
}

function createMotorSelectors() {
  [elements.motor_selector, elements.parameter_motor_selector].forEach((container) => {
    container.replaceChildren();
    MOTOR_NAMES.forEach((name, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "motor-select-button";
      button.dataset.motor = String(index);
      button.innerHTML = `
        <span class="motor-letter">${name}</span>
        <span class="motor-select-meta"><strong>电机 ${name}</strong><span data-role="speed">-- rpm</span></span>
        <span class="motor-select-output" data-role="output">-- %</span>`;
      button.addEventListener("click", () => selectMotor(index));
      container.append(button);
    });
  });
}

function createStatusRows() {
  elements.status_body.replaceChildren();
  MOTOR_NAMES.forEach((name, index) => {
    const row = document.createElement("tr");
    row.dataset.motor = String(index);
    row.innerHTML = `
      <td class="channel-name">电机 ${name}</td>
      <td><span class="state-badge" data-role="state">离线</span></td>
      <td data-role="encoder">--</td><td data-role="speed">--</td>
      <td data-role="target">--</td><td data-role="output">--</td>
      <td data-role="mode">--</td><td data-role="errors">--</td>`;
    row.addEventListener("click", () => selectMotor(index));
    elements.status_body.append(row);
  });
}

function resetLiveDisplay() {
  history = [];
  sampleHz = 0;
  previousSampleTime = 0;
  elements.export_button.disabled = true;
  elements.sample_state.textContent = "等待采样";
  elements.speed_live.textContent = "-- rpm";
  elements.encoder_live.textContent = "-- cnt";
  elements.duty_live.textContent = "-- %";
  elements.control_speed.textContent = "--";
  elements.control_target.textContent = "--";
  elements.control_encoder.textContent = "--";
  elements.control_output.textContent = "--";
  elements.control_mode_readback.textContent = "--";
  elements.control_errors.textContent = "--";
  elements.enable_switch.checked = false;
  elements.target_input.value = "0";
  elements.target_slider.value = "0";
  document.querySelectorAll(".motor-select-button").forEach((button) => {
    button.querySelector('[data-role="speed"]').textContent = "-- rpm";
    button.querySelector('[data-role="output"]').textContent = "-- %";
  });
  elements.status_body.querySelectorAll("tr").forEach((row) => {
    const state = row.querySelector('[data-role="state"]');
    state.textContent = "离线";
    state.classList.remove("is-enabled");
    ["encoder", "speed", "target", "output", "mode", "errors"].forEach((role) => {
      row.querySelector(`[data-role="${role}"]`).textContent = "--";
    });
  });
  renderCharts();
}

function clearParameterForm() {
  [
    elements.param_kp, elements.param_ki, elements.param_kd, elements.param_kaw,
    elements.param_alpha, elements.param_cpr, elements.param_gear,
    elements.param_max_speed, elements.param_max_duty, elements.param_accel,
    elements.param_timeout, elements.param_window,
  ].forEach((input) => { input.value = ""; });
  elements.param_invert_motor.checked = false;
  elements.param_invert_encoder.checked = false;
  elements.param_version.textContent = "--";
  elements.param_sequence.textContent = "--";
  elements.param_crc.textContent = "--";
}

function selectMotor(index) {
  if (currentParams) captureParameterForm();
  selectedMotor = index;
  document.querySelectorAll("[data-motor]").forEach((element) => {
    element.classList.toggle("is-active", Number(element.dataset.motor) === index);
  });
  elements.control_motor_title.textContent = `电机 ${MOTOR_NAMES[index]}`;
  if (currentStatus) {
    const motor = currentStatus.motors[index];
    if (motor.mode === 2) setControlMode("speed");
    elements.target_input.value = controlMode === "speed"
      ? String(Math.round(motor.targetMrpm / 1000))
      : String((motor.outputPermille / 10).toFixed(1));
    elements.target_slider.value = elements.target_input.value;
  }
  if (currentParams) populateParameterForm();
  updateStatusDisplay();
  renderCharts();
}

function setControlMode(mode) {
  controlMode = mode;
  elements.mode_control.querySelectorAll("button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  if (mode === "open") {
    elements.target_label.textContent = "占空比";
    elements.target_unit.textContent = "%";
    elements.target_input.min = "-100";
    elements.target_input.max = "100";
    elements.target_input.step = "0.1";
    elements.target_slider.min = "-100";
    elements.target_slider.max = "100";
    elements.target_slider.step = "0.1";
  } else {
    const maxRpm = currentParams
      ? Math.max(1, Math.round(currentParams.motors[selectedMotor].maxSpeedMrpm / 1000))
      : 3000;
    elements.target_label.textContent = "目标速度";
    elements.target_unit.textContent = "rpm";
    elements.target_input.min = String(-maxRpm);
    elements.target_input.max = String(maxRpm);
    elements.target_input.step = "1";
    elements.target_slider.min = String(-maxRpm);
    elements.target_slider.max = String(maxRpm);
    elements.target_slider.step = "1";
  }
  const value = Math.max(Number(elements.target_input.min), Math.min(
    Number(elements.target_input.max), Number(elements.target_input.value) || 0,
  ));
  elements.target_input.value = String(value);
  elements.target_slider.value = String(value);
}

function updateStatusDisplay() {
  if (!currentStatus) return;
  elements.uptime_value.textContent = durationLabel(currentStatus.uptimeMs);
  elements.fault_value.textContent = hex(currentStatus.faults);
  elements.clear_estop_button.disabled = !session || !currentStatus.estopLatched;
  elements.estop_button.textContent = currentStatus.estopLatched ? "急停已锁存" : "全部急停";

  currentStatus.motors.forEach((motor, index) => {
    const speedRpm = motor.speedMrpm / 1000;
    const targetRpm = motor.targetMrpm / 1000;
    const outputPercent = motor.outputPermille / 10;
    document.querySelectorAll(`.motor-select-button[data-motor="${index}"]`).forEach((button) => {
      button.querySelector('[data-role="speed"]').textContent = `${speedRpm.toFixed(1)} rpm`;
      button.querySelector('[data-role="output"]').textContent = `${outputPercent.toFixed(1)} %`;
    });
    const row = elements.status_body.querySelector(`tr[data-motor="${index}"]`);
    row.classList.toggle("is-active", index === selectedMotor);
    const state = row.querySelector('[data-role="state"]');
    state.textContent = motor.enabled ? "运行" : "停止";
    state.classList.toggle("is-enabled", motor.enabled);
    row.querySelector('[data-role="encoder"]').textContent = motor.encoderCount.toLocaleString();
    row.querySelector('[data-role="speed"]').textContent = `${speedRpm.toFixed(2)} rpm`;
    row.querySelector('[data-role="target"]').textContent = `${targetRpm.toFixed(2)} rpm`;
    row.querySelector('[data-role="output"]').textContent = `${outputPercent.toFixed(1)} %`;
    row.querySelector('[data-role="mode"]').textContent = MODE_NAMES[motor.mode] || `模式 ${motor.mode}`;
    row.querySelector('[data-role="errors"]').textContent = motor.encoderErrors.toLocaleString();
  });

  const motor = currentStatus.motors[selectedMotor];
  elements.enable_switch.checked = motor.enabled;
  elements.speed_live.textContent = `${(motor.speedMrpm / 1000).toFixed(2)} rpm`;
  elements.encoder_live.textContent = `${motor.encoderCount.toLocaleString()} cnt`;
  elements.duty_live.textContent = `${(motor.outputPermille / 10).toFixed(1)} %`;
  elements.control_speed.textContent = `${(motor.speedMrpm / 1000).toFixed(2)} rpm`;
  elements.control_target.textContent = `${(motor.targetMrpm / 1000).toFixed(2)} rpm`;
  elements.control_encoder.textContent = motor.encoderCount.toLocaleString();
  elements.control_output.textContent = `${(motor.outputPermille / 10).toFixed(1)} %`;
  elements.control_mode_readback.textContent = MODE_NAMES[motor.mode] || String(motor.mode);
  elements.control_errors.textContent = motor.encoderErrors.toLocaleString();
}

function recordStatus(status) {
  const now = Date.now();
  if (!paused) {
    history.push({ time: now, status: clone(status) });
    const cutoff = now - 31000;
    while (history.length && history[0].time < cutoff) history.shift();
  }
  if (previousSampleTime) {
    const instantHz = 1000 / Math.max(1, now - previousSampleTime);
    sampleHz = sampleHz ? sampleHz * 0.8 + instantHz * 0.2 : instantHz;
  }
  previousSampleTime = now;
  elements.link_rate.textContent = `${sampleHz.toFixed(1)} Hz`;
  elements.sample_state.textContent = `${new Date(now).toLocaleTimeString()} · ${history.length} 点`;
  elements.export_button.disabled = history.length === 0;
  renderCharts();
}

function formatAxis(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (absolute >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function drawChart(canvas, series, fixedRange = null) {
  const context = canvas.getContext("2d");
  const width = Math.max(280, canvas.clientWidth);
  const height = Math.max(120, canvas.clientHeight);
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const plot = { left: 52, right: width - 8, top: 12, bottom: height - 22 };
  const windowMs = Number(elements.window_select.value) * 1000;
  const endTime = Date.now();
  const startTime = endTime - windowMs;
  const points = history.filter((item) => item.time >= startTime);
  let minimum = fixedRange?.[0] ?? Infinity;
  let maximum = fixedRange?.[1] ?? -Infinity;
  if (!fixedRange) {
    for (const point of points) {
      for (const item of series) {
        const value = item.value(point.status.motors[selectedMotor]);
        if (Number.isFinite(value)) {
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      }
    }
    if (!Number.isFinite(minimum)) {
      minimum = -1;
      maximum = 1;
    } else if (minimum === maximum) {
      const margin = Math.max(1, Math.abs(minimum) * 0.1);
      minimum -= margin;
      maximum += margin;
    } else {
      const margin = (maximum - minimum) * 0.12;
      minimum -= margin;
      maximum += margin;
    }
  }

  context.lineWidth = 1;
  context.strokeStyle = "#e4e9e7";
  context.fillStyle = "#7b8782";
  context.font = '10px "Cascadia Mono", monospace';
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let line = 0; line <= 4; line += 1) {
    const y = plot.top + (plot.bottom - plot.top) * line / 4;
    context.beginPath();
    context.moveTo(plot.left, y);
    context.lineTo(plot.right, y);
    context.stroke();
    const value = maximum - (maximum - minimum) * line / 4;
    context.fillText(formatAxis(value), plot.left - 7, y);
  }
  context.textAlign = "center";
  context.textBaseline = "top";
  for (let line = 0; line <= 5; line += 1) {
    const x = plot.left + (plot.right - plot.left) * line / 5;
    context.beginPath();
    context.moveTo(x, plot.top);
    context.lineTo(x, plot.bottom);
    context.stroke();
    context.fillText(`${(-windowMs / 1000 + windowMs / 1000 * line / 5).toFixed(0)}s`, x, plot.bottom + 6);
  }
  if (points.length < 2) {
    context.fillStyle = "#8b9691";
    context.font = '12px "Segoe UI", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("等待采样", (plot.left + plot.right) / 2, (plot.top + plot.bottom) / 2);
    return;
  }

  for (const item of series) {
    context.beginPath();
    context.strokeStyle = item.color;
    context.lineWidth = 1.8;
    let started = false;
    for (const point of points) {
      const value = item.value(point.status.motors[selectedMotor]);
      if (!Number.isFinite(value)) continue;
      const x = plot.left + (point.time - startTime) / windowMs * (plot.right - plot.left);
      const y = plot.bottom - (value - minimum) / (maximum - minimum) * (plot.bottom - plot.top);
      if (!started) {
        context.moveTo(x, y);
        started = true;
      } else {
        context.lineTo(x, y);
      }
    }
    context.stroke();
  }
}

let chartFrame = 0;
function renderCharts() {
  window.cancelAnimationFrame(chartFrame);
  chartFrame = window.requestAnimationFrame(() => {
    drawChart(elements.speed_chart, [
      { color: "#168563", value: (motor) => motor.speedMrpm / 1000 },
      { color: "#2f64d6", value: (motor) => motor.targetMrpm / 1000 },
    ]);
    drawChart(elements.encoder_chart, [
      { color: "#c67417", value: (motor) => motor.encoderCount },
    ]);
    drawChart(elements.duty_chart, [
      { color: "#b42318", value: (motor) => motor.outputPermille / 10 },
    ], [-100, 100]);
  });
}

async function startPolling() {
  const generation = ++pollGeneration;
  let failures = 0;
  while (session && generation === pollGeneration) {
    const started = performance.now();
    try {
      const status = await session.getStatus();
      if (generation !== pollGeneration) break;
      currentStatus = status;
      failures = 0;
      updateStatusDisplay();
      recordStatus(status);
    } catch (error) {
      failures += 1;
      if (failures >= 3) {
        toast(`遥测中断：${error.message}`, "error");
        await endSession(false);
        break;
      }
    }
    const remaining = POLL_INTERVAL_MS - (performance.now() - started);
    if (remaining > 0) await sleep(remaining);
  }
}

async function activateSession(newSession) {
  session = newSession;
  currentStatus = null;
  currentParams = null;
  history = [];
  paused = false;
  sampleHz = 0;
  previousSampleTime = 0;
  elements.pause_button.textContent = "暂停";
  elements.device_name.textContent = PRODUCT_NAME;
  elements.adapter_name.textContent = newSession.adapterLabel;
  elements.firmware_version.textContent = firmwareLabel(newSession.version);
  elements.connect_button.textContent = "断开设备";
  setConnectionState("online", "设备在线");
  setInteractive(true);
  try {
    currentParams = await newSession.getParams();
    populateParameterForm();
    setInteractive(true);
  } catch (error) {
    currentParams = null;
    clearParameterForm();
    setInteractive(true);
    toast(`参数读取失败：${error.message}`, "error");
  }
  startPolling();
}

async function endSession(safeStop = true) {
  const oldSession = session;
  session = null;
  pollGeneration += 1;
  if (oldSession) {
    if (safeStop) {
      await Promise.allSettled(MOTOR_NAMES.map((_, index) => oldSession.setEnable(index, false)));
    }
    await oldSession.close();
  }
  currentStatus = null;
  currentParams = null;
  resetLiveDisplay();
  clearParameterForm();
  setInteractive(false);
  setConnectionState("offline", "未连接");
  elements.device_name.textContent = "等待设备";
  elements.adapter_name.textContent = "未授权串口";
  elements.firmware_version.textContent = "--";
  elements.uptime_value.textContent = "--";
  elements.fault_value.textContent = "--";
  elements.link_rate.textContent = "--";
  elements.connect_button.textContent = "连接设备";
  elements.estop_button.textContent = "全部急停";
}

async function connectHardware(port, automatic = false) {
  await endSession(false);
  setConnectionState("busy", "识别设备");
  elements.connect_button.disabled = true;
  let hardware = null;
  try {
    hardware = await HardwareSession.create(port);
    hardware.transport.onUnexpectedClose = () => {
      if (session === hardware) {
        toast("串口设备已断开", "error");
        endSession(false);
      }
    };
    await activateSession(hardware);
    toast(automatic ? "已自动连接授权设备" : "设备识别成功");
  } catch (error) {
    if (hardware) await hardware.close();
    else {
      try { await port.close(); } catch { /* not open */ }
    }
    setConnectionState("fault", "识别失败");
    toast(`没有识别到电机固件：${error.message}`, "error");
    await sleep(500);
    if (!session) setConnectionState("offline", "未连接");
  } finally {
    elements.connect_button.disabled = updateInProgress;
  }
}

async function reconnectApplication(port, expectedVersion) {
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await sleep(120);
    let hardware = null;
    try {
      hardware = await HardwareSession.create(port, true);
      if (hardware.version !== expectedVersion) {
        await hardware.detach();
        throw new ProtocolError(
          `重启版本 ${hex(hardware.version)} 与升级包 ${hex(expectedVersion)} 不一致`,
        );
      }
      return hardware;
    } catch (error) {
      lastError = error;
    }
  }
  throw new ProtocolError(`固件已写入，但应用重连失败：${lastError?.message || "无响应"}`);
}

function updateProgressState(state) {
  if (state.phase === "connect") {
    setUpdateStage(elements.update_stage_bsl, "active", "连接中");
  } else if (state.phase === "erase") {
    setUpdateStage(elements.update_stage_bsl, "done", "已连接");
    setUpdateStage(elements.update_stage_program, "active", "擦除应用区");
  } else if (state.phase === "program") {
    setUpdateStage(elements.update_stage_program, "active", "写入代码");
    setUpdatePercent(state.written, state.total);
  } else if (state.phase === "commit") {
    setUpdateStage(elements.update_stage_program, "active", "写入提交头");
    setUpdatePercent(state.written, state.total);
  } else if (state.phase === "verify") {
    setUpdateStage(elements.update_stage_program, "done", "CRC 通过");
    setUpdateStage(elements.update_stage_restart, "active", "等待重启");
    setUpdatePercent(state.total, state.total);
  }
}

async function performFirmwareUpdate(recoveryMode) {
  if (!selectedUpdate || !selectedUpdateKey || updateInProgress || !elements.update_confirm.checked) return;
  if (!recoveryMode && (!session || selectedUpdate.header.imageVersion <= session.version)) return;

  const image = selectedUpdate;
  const oldSession = session;
  let port = null;
  let rawTransport = null;
  let handedToBsl = false;
  updateInProgress = true;
  pollGeneration += 1;
  resetUpdateProgress();
  setUpdateStage(elements.update_stage_file, "done", "已校验");
  setUpdateStage(elements.update_stage_bsl, "active", recoveryMode ? "选择串口" : "准备切换");
  elements.update_state.textContent = recoveryMode ? "正在连接恢复 BSL" : "正在安全停止并进入 BSL";
  elements.connect_button.disabled = true;
  document.querySelectorAll(".view-tab").forEach((tab) => { tab.disabled = true; });
  setInteractive(false);

  try {
    if (recoveryMode) {
      port = await navigator.serial.requestPort();
      await port.open({ baudRate: 115200, bufferSize: 4096 });
      handedToBsl = true;
    } else {
      await sleep(POLL_INTERVAL_MS + 20);
      await oldSession.estop();
      await oldSession.enterUpdate();
      port = oldSession.transport.port;
      session = null;
      handedToBsl = true;
      await oldSession.detach();
      await sleep(250);
    }

    rawTransport = new RawSerialTransport(port);
    await rawTransport.attach();
    const bsl = new TiUartBsl(rawTransport, selectedUpdateKey.password, 2500);
    elements.update_state.textContent = "正在校验引导配置并写入应用区";
    const result = await bsl.upload(image.image, { onProgress: updateProgressState });
    await rawTransport.detach();
    rawTransport = null;

    elements.update_state.textContent = "目标 CRC 已通过，正在重连应用";
    await sleep(150);
    const hardware = await reconnectApplication(port, image.header.imageVersion);
    hardware.transport.onUnexpectedClose = () => {
      if (session === hardware) {
        toast("串口设备已断开", "error");
        endSession(false);
      }
    };
    await activateSession(hardware);
    setUpdateStage(elements.update_stage_restart, "done", "版本已确认");
    elements.update_state.textContent = `升级完成 · BSL ${hex(result.identity.pluginVersion, 4)}`;
    toast(`固件已升级到 ${firmwareLabel(image.header.imageVersion)}`);
  } catch (error) {
    if (rawTransport) {
      try { await rawTransport.detach(); } catch { /* 保留原始错误 */ }
    }
    const activeStage = document.querySelector(".update-stage[data-state='active']");
    const selectionCancelled = recoveryMode && error.name === "NotFoundError" && !handedToBsl;
    if (selectionCancelled) {
      if (activeStage) setUpdateStage(activeStage, "pending", "等待");
      elements.update_state.textContent = "已取消恢复串口选择";
    } else if (!handedToBsl && oldSession) {
      if (activeStage) setUpdateStage(activeStage, "error", "失败");
      elements.update_state.textContent = `升级未开始：${error.message}`;
      toast(`升级未开始：${error.message}`, "error");
      session = oldSession;
      setConnectionState("online", "设备在线");
      setInteractive(true);
      startPolling();
    } else {
      if (activeStage) setUpdateStage(activeStage, "error", "失败");
      elements.update_state.textContent = `升级中断：${error.message} · 可使用恢复模式重试`;
      toast(`升级中断：${error.message}`, "error");
      session = null;
      if (oldSession) {
        try { await oldSession.close(); } catch { /* 端口可能已经关闭 */ }
      } else if (port) {
        try { await port.close(); } catch { /* 端口可能已经关闭 */ }
      }
      currentStatus = null;
      currentParams = null;
      resetLiveDisplay();
      clearParameterForm();
      setConnectionState("fault", "等待恢复");
      elements.connect_button.textContent = "连接设备";
    }
  } finally {
    updateInProgress = false;
    elements.connect_button.disabled = false;
    document.querySelectorAll(".view-tab").forEach((tab) => { tab.disabled = false; });
    setInteractive(Boolean(session));
    setUpdateControls();
  }
}

function captureParameterForm() {
  if (!currentParams) return;
  const motor = currentParams.motors[selectedMotor];
  const number = (element, label) => {
    const value = Number(element.value);
    if (!Number.isFinite(value)) throw new ProtocolError(`${label} 不是有效数字`);
    return value;
  };
  motor.kpQ16 = Math.round(number(elements.param_kp, "KP") * 65536);
  motor.kiQ16 = Math.round(number(elements.param_ki, "KI") * 65536);
  motor.kdQ16 = Math.round(number(elements.param_kd, "KD") * 65536);
  motor.kawQ16 = Math.round(number(elements.param_kaw, "KAW") * 65536);
  motor.derivativeAlphaQ16 = Math.round(number(elements.param_alpha, "滤波系数") * 65536);
  motor.encoderCountsPerRev = Math.round(number(elements.param_cpr, "编码器计数"));
  motor.gearRatioQ16 = Math.round(number(elements.param_gear, "减速比") * 65536);
  motor.maxSpeedMrpm = Math.round(number(elements.param_max_speed, "最大速度") * 1000);
  motor.maxDutyPermille = Math.round(number(elements.param_max_duty, "最大占空比") * 10);
  motor.accelMrpmPerTick = Math.round(number(elements.param_accel, "加速度斜坡"));
  motor.invertMotor = elements.param_invert_motor.checked ? 1 : 0;
  motor.invertEncoder = elements.param_invert_encoder.checked ? 1 : 0;
  currentParams.controlTimeoutMs = Math.round(number(elements.param_timeout, "通信超时"));
  currentParams.lowSpeedWindowMs = Math.round(number(elements.param_window, "测速窗口"));
  currentParams = decodeParams(encodeParams(currentParams));
}

function populateParameterForm() {
  if (!currentParams) return;
  const motor = currentParams.motors[selectedMotor];
  elements.param_kp.value = (motor.kpQ16 / 65536).toFixed(4);
  elements.param_ki.value = (motor.kiQ16 / 65536).toFixed(4);
  elements.param_kd.value = (motor.kdQ16 / 65536).toFixed(4);
  elements.param_kaw.value = (motor.kawQ16 / 65536).toFixed(4);
  elements.param_alpha.value = (motor.derivativeAlphaQ16 / 65536).toFixed(4);
  elements.param_cpr.value = String(motor.encoderCountsPerRev);
  elements.param_gear.value = (motor.gearRatioQ16 / 65536).toFixed(4);
  elements.param_max_speed.value = String(Math.round(motor.maxSpeedMrpm / 1000));
  elements.param_max_duty.value = (motor.maxDutyPermille / 10).toFixed(1);
  elements.param_accel.value = String(motor.accelMrpmPerTick);
  elements.param_invert_motor.checked = Boolean(motor.invertMotor);
  elements.param_invert_encoder.checked = Boolean(motor.invertEncoder);
  elements.param_timeout.value = String(currentParams.controlTimeoutMs);
  elements.param_window.value = String(currentParams.lowSpeedWindowMs);
  elements.param_version.textContent = String(currentParams.version);
  elements.param_sequence.textContent = String(currentParams.sequence);
  elements.param_crc.textContent = hex(currentParams.crc32);
  setControlMode(controlMode);
}

function exportCsv() {
  if (!history.length) return;
  const rows = [[
    "host_time", "uptime_ms", "motor", "encoder_count", "speed_rpm",
    "target_rpm", "duty_percent", "enabled", "mode", "encoder_errors", "faults",
  ]];
  history.forEach((sample) => {
    sample.status.motors.forEach((motor) => rows.push([
      new Date(sample.time).toISOString(), sample.status.uptimeMs, motor.index,
      motor.encoderCount, (motor.speedMrpm / 1000).toFixed(3),
      (motor.targetMrpm / 1000).toFixed(3), (motor.outputPermille / 10).toFixed(2),
      motor.enabled ? 1 : 0, motor.mode, motor.encoderErrors, hex(sample.status.faults),
    ]));
  });
  const blob = new Blob([rows.map((row) => row.join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `m4-telemetry-${new Date().toISOString().replaceAll(":", "-")}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindEvents() {
  document.querySelectorAll(".view-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".view-tab").forEach((candidate) => {
        const active = candidate === tab;
        candidate.classList.toggle("is-active", active);
        candidate.setAttribute("aria-selected", String(active));
      });
      document.querySelectorAll("[data-panel]").forEach((panel) => {
        const active = panel.dataset.panel === tab.dataset.view;
        panel.classList.toggle("is-active", active);
        panel.hidden = !active;
      });
    });
  });

  elements.connect_button.addEventListener("click", async () => {
    if (updateInProgress) return;
    if (session) {
      await endSession(true);
      return;
    }
    if (!("serial" in navigator)) return;
    try {
      const port = await navigator.serial.requestPort();
      await connectHardware(port);
    } catch (error) {
      if (error.name !== "NotFoundError") toast(error.message, "error");
    }
  });

  elements.select_update_file_button.addEventListener("click", () => {
    if (!updateInProgress) elements.update_file_input.click();
  });
  elements.update_file_input.addEventListener("change", async () => {
    await selectUpdateFile(elements.update_file_input.files?.[0] || null);
  });
  elements.select_update_key_button.addEventListener("click", () => {
    if (!updateInProgress) elements.update_key_file_input.click();
  });
  elements.update_key_file_input.addEventListener("change", async () => {
    await selectUpdateKey(elements.update_key_file_input.files?.[0] || null);
  });
  elements.update_confirm.addEventListener("change", setUpdateControls);
  elements.update_start_button.addEventListener("click", async () => {
    await performFirmwareUpdate(false);
  });
  elements.update_recovery_button.addEventListener("click", async () => {
    await performFirmwareUpdate(true);
  });

  elements.estop_button.addEventListener("click", async () => {
    if (!session) return;
    try {
      await session.estop();
      toast("四路急停已锁存");
    } catch (error) { toast(error.message, "error"); }
  });

  elements.clear_estop_button.addEventListener("click", async () => {
    if (!session) return;
    try {
      await session.clearEstop();
      toast("急停已解除");
    } catch (error) { toast(error.message, "error"); }
  });

  elements.enable_switch.addEventListener("change", async () => {
    if (!session) return;
    try {
      await session.setEnable(selectedMotor, elements.enable_switch.checked);
    } catch (error) {
      elements.enable_switch.checked = !elements.enable_switch.checked;
      toast(error.message, "error");
    }
  });

  elements.mode_control.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => setControlMode(button.dataset.mode));
  });
  elements.target_input.addEventListener("input", () => {
    elements.target_slider.value = elements.target_input.value;
  });
  elements.target_slider.addEventListener("input", () => {
    elements.target_input.value = elements.target_slider.value;
  });

  elements.apply_control_button.addEventListener("click", async () => {
    if (!session) return;
    const value = Number(elements.target_input.value);
    if (!Number.isFinite(value)) return toast("目标值无效", "error");
    try {
      if (!elements.enable_switch.checked) {
        await session.setEnable(selectedMotor, false);
      } else if (controlMode === "open") {
        await session.setOpenLoop(selectedMotor, Math.round(value * 10));
      } else {
        await session.setSpeed(selectedMotor, Math.round(value * 1000));
      }
      toast(`电机 ${MOTOR_NAMES[selectedMotor]} 目标已发送`);
    } catch (error) { toast(error.message, "error"); }
  });

  elements.stop_motor_button.addEventListener("click", async () => {
    if (!session) return;
    try {
      await session.setEnable(selectedMotor, false);
      toast(`电机 ${MOTOR_NAMES[selectedMotor]} 已停止`);
    } catch (error) { toast(error.message, "error"); }
  });

  elements.pause_button.addEventListener("click", () => {
    paused = !paused;
    elements.pause_button.textContent = paused ? "继续" : "暂停";
  });
  elements.clear_chart_button.addEventListener("click", () => {
    history = [];
    elements.export_button.disabled = true;
    renderCharts();
  });
  elements.export_button.addEventListener("click", exportCsv);
  elements.window_select.addEventListener("change", renderCharts);

  elements.read_params_button.addEventListener("click", async () => {
    if (!session) return;
    try {
      currentParams = await session.getParams();
      populateParameterForm();
      setInteractive(true);
      toast("参数已读取");
    } catch (error) { toast(error.message, "error"); }
  });

  elements.apply_params_button.addEventListener("click", async () => {
    if (!session || !currentParams) return;
    try {
      captureParameterForm();
      await session.setParams(currentParams);
      toast("参数已应用到 RAM");
    } catch (error) { toast(error.message, "error"); }
  });

  elements.save_params_button.addEventListener("click", async () => {
    if (!session || !currentParams) return;
    try {
      captureParameterForm();
      await session.setParams(currentParams);
      await session.saveParams();
      currentParams = await session.getParams();
      populateParameterForm();
      toast("参数已保存，四路电机保持停止");
    } catch (error) { toast(error.message, "error"); }
  });

  window.addEventListener("resize", renderCharts);
  window.addEventListener("beforeunload", () => {
    pollGeneration += 1;
  });
}

async function autoConnect() {
  if (!("serial" in navigator)) return;
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length === 1 && !session) await connectHardware(ports[0], true);
  } catch { /* explicit connection remains available */ }
}

function initialize() {
  createMotorSelectors();
  createStatusRows();
  selectMotor(0);
  setControlMode("open");
  setInteractive(false);
  resetUpdateProgress();
  setUpdateControls();
  const supported = "serial" in navigator && window.isSecureContext;
  elements.support_banner.hidden = supported;
  if (!supported) elements.connect_button.disabled = true;
  bindEvents();
  renderCharts();
  if (supported) autoConnect();
}

initialize();

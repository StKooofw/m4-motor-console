import {
  LineDecoder,
  ProtocolError,
  DEFAULT_CONFIG,
  DEFAULT_POLICY,
  encodeCommand,
  episodeCsv,
  summarizeEpisode,
  validateConfig,
  validatePolicy,
} from "./ballbeam_protocol.mjs?v=20260730-2";
import {
  QDRIVE_CONTROL_SPECS,
  QDriveSerialSession,
  formatConfigCommand,
  formatControlCommand,
  isCompleteQDriveStatus,
  parseQDriveConfig,
  parseQDriveIdentity,
  parseQDriveStatus,
  qdriveSamplesCsv,
  stripAnsi,
} from "./qdrive_shell.mjs?v=20260731-1";
import {
  chooseQDriveDfuDevice,
  flashQDriveDfu,
  parseDfuSeFile,
} from "./qdrive_dfu.mjs?v=20260731-1";
import {
  registerSerialReleaseHandler,
  requestSerialHandoff,
  serialConnectionMessage,
} from "./serial_handoff.mjs";

const $ = (id) => document.getElementById(id);
const elements = Object.fromEntries([
  "connection-state", "connection-label", "connect-button", "clear-fault-button", "estop-button",
  "support-banner", "device-name", "firmware-version", "vision-state", "state-value",
  "ball-position", "target-position", "ball-velocity", "beam-angle", "motor-angle", "motor-current",
  "tracking-badge", "target-marker", "ball-marker", "position-chart", "chart-window",
  "control-state-badge", "control-mode", "vision-age", "qdrive-age", "motor-speed", "lease-age",
  "fault-code", "target-input", "send-target-button", "center-button", "sequence-button",
  "confirm-limits", "confirm-ground", "confirm-clear", "arm-button", "disarm-button",
  "left-x", "left-y", "right-x", "right-y", "roi-x", "roi-y", "roi-width", "roi-height",
  "gain-kp", "gain-ki", "gain-kd", "control-sign", "apply-vision-button",
  "motor-min", "motor-neutral", "motor-max", "beam-min", "beam-max", "motor-step",
  "vision-timeout", "qdrive-timeout", "lease-timeout", "max-current", "max-ball-speed",
  "integral-limit", "apply-safety-button", "episode-badge", "policy-w0", "policy-w1", "policy-w2",
  "policy-w3", "policy-bias", "policy-limit", "policy-file", "apply-policy-button", "episode-mode",
  "episode-target", "episode-duration", "start-episode-button", "stop-episode-button",
  "export-episode-button", "report-samples", "report-duration", "report-mae", "report-max-error",
  "report-within", "report-current", "clear-log-button", "event-log", "toast",
  "qdrive-baud-rate", "qdrive-connection-badge", "qdrive-connect-button", "qdrive-terminal-clear",
  "qdrive-terminal-output", "qdrive-terminal-form", "qdrive-terminal-input", "qdrive-terminal-send",
  "qdrive-read-device", "qdrive-hardware", "qdrive-software", "qdrive-drive-state",
  "qdrive-control-mode", "qdrive-can-id-value", "qdrive-voltage", "qdrive-read-status",
  "qdrive-read-config", "qdrive-wave-frequency", "qdrive-wave-toggle", "qdrive-wave-export",
  "qdrive-current", "qdrive-speed", "qdrive-angle", "qdrive-current-chart", "qdrive-speed-chart",
  "qdrive-angle-chart", "qdrive-ctrl-mode", "qdrive-ctrl-value", "qdrive-ctrl-unit",
  "qdrive-ctrl-send", "qdrive-confirm-clear", "qdrive-confirm-k230", "qdrive-confirm-limits",
  "qdrive-enable", "qdrive-disable", "qdrive-apply-config", "qdrive-timeout-input",
  "qdrive-timeout-support", "qdrive-zero", "qdrive-calibrate", "qdrive-store", "qdrive-restore",
  "qdrive-reboot", "qdrive-upgrade", "qdrive-confirm-dialog", "qdrive-confirm-title",
  "qdrive-confirm-description", "qdrive-confirm-ok", "qdrive-dfu-dialog", "qdrive-dfu-file",
  "qdrive-dfu-file-name", "qdrive-dfu-device", "qdrive-dfu-device-name", "qdrive-dfu-progress",
  "qdrive-dfu-status", "qdrive-dfu-start",
].map((id) => [id.replaceAll("-", "_"), $(id)]));

let activeSession = null;
let connectionBusy = false;
let latestTelemetry = null;
let currentConfig = validateConfig({});
let currentPolicy = validatePolicy(DEFAULT_POLICY);
let positionHistory = [];
let episodeSamples = [];
let episodeActive = false;
let heartbeatTimer = null;
let heartbeatBusy = false;
let toastTimer = null;
let logLines = [];
let qdriveSession = null;
let qdriveConnectionBusy = false;
let qdriveLastStatus = null;
let qdriveWaveActive = false;
let qdriveWaveGeneration = 0;
let qdriveWaveTimer = null;
let qdriveWaveStart = 0;
let qdriveSamples = [];
let qdriveTerminalText = "";
let qdriveDfuFile = null;
let qdriveDfuDevice = null;
let qdriveDfuBusy = false;
let qdriveActionBusy = false;

class SerialTransport {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.decoder = new LineDecoder();
    this.pending = new Map();
    this.sequence = 1;
    this.closing = false;
    this.readTask = null;
    this.onTelemetry = null;
    this.onEvent = null;
    this.onUnexpectedClose = null;
  }

  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 4096 });
    this.reader = this.port.readable.getReader();
    this.writer = this.port.writable.getWriter();
    this.readTask = this.readLoop();
  }

  async readLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const message of this.decoder.feed(value)) this.handleMessage(message);
      }
    } catch (error) {
      if (!this.closing) this.onUnexpectedClose?.(error);
    } finally {
      try { this.reader?.releaseLock(); } catch { /* released by close */ }
      this.reader = null;
    }
  }

  handleMessage(message) {
    if (message.type === "ack") {
      const pending = this.pending.get(message.seq);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      this.pending.delete(message.seq);
      if (message.command !== pending.command) {
        pending.reject(new ProtocolError("响应命令不匹配"));
      } else if (!message.ok) {
        const detail = message.error?.detail || message.error?.code || "K230 拒绝命令";
        pending.reject(new ProtocolError(detail));
      } else {
        pending.resolve(message.data || {});
      }
    } else if (message.type === "telemetry") {
      this.onTelemetry?.(message.data);
    } else if (message.type === "event") {
      this.onEvent?.(message.event, message.data || {});
    }
  }

  request(command, data = {}, timeoutMs = 900) {
    if (!this.writer || this.closing) return Promise.reject(new ProtocolError("串口未连接"));
    const sequence = this.sequence++ & 0x7fffffff;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(sequence);
        reject(new ProtocolError(`${command} 响应超时`));
      }, timeoutMs);
      this.pending.set(sequence, { command, resolve, reject, timer });
      this.writer.write(encodeCommand(sequence, command, data)).catch((error) => {
        window.clearTimeout(timer);
        this.pending.delete(sequence);
        reject(error);
      });
    });
  }

  async close(reason = "串口已断开") {
    if (this.closing) return;
    this.closing = true;
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new ProtocolError(reason));
    }
    this.pending.clear();
    try { await this.reader?.cancel(); } catch { /* device may be removed */ }
    try { await this.readTask; } catch { /* read loop handled it */ }
    this.readTask = null;
    try { this.writer?.releaseLock(); } catch { /* already released */ }
    this.writer = null;
    try { await this.port.close(); } catch { /* already closed */ }
  }
}

function toast(message, kind = "info") {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.dataset.kind = kind;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 3800);
}

function logEvent(message) {
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  logLines.push(`[${stamp}] ${message}`);
  if (logLines.length > 80) logLines = logLines.slice(-80);
  elements.event_log.textContent = logLines.join("\n") || "等待事件";
  elements.event_log.scrollTop = elements.event_log.scrollHeight;
}

function setBadge(element, text, state = "") {
  element.textContent = text;
  if (state) element.dataset.state = state;
  else delete element.dataset.state;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function appendQDriveTerminal(chunk) {
  const text = stripAnsi(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  qdriveTerminalText = `${qdriveTerminalText}${text}`.slice(-40000);
  elements.qdrive_terminal_output.textContent = qdriveTerminalText || "等待 QDrive 输出";
  elements.qdrive_terminal_output.scrollTop = elements.qdrive_terminal_output.scrollHeight;
}

function qdriveValue(value, digits, unit) {
  return Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : `-- ${unit}`;
}

function renderQDriveStatus(status) {
  qdriveLastStatus = status;
  elements.qdrive_drive_state.textContent = status.enabled === true ? "enabled" : status.enabled === false ? "disabled" : "unknown";
  elements.qdrive_control_mode.textContent = status.mode;
  elements.qdrive_can_id_value.textContent = status.can_id === null ? "--" : String(status.can_id).padStart(3, "0");
  elements.qdrive_voltage.textContent = qdriveValue(status.voltage_v, 2, "V");
  elements.qdrive_current.textContent = qdriveValue(status.current_a, 3, "A");
  elements.qdrive_speed.textContent = qdriveValue(status.speed_rpm, 2, "rpm");
  elements.qdrive_angle.textContent = qdriveValue(status.angle_rad, 3, "rad");
  updateControls();
}

function drawQDriveChart(canvas, key, color, flatRange) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(bounds.width * ratio);
  const height = Math.round(bounds.height * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = bounds.width;
  const h = bounds.height;
  context.fillStyle = "#fafbfb";
  context.fillRect(0, 0, w, h);
  const pad = { left: 42, right: 10, top: 10, bottom: 22 };
  const plotW = Math.max(1, w - pad.left - pad.right);
  const plotH = Math.max(1, h - pad.top - pad.bottom);
  const lastTime = qdriveSamples.at(-1)?.time_s ?? 10;
  const firstTime = Math.max(0, lastTime - 10);
  const visible = qdriveSamples.filter((sample) => sample.time_s >= firstTime);
  const values = visible.map((sample) => sample[key]).filter(Number.isFinite);
  let min = values.length ? Math.min(...values) : -flatRange;
  let max = values.length ? Math.max(...values) : flatRange;
  if (min === max) { min -= flatRange; max += flatRange; }
  const margin = Math.max(flatRange * .1, (max - min) * .12);
  min -= margin;
  max += margin;
  context.font = "9px ui-monospace, monospace";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + plotH * index / 4;
    const value = max - (max - min) * index / 4;
    context.strokeStyle = "#e2e6e8";
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(pad.left, y); context.lineTo(w - pad.right, y); context.stroke();
    context.fillStyle = "#7a8288";
    context.fillText(value.toPrecision(3), pad.left - 6, y);
  }
  context.textAlign = "center";
  context.textBaseline = "alphabetic";
  for (let index = 0; index <= 4; index += 1) {
    const x = pad.left + plotW * index / 4;
    const time = firstTime + 10 * index / 4;
    context.fillStyle = "#7a8288";
    context.fillText(`${(time - lastTime).toFixed(1)}s`, x, h - 6);
  }
  if (!visible.length) return;
  context.strokeStyle = color;
  context.lineWidth = 1.7;
  context.lineJoin = "round";
  context.beginPath();
  visible.forEach((sample, index) => {
    const x = pad.left + (sample.time_s - firstTime) / 10 * plotW;
    const y = pad.top + (max - sample[key]) / (max - min) * plotH;
    if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
}

function renderQDriveCharts() {
  drawQDriveChart(elements.qdrive_current_chart, "current_a", "#287387", .1);
  drawQDriveChart(elements.qdrive_speed_chart, "speed_rpm", "#176a49", 10);
  drawQDriveChart(elements.qdrive_angle_chart, "angle_rad", "#a42e35", .1);
}

function downloadText(filename, text, type = "text/plain;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function confirmQDriveAction(title, description) {
  const dialog = elements.qdrive_confirm_dialog;
  elements.qdrive_confirm_title.textContent = title;
  elements.qdrive_confirm_description.textContent = description;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
  });
}

function k230IsArmed() {
  return latestTelemetry?.state === "ARMED";
}

function qdriveInterlocksReady() {
  return elements.qdrive_confirm_clear.checked && elements.qdrive_confirm_k230.checked &&
    elements.qdrive_confirm_limits.checked && !k230IsArmed() &&
    elements.qdrive_timeout_support.dataset.state === "supported" &&
    Number(elements.qdrive_timeout_input.value) > 0;
}

function updateQDriveControls() {
  const connected = Boolean(qdriveSession?.isConnected());
  const busy = qdriveConnectionBusy || qdriveActionBusy || qdriveDfuBusy;
  const directReady = connected && qdriveInterlocksReady() && !busy;
  const stopped = qdriveLastStatus?.enabled !== true;
  elements.qdrive_connect_button.textContent = connected ? "断开 QDrive" : "连接 QDrive Type-C";
  elements.qdrive_connect_button.disabled = busy || !("serial" in navigator);
  elements.qdrive_terminal_input.disabled = !connected || qdriveWaveActive || busy;
  elements.qdrive_terminal_send.disabled = !connected || qdriveWaveActive || busy;
  elements.qdrive_read_device.disabled = !connected || busy;
  elements.qdrive_read_status.disabled = !connected || busy;
  elements.qdrive_read_config.disabled = !connected || busy;
  elements.qdrive_wave_toggle.disabled = !connected || busy;
  elements.qdrive_wave_toggle.textContent = qdriveWaveActive ? "停止绘制" : "开始绘制";
  elements.qdrive_wave_export.disabled = qdriveSamples.length === 0;
  elements.qdrive_enable.disabled = !directReady || qdriveLastStatus?.enabled === true;
  elements.qdrive_disable.disabled = !connected || busy;
  elements.qdrive_ctrl_send.disabled = !directReady || qdriveLastStatus?.enabled !== true;
  const configAllowed = connected && stopped && !k230IsArmed() && !busy;
  elements.qdrive_apply_config.disabled = !configAllowed;
  document.querySelectorAll("[data-qdrive-config-key]").forEach((input) => {
    input.disabled = !configAllowed || (input.dataset.qdriveConfigKey === "timeout" &&
      elements.qdrive_timeout_support.dataset.state === "unsupported");
  });
  elements.qdrive_zero.disabled = !configAllowed;
  elements.qdrive_calibrate.disabled = !directReady || !stopped;
  elements.qdrive_store.disabled = !configAllowed;
  elements.qdrive_restore.disabled = !configAllowed;
  elements.qdrive_reboot.disabled = !connected || busy;
  elements.qdrive_upgrade.disabled = qdriveDfuBusy || qdriveActionBusy;
}

function numberText(value, digits, suffix) {
  return value === null || value === undefined || !Number.isFinite(value) ? `--${suffix}` : `${value.toFixed(digits)}${suffix}`;
}

function percentOnBeam(position) {
  return Math.max(0, Math.min(100, (position - currentConfig.left_cm) /
    (currentConfig.right_cm - currentConfig.left_cm) * 100));
}

function renderTelemetry(data) {
  latestTelemetry = data;
  elements.ball_position.textContent = numberText(data.ball_cm, 2, " cm");
  elements.target_position.textContent = numberText(data.target_cm, 1, " cm");
  elements.ball_velocity.textContent = numberText(data.ball_velocity_cm_s, 2, " cm/s");
  elements.beam_angle.textContent = numberText(data.beam_target_deg, 2, "°");
  elements.motor_angle.textContent = numberText(data.motor_angle_deg, 2, "°");
  elements.motor_current.textContent = numberText(data.motor_current_a, 3, " A");
  elements.target_marker.style.left = `${percentOnBeam(data.target_cm)}%`;
  if (data.ball_valid && data.ball_cm !== null) {
    elements.ball_marker.style.left = `${percentOnBeam(data.ball_cm)}%`;
    elements.ball_marker.dataset.visible = "true";
    setBadge(elements.tracking_badge, `${(data.vision_confidence * 100).toFixed(0)}%`, "ok");
  } else {
    elements.ball_marker.dataset.visible = "false";
    setBadge(elements.tracking_badge, "视觉丢失", "fault");
  }
  elements.control_mode.textContent = data.mode === "policy" ? "候选策略" : "基线控制";
  elements.vision_age.textContent = numberText(data.vision_age_ms, 0, " ms");
  elements.qdrive_age.textContent = numberText(data.qdrive_age_ms, 0, " ms");
  elements.motor_speed.textContent = numberText(data.motor_speed_rpm, 2, " rpm");
  elements.lease_age.textContent = numberText(data.lease_age_ms, 0, " ms");
  elements.fault_code.textContent = data.fault || "无";
  elements.vision_state.textContent = data.ball_valid ? "TRACKING" : "LOST";
  elements.state_value.textContent = data.state;
  const faulted = ["FAULT", "ESTOP"].includes(data.state);
  setBadge(elements.control_state_badge, data.state,
    faulted ? "fault" : data.state === "ARMED" ? "busy" : data.state === "READY" ? "ok" : "");
  elements.connection_state.dataset.state = faulted ? "fault" : "online";

  positionHistory.push({
    timestamp_ms: data.timestamp_ms,
    target_cm: data.target_cm,
    ball_cm: data.ball_valid ? data.ball_cm : null,
  });
  if (positionHistory.length > 300) positionHistory = positionHistory.slice(-300);
  if (episodeActive || data.episode !== null && data.episode !== undefined) {
    episodeSamples.push({ ...data });
    if (episodeSamples.length > 1000) episodeSamples = episodeSamples.slice(-1000);
    renderReport();
  }
  renderChart();
  updateControls();
}

function handleEvent(name, data) {
  logEvent(`${name} ${Object.keys(data).length ? JSON.stringify(data) : ""}`.trim());
  if (["episode_started"].includes(name)) {
    episodeActive = true;
    episodeSamples = [];
    setBadge(elements.episode_badge, `回合 ${data.episode}`, "busy");
  }
  if (["episode_complete", "episode_stopped"].includes(name)) {
    episodeActive = false;
    setBadge(elements.episode_badge, name === "episode_complete" ? "已完成" : "已停止", "ok");
    renderReport();
  }
  if (name === "fault" || name === "estop") {
    episodeActive = false;
    setBadge(elements.episode_badge, "安全中止", "fault");
    toast(data.code || "控制器已安全停止", "error");
  }
  if (name === "sequence_started") setBadge(elements.episode_badge, "验收轨迹", "busy");
  if (name === "sequence_complete") setBadge(elements.episode_badge, "轨迹完成", "ok");
  updateControls();
}

function renderChart() {
  const canvas = elements.position_chart;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.round(bounds.width * ratio);
  const height = Math.round(bounds.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const w = bounds.width;
  const h = bounds.height;
  context.clearRect(0, 0, w, h);
  context.fillStyle = "#f9fafa";
  context.fillRect(0, 0, w, h);
  const pad = { left: 42, right: 14, top: 14, bottom: 24 };
  const plotW = Math.max(1, w - pad.left - pad.right);
  const plotH = Math.max(1, h - pad.top - pad.bottom);
  context.font = "9px ui-monospace, monospace";
  context.textAlign = "right";
  context.textBaseline = "middle";
  for (const value of [-12, -6, 0, 6, 12]) {
    const y = pad.top + (12 - value) / 24 * plotH;
    context.strokeStyle = value === 0 ? "#b8bec2" : "#e1e5e7";
    context.lineWidth = 1;
    context.beginPath(); context.moveTo(pad.left, y); context.lineTo(w - pad.right, y); context.stroke();
    context.fillStyle = "#7a8288";
    context.fillText(String(value), pad.left - 7, y);
  }
  if (positionHistory.length > 1) {
    const drawSeries = (field, color) => {
      context.strokeStyle = color;
      context.lineWidth = 1.8;
      context.beginPath();
      let drawing = false;
      positionHistory.forEach((row, index) => {
        const value = row[field];
        if (value === null || !Number.isFinite(value)) { drawing = false; return; }
        const x = pad.left + index / Math.max(1, positionHistory.length - 1) * plotW;
        const y = pad.top + (12 - Math.max(-12, Math.min(12, value))) / 24 * plotH;
        if (!drawing) { context.moveTo(x, y); drawing = true; } else context.lineTo(x, y);
      });
      context.stroke();
    };
    drawSeries("target_cm", "#a42e35");
    drawSeries("ball_cm", "#287387");
  }
  elements.chart_window.textContent = `${positionHistory.length} samples`;
}

function renderReport() {
  const report = summarizeEpisode(episodeSamples);
  elements.export_episode_button.disabled = !episodeSamples.length;
  if (!report) {
    elements.report_samples.textContent = "--";
    elements.report_duration.textContent = "-- s";
    elements.report_mae.textContent = "-- cm";
    elements.report_max_error.textContent = "-- cm";
    elements.report_within.textContent = "--%";
    elements.report_current.textContent = "-- A";
    return;
  }
  elements.report_samples.textContent = String(report.samples);
  elements.report_duration.textContent = `${(report.duration_ms / 1000).toFixed(2)} s`;
  elements.report_mae.textContent = `${report.mean_abs_error_cm.toFixed(3)} cm`;
  elements.report_max_error.textContent = `${report.max_abs_error_cm.toFixed(3)} cm`;
  elements.report_within.textContent = `${(report.within_1cm_ratio * 100).toFixed(1)}%`;
  elements.report_current.textContent = `${report.max_current_a.toFixed(3)} A`;
}

function confirmationsReady() {
  return elements.confirm_limits.checked && elements.confirm_ground.checked && elements.confirm_clear.checked;
}

function updateControls() {
  const connected = Boolean(activeSession);
  const state = latestTelemetry?.state || "SAFE";
  const armed = state === "ARMED";
  const disarmed = !armed;
  const ready = state === "READY" && latestTelemetry?.ball_valid && latestTelemetry?.qdrive_online;
  elements.connect_button.textContent = connected ? "断开 K230" : "连接 K230";
  elements.connect_button.disabled = connectionBusy;
  elements.estop_button.disabled = !connected;
  elements.clear_fault_button.disabled = !connected || !["FAULT", "ESTOP"].includes(state);
  elements.arm_button.disabled = !connected || !ready || !confirmationsReady();
  elements.disarm_button.disabled = !connected || !armed;
  elements.send_target_button.disabled = !connected;
  elements.center_button.disabled = !connected;
  elements.sequence_button.disabled = !connected || !armed || episodeActive;
  elements.apply_vision_button.disabled = !connected || !disarmed;
  elements.apply_safety_button.disabled = !connected || !disarmed;
  elements.apply_policy_button.disabled = !connected || !disarmed;
  elements.start_episode_button.disabled = !connected || !armed || episodeActive;
  elements.stop_episode_button.disabled = !connected || !armed;
  if (armed) startHeartbeat(); else stopHeartbeat();
  updateQDriveControls();
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = window.setInterval(async () => {
    if (!activeSession || heartbeatBusy) return;
    heartbeatBusy = true;
    try { await activeSession.request("heartbeat", {}, 700); }
    catch (error) { logEvent(`heartbeat_error ${error.message}`); }
    finally { heartbeatBusy = false; }
  }, 200);
}

function stopHeartbeat() {
  window.clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  heartbeatBusy = false;
}

async function endSession(requestDisarm = true) {
  const session = activeSession;
  activeSession = null;
  stopHeartbeat();
  if (session) {
    if (requestDisarm) {
      try { await session.request("disarm", {}, 600); } catch { /* lease remains the fallback */ }
    }
    await session.close();
  }
  latestTelemetry = null;
  episodeActive = false;
  elements.connection_state.dataset.state = "offline";
  elements.connection_label.textContent = "未连接";
  elements.device_name.textContent = "等待连接";
  elements.firmware_version.textContent = "--";
  elements.vision_state.textContent = "--";
  elements.state_value.textContent = "离线";
  setBadge(elements.control_state_badge, "离线");
  elements.ball_marker.dataset.visible = "false";
  updateControls();
}

async function connectPort(port) {
  connectionBusy = true;
  elements.connection_state.dataset.state = "busy";
  elements.connection_label.textContent = "识别中";
  updateControls();
  const transport = new SerialTransport(port);
  try {
    const handoff = await requestSerialHandoff();
    if (!handoff.released) throw new ProtocolError("另一个产品页面正在执行不可中断任务");
    if (handoff.delayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, handoff.delayMs));
    await transport.open();
    transport.onTelemetry = renderTelemetry;
    transport.onEvent = handleEvent;
    transport.onUnexpectedClose = async (error) => {
      logEvent(`serial_closed ${error.message}`);
      if (activeSession === transport) await endSession(false);
      toast("K230 串口已断开，板端租约将触发失能", "error");
    };
    const identity = await transport.request("ping", {}, 1200);
    if (identity.protocol !== 1 || !Array.isArray(identity.capabilities) || identity.qdrive_id !== 0) {
      throw new ProtocolError("K230 滚球控制器身份或能力不匹配");
    }
    activeSession = transport;
    elements.device_name.textContent = "BBK230";
    elements.firmware_version.textContent = identity.firmware || "unknown";
    elements.connection_state.dataset.state = "online";
    elements.connection_label.textContent = "已连接";
    logEvent(`connected firmware=${identity.firmware} camera=${identity.camera}`);
    toast("K230 滚球控制器已连接");
  } catch (error) {
    await transport.close().catch(() => {});
    elements.connection_state.dataset.state = "offline";
    elements.connection_label.textContent = "连接失败";
    throw error;
  } finally {
    connectionBusy = false;
    updateControls();
  }
}

function inputNumber(element) {
  const value = Number(element.value);
  if (!Number.isFinite(value)) throw new ProtocolError(`${element.previousElementSibling?.textContent || "输入"}无效`);
  return value;
}

function readConfig() {
  return validateConfig({
    left_px: [inputNumber(elements.left_x), inputNumber(elements.left_y)],
    right_px: [inputNumber(elements.right_x), inputNumber(elements.right_y)],
    left_cm: -12,
    right_cm: 12,
    roi: [inputNumber(elements.roi_x), inputNumber(elements.roi_y), inputNumber(elements.roi_width), inputNumber(elements.roi_height)],
    kp: inputNumber(elements.gain_kp),
    ki: inputNumber(elements.gain_ki),
    kd: inputNumber(elements.gain_kd),
    control_sign: inputNumber(elements.control_sign),
    motor_min_deg: inputNumber(elements.motor_min),
    motor_neutral_deg: inputNumber(elements.motor_neutral),
    motor_max_deg: inputNumber(elements.motor_max),
    beam_min_deg: inputNumber(elements.beam_min),
    beam_max_deg: inputNumber(elements.beam_max),
    max_motor_step_deg: inputNumber(elements.motor_step),
    vision_timeout_ms: inputNumber(elements.vision_timeout),
    qdrive_timeout_ms: inputNumber(elements.qdrive_timeout),
    lease_timeout_ms: inputNumber(elements.lease_timeout),
    max_current_a: inputNumber(elements.max_current),
    max_ball_speed_cm_s: inputNumber(elements.max_ball_speed),
    integral_limit: inputNumber(elements.integral_limit),
  });
}

function readPolicy() {
  return validatePolicy({
    weights: [elements.policy_w0, elements.policy_w1, elements.policy_w2, elements.policy_w3].map(inputNumber),
    bias_deg: inputNumber(elements.policy_bias),
    max_residual_deg: inputNumber(elements.policy_limit),
  });
}

function populatePolicy(policy) {
  [elements.policy_w0, elements.policy_w1, elements.policy_w2, elements.policy_w3]
    .forEach((element, index) => { element.value = String(policy.weights[index]); });
  elements.policy_bias.value = String(policy.bias_deg);
  elements.policy_limit.value = String(policy.max_residual_deg);
}

async function runCommand(command, data, successMessage) {
  if (!activeSession) throw new ProtocolError("K230 未连接");
  const result = await activeSession.request(command, data);
  if (successMessage) toast(successMessage);
  return result;
}

async function applyConfig() {
  currentConfig = readConfig();
  await runCommand("set_config", { config: currentConfig }, "配置已写入 K230 RAM");
  logEvent("config_applied");
}

function stopQDriveWave(message = "") {
  qdriveWaveGeneration += 1;
  qdriveWaveActive = false;
  window.clearTimeout(qdriveWaveTimer);
  qdriveWaveTimer = null;
  if (message) toast(message);
  updateQDriveControls();
}

async function queryQDriveStatus(silent = false) {
  if (!qdriveSession) throw new ProtocolError("QDrive 未连接");
  const raw = await qdriveSession.captureUntilIdle(
    () => qdriveSession.sendLine("status"),
    24,
    700,
    { silent, isComplete: isCompleteQDriveStatus },
  );
  const status = parseQDriveStatus(raw);
  if (!status) throw new ProtocolError("QDrive status 输出无法解析");
  renderQDriveStatus(status);
  return status;
}

async function qdriveWavePoll(generation) {
  if (!qdriveWaveActive || generation !== qdriveWaveGeneration || !qdriveSession) return;
  const started = performance.now();
  try {
    const status = await queryQDriveStatus(true);
    const time = (performance.now() - qdriveWaveStart) / 1000;
    qdriveSamples.push({ time_s: time, ...status });
    if (qdriveSamples.length > 6000) qdriveSamples.splice(0, qdriveSamples.length - 6000);
    elements.qdrive_wave_export.disabled = false;
    window.requestAnimationFrame(renderQDriveCharts);
  } catch (error) {
    stopQDriveWave();
    toast(`QDrive 波形采集停止：${error.message}`, "error");
    return;
  }
  const frequency = Math.min(120, Math.max(30, Number(elements.qdrive_wave_frequency.value) || 30));
  const remaining = Math.max(0, 1000 / frequency - (performance.now() - started));
  qdriveWaveTimer = window.setTimeout(() => qdriveWavePoll(generation), remaining);
}

function startQDriveWave() {
  if (!qdriveSession) throw new ProtocolError("请先连接 QDrive");
  qdriveWaveActive = true;
  qdriveWaveGeneration += 1;
  const offset = qdriveSamples.at(-1)?.time_s ?? 0;
  qdriveWaveStart = performance.now() - offset * 1000;
  updateQDriveControls();
  qdriveWavePoll(qdriveWaveGeneration);
}

async function endQDriveSession(requestDisable = true) {
  const session = qdriveSession;
  qdriveSession = null;
  stopQDriveWave();
  if (session) {
    if (requestDisable && session.isConnected()) {
      try { await session.sendLine("disable"); await delay(80); } catch { /* USB removal remains safe */ }
    }
    await session.close().catch(() => {});
  }
  qdriveLastStatus = null;
  setBadge(elements.qdrive_connection_badge, "未连接");
  elements.qdrive_hardware.textContent = "--";
  elements.qdrive_software.textContent = "--";
  elements.qdrive_drive_state.textContent = "--";
  elements.qdrive_control_mode.textContent = "--";
  elements.qdrive_can_id_value.textContent = "--";
  elements.qdrive_voltage.textContent = "-- V";
  updateControls();
}

async function readQDriveDevice() {
  if (!qdriveSession) throw new ProtocolError("QDrive 未连接");
  const version = await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine("version"), 35, 1200);
  const info = await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine("info"), 35, 1200);
  const identity = parseQDriveIdentity(version, info);
  if (!identity) throw new ProtocolError("所选 Type-C 串口不是可识别的 QDrive LetterShell");
  elements.qdrive_hardware.textContent = identity.hardware;
  elements.qdrive_software.textContent = identity.software;
  return identity;
}

async function connectQDrivePort(port) {
  qdriveConnectionBusy = true;
  setBadge(elements.qdrive_connection_badge, "识别中", "busy");
  updateQDriveControls();
  const session = new QDriveSerialSession(port, {
    onChunk: appendQDriveTerminal,
    onReadError: (error) => logEvent(`qdrive_read_error ${error.message}`),
    onUnexpectedClose: async () => {
      if (qdriveSession === session) await endQDriveSession(false);
      toast("QDrive Type-C 已断开", "error");
    },
  });
  try {
    const handoff = await requestSerialHandoff();
    if (!handoff.released) throw new ProtocolError("另一个产品页面正在执行不可中断任务");
    if (handoff.delayMs > 0) await delay(handoff.delayMs);
    await session.open(Number(elements.qdrive_baud_rate.value) || 115200);
    await delay(20);
    await session.sendRaw(" \x7f");
    await delay(20);
    const version = await session.captureUntilIdle(() => session.sendLine("version"), 35, 1200);
    const info = await session.captureUntilIdle(() => session.sendLine("info"), 35, 1200);
    const identity = parseQDriveIdentity(version, info);
    if (!identity) throw new ProtocolError("所选 Type-C 串口不是 QDrive QD4310");
    qdriveSession = session;
    elements.qdrive_hardware.textContent = identity.hardware;
    elements.qdrive_software.textContent = identity.software;
    setBadge(elements.qdrive_connection_badge, "已连接", "ok");
    await queryQDriveStatus(false).catch((error) => appendQDriveTerminal(`\n[status] ${error.message}\n`));
    await readQDriveConfig().catch((error) => appendQDriveTerminal(`\n[config] ${error.message}\n`));
    toast("QDrive Type-C 已连接");
  } catch (error) {
    await session.close().catch(() => {});
    setBadge(elements.qdrive_connection_badge, "连接失败", "fault");
    throw error;
  } finally {
    qdriveConnectionBusy = false;
    updateControls();
  }
}

async function readQDriveConfig() {
  if (!qdriveSession) throw new ProtocolError("QDrive 未连接");
  const raw = await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine("config --list"), 35, 1500);
  const config = parseQDriveConfig(raw);
  if (!Object.keys(config).length) throw new ProtocolError("没有从 config --list 解析到参数");
  document.querySelectorAll("[data-qdrive-config-key]").forEach((input) => {
    const key = input.dataset.qdriveConfigKey;
    if (Object.hasOwn(config, key)) input.value = config[key] === null ? "" : String(config[key]);
  });
  const timeoutSupported = Object.hasOwn(config, "timeout");
  elements.qdrive_timeout_support.dataset.state = timeoutSupported ? "supported" : "unsupported";
  elements.qdrive_timeout_support.textContent = timeoutSupported ? "当前固件支持 timeout；直控要求 > 0 s" : "当前固件未列出 timeout，已禁止直控与写入";
  if (!timeoutSupported) elements.qdrive_timeout_input.value = "";
  updateQDriveControls();
  toast("QDrive 参数已读取");
  return config;
}

async function withQDriveAction(action) {
  if (qdriveActionBusy) throw new ProtocolError("QDrive 正在执行上一项操作");
  qdriveActionBusy = true;
  updateQDriveControls();
  try { return await action(); }
  finally { qdriveActionBusy = false; updateControls(); }
}

async function setQDriveConfig() {
  if (k230IsArmed()) throw new ProtocolError("K230 闭环已武装，禁止修改 QDrive 参数");
  if (qdriveLastStatus?.enabled === true) throw new ProtocolError("请先失能 QDrive 再修改参数");
  const commands = [];
  document.querySelectorAll("[data-qdrive-config-key]").forEach((input) => {
    if (input.disabled || input.value.trim() === "") return;
    commands.push(formatConfigCommand(input.dataset.qdriveConfigKey, input.value));
  });
  if (!commands.length) throw new ProtocolError("没有可写入的 QDrive 参数");
  await withQDriveAction(async () => {
    for (const command of commands) {
      await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine(command), 35, 1200);
      await delay(50);
    }
  });
  toast(`${commands.length} 项参数已设置到 QDrive RAM`);
}

async function enableQDrive() {
  if (!qdriveInterlocksReady()) throw new ProtocolError("直接控制的三项安全确认尚未完成");
  const confirmed = await confirmQDriveAction("使能 QDrive？", "Type-C 将直接取得 QD4310 控制权，K230 闭环必须保持失能。");
  if (!confirmed) return;
  await withQDriveAction(async () => {
    const raw = await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine("enable"), 50, 1800);
    if (/failed|calibrate first/i.test(raw)) throw new ProtocolError("QDrive 使能失败，需先完成校准");
    await queryQDriveStatus(false);
  });
}

async function disableQDrive() {
  stopQDriveWave();
  await withQDriveAction(async () => {
    await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine("disable"), 35, 1200);
    await queryQDriveStatus(false).catch(() => {});
  });
  toast("QDrive 已失能");
}

async function sendQDriveControl(mode = elements.qdrive_ctrl_mode.value, value = elements.qdrive_ctrl_value.value) {
  if (!qdriveInterlocksReady()) throw new ProtocolError("直接控制的三项安全确认尚未完成");
  if (qdriveLastStatus?.enabled !== true) throw new ProtocolError("请先使能 QDrive");
  const command = formatControlCommand(mode, value);
  await withQDriveAction(() => qdriveSession.captureUntilIdle(() => qdriveSession.sendLine(command), 35, 1200));
}

async function promptedQDriveCommand(command, options = {}) {
  const first = await qdriveSession.captureUntilIdle(
    () => qdriveSession.sendLine(command),
    options.initialIdleMs ?? 100,
    options.initialTimeoutMs ?? 2500,
  );
  if (!/(?:\(y\/n\)|re-calibrate\?)/i.test(first)) return first;
  return `${first}${await qdriveSession.captureUntilIdle(
    () => qdriveSession.sendLine("y"),
    options.confirmIdleMs ?? 250,
    options.confirmTimeoutMs ?? 8000,
    { isComplete: options.isComplete },
  )}`;
}

async function zeroQDrive() {
  const confirmed = await confirmQDriveAction("设置 QDrive 零点？", "当前位置将作为新的机械零位；QDrive 必须保持失能。");
  if (!confirmed) return;
  await withQDriveAction(() => qdriveSession.captureUntilIdle(() => qdriveSession.sendLine("config zero_pos"), 50, 1500));
  toast("QDrive 零点命令已执行");
}

async function calibrateQDrive() {
  if (!qdriveInterlocksReady()) throw new ProtocolError("校准前必须完成三项安全确认");
  const confirmed = await confirmQDriveAction("开始 QDrive 校准？", "校准会驱动电机运动。机构必须架空，且 K230 闭环保持失能。");
  if (!confirmed) return;
  await withQDriveAction(async () => {
    const first = await promptedQDriveCommand("calibrate", {
      confirmIdleMs: 30000,
      confirmTimeoutMs: 45000,
      isComplete: (raw) => /calibration (?:completed|failed)/i.test(stripAnsi(raw)),
    });
    if (/calibration started/i.test(first) && !/calibration (?:completed|failed)/i.test(first)) {
      await qdriveSession.captureUntilIdle(
        () => Promise.resolve(),
        30000,
        45000,
        { isComplete: (raw) => /calibration (?:completed|failed)/i.test(stripAnsi(raw)) },
      );
    }
    await queryQDriveStatus(false).catch(() => {});
  });
}

async function storeQDrive() {
  const confirmed = await confirmQDriveAction("存储 QDrive 参数？", "当前 RAM 参数将写入设备 Flash；QDrive 必须保持失能。");
  if (!confirmed) return;
  await withQDriveAction(() => promptedQDriveCommand("store"));
  toast("QDrive 存储流程已完成");
}

async function restoreQDrive() {
  const confirmed = await confirmQDriveAction("恢复 QDrive 默认值？", "该操作会覆盖当前 PID、限制、ID、timeout 与波特率配置。");
  if (!confirmed) return;
  await withQDriveAction(async () => {
    await promptedQDriveCommand("restore", { confirmIdleMs: 1200, confirmTimeoutMs: 5000 });
    await delay(1500);
    await readQDriveConfig().catch(() => {});
  });
}

async function rebootQDrive() {
  const confirmed = await confirmQDriveAction("重启 QDrive？", "Type-C 串口会断开，电机输出将停止。");
  if (!confirmed) return;
  await qdriveSession.sendLine("reboot");
  await delay(200);
  await endQDriveSession(false);
}

function openQDriveDfuDialog() {
  if (!navigator.usb) elements.qdrive_dfu_status.textContent = "当前浏览器不支持 WebUSB，请使用桌面版 Chrome 或 Edge";
  if (!elements.qdrive_dfu_dialog.open) elements.qdrive_dfu_dialog.showModal();
}

async function upgradeQDrive() {
  if (!qdriveSession) { openQDriveDfuDialog(); return; }
  const confirmed = await confirmQDriveAction("进入 QDrive 升级模式？", "设备会释放 Type-C 串口并重新枚举为 STM32 DFU。");
  if (!confirmed) return;
  await withQDriveAction(async () => {
    const raw = await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine("upgrade"), 120, 2500);
    if (!/\(y\/n\)/i.test(raw) || /unknown|not\s+found/i.test(raw)) {
      toast("当前固件不支持串口进入 DFU，已打开手动升级窗口", "error");
      openQDriveDfuDialog();
      return;
    }
    await qdriveSession.sendLine("y");
    await delay(250);
    await endQDriveSession(false);
    openQDriveDfuDialog();
  });
}

function updateQDriveControlMode() {
  const spec = QDRIVE_CONTROL_SPECS[elements.qdrive_ctrl_mode.value];
  elements.qdrive_ctrl_unit.textContent = spec.unit;
  elements.qdrive_ctrl_value.min = String(spec.min);
  elements.qdrive_ctrl_value.max = String(spec.max);
}

async function dispatchQDriveTerminal(line) {
  if (!qdriveSession) throw new ProtocolError("QDrive 未连接");
  const command = line.trim();
  if (!command) return;
  if (/^status\b/i.test(command)) { await queryQDriveStatus(false); return; }
  if (/^config\s+--list\b/i.test(command)) { await readQDriveConfig(); return; }
  if (/^enable\b/i.test(command)) { await enableQDrive(); return; }
  if (/^disable\b/i.test(command)) { await disableQDrive(); return; }
  const ctrl = /^ctrl\s+(current|speed|low_speed|angle|step_angle)(?:\s+|=)([-+\deE.]+)\s*$/i.exec(command);
  if (ctrl) { await sendQDriveControl(ctrl[1].toLowerCase(), ctrl[2]); return; }
  if (/^config\s+zero_pos\b/i.test(command)) { await zeroQDrive(); return; }
  const config = /^config\s+([\w.]+)(?:\s+|=)([-+\deE.]+)\s*$/i.exec(command);
  if (config) {
    if (k230IsArmed() || qdriveLastStatus?.enabled === true) throw new ProtocolError("请先失能 K230 闭环和 QDrive");
    const normalized = formatConfigCommand(config[1], config[2]);
    await withQDriveAction(() => qdriveSession.captureUntilIdle(() => qdriveSession.sendLine(normalized), 35, 1200));
    return;
  }
  if (/^calibrate\b/i.test(command)) { await calibrateQDrive(); return; }
  if (/^store\b/i.test(command)) { await storeQDrive(); return; }
  if (/^restore\b/i.test(command)) { await restoreQDrive(); return; }
  if (/^reboot\b/i.test(command)) { await rebootQDrive(); return; }
  if (/^upgrade\b/i.test(command)) { await upgradeQDrive(); return; }
  if (/^ctrl\b/i.test(command)) throw new ProtocolError("ctrl 命令格式或范围无效");
  if (/^silent\b/i.test(command)) {
    const confirmed = await confirmQDriveAction("关闭 QDrive Shell 输出？", "执行 silent 后，只有重启设备才能恢复终端与网页解析输出。");
    if (!confirmed) return;
  }
  await qdriveSession.captureUntilIdle(() => qdriveSession.sendLine(command), 50, 1500);
}

async function selectQDriveDfuFile() {
  const file = elements.qdrive_dfu_file.files?.[0];
  if (!file) return;
  const parsed = parseDfuSeFile(await file.arrayBuffer());
  qdriveDfuFile = { file, parsed };
  elements.qdrive_dfu_file_name.textContent = `${file.name} · ${file.size} bytes`;
  elements.qdrive_dfu_status.textContent = "DFU 文件已校验";
  elements.qdrive_dfu_start.disabled = !qdriveDfuDevice;
}

async function selectQDriveDfuDevice() {
  qdriveDfuDevice = await chooseQDriveDfuDevice();
  const { device, descriptors } = qdriveDfuDevice;
  elements.qdrive_dfu_device_name.textContent = `${device.productName || "STM32 DFU"} · ${descriptors.length} interface`;
  elements.qdrive_dfu_status.textContent = "DFU 设备已选择";
  elements.qdrive_dfu_start.disabled = !qdriveDfuFile;
}

async function startQDriveDfu() {
  if (!qdriveDfuFile || !qdriveDfuDevice) throw new ProtocolError("请先选择 .dfu 文件和 DFU 设备");
  qdriveDfuBusy = true;
  elements.qdrive_dfu_start.disabled = true;
  elements.qdrive_dfu_progress.value = 0;
  updateQDriveControls();
  try {
    await flashQDriveDfu(qdriveDfuDevice, qdriveDfuFile.parsed, (progress, status) => {
      elements.qdrive_dfu_progress.value = progress;
      elements.qdrive_dfu_status.textContent = `${status} · ${(progress * 100).toFixed(0)}%`;
    });
    elements.qdrive_dfu_status.textContent = "写入完成，等待设备重新枚举";
    qdriveDfuDevice = null;
  } finally {
    qdriveDfuBusy = false;
    elements.qdrive_dfu_start.disabled = !(qdriveDfuFile && qdriveDfuDevice);
    updateQDriveControls();
  }
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => {
      const active = item === tab;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".view").forEach((panel) => panel.classList.toggle(
      "is-active", panel.dataset.panel === tab.dataset.view));
    window.requestAnimationFrame(renderChart);
    window.requestAnimationFrame(renderQDriveCharts);
  }));

  elements.connect_button.addEventListener("click", async () => {
    try {
      if (activeSession) { await endSession(true); return; }
      await connectPort(await navigator.serial.requestPort());
    } catch (error) {
      if (error.name !== "NotFoundError") toast(serialConnectionMessage(error), "error");
    }
  });
  elements.estop_button.addEventListener("click", async () => {
    try { await runCommand("estop", {}, "急停已发送"); }
    catch (error) { toast(error.message, "error"); }
  });
  elements.clear_fault_button.addEventListener("click", async () => {
    try { await runCommand("clear_fault", {}, "锁存已清除"); }
    catch (error) { toast(error.message, "error"); }
  });
  elements.arm_button.addEventListener("click", async () => {
    try {
      await runCommand("arm", {
        mechanical_limits: elements.confirm_limits.checked,
        common_ground: elements.confirm_ground.checked,
        area_clear: elements.confirm_clear.checked,
      }, "闭环已使能");
    } catch (error) { toast(error.message, "error"); }
  });
  elements.disarm_button.addEventListener("click", async () => {
    try { await runCommand("disarm", {}, "QD4310 已失能"); }
    catch (error) { toast(error.message, "error"); }
  });
  [elements.confirm_limits, elements.confirm_ground, elements.confirm_clear]
    .forEach((element) => element.addEventListener("change", updateControls));
  elements.send_target_button.addEventListener("click", async () => {
    try {
      const target = inputNumber(elements.target_input);
      await runCommand("set_target", { target_cm: target }, `目标已设为 ${target.toFixed(1)} cm`);
    } catch (error) { toast(error.message, "error"); }
  });
  elements.center_button.addEventListener("click", async () => {
    elements.target_input.value = "0";
    try { await runCommand("set_target", { target_cm: 0 }, "目标已回到 O"); }
    catch (error) { toast(error.message, "error"); }
  });
  elements.sequence_button.addEventListener("click", async () => {
    try { await runCommand("start_sequence", {}, "验收轨迹已启动"); }
    catch (error) { toast(error.message, "error"); }
  });
  elements.apply_vision_button.addEventListener("click", () => applyConfig().catch((error) => toast(error.message, "error")));
  elements.apply_safety_button.addEventListener("click", () => applyConfig().catch((error) => toast(error.message, "error")));
  elements.apply_policy_button.addEventListener("click", async () => {
    try {
      currentPolicy = readPolicy();
      await runCommand("set_policy", { policy: currentPolicy }, "候选策略已写入 K230 RAM");
      logEvent("policy_applied");
    } catch (error) { toast(error.message, "error"); }
  });
  elements.policy_file.addEventListener("change", async () => {
    try {
      const file = elements.policy_file.files?.[0];
      if (!file) return;
      const raw = JSON.parse(await file.text());
      currentPolicy = validatePolicy(raw.policy || raw);
      populatePolicy(currentPolicy);
      toast("候选策略已载入表单");
    } catch (error) { toast(`策略文件无效：${error.message}`, "error"); }
    finally { elements.policy_file.value = ""; }
  });
  elements.start_episode_button.addEventListener("click", async () => {
    try {
      const duration = inputNumber(elements.episode_duration);
      const target = inputNumber(elements.episode_target);
      episodeSamples = [];
      renderReport();
      await runCommand("start_episode", {
        duration_s: duration,
        target_cm: target,
        mode: elements.episode_mode.value,
      }, "有限回合已开始");
    } catch (error) { toast(error.message, "error"); }
  });
  elements.stop_episode_button.addEventListener("click", async () => {
    try { await runCommand("stop_episode", {}, "回合已停止，QD4310 已失能"); }
    catch (error) { toast(error.message, "error"); }
  });
  elements.export_episode_button.addEventListener("click", () => {
    if (!episodeSamples.length) return;
    const blob = new Blob([episodeCsv(episodeSamples)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ballbeam-episode-${new Date().toISOString().replaceAll(":", "-")}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });
  elements.clear_log_button.addEventListener("click", () => {
    logLines = [];
    elements.event_log.textContent = "等待事件";
  });
  elements.qdrive_connect_button.addEventListener("click", async () => {
    try {
      if (qdriveSession) { await endQDriveSession(true); return; }
      await connectQDrivePort(await navigator.serial.requestPort());
    } catch (error) {
      if (error.name !== "NotFoundError") toast(serialConnectionMessage(error), "error");
    }
  });
  elements.qdrive_terminal_clear.addEventListener("click", () => {
    qdriveTerminalText = "";
    elements.qdrive_terminal_output.textContent = "等待 QDrive 输出";
  });
  elements.qdrive_terminal_form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const line = elements.qdrive_terminal_input.value;
    elements.qdrive_terminal_input.value = "";
    try { await dispatchQDriveTerminal(line); }
    catch (error) { toast(error.message, "error"); }
    elements.qdrive_terminal_input.focus();
  });
  elements.qdrive_read_device.addEventListener("click", () => withQDriveAction(readQDriveDevice)
    .then(() => toast("QDrive 设备信息已读取")).catch((error) => toast(error.message, "error")));
  elements.qdrive_read_status.addEventListener("click", () => withQDriveAction(() => queryQDriveStatus(false))
    .catch((error) => toast(error.message, "error")));
  elements.qdrive_read_config.addEventListener("click", () => withQDriveAction(readQDriveConfig)
    .catch((error) => toast(error.message, "error")));
  elements.qdrive_wave_toggle.addEventListener("click", () => {
    try { if (qdriveWaveActive) stopQDriveWave("QDrive 波形采集已停止"); else startQDriveWave(); }
    catch (error) { toast(error.message, "error"); }
  });
  elements.qdrive_wave_export.addEventListener("click", () => {
    if (!qdriveSamples.length) return;
    downloadText(`qdrive-waveform-${new Date().toISOString().replaceAll(":", "-")}.csv`,
      qdriveSamplesCsv(qdriveSamples), "text/csv;charset=utf-8");
  });
  elements.qdrive_ctrl_mode.addEventListener("change", updateQDriveControlMode);
  elements.qdrive_ctrl_send.addEventListener("click", () => sendQDriveControl().catch((error) => toast(error.message, "error")));
  elements.qdrive_enable.addEventListener("click", () => enableQDrive().catch((error) => toast(error.message, "error")));
  elements.qdrive_disable.addEventListener("click", () => disableQDrive().catch((error) => toast(error.message, "error")));
  [elements.qdrive_confirm_clear, elements.qdrive_confirm_k230, elements.qdrive_confirm_limits]
    .forEach((input) => input.addEventListener("change", updateQDriveControls));
  elements.qdrive_timeout_input.addEventListener("input", updateQDriveControls);
  elements.qdrive_apply_config.addEventListener("click", () => setQDriveConfig().catch((error) => toast(error.message, "error")));
  elements.qdrive_zero.addEventListener("click", () => zeroQDrive().catch((error) => toast(error.message, "error")));
  elements.qdrive_calibrate.addEventListener("click", () => calibrateQDrive().catch((error) => toast(error.message, "error")));
  elements.qdrive_store.addEventListener("click", () => storeQDrive().catch((error) => toast(error.message, "error")));
  elements.qdrive_restore.addEventListener("click", () => restoreQDrive().catch((error) => toast(error.message, "error")));
  elements.qdrive_reboot.addEventListener("click", () => rebootQDrive().catch((error) => toast(error.message, "error")));
  elements.qdrive_upgrade.addEventListener("click", () => upgradeQDrive().catch((error) => toast(error.message, "error")));
  elements.qdrive_dfu_file.addEventListener("change", () => selectQDriveDfuFile().catch((error) => {
    qdriveDfuFile = null;
    elements.qdrive_dfu_file_name.textContent = "文件无效";
    elements.qdrive_dfu_status.textContent = error.message;
    elements.qdrive_dfu_start.disabled = true;
  }));
  elements.qdrive_dfu_device.addEventListener("click", (event) => {
    event.preventDefault();
    selectQDriveDfuDevice().catch((error) => {
      qdriveDfuDevice = null;
      elements.qdrive_dfu_device_name.textContent = "设备选择失败";
      elements.qdrive_dfu_status.textContent = error.message;
      elements.qdrive_dfu_start.disabled = true;
    });
  });
  elements.qdrive_dfu_start.addEventListener("click", (event) => {
    event.preventDefault();
    startQDriveDfu().catch((error) => {
      elements.qdrive_dfu_status.textContent = `升级失败：${error.message}`;
      toast(error.message, "error");
    });
  });
  window.addEventListener("resize", () => { renderChart(); renderQDriveCharts(); });
  window.addEventListener("pagehide", () => {
    stopHeartbeat();
    stopQDriveWave();
    qdriveSession?.sendLine("disable").catch(() => {});
  });
}

function initialize() {
  const supported = "serial" in navigator;
  elements.support_banner.hidden = supported;
  elements.connect_button.disabled = !supported;
  populatePolicy(currentPolicy);
  bindEvents();
  renderReport();
  updateQDriveControlMode();
  updateControls();
  window.requestAnimationFrame(() => { renderChart(); renderQDriveCharts(); });
  registerSerialReleaseHandler(async () => {
    if (connectionBusy || qdriveConnectionBusy || qdriveActionBusy || qdriveDfuBusy) return false;
    if (activeSession) await endSession(true);
    if (qdriveSession) await endQDriveSession(true);
    return true;
  });
}

initialize();

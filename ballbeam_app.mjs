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
  window.addEventListener("resize", renderChart);
  window.addEventListener("beforeunload", stopHeartbeat);
}

function initialize() {
  const supported = "serial" in navigator;
  elements.support_banner.hidden = supported;
  elements.connect_button.disabled = !supported;
  populatePolicy(currentPolicy);
  bindEvents();
  renderReport();
  updateControls();
  window.requestAnimationFrame(renderChart);
  registerSerialReleaseHandler(async () => {
    if (connectionBusy) return false;
    if (activeSession) await endSession(true);
    return true;
  });
}

initialize();

export const AUTOTUNE_DUTIES_PERMILLE = Object.freeze([100, 150, 200]);
export const AUTOTUNE_MAX_DUTY_PERMILLE = 200;
export const AUTOTUNE_SAMPLE_PERIOD_MS = 50;
export const AUTOTUNE_KEEPALIVE_PERIOD_MS = 100;

export class MotorAutotuneError extends Error {}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function requireFinite(value, label) {
  if (!Number.isFinite(value)) throw new MotorAutotuneError(`${label}无效`);
  return value;
}

/** 检查整定期间的唯一运动通道和 20% 硬限幅。 */
export function assertSafeAutotuneStatus(status, selectedMotor) {
  if (!status || !Array.isArray(status.motors) || status.motors.length !== 4) {
    throw new MotorAutotuneError("设备状态格式无效");
  }
  status.motors.forEach((motor, index) => {
    if (Math.abs(motor.outputPermille) > AUTOTUNE_MAX_DUTY_PERMILLE) {
      throw new MotorAutotuneError(`电机 ${index} 输出超过 20% 安全限幅`);
    }
    if (index !== selectedMotor && (motor.enabled || motor.outputPermille !== 0)) {
      throw new MotorAutotuneError(`非标定通道 ${index} 意外启动`);
    }
  });
}

/** 把一次 GET_STATUS 结果转换成可导出的整定样本。 */
export function makeAutotuneSample(stage, stageMs, status, motorIndex) {
  const motor = status.motors[motorIndex];
  return Object.freeze({
    stage,
    stageMs: requireFinite(stageMs, "采样时间"),
    uptimeMs: status.uptimeMs,
    faults: status.faults,
    encoderCount: motor.encoderCount,
    speedMrpm: motor.speedMrpm,
    targetMrpm: motor.targetMrpm,
    outputPermille: motor.outputPermille,
    enabled: motor.enabled,
    mode: motor.mode,
    encoderErrors: motor.encoderErrors,
  });
}

/** 从阶跃尾段稳态值估计速度增益，并从 63.2% 上升点估计时间常数。 */
export function summarizeAutotuneStep(samples, dutyPermille) {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new MotorAutotuneError(`占空比 ${dutyPermille / 10}% 的样本不足`);
  }
  const finalTimeMs = samples.at(-1).stageMs;
  const tail = samples.filter((sample) => sample.stageMs >= finalTimeMs * 0.60);
  const signedSteadySpeedRpm = median(tail.map((sample) => sample.speedMrpm / 1000));
  const steadySpeedRpm = Math.abs(signedSteadySpeedRpm);
  const riseThreshold = steadySpeedRpm * 0.632;
  const riseSample = riseThreshold > 0
    ? samples.find((sample) => Math.abs(sample.speedMrpm / 1000) >= riseThreshold)
    : null;
  const motionThreshold = Math.max(0.8, steadySpeedRpm * 0.05);
  const motionSample = samples.find(
    (sample) => Math.abs(sample.speedMrpm / 1000) >= motionThreshold,
  );
  return Object.freeze({
    dutyPermille,
    steadySpeedRpm,
    signedSteadySpeedRpm,
    maxSpeedRpm: Math.max(...samples.map(
      (sample) => Math.abs(sample.speedMrpm / 1000),
    )),
    tauS: riseSample ? riseSample.stageMs / 1000 : 0,
    deadtimeS: motionSample ? motionSample.stageMs / 1000 : 0,
    encoderErrorDelta: (samples.at(-1).encoderErrors - samples[0].encoderErrors) >>> 0,
  });
}

function linearFit(points) {
  if (points.length < 2) {
    throw new MotorAutotuneError("至少需要两个产生运动的开环阶跃");
  }
  const meanX = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const variance = points.reduce((sum, point) => sum + (point[0] - meanX) ** 2, 0);
  if (variance <= 0) throw new MotorAutotuneError("阶跃占空比范围无效");
  const covariance = points.reduce(
    (sum, point) => sum + (point[0] - meanX) * (point[1] - meanY),
    0,
  );
  const slope = covariance / variance;
  return [slope, meanY - slope * meanX];
}

/** 复刻板端实测工具使用的保守一阶模型 PI 设计，并量化为 Q16。 */
export function designAutotunePi(stepSummaries) {
  const moving = stepSummaries.filter((summary) => summary.steadySpeedRpm >= 1.0);
  const [plantGain, plantIntercept] = linearFit(moving.map((summary) => [
    summary.dutyPermille,
    summary.steadySpeedRpm,
  ]));
  if (!Number.isFinite(plantGain) || plantGain <= 0) {
    throw new MotorAutotuneError("辨识得到的电机增益不是正数");
  }
  const tauS = median(moving.map((summary) => summary.tauS).filter((value) => value > 0)) || 0.15;
  const deadtimeS = median(
    moving.map((summary) => summary.deadtimeS).filter((value) => value > 0),
  );
  const desiredClosedLoopS = Math.max(0.25, 3 * tauS);
  const inverseGain = 1 / plantGain;
  const modelKc = tauS / (plantGain * (desiredClosedLoopS + deadtimeS));
  const kcPermillePerRpm = Math.min(
    5 * inverseGain,
    Math.max(0.75 * inverseGain, modelKc),
  );
  const kpQ16 = Math.max(1, Math.min(
    4096,
    Math.round((kcPermillePerRpm / 1000) * 65536),
  ));
  const integralTimeMs = Math.max(100, tauS * 1000);
  const kiQ16 = Math.max(1, Math.min(64, Math.round(kpQ16 / integralTimeMs)));
  return Object.freeze({
    plantGainRpmPerPermille: plantGain,
    plantInterceptRpm: plantIntercept,
    estimatedDeadzonePermille: Math.max(0, -plantIntercept / plantGain),
    tauS,
    deadtimeS,
    desiredClosedLoopS,
    kpQ16,
    kiQ16,
    kdQ16: 0,
    kp: kpQ16 / 65536,
    ki: kiQ16 / 65536,
  });
}

/** 使用稳态误差、超调、饱和、振荡和编码器错误共同验收闭环。 */
export function analyzeAutotuneClosedLoop(samples, targetRpm, maxDutyPermille = 200) {
  if (!Array.isArray(samples) || samples.length < 2 || targetRpm <= 0) {
    throw new MotorAutotuneError("闭环验收样本或目标无效");
  }
  const finalTimeMs = samples.at(-1).stageMs;
  const settled = samples.filter(
    (sample) => sample.stageMs >= Math.max(1000, finalTimeMs - 1500),
  );
  if (!settled.length) throw new MotorAutotuneError("闭环稳态样本不足");
  const speeds = settled.map((sample) => sample.speedMrpm / 1000);
  const errors = speeds.map((speed) => targetRpm - speed);
  const meanSpeedRpm = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length;
  const meanAbsErrorRpm = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const maxAbsErrorRpm = Math.max(...errors.map(Math.abs));
  const allSpeeds = samples.map((sample) => sample.speedMrpm / 1000);
  const overshootRatio = Math.max(0, (Math.max(...allSpeeds) - targetRpm) / targetRpm);
  const saturationCount = settled.filter(
    (sample) => Math.abs(sample.outputPermille) >= maxDutyPermille - 1,
  ).length;
  let oscillationCrossings = 0;
  let previousSign = 0;
  errors.forEach((error) => {
    const sign = error > 1 ? 1 : error < -1 ? -1 : 0;
    if (sign && previousSign && sign !== previousSign) oscillationCrossings += 1;
    if (sign) previousSign = sign;
  });
  const encoderErrorDelta = (
    samples.at(-1).encoderErrors - samples[0].encoderErrors
  ) >>> 0;
  const passed = meanSpeedRpm > 0 &&
    meanAbsErrorRpm <= Math.max(2, targetRpm * 0.10) &&
    overshootRatio <= 0.20 &&
    saturationCount <= settled.length * 0.25 &&
    oscillationCrossings <= 4 &&
    encoderErrorDelta === 0;
  return Object.freeze({
    targetRpm,
    meanSpeedRpm,
    meanAbsErrorRpm,
    maxAbsErrorRpm,
    overshootPercent: overshootRatio * 100,
    saturationCount,
    settledSampleCount: settled.length,
    oscillationCrossings,
    encoderErrorDelta,
    passed,
  });
}

export function chooseAutotuneTargetRpm(topOpenLoopRpm, maxSpeedMrpm) {
  const configuredMaximumRpm = maxSpeedMrpm / 1000;
  if (!Number.isFinite(configuredMaximumRpm) || configuredMaximumRpm < 10) {
    throw new MotorAutotuneError("本通道最大速度必须至少为 10 rpm");
  }
  return Math.min(30, configuredMaximumRpm, Math.max(10, topOpenLoopRpm * 0.45));
}

/** 保留当前编码器尺度，只临时收紧整定通道的输出和斜坡。 */
export function makeAutotuneCandidate(params, motorIndex) {
  if (!params?.motors?.[motorIndex]) throw new MotorAutotuneError("当前通道参数不存在");
  const candidate = typeof structuredClone === "function"
    ? structuredClone(params)
    : JSON.parse(JSON.stringify(params));
  const motor = candidate.motors[motorIndex];
  if (!Number.isInteger(motor.encoderCountsPerRev) || motor.encoderCountsPerRev < 1 ||
      !Number.isInteger(motor.gearRatioQ16) || motor.gearRatioQ16 < 1) {
    throw new MotorAutotuneError("请先填写有效的编码器计数和减速比");
  }
  motor.maxDutyPermille = AUTOTUNE_MAX_DUTY_PERMILLE;
  motor.accelMrpmPerTick = 100;
  return candidate;
}

/**
 * 从整定期临时参数生成最终运行参数。
 *
 * 20% 占空比和低斜坡仅用于架空辨识及闭环验收，不能覆盖用户原有的运行
 * 性能上限。PID 和编码器反馈方向等辨识结果保留在 candidate 中。
 */
export function makeAutotuneFinalParams(candidate, originalParams, motorIndex) {
  if (!candidate?.motors?.[motorIndex] || !originalParams?.motors?.[motorIndex]) {
    throw new MotorAutotuneError("自动整定参数不存在");
  }
  const finalParams = typeof structuredClone === "function"
    ? structuredClone(candidate)
    : JSON.parse(JSON.stringify(candidate));
  const originalMotor = originalParams.motors[motorIndex];
  if (!Number.isInteger(originalMotor.maxDutyPermille) ||
      originalMotor.maxDutyPermille < 1 || originalMotor.maxDutyPermille > 1000 ||
      !Number.isInteger(originalMotor.accelMrpmPerTick) ||
      originalMotor.accelMrpmPerTick < 1 || originalMotor.accelMrpmPerTick > 65535) {
    throw new MotorAutotuneError("原始运行限幅参数无效");
  }
  finalParams.motors[motorIndex].maxDutyPermille = originalMotor.maxDutyPermille;
  finalParams.motors[motorIndex].accelMrpmPerTick = originalMotor.accelMrpmPerTick;
  return finalParams;
}

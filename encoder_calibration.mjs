export const MAX_CALIBRATION_TURNS = 100;
export const MAX_EFFECTIVE_COUNTS_PER_REV = 1000000;

export class EncoderCalibrationError extends Error {}

/** 按 MCU 的 32 位累计计数语义求差，正确处理有符号显示跨界。 */
export function signedCounterDelta(start, current) {
  const delta = ((current >>> 0) - (start >>> 0)) >>> 0;
  return delta >= 0x80000000 ? delta - 0x100000000 : delta;
}

/** 错误计数是 uint32，同样允许从 0xFFFFFFFF 回绕到 0。 */
export function unsignedCounterDelta(start, current) {
  return ((current >>> 0) - (start >>> 0)) >>> 0;
}

/**
 * 根据手动转动的输出轴圈数计算等效每转计数。
 * 硬件没有 Z 相或输出轴绝对基准，因此结果只能确定 CPR 与减速比的乘积。
 */
export function calculateEncoderCalibration({
  startCount,
  currentCount,
  startErrors,
  currentErrors,
  turns,
}) {
  if (!Number.isInteger(turns) || turns < 1 || turns > MAX_CALIBRATION_TURNS) {
    throw new EncoderCalibrationError(`转动圈数必须是 1 至 ${MAX_CALIBRATION_TURNS} 的整数`);
  }

  const countDelta = signedCounterDelta(startCount, currentCount);
  const errorDelta = unsignedCounterDelta(startErrors, currentErrors);
  if (errorDelta !== 0) {
    throw new EncoderCalibrationError(`标定期间出现 ${errorDelta} 次正交跳变错误，请重新标定`);
  }
  if (countDelta === 0) {
    throw new EncoderCalibrationError("没有检测到编码器计数变化");
  }

  const absoluteCounts = Math.abs(countDelta);
  const effectiveCountsPerRev = Math.round(absoluteCounts / turns);
  if (effectiveCountsPerRev < 1 ||
      effectiveCountsPerRev > MAX_EFFECTIVE_COUNTS_PER_REV) {
    throw new EncoderCalibrationError(
      `等效每转计数必须在 1 至 ${MAX_EFFECTIVE_COUNTS_PER_REV} 之间`,
    );
  }

  return Object.freeze({
    turns,
    countDelta,
    errorDelta,
    absoluteCounts,
    effectiveCountsPerRev,
    residualCounts: absoluteCounts - effectiveCountsPerRev * turns,
    invertEncoder: countDelta < 0 ? 1 : 0,
    gearRatioQ16: 65536,
  });
}

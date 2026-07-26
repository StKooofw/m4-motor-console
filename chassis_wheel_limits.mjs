export const LEGACY_SAFE_LIMIT_MRPM = 120000;

export function resolveWheelLimits(limitInfo, mapping,
    fallbackMrpm = LEGACY_SAFE_LIMIT_MRPM) {
  const leftChannel = Number(mapping?.leftMotorChannel);
  const rightChannel = Number(mapping?.rightMotorChannel);
  if (!Number.isInteger(leftChannel) || !Number.isInteger(rightChannel) ||
      leftChannel < 0 || leftChannel > 3 || rightChannel < 0 ||
      rightChannel > 3 || leftChannel === rightChannel) {
    throw new RangeError("Invalid chassis motor channel mapping");
  }
  const synced = Boolean(limitInfo?.synced) &&
    Array.isArray(limitInfo?.limitsMrpm) && limitInfo.limitsMrpm.length === 4;
  const limits = synced ? limitInfo.limitsMrpm :
    [fallbackMrpm, fallbackMrpm, fallbackMrpm, fallbackMrpm];
  const leftMrpm = Number(limits[leftChannel]);
  const rightMrpm = Number(limits[rightChannel]);
  if (!Number.isInteger(leftMrpm) || leftMrpm <= 0 ||
      !Number.isInteger(rightMrpm) || rightMrpm <= 0) {
    throw new RangeError("Invalid motor speed limit");
  }
  return Object.freeze({ synced, leftChannel, rightChannel,
    leftMrpm, rightMrpm, leftRpm: leftMrpm / 1000,
    rightRpm: rightMrpm / 1000 });
}

export function wheelTargetsWithinLimits(leftMrpm, rightMrpm, limits) {
  return Number.isInteger(leftMrpm) && Number.isInteger(rightMrpm) &&
    Math.abs(leftMrpm) <= limits.leftMrpm &&
    Math.abs(rightMrpm) <= limits.rightMrpm;
}

export function applyWheelInputBounds(leftInput, rightInput, limitInfo,
    mapping) {
  const limits = resolveWheelLimits(limitInfo, mapping);
  for (const [input, rpm] of [
    [leftInput, limits.leftRpm], [rightInput, limits.rightRpm],
  ]) {
    const bound = String(Number(rpm.toFixed(3)));
    input.min = String(-Number(bound));
    input.max = bound;
    const current = Number(input.value);
    if (Number.isFinite(current)) {
      input.value = String(Math.max(-rpm, Math.min(rpm, current)));
    }
  }
  return limits;
}

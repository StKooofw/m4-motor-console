export const CONTROL_MODE_OPEN = "open";
export const CONTROL_MODE_SPEED = "speed";

/**
 * 将界面单位换算为固件协议单位并发送。目标命令本身会在固件侧使能该路，
 * 因此“发送目标”不应再依赖一个容易与状态轮询竞态的前置开关。
 */
export async function sendMotorTarget(session, motor, mode, displayValue) {
  const value = Number(displayValue);
  if (!Number.isFinite(value)) throw new TypeError("目标值无效");
  if (!Number.isInteger(motor) || motor < 0 || motor > 3) {
    throw new RangeError("电机通道无效");
  }
  if (mode === CONTROL_MODE_OPEN) {
    await session.setOpenLoop(motor, Math.round(value * 10));
    return;
  }
  if (mode === CONTROL_MODE_SPEED) {
    await session.setSpeed(motor, Math.round(value * 1000));
    return;
  }
  throw new RangeError("控制模式无效");
}

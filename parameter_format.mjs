const Q16_SCALE = 65536;

/** 六位小数足以让 32 位 Q16 原始值经网页输入框无损往返。 */
export function formatQ16ForInput(rawQ16) {
  if (!Number.isSafeInteger(rawQ16)) throw new TypeError("Q16 原始值无效");
  return (rawQ16 / Q16_SCALE).toFixed(6);
}

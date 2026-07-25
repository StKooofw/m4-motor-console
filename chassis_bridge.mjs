import { PROTOCOL_VERSION, ProtocolError } from "./protocol.mjs";

export const CHASSIS_PRODUCT_ID = 0x53414843;
export const CHASSIS_CAP_MOTOR_BRIDGE = 1 << 5;
export const CHASSIS_ENTER_MOTOR_BRIDGE = 0x31;

export function classifyPingPayload(payload) {
  if (!(payload instanceof Uint8Array)) {
    throw new TypeError("PING payload must be a Uint8Array");
  }
  if (payload.length === 4) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    return Object.freeze({ kind: "motor", version: view.getUint32(0, true) });
  }
  if (payload.length === 16) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const endpoint = {
      kind: "chassis",
      version: view.getUint32(0, true),
      productId: view.getUint32(4, true),
      capabilities: view.getUint32(8, true),
      protocolVersion: view.getUint32(12, true),
    };
    if (endpoint.productId !== CHASSIS_PRODUCT_ID) {
      throw new ProtocolError("16 字节 PING 身份不是灰度循迹底盘");
    }
    if (endpoint.protocolVersion !== PROTOCOL_VERSION) {
      throw new ProtocolError(`底盘协议版本 ${endpoint.protocolVersion} 不受支持`);
    }
    return Object.freeze(endpoint);
  }
  throw new ProtocolError(`PING 响应长度 ${payload.length} 无法识别`);
}

export async function resolveMotorEndpoint(
  initialTransport,
  pingCommand,
  createAttachedTransport,
  wait = async () => {},
) {
  const endpoint = classifyPingPayload(await initialTransport.request(pingCommand));
  if (endpoint.kind === "motor") {
    return Object.freeze({
      transport: initialTransport,
      version: endpoint.version,
      chassisVersion: null,
    });
  }
  if (!(endpoint.capabilities & CHASSIS_CAP_MOTOR_BRIDGE)) {
    throw new ProtocolError("底盘固件不支持电机串口透传，请先升级底盘固件");
  }

  await initialTransport.request(CHASSIS_ENTER_MOTOR_BRIDGE);
  await initialTransport.detach();
  await wait(30);
  const motorTransport = await createAttachedTransport();
  try {
    const motor = classifyPingPayload(
      await motorTransport.request(pingCommand, new Uint8Array(), 1200),
    );
    if (motor.kind !== "motor") {
      throw new ProtocolError("已进入透传，但没有识别到四路电机控制板");
    }
    return Object.freeze({
      transport: motorTransport,
      version: motor.version,
      chassisVersion: endpoint.version,
    });
  } catch (error) {
    await motorTransport.detach();
    throw error;
  }
}

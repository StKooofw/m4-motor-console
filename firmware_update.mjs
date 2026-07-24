import { crc32Msp } from "./protocol.mjs";

export const APP_MAGIC = 0x4d304150;
export const BOARD_ID = 0x4d344d43;
export const MIN_APP_VERSION = 0x00010000;
export const HEADER_VERSION = 1;
export const HEADER_SIZE = 0x100;
export const APP_HEADER_ADDRESS = 0x3000;
export const APP_VECTOR = 0x3100;
export const APP_END = 0x1f800;
export const FLASH_SECTOR_SIZE = 0x400;
export const BSL_PASSWORD_SIZE = 32;

const SRAM_START = 0x20200000;
const SRAM_END = 0x20208000;
const RELEASE_FLAG = 1;
const BSL_VERIFY_MIN_LENGTH = 1024;

const PACKET_HEADER = 0x80;
const RESPONSE_HEADER = 0x08;
const PI_ACK = 0x00;
const CMD_CONNECTION = 0x12;
const CMD_GET_IDENTITY = 0x19;
const CMD_UNLOCK = 0x21;
const CMD_RANGE_ERASE = 0x23;
const CMD_PROGRAM = 0x20;
const CMD_VERIFY = 0x26;
const CMD_START = 0x40;
const RSP_IDENTITY = 0x31;
const RSP_VERIFY = 0x32;
const RSP_MESSAGE = 0x3b;

const BSL_ERROR_NAMES = Object.freeze({
  0x01: "BSL 已锁定",
  0x02: "BSL 密码错误",
  0x03: "BSL 密码错误次数过多",
  0x04: "未知 BSL 命令",
  0x05: "Flash 地址范围无效",
  0x06: "BSL 命令参数无效",
  0x07: "Factory Reset 已禁用",
  0x08: "Factory Reset 密码错误",
  0x09: "Flash 回读已禁用",
  0x0a: "Flash 地址或长度未按要求对齐",
  0x0b: "CRC 校验长度无效",
  0xf1: "Flash 编程失败",
  0xf2: "整片擦除失败",
  0xf3: "Flash 扇区擦除失败",
  0xf4: "Factory Reset 失败",
});

export class ImageValidationError extends Error {}
export class BslError extends Error {}

function bytes(input) {
  return input instanceof Uint8Array ? input : new Uint8Array(input);
}

function hex(value, width = 8) {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, "0")}`;
}

function uint32InRange(value, start, end) {
  return value >= start && value <= end;
}

/**
 * 更新密钥只由用户在本机选择，网页源码和浏览器存储均不保存该密钥。
 */
export function validateBslPassword(input) {
  const password = bytes(input);
  if (password.length !== BSL_PASSWORD_SIZE) {
    throw new BslError(`更新密钥必须正好为 ${BSL_PASSWORD_SIZE} 字节`);
  }
  return password.slice();
}

/**
 * 在浏览器本地完整校验应用镜像，避免将错误板型或损坏文件交给 BSL。
 */
export function validateApplicationImage(input) {
  const data = bytes(input);
  if (data.length < HEADER_SIZE) throw new ImageValidationError("固件文件短于镜像头");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = {
    magic: view.getUint32(0, true),
    headerVersion: view.getUint16(4, true),
    headerSize: view.getUint16(6, true),
    imageVersion: view.getUint32(8, true),
    vectorAddress: view.getUint32(12, true),
    imageLength: view.getUint32(16, true),
    imageCrc32: view.getUint32(20, true),
    flags: view.getUint32(24, true),
    boardId: view.getUint32(28, true),
    headerCrc32: view.getUint32(252, true),
  };

  if (header.magic !== APP_MAGIC) throw new ImageValidationError("不是 M4 应用升级包");
  if (header.headerVersion !== HEADER_VERSION) throw new ImageValidationError("镜像头版本不受支持");
  if (header.headerSize !== HEADER_SIZE) throw new ImageValidationError("镜像头长度错误");
  if (header.boardId !== BOARD_ID) throw new ImageValidationError("固件不属于当前控制板");
  if (header.flags & ~RELEASE_FLAG) throw new ImageValidationError("镜像包含未知标志");
  if (header.imageVersion < MIN_APP_VERSION) throw new ImageValidationError("固件版本低于引导程序下限");
  if (header.vectorAddress !== APP_VECTOR) throw new ImageValidationError("应用向量地址错误");
  if (header.imageLength < 256 || header.imageLength % 8 !== 0) {
    throw new ImageValidationError("应用长度必须是非零的 8 字节倍数");
  }
  if (APP_VECTOR + header.imageLength > APP_END) {
    throw new ImageValidationError("应用镜像与参数存储区重叠");
  }
  if (data.length !== HEADER_SIZE + header.imageLength) {
    throw new ImageValidationError("文件长度与镜像头记录不一致");
  }
  if (data.length < BSL_VERIFY_MIN_LENGTH) {
    throw new ImageValidationError("升级包短于 TI BSL 最小校验长度");
  }
  if (crc32Msp(data.subarray(0, 252)) !== header.headerCrc32) {
    throw new ImageValidationError("镜像头 CRC 错误");
  }

  const image = data.subarray(HEADER_SIZE);
  if (crc32Msp(image) !== header.imageCrc32) {
    throw new ImageValidationError("应用代码 CRC 错误");
  }
  const imageView = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const initialSp = imageView.getUint32(0, true);
  const resetVector = imageView.getUint32(4, true);
  const resetAddress = resetVector & ~1;
  if (!uint32InRange(initialSp, SRAM_START, SRAM_END) || initialSp % 8 !== 0) {
    throw new ImageValidationError("初始栈指针超出 SRAM");
  }
  if (!(resetVector & 1) || resetAddress < APP_VECTOR ||
      resetAddress >= APP_VECTOR + header.imageLength) {
    throw new ImageValidationError("复位向量超出应用分区");
  }
  for (let offset = 8; offset < 256; offset += 4) {
    const vector = imageView.getUint32(offset, true);
    const address = vector & ~1;
    if (vector !== 0 && (!(vector & 1) || address < APP_VECTOR ||
        address >= APP_VECTOR + header.imageLength)) {
      throw new ImageValidationError(`中断向量 ${hex(offset, 2)} 超出应用分区`);
    }
  }
  return Object.freeze({ ...header, totalLength: data.length, initialSp, resetVector });
}

function makePayload(length, writer) {
  const output = new Uint8Array(length);
  writer(new DataView(output.buffer), output);
  return output;
}

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/**
 * TI 二级 BSL 客户端。transport 只需提供 write/readExact，便于浏览器和测试共用。
 */
export class TiUartBsl {
  constructor(transport, password, timeoutMs = 2500,
      sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.transport = transport;
    this.password = validateBslPassword(password);
    this.timeoutMs = timeoutMs;
    this.sleep = sleepFn;
    this.identity = null;
  }

  async readResponse() {
    const header = (await this.transport.readExact(1, this.timeoutMs))[0];
    if (header !== RESPONSE_HEADER) throw new BslError(`BSL 响应头错误：${hex(header, 2)}`);
    const lengthBytes = await this.transport.readExact(2, this.timeoutMs);
    const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 2).getUint16(0, true);
    const payload = await this.transport.readExact(length, this.timeoutMs);
    const crcBytes = await this.transport.readExact(4, this.timeoutMs);
    const receivedCrc = new DataView(crcBytes.buffer, crcBytes.byteOffset, 4).getUint32(0, true);
    if (crc32Msp(payload) !== receivedCrc) throw new BslError("BSL 响应 CRC 错误");
    return payload;
  }

  async send(payloadInput, expectResponse = true) {
    const payload = bytes(payloadInput);
    const packet = makePayload(3 + payload.length + 4, (view, output) => {
      output[0] = PACKET_HEADER;
      view.setUint16(1, payload.length, true);
      output.set(payload, 3);
      view.setUint32(3 + payload.length, crc32Msp(payload), true);
    });
    const written = await this.transport.write(packet);
    if (written != null && written !== packet.length) throw new BslError("串口写入不完整");
    const ack = (await this.transport.readExact(1, this.timeoutMs))[0];
    if (ack !== PI_ACK) throw new BslError(`BSL 拒绝数据包：${hex(ack, 2)}`);
    return expectResponse ? this.readResponse() : new Uint8Array();
  }

  checkMessage(payload) {
    if (payload.length !== 2 || payload[0] !== RSP_MESSAGE) throw new BslError("BSL 命令响应格式错误");
    if (payload[1] !== 0) throw new BslError(BSL_ERROR_NAMES[payload[1]] || `BSL 错误 ${hex(payload[1], 2)}`);
  }

  async connect(attempts = 20, retryDelayMs = 100) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if (typeof this.transport.clearInput === "function") this.transport.clearInput();
        await this.send(Uint8Array.of(CMD_CONNECTION), false);
        return;
      } catch (error) {
        lastError = error;
        await this.sleep(retryDelayMs);
      }
    }
    throw new BslError(`无法连接二级 BSL：${lastError?.message || "无响应"}`);
  }

  async getIdentity() {
    const payload = await this.send(Uint8Array.of(CMD_GET_IDENTITY));
    if (payload.length !== 25 || payload[0] !== RSP_IDENTITY) throw new BslError("BSL 身份响应格式错误");
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const identity = Object.freeze({
      commandInterpreterVersion: view.getUint16(1, true),
      buildId: view.getUint16(3, true),
      appRevision: view.getUint32(5, true),
      pluginVersion: view.getUint16(9, true),
      maxBufferSize: view.getUint16(11, true),
      ramStart: view.getUint32(13, true),
      bcrConfigId: view.getUint32(17, true),
      bslConfigId: view.getUint32(21, true),
    });
    if (identity.pluginVersion !== 0x1331 || identity.bcrConfigId !== 1 || identity.bslConfigId !== 1) {
      throw new BslError("目标二级 BSL 配置与本控制板不匹配");
    }
    this.identity = identity;
    return identity;
  }

  async unlock() {
    this.checkMessage(await this.send(concat(Uint8Array.of(CMD_UNLOCK), this.password)));
  }

  async rangeErase(start, endSector) {
    const payload = makePayload(9, (view, output) => {
      output[0] = CMD_RANGE_ERASE;
      view.setUint32(1, start, true);
      view.setUint32(5, endSector, true);
    });
    this.checkMessage(await this.send(payload));
  }

  async program(address, dataInput) {
    const data = bytes(dataInput);
    if (!data.length || address % 8 !== 0 || data.length % 8 !== 0) {
      throw new BslError("Flash 写入地址和长度必须按 8 字节对齐");
    }
    const prefix = makePayload(5, (view, output) => {
      output[0] = CMD_PROGRAM;
      view.setUint32(1, address, true);
    });
    this.checkMessage(await this.send(concat(prefix, data)));
  }

  async verifyCrc(address, length) {
    const payload = makePayload(9, (view, output) => {
      output[0] = CMD_VERIFY;
      view.setUint32(1, address, true);
      view.setUint32(5, length, true);
    });
    const response = await this.send(payload);
    if (response.length !== 5 || response[0] !== RSP_VERIFY) throw new BslError("BSL 校验响应格式错误");
    return new DataView(response.buffer, response.byteOffset, response.byteLength).getUint32(1, true);
  }

  async startApplication() {
    await this.send(Uint8Array.of(CMD_START), false);
  }

  /**
   * 先写应用代码、最后写提交头；掉电时不会留下可启动的半成品镜像。
   */
  async upload(imageInput, { start = true, onProgress = null } = {}) {
    const image = bytes(imageInput);
    const header = validateApplicationImage(image);
    onProgress?.({ phase: "connect", written: 0, total: image.length });
    await this.connect();
    const identity = await this.getIdentity();
    await this.unlock();
    const endSector = (APP_HEADER_ADDRESS + image.length - 1) & ~(FLASH_SECTOR_SIZE - 1);
    onProgress?.({ phase: "erase", written: 0, total: image.length });
    await this.rangeErase(APP_HEADER_ADDRESS, endSector);

    const maxData = Math.min(256, (identity.maxBufferSize - 12) & ~7);
    if (maxData < 8) throw new BslError("二级 BSL 缓冲区过小");
    const code = image.subarray(HEADER_SIZE);
    let written = 0;
    onProgress?.({ phase: "program", written, total: image.length });
    for (let offset = 0; offset < code.length; offset += maxData) {
      const block = code.subarray(offset, offset + maxData);
      await this.program(APP_VECTOR + offset, block);
      written += block.length;
      onProgress?.({ phase: "program", written, total: image.length });
    }
    for (let offset = 0; offset < HEADER_SIZE; offset += maxData) {
      const block = image.subarray(offset, offset + maxData);
      await this.program(APP_HEADER_ADDRESS + offset, block);
      written += block.length;
      onProgress?.({ phase: "commit", written, total: image.length });
    }

    const expectedCrc = crc32Msp(image);
    const actualCrc = await this.verifyCrc(APP_HEADER_ADDRESS, image.length);
    if (actualCrc !== expectedCrc) {
      throw new BslError(`目标 CRC ${hex(actualCrc)} 与文件 CRC ${hex(expectedCrc)} 不一致`);
    }
    onProgress?.({ phase: "verify", written, total: image.length });
    if (start) await this.startApplication();
    return { identity, header, expectedCrc };
  }
}

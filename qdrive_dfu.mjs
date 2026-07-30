const DFU_REQUEST = Object.freeze({
  DNLOAD: 1,
  GETSTATUS: 3,
  CLRSTATUS: 4,
  GETSTATE: 5,
  ABORT: 6,
});

const DFU_STATE = Object.freeze({
  IDLE: 2,
  DNLOAD_BUSY: 4,
  DNLOAD_IDLE: 5,
  MANIFEST: 7,
  MANIFEST_WAIT_RESET: 8,
  ERROR: 10,
});

const DFUSE_COMMAND = Object.freeze({ SET_ADDRESS: 0x21, ERASE_SECTOR: 0x41 });

function ascii(bytes, start, length) {
  return new TextDecoder().decode(bytes.subarray(start, start + length));
}

export function parseDfuSuffix(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 16) {
    throw new Error("DFU 文件缺少 16 字节 suffix");
  }
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const offset = buffer.byteLength - 16;
  if (ascii(bytes, offset + 8, 3) !== "UFD" || view.getUint8(offset + 11) !== 16) {
    throw new Error("DFU 文件 suffix 无效");
  }
  return {
    device: view.getUint16(offset, true),
    product: view.getUint16(offset + 2, true),
    vendor: view.getUint16(offset + 4, true),
    dfu: view.getUint16(offset + 6, true),
  };
}

export function parseDfuSeFile(buffer) {
  const suffix = parseDfuSuffix(buffer);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (ascii(bytes, 0, 5) !== "DfuSe" || view.getUint8(5) !== 1) {
    throw new Error("只支持 STM32 DfuSe .dfu 文件");
  }
  const imageSize = view.getUint32(6, true);
  const targetCount = view.getUint8(10);
  if (targetCount < 1 || imageSize > buffer.byteLength) throw new Error("DfuSe 文件头长度无效");
  let offset = 11;
  const targets = [];
  for (let index = 0; index < targetCount; index += 1) {
    if (offset + 274 > buffer.byteLength || ascii(bytes, offset, 6) !== "Target") {
      throw new Error("DfuSe Target 前缀无效");
    }
    const alternate = view.getUint8(offset + 6);
    const named = view.getUint32(offset + 7, true) !== 0;
    const name = named ? ascii(bytes, offset + 11, 255).replace(/\0.*$/s, "").trim() : "";
    const targetSize = view.getUint32(offset + 266, true);
    const elementCount = view.getUint32(offset + 270, true);
    offset += 274;
    const targetEnd = offset + targetSize;
    if (targetEnd > buffer.byteLength - 16) throw new Error("DfuSe Target 数据不完整");
    const elements = [];
    for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
      if (offset + 8 > targetEnd) throw new Error("DfuSe element 头无效");
      const address = view.getUint32(offset, true);
      const size = view.getUint32(offset + 4, true);
      offset += 8;
      if (offset + size > targetEnd) throw new Error("DfuSe element 长度无效");
      elements.push({ address, data: buffer.slice(offset, offset + size) });
      offset += size;
    }
    if (offset !== targetEnd) throw new Error("DfuSe Target 长度不匹配");
    targets.push({ alternate, name, elements });
  }
  if (!targets.some((target) => target.elements.length)) throw new Error("DFU 文件没有可写入数据");
  return { suffix, targets };
}

export function parseDfuMemoryMap(name) {
  const match = /\/(0x[0-9a-f]+)\/(.+)$/i.exec(String(name));
  if (!match) return [];
  let address = Number.parseInt(match[1], 16);
  const sectors = [];
  const multipliers = { B: 1, K: 1024, M: 1024 * 1024 };
  for (const group of match[2].split(",")) {
    const part = /^(\d+)\*(\d+)([BKM]?)([a-g])$/i.exec(group.trim());
    if (!part) continue;
    const count = Number(part[1]);
    const size = Number(part[2]) * (multipliers[part[3].toUpperCase()] || 1);
    const flags = part[4].toLowerCase().charCodeAt(0) - 96;
    for (let index = 0; index < count; index += 1) {
      sectors.push({
        start: address,
        end: address + size,
        size,
        erasable: Boolean(flags & 0x2),
        writable: Boolean(flags & 0x4),
      });
      address += size;
    }
  }
  return sectors;
}

function sleep(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function percentHex(value) {
  return `0x${Number(value).toString(16).padStart(4, "0").toUpperCase()}`;
}

function descriptorKey(configurationValue, interfaceNumber, alternateSetting) {
  return `${configurationValue}:${interfaceNumber}:${alternateSetting}`;
}

async function readDfuDescriptorMetadata(device) {
  const openedHere = !device.opened;
  const metadata = new Map();
  async function descriptor(value, index, length) {
    const result = await device.controlTransferIn({
      requestType: "standard",
      recipient: "device",
      request: 6,
      value,
      index,
    }, length);
    if (result.status !== "ok" || !result.data) throw new Error(`USB 描述符读取失败：${result.status}`);
    return result.data;
  }
  try {
    if (openedHere) await device.open();
    for (let configIndex = 0; configIndex < (device.configurations?.length || 0); configIndex += 1) {
      const prefix = await descriptor(0x0200 | configIndex, 0, 4);
      const full = await descriptor(0x0200 | configIndex, 0, prefix.getUint16(2, true));
      const configurationValue = full.getUint8(5);
      let activeKey = null;
      for (let offset = full.getUint8(0); offset + 2 <= full.byteLength;) {
        const length = full.getUint8(offset);
        const type = full.getUint8(offset + 1);
        if (length < 2 || offset + length > full.byteLength) break;
        if (type === 4 && length >= 9 && full.getUint8(offset + 5) === 0xfe &&
            full.getUint8(offset + 6) === 1 && full.getUint8(offset + 7) === 2) {
          activeKey = descriptorKey(configurationValue, full.getUint8(offset + 2), full.getUint8(offset + 3));
          metadata.set(activeKey, { stringIndex: full.getUint8(offset + 8), transferSize: 1024 });
        } else if (type === 0x21 && activeKey && length >= 9) {
          metadata.get(activeKey).transferSize = full.getUint16(offset + 5, true) || 1024;
        }
        offset += length;
      }
    }
    for (const item of metadata.values()) {
      item.name = "";
      if (!item.stringIndex) continue;
      try {
        const header = await descriptor(0x0300 | item.stringIndex, 0x0409, 2);
        const string = await descriptor(0x0300 | item.stringIndex, 0x0409, header.getUint8(0));
        const codes = [];
        for (let offset = 2; offset + 1 < string.byteLength; offset += 2) codes.push(string.getUint16(offset, true));
        item.name = String.fromCharCode(...codes);
      } catch { /* interfaceName remains a fallback */ }
    }
    return metadata;
  } finally {
    if (openedHere && device.opened) await device.close();
  }
}

function interfaceDescriptors(device, metadata = new Map()) {
  const result = [];
  for (const configuration of device.configurations || []) {
    for (const iface of configuration.interfaces || []) {
      for (const alternate of iface.alternates || []) {
        if (alternate.interfaceClass !== 0xfe || alternate.interfaceSubclass !== 1 || alternate.interfaceProtocol !== 2) continue;
        const extra = metadata.get(descriptorKey(
          configuration.configurationValue,
          iface.interfaceNumber,
          alternate.alternateSetting,
        ));
        result.push({
          configurationValue: configuration.configurationValue,
          interfaceNumber: iface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          name: extra?.name || alternate.interfaceName || "",
          transferSize: extra?.transferSize || 1024,
        });
      }
    }
  }
  return result;
}

class DfuSeDevice {
  constructor(device, descriptor) {
    this.device = device;
    this.descriptor = descriptor;
    this.erased = new Set();
  }

  get interfaceNumber() { return this.descriptor.interfaceNumber; }

  async open() {
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration || this.device.configuration.configurationValue !== this.descriptor.configurationValue) {
      await this.device.selectConfiguration(this.descriptor.configurationValue);
    }
    await this.device.claimInterface(this.interfaceNumber);
    await this.device.selectAlternateInterface(this.interfaceNumber, this.descriptor.alternateSetting);
  }

  async close() {
    try { await this.device.releaseInterface(this.interfaceNumber); } catch { /* device may reset */ }
    try { if (this.device.opened) await this.device.close(); } catch { /* device may reset */ }
  }

  async controlOut(request, value = 0, data) {
    const result = await this.device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request,
      value,
      index: this.interfaceNumber,
    }, data);
    if (result.status !== "ok") throw new Error(`DFU USB 写入失败：${result.status}`);
  }

  async status() {
    const result = await this.device.controlTransferIn({
      requestType: "class",
      recipient: "interface",
      request: DFU_REQUEST.GETSTATUS,
      value: 0,
      index: this.interfaceNumber,
    }, 6);
    if (result.status !== "ok" || !result.data) throw new Error(`DFU 状态读取失败：${result.status}`);
    return {
      status: result.data.getUint8(0),
      timeout: result.data.getUint32(1, true) & 0x00ffffff,
      state: result.data.getUint8(4),
    };
  }

  async pollUntil(predicate) {
    let state = await this.status();
    for (let attempts = 0; attempts < 500 && !predicate(state); attempts += 1) {
      if (state.state === DFU_STATE.ERROR) throw new Error(`DFU 设备报告错误状态 ${state.status}`);
      await sleep(Math.max(1, state.timeout));
      state = await this.status();
    }
    if (!predicate(state)) throw new Error("DFU 状态等待超时");
    return state;
  }

  async prepare() {
    const stateResult = await this.device.controlTransferIn({
      requestType: "class",
      recipient: "interface",
      request: DFU_REQUEST.GETSTATE,
      value: 0,
      index: this.interfaceNumber,
    }, 1);
    let state = stateResult.data?.getUint8(0) ?? DFU_STATE.IDLE;
    if (state === DFU_STATE.ERROR) {
      await this.controlOut(DFU_REQUEST.CLRSTATUS);
      state = (await this.status()).state;
    }
    if (state === DFU_STATE.MANIFEST_WAIT_RESET) throw new Error("DFU 设备等待复位，请重新进入升级模式");
    if (state !== DFU_STATE.IDLE) {
      await this.controlOut(DFU_REQUEST.ABORT);
      await this.pollUntil((next) => next.state === DFU_STATE.IDLE);
    }
  }

  async command(command, address) {
    const data = new Uint8Array(5);
    data[0] = command;
    new DataView(data.buffer).setUint32(1, address, true);
    await this.controlOut(DFU_REQUEST.DNLOAD, 0, data);
    const state = await this.pollUntil((next) => next.state !== DFU_STATE.DNLOAD_BUSY);
    if (state.status !== 0 || state.state !== DFU_STATE.DNLOAD_IDLE) throw new Error("DfuSe 命令执行失败");
  }

  sectorAt(sectors, address) {
    return sectors.find((sector) => sector.start <= address && address < sector.end);
  }

  async erase(sectors, address, length, progress) {
    const end = address + length;
    let cursor = address;
    while (cursor < end) {
      const sector = this.sectorAt(sectors, cursor);
      if (!sector?.erasable || !sector.writable) throw new Error(`地址 0x${cursor.toString(16)} 不可擦写`);
      if (!this.erased.has(sector.start)) {
        await this.command(DFUSE_COMMAND.ERASE_SECTOR, sector.start);
        this.erased.add(sector.start);
      }
      cursor = sector.end;
      progress(Math.min(length, cursor - address), length, "正在擦除 Flash");
    }
  }

  async writeElement(element, progress) {
    const sectors = parseDfuMemoryMap(this.descriptor.name);
    if (!sectors.length) throw new Error("DFU 设备没有公布可验证的 Flash 内存映射");
    const totalSize = element.data.byteLength;
    await this.erase(sectors, element.address, totalSize, (done, size, stage) => {
      progress(done / Math.max(1, size) * totalSize * .25, totalSize, stage);
    });
    await this.command(DFUSE_COMMAND.SET_ADDRESS, element.address);
    const bytes = new Uint8Array(element.data);
    let offset = 0;
    let block = 2;
    while (offset < bytes.length) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + this.descriptor.transferSize));
      await this.controlOut(DFU_REQUEST.DNLOAD, block, chunk);
      const state = await this.pollUntil((next) => next.state !== DFU_STATE.DNLOAD_BUSY);
      if (state.status !== 0 || state.state !== DFU_STATE.DNLOAD_IDLE) throw new Error(`DFU 数据块 ${block} 写入失败`);
      offset += chunk.byteLength;
      block += 1;
      progress(totalSize * .25 + offset / Math.max(1, bytes.length) * totalSize * .75,
        totalSize, "正在写入固件");
    }
  }

  async manifest() {
    try {
      await this.controlOut(DFU_REQUEST.DNLOAD, 0, new Uint8Array());
      await this.pollUntil((next) => [DFU_STATE.IDLE, DFU_STATE.MANIFEST, DFU_STATE.MANIFEST_WAIT_RESET].includes(next.state));
    } catch (error) {
      if (this.device.opened) throw error;
    }
  }
}

export async function chooseQDriveDfuDevice(usb = navigator.usb) {
  if (!usb) throw new Error("当前浏览器不支持 WebUSB");
  const device = await usb.requestDevice({ filters: [{ vendorId: 0x0483 }] });
  const metadata = await readDfuDescriptorMetadata(device);
  const descriptors = interfaceDescriptors(device, metadata);
  if (!descriptors.length) throw new Error("所选 USB 设备未处于 STM32 DFU 模式");
  return { device, descriptors };
}

export async function flashQDriveDfu(deviceSelection, parsedFile, onProgress = () => {}) {
  const { device, descriptors } = deviceSelection;
  const { vendor, product } = parsedFile.suffix;
  if (vendor !== 0xffff && vendor !== device.vendorId) {
    throw new Error(`固件 VID ${percentHex(vendor)} 与设备 ${percentHex(device.vendorId)} 不匹配`);
  }
  if (product !== 0xffff && product !== device.productId) {
    throw new Error(`固件 PID ${percentHex(product)} 与设备 ${percentHex(device.productId)} 不匹配`);
  }
  const total = parsedFile.targets.reduce((sum, target) =>
    sum + target.elements.reduce((targetSum, element) => targetSum + element.data.byteLength, 0), 0);
  let completed = 0;
  let active = null;
  try {
    for (let targetIndex = 0; targetIndex < parsedFile.targets.length; targetIndex += 1) {
      const target = parsedFile.targets[targetIndex];
      const descriptor = descriptors.find((item) => item.alternateSetting === target.alternate);
      if (!descriptor) throw new Error(`设备缺少 DFU alternate ${target.alternate}`);
      active = new DfuSeDevice(device, descriptor);
      await active.open();
      await active.prepare();
      for (const element of target.elements) {
        await active.writeElement(element, (done, size, stage) => {
          onProgress(Math.min(1, (completed + done) / total), stage);
        });
        completed += element.data.byteLength;
      }
      if (targetIndex === parsedFile.targets.length - 1) {
        await active.manifest();
        onProgress(1, "固件写入完成，设备正在复位");
      }
      await active.close().catch(() => {});
      active = null;
    }
  } finally {
    await active?.close().catch(() => {});
    try { if (device.opened) await device.close(); } catch { /* reset may disconnect */ }
  }
}

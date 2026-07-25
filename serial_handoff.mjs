const CHANNEL_NAME = "m4-console-serial-handoff-v1";
const pageId = globalThis.crypto?.randomUUID?.() ||
  `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const channel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel(CHANNEL_NAME)
  : null;
channel?.unref?.();
let releaseHandler = null;
const pendingRequests = new Map();

if (channel) {
  channel.addEventListener("message", async ({ data }) => {
    if (!data || data.pageId === pageId) return;
    if (data.type === "release-request" && releaseHandler) {
      let released = false;
      let delayMs = 0;
      try {
        const result = await releaseHandler();
        released = result !== false && result?.released !== false;
        delayMs = Number(result?.delayMs) || 0;
      } catch { released = false; }
      channel.postMessage({
        type: "release-result",
        pageId,
        requestId: data.requestId,
        released,
        delayMs,
      });
    } else if (data.type === "release-result") {
      pendingRequests.get(data.requestId)?.({
        released: Boolean(data.released),
        delayMs: Number(data.delayMs) || 0,
      });
    }
  });
}

export function registerSerialReleaseHandler(handler) {
  releaseHandler = handler;
}

export async function requestSerialHandoff(timeoutMs = 450) {
  if (!channel) return { released: true, delayMs: 0 };
  const requestId = `${pageId}-${Date.now()}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      pendingRequests.delete(requestId);
      resolve(result);
    };
    pendingRequests.set(requestId, finish);
    channel.postMessage({ type: "release-request", pageId, requestId });
    globalThis.setTimeout(() => finish({ released: true, delayMs: 0 }), timeoutMs);
  });
}

export function isSerialPortAlreadyOpen(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.name === "InvalidStateError" || message.includes("already open");
}

export function serialConnectionMessage(error) {
  if (isSerialPortAlreadyOpen(error)) {
    return "所选串口正被另一个页面占用，请在底盘上位机点击“断开底盘”或关闭旧标签页后重试";
  }
  return error?.message || String(error);
}

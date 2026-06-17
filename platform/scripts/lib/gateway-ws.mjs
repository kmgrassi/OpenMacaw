export function waitForSocketOpen(
  ws,
  {
    timeoutMs,
    timeoutMessage = "gateway websocket open timed out",
    errorMessage = "gateway websocket failed to connect",
    closeMessage = (event) =>
      `gateway websocket closed before open (${event.code}) ${event.reason}`,
  },
) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(new Error(errorMessage));
    };

    const onClose = (event) => {
      cleanup();
      reject(new Error(closeMessage(event)));
    };

    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
    ws.addEventListener("close", onClose, { once: true });
  });
}

export function waitForGatewayHello({
  ws,
  requestId,
  timeoutMs,
  parseFrame,
  onFrame,
  timeoutMessage = "gateway connect timed out",
  closeMessage = (event) =>
    `gateway closed during connect (${event.code}) ${event.reason}`,
  rejectedMessage = "gateway connect rejected",
}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };

    const onClose = (event) => {
      cleanup();
      reject(new Error(closeMessage(event)));
    };

    const onMessage = (event) => {
      const frame = readFrame(event, parseFrame, onFrame);
      if (frame?.type === "hello-ok") {
        cleanup();
        resolve(frame);
        return;
      }

      if (
        frame?.type === "res" &&
        frame.id === requestId &&
        frame.ok === false
      ) {
        cleanup();
        reject(new Error(frame.error?.message ?? rejectedMessage));
      }
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

export function waitForGatewayResponse({
  ws,
  requestId,
  timeoutMs,
  parseFrame,
  onFrame,
  timeoutMessage = "chat.send response timed out",
  closeMessage = (event) =>
    `gateway closed before chat.send response (${event.code}) ${event.reason}`,
  rejectedMessage = "chat.send rejected",
}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };

    const onClose = (event) => {
      cleanup();
      reject(new Error(closeMessage(event)));
    };

    const onMessage = (event) => {
      const frame = readFrame(event, parseFrame, onFrame);
      if (frame?.type !== "res" || frame.id !== requestId) return;

      cleanup();
      if (frame.ok === false) {
        reject(new Error(frame.error?.message ?? rejectedMessage));
        return;
      }

      resolve(frame.payload ?? {});
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

export function waitForGatewayEvent({
  ws,
  timeoutMs,
  parseFrame,
  onFrame,
  onFrameResult,
  fallbackResult,
}) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(fallbackResult());
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
    };

    const onClose = () => {
      cleanup();
      resolve(fallbackResult());
    };

    const onMessage = (event) => {
      const frame = readFrame(event, parseFrame, onFrame);
      const result = onFrameResult(frame);
      if (result === undefined) return;

      cleanup();
      resolve(result);
    };

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

function readFrame(event, parseFrame, onFrame) {
  const frame = parseFrame(String(event.data ?? ""));
  onFrame?.(frame);
  return frame;
}

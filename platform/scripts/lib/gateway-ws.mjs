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
  return waitForGatewaySocket(
    {
      ws,
      timeoutMs,
      onTimeout: ({ reject }) => reject(new Error(timeoutMessage)),
    },
    ({ listen, resolve, reject }) => {
      listen("open", () => resolve(), { once: true });
      listen("error", () => reject(new Error(errorMessage)), { once: true });
      listen(
        "close",
        (event) => reject(new Error(closeMessage(event))),
        { once: true },
      );
    },
  );
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
  return waitForGatewaySocket(
    {
      ws,
      timeoutMs,
      onTimeout: ({ reject }) => reject(new Error(timeoutMessage)),
    },
    ({ listen, resolve, reject }) => {
      listen("close", (event) => reject(new Error(closeMessage(event))));
      listen("message", (event) => {
        const frame = readFrame(event, parseFrame, onFrame);
        if (frame?.type === "hello-ok") {
          resolve(frame);
          return;
        }

        if (
          frame?.type === "res" &&
          frame.id === requestId &&
          frame.ok === false
        ) {
          reject(new Error(frame.error?.message ?? rejectedMessage));
        }
      });
    },
  );
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
  malformedMessage = "chat.send returned a malformed response",
}) {
  return waitForGatewaySocket(
    {
      ws,
      timeoutMs,
      onTimeout: ({ reject }) => reject(new Error(timeoutMessage)),
    },
    ({ listen, resolve, reject }) => {
      listen("close", (event) => reject(new Error(closeMessage(event))));
      listen("message", (event) => {
        const frame = readFrame(event, parseFrame, onFrame);
        if (frame?.type !== "res" || frame.id !== requestId) return;

        if (frame.ok === false) {
          reject(new Error(frame.error?.message ?? rejectedMessage));
          return;
        }
        if (frame.ok !== true) {
          reject(new Error(malformedMessage));
          return;
        }

        resolve(frame.payload ?? {});
      });
    },
  );
}

export function waitForGatewayEvent({
  ws,
  timeoutMs,
  parseFrame,
  onFrame,
  onFrameResult,
  fallbackResult,
}) {
  return waitForGatewaySocket(
    {
      ws,
      timeoutMs,
      onTimeout: ({ resolve }) => resolve(fallbackResult()),
    },
    ({ listen, resolve }) => {
      listen("close", () => resolve(fallbackResult()));
      listen("message", (event) => {
        const frame = readFrame(event, parseFrame, onFrame);
        const result = onFrameResult(frame);
        if (result === undefined) return;

        resolve(result);
      });
    },
  );
}

function waitForGatewaySocket({ ws, timeoutMs, onTimeout }, register) {
  return new Promise((resolve, reject) => {
    const listeners = [];
    let settled = false;
    const timeout = setTimeout(() => onTimeout(controller), timeoutMs);

    const cleanup = () => {
      clearTimeout(timeout);
      for (const [type, handler] of listeners) {
        ws.removeEventListener(type, handler);
      }
    };

    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const controller = {
      listen(type, handler, options) {
        listeners.push([type, handler]);
        ws.addEventListener(type, handler, options);
      },
      resolve(value) {
        settle(resolve, value);
      },
      reject(error) {
        settle(reject, error);
      },
    };

    register(controller);
  });
}

function readFrame(event, parseFrame, onFrame) {
  const frame = parseFrame(String(event.data ?? ""));
  onFrame?.(frame);
  return frame;
}

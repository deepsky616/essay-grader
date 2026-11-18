"use strict";

const WEBAPP_ORIGIN = "https://deepsky616.github.io";
const PAGE_SOURCE = "essay-grader-neis-page";
const EXTENSION_SOURCE = "essay-grader-neis-extension";

function respond(type, requestId, payload = {}) {
  window.postMessage({
    source: EXTENSION_SOURCE,
    type,
    version: 1,
    requestId,
    ...payload,
  }, WEBAPP_ORIGIN);
}

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== WEBAPP_ORIGIN) return;
  const message = event.data;
  if (!message || message.source !== PAGE_SOURCE || message.version !== 1) return;
  if (typeof message.requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(message.requestId)) return;
  if (message.type === "NEIS_EXTENSION_PING") {
    respond("NEIS_EXTENSION_PONG", message.requestId, { ready: true });
    return;
  }
  if (message.type !== "NEIS_AUTO_FILL_REQUEST") return;
  chrome.runtime.sendMessage({
    type: "NEIS_AUTO_FILL_REQUEST",
    version: 1,
    requestId: message.requestId,
    payload: message.payload,
  }).then((result) => {
    respond("NEIS_AUTO_FILL_RESULT", message.requestId, { result });
  }).catch((error) => {
    respond("NEIS_AUTO_FILL_RESULT", message.requestId, {
      result: { ok: false, message: error?.message || "NEIS 입력 도우미와 연결하지 못했습니다." },
    });
  });
});

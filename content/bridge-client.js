window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // Injects the main-world bridge once (PLAN.md §7), then wraps commands
  // in promises keyed by nonce. Responses require matching nonce + window source.
  const pending = new Map();
  let seq = 0;
  let injected = false;

  function inject() {
    if (injected) return;
    injected = true;
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("page/bridge.js");
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  function newNonce() {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return `${buf[0].toString(16)}-${buf[1].toString(16)}-${++seq}`;
  }

  function call(cmd, timeoutMs) {
    inject();
    return new Promise((resolve, reject) => {
      const nonce = newNonce();
      const timer = setTimeout(() => {
        pending.delete(nonce);
        reject(new Error("bridge timeout: " + cmd));
      }, timeoutMs || 5000);

      pending.set(nonce, {
        resolve: (data) => { clearTimeout(timer); pending.delete(nonce); resolve(data); },
        reject: (err) => { clearTimeout(timer); pending.delete(nonce); reject(err); }
      });

      window.postMessage(
        { __yga: "cmd", id: nonce, nonce: nonce, cmd: cmd },
        window.location.origin
      );
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__yga !== "resp") return;
    const entry = pending.get(msg.nonce);
    if (!entry) return;
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error || "bridge error"));
  });

  yga.bridge = { call: call };
})(window.yga);

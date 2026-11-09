window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // The bridge ships as a "world": "MAIN" content script (manifest) — CSP-safe;
  // <script src=chrome-extension://...> injection is blocked by YouTube CSP.
  // The isolated world cannot see the bridge directly; readiness is handled by
  // the retry in api-client when a first call races the MAIN-world load.
  const pending = new Map();
  let seq = 0;

  function newNonce() {
    const buf = new Uint32Array(2);
    crypto.getRandomValues(buf);
    return `${buf[0].toString(16)}-${buf[1].toString(16)}-${++seq}`;
  }

  function call(cmd, arg, timeoutMs) {
    // Older callers use call(cmd, timeoutMs); keep that shape working.
    if (typeof arg === "number") {
      timeoutMs = arg;
      arg = undefined;
    }
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
        { __yga: "cmd", id: nonce, nonce: nonce, cmd: cmd, arg: arg },
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

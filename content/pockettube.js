window.yga = window.yga || {};

(function (yga) {
  "use strict";

  // PocketTube migration (PLAN.md §20). PocketTube keeps its groups in
  // chrome.storage.sync as `{ "<group name>": ["UC…"] }` plus `ysc_meta`
  // `{ name: { img, position } }`; its own export file has the same shape, and
  // a chrome.storage dump wraps it as `{ local, sync }`. Only group names,
  // order and channel ids are portable — PocketTube's watched flags and
  // per-video state have no counterpart in our lastVisitAt model (§10.4).
  const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
  const collator = new Intl.Collator(undefined, { sensitivity: "base" });

  function sourceOf(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.sync && typeof payload.sync === "object") return payload.sync;
    return payload;
  }

  // `{ groups: [{name, order, ids}] }`, sorted the way PocketTube shows them
  // (ysc_meta.position first, export order as the fallback). Returns null when
  // the payload carries no group arrays.
  function parse(payload) {
    const src = sourceOf(payload);
    if (!src) return null;
    const meta = src.ysc_meta && typeof src.ysc_meta === "object" ? src.ysc_meta : {};
    const groups = [];
    let index = 0;
    for (const key in src) {
      if (key.indexOf("ysc_") === 0 || key.indexOf("yga:") === 0) continue;
      const value = src[key];
      if (!Array.isArray(value)) continue;
      const name = String(key).trim();
      if (!name) continue;
      const ids = [];
      for (const id of value) if (typeof id === "string" && CHANNEL_ID.test(id)) ids.push(id);
      const position = meta[key] && Number.isFinite(meta[key].position) ? meta[key].position : index;
      groups.push({ name: name, order: position, ids: ids });
      index++;
    }
    // A payload with no channel ids anywhere is not a PocketTube export (our
    // own yga:* export holds arrays of objects, which yield no ids here).
    if (!groups.length || groups.every((g) => !g.ids.length)) return null;
    groups.sort((a, b) => (a.order - b.order) || collator.compare(a.name, b.name));
    return { groups: groups };
  }

  // Read-only pass: resolve each PocketTube group against the groups of one
  // profile and drop ids that are not in the subscription catalog (a channel
  // YouTube no longer lists would only be marked `unsubscribed` by syncProfile,
  // so assigning it would create a row that never shows — PLAN.md §5).
  async function plan(payload, profileId) {
    const parsed = parse(payload);
    if (!parsed) return { ok: false, error: "noGroups" };
    if (!yga.groups || !yga.profiles || !yga.state) return { ok: false, error: "noModules" };
    const pid = profileId || (await yga.profiles.activeProfileId());
    if (!yga.profiles.get(pid)) return { ok: false, error: "noProfile" };
    const catalog = await yga.state.getAllSubs();
    const known = new Set(catalog.map((s) => s.channelId));
    await yga.groups.load();
    const existing = new Map();
    for (const g of yga.groups.list(pid)) existing.set(g.name.toLowerCase(), g);
    const steps = [];
    let assigned = 0;
    let missing = 0;
    let created = 0;
    for (const g of parsed.groups) {
      const match = existing.get(g.name.toLowerCase());
      if (!match) created++;
      const ids = [];
      for (const id of g.ids) {
        if (known.has(id)) ids.push(id);
        else missing++;
      }
      assigned += ids.length;
      steps.push({ name: g.name, ids: ids, group: match || null });
    }
    return {
      ok: true,
      profileId: pid,
      steps: steps,
      groups: parsed.groups.length,
      created: created,
      matched: parsed.groups.length - created,
      assigned: assigned,
      missing: missing
    };
  }

  // Writes through the single owners only: groups.js for yga:groups, profiles.js
  // for the composition (§5). Idempotent — a second import of the same file
  // matches existing groups by name and setGroup skips unchanged rows.
  async function apply(planResult) {
    if (!planResult || !planResult.ok) return { ok: false, error: (planResult && planResult.error) || "badPlan" };
    const pid = planResult.profileId;
    let created = 0;
    let assigned = 0;
    for (const step of planResult.steps) {
      let groupId = step.group ? step.group.id : null;
      if (!groupId) {
        const group = await yga.groups.create(step.name, pid);
        if (!group) continue;
        groupId = group.id;
        created++;
      }
      if (!step.ids.length) continue;
      assigned += await yga.profiles.setGroup(pid, step.ids, groupId);
    }
    return {
      ok: true,
      profileId: pid,
      groups: planResult.groups,
      created: created,
      matched: planResult.groups - created,
      assigned: assigned,
      missing: planResult.missing
    };
  }

  yga.pockettube = {
    parse: parse,
    plan: plan,
    apply: apply
  };
})(window.yga);

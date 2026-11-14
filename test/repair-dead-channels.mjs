// One-off data repair (browser report 2026-11-14): the dead-channel detector
// counted HTTP 429/5xx and network failures as "channel gone", so one
// rate-limited mass pass excluded 144 live channels of profile "Andi" and
// cleared their groupId. The worker is fixed; this rebuilds the lost state from
// two config snapshots taken with the panel's Data → Export button.
//
//   node test/repair-dead-channels.mjs <before.json> <after.json> [out.json]
//
// <before> is a snapshot from before the loss (groups intact), <after> the
// current one (counters/visits current). The output keeps <after> everywhere
// except the composition records the detector wrongly excluded, which get their
// `excluded` flag cleared and their `groupId` back. Import the result with
// Data → Import.

import fs from "node:fs";

const [, , beforePath, afterPath, outPath = "youtube-aggregator-repaired.json"] = process.argv;
if (!beforePath || !afterPath) {
  console.error("usage: node test/repair-dead-channels.mjs <before.json> <after.json> [out.json]");
  process.exit(2);
}

const DEAD_AFTER_ERRORS = 5;
const load = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

const before = load(beforePath);
const after = load(afterPath);
if (before.ygaExport !== 1 || after.ygaExport !== 1) {
  console.error("both files must be panel exports (ygaExport: 1)");
  process.exit(2);
}

const profiles = after["yga:profiles"] || before["yga:profiles"] || {};
const report = [];
let restored = 0;

for (const profileId of Object.keys(profiles)) {
  const key = "yga:profile-channels:" + profileId;
  const oldComp = before[key] || {};
  const comp = after[key];
  if (!comp) continue;

  let changed = 0;
  for (const [channelId, rec] of Object.entries(comp)) {
    if (!rec.excluded) continue;
    const prev = oldComp[channelId];
    if (!prev || prev.excluded) continue; // user choice, or new since <before>
    // Only undo what the detector could have done: a feed that failed enough
    // times to trip the old rule. A hand-removed channel stays removed.
    const video = after["yga:videos:" + channelId];
    if (!video || (video.errorStreak || 0) < DEAD_AFTER_ERRORS) continue;

    delete rec.excluded;
    rec.groupId = prev.groupId || null;
    changed++;
    restored++;
  }
  if (changed) {
    after[key] = comp;
    report.push(`${profiles[profileId].name} (${profileId}): ${changed} restored`);
  }
}

// The detector's streak is gone with the fix; clear it so a channel that is
// actually blocked starts from zero instead of one failure from the mark.
let cleared = 0;
for (const key of Object.keys(after)) {
  if (key.indexOf("yga:videos:") !== 0) continue;
  const rec = after[key];
  if ((rec.errorStreak || 0) >= DEAD_AFTER_ERRORS) {
    rec.errorStreak = 0;
    delete rec.deadStreak;
    cleared++;
  }
}

after.exportedAt = Date.now();
fs.writeFileSync(outPath, JSON.stringify(after, null, 2));

console.log(report.length ? report.join("\n") : "nothing to restore");
console.log(`streaks cleared on ${cleared} video records`);
console.log(`wrote ${outPath} (${restored} channels restored)`);

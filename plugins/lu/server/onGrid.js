"use strict";

// The plugin's onGrid hook (bridge/plugins.js), run on every sample of a watch:
//   - a decision that names a ball by ID ("engaging:<id>") names it by label;
//   - a hunter report on the watched character is one SIGHTING, said again
//     only once it is a minute newer.
// Both read what annotate joined (join.js): ext.lu, and the reports in hidden.lu.

// A decision naming a ball by ID; the label replaces the ID.
const TARGETED_DECISION = /(engaging|fleeing|flee-warp):(\d+)$/;
// The same sighting is re-reported every few seconds; say it again only after this.
const SIGHTING_REPEAT_MS = 60_000;

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function luOf(entry) {
  return entry && entry.ext ? entry.ext.lu || null : null;
}

function createLuOnGrid() {
  return {
    watch() {
      const seen = new Map();
      return {
        // entries: Map itemID -> differ entry; ctx: { atMs, labelFor(itemID) }
        step(entries, ctx) {
          for (const entry of entries.values()) {
            const lu = luOf(entry);
            if (!lu || !lu.decision || !TARGETED_DECISION.test(lu.decision)) continue;
            const named = lu.decision.replace(TARGETED_DECISION, (_match, verb, id) => `${verb}:${ctx.labelFor(toPositiveInt(id))}`);
            entry.ext = { ...entry.ext, lu: { ...lu, decision: named } };
          }
          const events = [];
          for (const entry of entries.values()) {
            const reports = entry.hidden && entry.hidden.lu && Array.isArray(entry.hidden.lu.sightings)
              ? entry.hidden.lu.sightings : [];
            for (const report of reports) {
              const key = `${report.observerID}:${report.source}`;
              const last = seen.get(key);
              if (last && (last.observedAtMs === report.observedAtMs || report.observedAtMs - last.observedAtMs < SIGHTING_REPEAT_MS)) {
                continue;
              }
              seen.set(key, { observedAtMs: report.observedAtMs, atMs: ctx.atMs });
              const observer = entries.get(report.observerID);
              events.push({
                kind: "SIGHTING",
                observerID: report.observerID,
                observerLabel: ctx.labelFor(report.observerID),
                observerFlightID: report.observerFlightID,
                source: report.source,
                certainty: report.certainty,
                observedAtMs: report.observedAtMs,
                distanceMeters: observer ? observer.distanceMeters : null,
                lu: observer ? luOf(observer) : luOf(entry),
              });
            }
          }
          return events;
        },
      };
    },
  };
}

module.exports = {
  createLuOnGrid,
};

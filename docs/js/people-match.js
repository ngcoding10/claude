// Typo-tolerant ranking of people for a typed name ("nicoo", "ncio" -> nico), shared by both data layers.
import { foldText, wordScore } from "./fuzzy.js";

/** How well a typed query matches a profile's username or display name: 0 (not at all) to 1. */
export function personScore(query, p) {
  const typed = foldText(query).split(" ").filter(Boolean);
  if (!typed.length) return 0;
  const user = foldText(p.username), name = foldText(p.display_name);
  // whole names with the spaces closed up ("mayaortiz") plus each separate word
  const words = [...new Set([user.replace(/ /g, ""), name.replace(/ /g, ""), ...user.split(" "), ...name.split(" ")].filter(Boolean))];
  let total = 0;
  for (const t of typed) {
    let best = 0;
    for (const w of words) best = Math.max(best, wordScore(t, w));
    if (!best) return 0;
    total += best;
  }
  return total / typed.length;
}

/** Profiles that match, best first; more films ranked wins a tie. */
export function rankPeople(query, profiles, limit = 20) {
  return profiles
    .map((p) => [personScore(query, p), p])
    .filter((x) => x[0] > 0)
    .sort((a, b) => Math.round(b[0] * 5) - Math.round(a[0] * 5) || b[1].ranked_count - a[1].ranked_count || b[0] - a[0])
    .slice(0, limit)
    .map((x) => x[1]);
}

import { norm } from "./util.js";
import { DATA_VERSION } from "./data-version.js";

// Versioned URLs: the browser may reuse its copy without asking the server, until the data changes.
const dataUrl = (path) => fetch(`data/${path}?v=${DATA_VERSION}`, { cache: "force-cache" });

let DB = null;
const shardCache = new Map();

export async function loadFilms() {
  const res = await dataUrl("index.json");
  if (!res.ok) throw new Error(`index.json ${res.status}`);
  const raw = await res.json();
  DB = {
    genres: raw.genres,
    shard: raw.shard,
    posterBase: raw.posterBase,
    // `alt` holds a film's other names ("Se7en" for "Seven"), so search and list matching find it either way.
    films: raw.films.map(([title, year, g, poster, pop, alt], id) => ({ id, title, year, g, poster, pop, n: norm(title), alt: (alt || []).map(norm).filter(Boolean) })),
  };
  // A film's id is its position in the data and never changes (rankings are saved by id), so new films
  // are added at the end. Anything that wants "most popular first" uses this order, not the ids.
  DB.byPop = [...DB.films].sort((a, b) => b.pop - a.pop || a.id - b.id);
  const counts = new Array(DB.genres.length).fill(0);
  DB.byPop.slice(0, 3000).forEach((f) => f.g.forEach((g) => counts[g]++));
  DB.genreFreq = counts.map((c) => Math.max(c, 1) / 3000);
  DB.postersReady = loadRestPosters(raw.corePosters ?? DB.films.length);
  return DB;
}

// Posters beyond the most popular films arrive a moment after the first screen.
async function loadRestPosters(core) {
  if (core >= DB.films.length) return;
  try {
    const rest = await (await dataUrl("posters.json")).json();
    rest.forEach((p, i) => { if (p && DB.films[core + i]) DB.films[core + i].poster = p; });
    document.dispatchEvent(new CustomEvent("movi:posters"));
  } catch {}
}

export const genreFreq = (name) => DB.genreFreq[DB.genres.indexOf(name)] ?? 0.05;

export const filmCount = () => DB.films.length;
/** Every film, most popular first. */
export const allFilms = () => DB.byPop;
/** A film's title and other names, normalised for matching. */
export const namesOf = (f) => (f.alt.length ? [f.n, ...f.alt] : [f.n]);
export const genres = () => DB.genres;
export const film = (id) => DB.films[id];
export const isFilmId = (id) => Number.isInteger(id) && id >= 0 && id < DB.films.length;
// TMDB serves fixed widths; pick the smallest that stays sharp at 2x for where the poster is shown.
const TMDB_SIZES = { s: "w185", m: "w342", l: "w500" };
export const posterUrl = (f, size = "m") =>
  !f.poster ? "" : f.poster[0] === "~" ? `https://image.tmdb.org/t/p/${TMDB_SIZES[size] || "w342"}${f.poster.slice(1)}` : f.poster.startsWith("http") ? f.poster : DB.posterBase + f.poster;
export const genreNames = (f) => f.g.map((i) => DB.genres[i]);
export const genreIndex = (name) => DB.genres.indexOf(name);

export function details(id) {
  const n = Math.floor(id / DB.shard);
  if (!shardCache.has(n)) {
    shardCache.set(
      n,
      dataUrl(`details/${n}.json`)
        .then((r) => r.json())
        .catch(() => {
          shardCache.delete(n);
          return [];
        }),
    );
  }
  return shardCache.get(n).then((rows) => {
    const [cast = [], plot = "", href = ""] = rows[id % DB.shard] || [];
    return { cast, plot, href };
  });
}

const YEAR = /^(19|20)\d\d$/;

export function searchFilms({ q = "", genre = "", decade = "", sort = "pop", exclude = null } = {}) {
  const tokens = norm(q).split(" ").filter(Boolean);
  const years = tokens.filter((t) => YEAR.test(t)).map(Number);
  const words = tokens.filter((t) => !YEAR.test(t));
  const g = genre ? DB.genres.indexOf(genre) : -1;
  const dec = decade ? Number(decade) : null;
  const phrase = words.join(" ");
  const out = [];
  for (const f of DB.byPop) {
    if (exclude && exclude.has(f.id)) continue;
    if (g >= 0 && !f.g.includes(g)) continue;
    if (dec !== null && (f.year < dec || f.year >= dec + 10)) continue;
    let rel = 0;
    if (years.length) {
      const titleHasYear = years.every((y) => ` ${f.n} `.includes(` ${y} `));
      if (!years.includes(f.year) && !titleHasYear) continue;
      if (titleHasYear) rel += 2;
    }
    if (words.length) {
      let best = -1;
      for (const n of namesOf(f)) {
        if (!words.every((w) => n.includes(w))) continue;
        best = Math.max(best, n === phrase ? 3 : n.startsWith(phrase) ? 2 : ` ${n}`.includes(` ${words[0]}`) ? 1 : 0);
      }
      if (best < 0) continue;
      rel += best;
    }
    out.push([rel, f]);
  }
  const sorters = {
    pop: (a, b) => b[0] - a[0] || b[1].pop - a[1].pop || a[1].id - b[1].id,
    new: (a, b) => b[0] - a[0] || b[1].year - a[1].year || b[1].pop - a[1].pop || a[1].id - b[1].id,
    old: (a, b) => b[0] - a[0] || a[1].year - b[1].year || b[1].pop - a[1].pop || a[1].id - b[1].id,
    az: (a, b) => a[1].n.localeCompare(b[1].n),
  };
  return out.sort(sorters[sort] || sorters.pop).map((x) => x[1]);
}

export function topByGenre(name, limit = 20, exclude = null) {
  const g = DB.genres.indexOf(name);
  const out = [];
  for (const f of DB.byPop) {
    if (f.g.includes(g) && !(exclude && exclude.has(f.id))) out.push(f);
    if (out.length >= limit) break;
  }
  return out;
}

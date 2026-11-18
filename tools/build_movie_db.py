#!/usr/bin/env python3
"""Build Movi's static movie database from the Wikipedia movie dataset.

Usage: python3 tools/build_movie_db.py path/to/movies.json docs/data
Source: https://github.com/prust/wikipedia-movie-data (CC BY-SA, from Wikipedia)
"""
import hashlib
import json
import os
import re
import sys

SHARD_SIZE = 500
CORE_POSTERS = 3000
POSTER_PREFIX = "https://upload.wikimedia.org/wikipedia/"

GENRE_ALIASES = {"Sport": "Sports", "Sci-Fi": "Science Fiction", "Animation": "Animated"}
GENRES = [
    "Drama", "Comedy", "Action", "Thriller", "Romance", "Crime", "Horror", "Adventure",
    "Science Fiction", "Fantasy", "Animated", "Mystery", "Western", "Musical", "War",
    "Noir", "Biography", "Historical", "Documentary", "Sports", "Family", "Superhero",
    "Supernatural", "Slasher", "Spy", "Teen", "Satire", "Martial Arts", "Disaster",
    "Political", "Independent", "Silent", "Short",
]
GENRE_INDEX = {g: i for i, g in enumerate(GENRES)}
DEFINING = ["Animated", "Superhero", "Documentary", "Horror", "Science Fiction", "Western", "Musical", "War", "Noir", "Fantasy", "Sports"]

BOOSTS = [
    (r"greatest films", 6), (r"Best Picture", 5), (r"highest-grossing", 4),
    (r"Academy Award", 4), (r"National Film Registry", 4), (r"Oscar", 2),
    (r"Golden Globe", 2), (r"acclaim", 2), (r"cult (film|classic|following)", 2),
    (r"box office (success|hit)", 2), (r"franchise", 2), (r"sequel", 1),
    (r"Cannes", 2), (r"Pixar|Marvel|Star Wars|Disney", 2),
]


def norm(title):
    return re.sub(r"[^a-z0-9]", "", title.lower().replace("&", "and"))


def load_canon():
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "canon.txt")
    canon = {}
    for rank, line in enumerate(open(path, encoding="utf-8")):
        title, _, year = line.strip().rpartition("|")
        if title:
            canon.setdefault((norm(title), int(year)), rank)
    return canon


def canon_bonus(m, canon):
    key = norm(m["title"])
    for dy in (0, -1, 1):
        rank = canon.get((key, m["year"] + dy))
        if rank is not None:
            return 60 - rank / 20
    return 0


def popularity(m):
    text = m.get("extract", "")
    score = min(len(text), 1500) / 150
    score += sum(w for pat, w in BOOSTS if re.search(pat, text))
    score += 3 if m.get("thumbnail") else 0
    score += min(len(m.get("cast", [])), 12) / 3
    score += max(0, m["year"] - 1930) / 15
    if "Silent" in m.get("genres", []) or "Short" in m.get("genres", []):
        score -= 5
    if "upcoming" in text[:200]:
        score -= 3
    return score


def clean_extract(text, limit=700):
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = cut.rfind(". ")
    return cut[: end + 1] if end > 200 else cut.rstrip() + "…"


TMDB_GENRES = {
    28: "Action", 12: "Adventure", 16: "Animated", 35: "Comedy", 80: "Crime", 99: "Documentary", 18: "Drama",
    10751: "Family", 14: "Fantasy", 36: "Historical", 27: "Horror", 10402: "Musical", 9648: "Mystery",
    10749: "Romance", 878: "Science Fiction", 53: "Thriller", 10752: "War", 37: "Western",
}


def load_tmdb():
    # From tools/fetch_tmdb_posters.py: {"Title|Year": {"p": poster, "g": [genre ids], "o": overview}}.
    # Older caches (tmdb_posters.json: {"Title|Year": poster}) fill any posters the newer one lacks.
    here = os.path.dirname(os.path.abspath(__file__))
    data = {}
    legacy = os.path.join(here, "tmdb_posters.json")
    if os.path.exists(legacy):
        data = {k: {"p": v} for k, v in json.load(open(legacy, encoding="utf-8")).items() if v}
    current = os.path.join(here, "tmdb_data.json")
    if os.path.exists(current):
        for k, v in json.load(open(current, encoding="utf-8")).items():
            merged = {**data.get(k, {}), **{key: val for key, val in v.items() if val}}
            data[k] = merged
    return data


def best_plot(extract, overview):
    plot = clean_extract(extract)
    if overview and len(plot) < 120 and len(overview) > len(plot):
        return clean_extract(overview)
    return plot


def main(src, out):
    raw = json.load(open(src, encoding="utf-8"))
    tmdb = load_tmdb()
    canon = load_canon()
    seen = set()
    films = []
    for m in raw:
        key = m.get("href") or f"{m['title']}|{m['year']}"
        if key in seen or not m.get("title"):
            continue
        seen.add(key)
        genres = []
        # TMDB's genres are the more reliable, so they come first; Wikipedia adds finer ones (Superhero, Noir...).
        tm = tmdb.get(f"{m['title']}|{m['year']}", {})
        names = [TMDB_GENRES[g] for g in tm.get("g", []) if g in TMDB_GENRES] + list(m.get("genres", []))
        names = [GENRE_ALIASES.get(g, g) for g in names]
        # Genres that say the most about a film are listed first, since cards show only the first two.
        names = [g for g in DEFINING if g in names] + [g for g in names if g not in DEFINING]
        for g in names:
            if g in GENRE_INDEX and GENRE_INDEX[g] not in genres:
                genres.append(GENRE_INDEX[g])
        films.append((popularity(m) + canon_bonus(m, canon), m, genres))

    films.sort(key=lambda f: -f[0])
    top = films[0][0]

    index, shards = [], {}
    for fid, (pop, m, genres) in enumerate(films):
        poster = m.get("thumbnail") or ""
        tm = tmdb.get(f"{m['title']}|{m['year']}", {})
        if tm.get("p"):
            poster = "~" + tm["p"]
        if "/thumb/" in poster:
            # Wikimedia only serves thumbnails at standard widths; 320px now returns 400.
            poster = re.sub(r"/\d+px-([^/]+)$", r"/330px-\1", poster)
        if poster.startswith(POSTER_PREFIX):
            poster = poster[len(POSTER_PREFIX):]
        index.append([m["title"], m["year"], genres, poster, round(max(pop, 0) / top * 100)])
        shards.setdefault(fid // SHARD_SIZE, []).append(
            [m.get("cast", [])[:10], best_plot(m.get("extract"), tm.get("o")), m.get("href") or ""]
        )

    os.makedirs(os.path.join(out, "details"), exist_ok=True)
    # Posters of the most popular films ship with the index so the first screen has them; the rest
    # (random-looking file names that barely compress) load in the background from posters.json.
    rest_posters = [row[3] for row in index[CORE_POSTERS:]]
    for row in index[CORE_POSTERS:]:
        row[3] = ""
    written = []
    def dump(path, data):
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        written.append(text)
    dump(os.path.join(out, "index.json"),
         {"genres": GENRES, "shard": SHARD_SIZE, "posterBase": POSTER_PREFIX, "corePosters": CORE_POSTERS, "films": index})
    dump(os.path.join(out, "posters.json"), rest_posters)
    for n, rows in sorted(shards.items()):
        dump(os.path.join(out, "details", f"{n}.json"), rows)
    # A content hash in the data URLs lets browsers keep the files until a rebuild changes them.
    version = hashlib.sha1("".join(written).encode("utf-8")).hexdigest()[:12]
    js_dir = os.path.join(os.path.dirname(os.path.abspath(out)), "js")
    with open(os.path.join(js_dir, "data-version.js"), "w", encoding="utf-8") as f:
        f.write(f'// Written by tools/build_movie_db.py. Changes whenever the film data changes.\nexport const DATA_VERSION = "{version}";\n')
    print(f"{len(index)} films, {len(shards)} detail shards")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

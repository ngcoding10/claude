#!/usr/bin/env python3
"""Look up TMDB data for every film in docs/data/index.json.

Usage: TMDB_API_KEY=... python3 tools/fetch_tmdb_posters.py
Writes tools/tmdb_data.json: {"Title|Year": {"p": posterPath, "g": [tmdbGenreIds], "o": overview}}
("o" only for films whose Wikipedia summary is missing or very short). The file is a cache:
re-running only looks up films that aren't in it yet. build_movie_db.py reads it.
"""
import concurrent.futures as cf
import glob
import json
import os
import ssl
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = os.path.join(ROOT, "docs", "data", "index.json")
DETAILS = os.path.join(ROOT, "docs", "data", "details")
CACHE = os.path.join(ROOT, "tools", "tmdb_data.json")
KEY = os.environ.get("TMDB_API_KEY")
SHORT_PLOT = 120

ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)


def get(params):
    url = "https://api.themoviedb.org/3/search/movie?" + urllib.parse.urlencode({"api_key": KEY, "include_adult": "false", **params})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(url, timeout=20, context=ctx) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(2 + attempt * 2)
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1 + attempt)
    return {"results": []}


def norm(s):
    return "".join(c for c in s.lower() if c.isalnum())


def find(title, year):
    def pick(results, strict):
        ok = [r for r in results if (int((r.get("release_date") or "0")[:4] or 0) == year if strict
                                     else abs(int((r.get("release_date") or "0")[:4] or 0) - year) <= 1)]
        for r in ok:
            if norm(title) in (norm(r.get("title", "")), norm(r.get("original_title", ""))):
                return r
        # Same title search and exact year: TMDB's top hit is almost always the film.
        return ok[0] if strict and ok else None

    hit = pick(get({"query": title, "primary_release_year": year}).get("results", []), True)
    return hit or pick(get({"query": title}).get("results", []), False)


def main():
    if not KEY:
        sys.exit("Set TMDB_API_KEY")
    index = json.load(open(INDEX))
    films = index["films"]
    shard = index["shard"]
    plots = {}
    for path in glob.glob(os.path.join(DETAILS, "*.json")):
        n = int(os.path.basename(path).split(".")[0])
        for i, row in enumerate(json.load(open(path))):
            plots[n * shard + i] = row[1]
    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    todo = [(fid, t, y) for fid, (t, y, *_) in enumerate(films) if f"{t}|{y}" not in cache]
    print(f"{len(films)} films, {len(todo)} to look up", flush=True)

    def work(fid, t, y):
        r = find(t, y)
        if not r:
            return {}
        entry = {"p": r.get("poster_path") or "", "g": r.get("genre_ids") or []}
        if len(plots.get(fid, "")) < SHORT_PLOT and r.get("overview"):
            entry["o"] = r["overview"].strip()
        return entry

    done = 0
    with cf.ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(work, *job): job for job in todo}
        for fut in cf.as_completed(futures):
            _, t, y = futures[fut]
            try:
                cache[f"{t}|{y}"] = fut.result()
            except Exception as e:  # keep going; a re-run retries anything missing
                print("error", t, y, e, flush=True)
            done += 1
            if done % 2000 == 0:
                json.dump(cache, open(CACHE, "w"), ensure_ascii=False, separators=(",", ":"))
                print(f"{done}/{len(todo)}", flush=True)
    json.dump(cache, open(CACHE, "w"), ensure_ascii=False, separators=(",", ":"))
    vals = list(cache.values())
    print(f"done: {sum(1 for v in vals if v.get('p'))} posters, {sum(1 for v in vals if v.get('g'))} with genres, "
          f"{sum(1 for v in vals if v.get('o'))} new descriptions, of {len(vals)}")


if __name__ == "__main__":
    main()

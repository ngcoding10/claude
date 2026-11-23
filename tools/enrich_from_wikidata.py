#!/usr/bin/env python3
"""Fill the gaps in Movi's film database using Wikidata and Wikipedia (no API key needed).

The base data (tools/build_movie_db.py) is mostly American films up to 2023 and knows nothing
about how famous a film is. This script, run after it, edits docs/data IN PLACE:

  1. Looks up every existing film on Wikidata: how many Wikipedia languages cover it (a good
     measure of fame), its common English name, and its other names ("Se7en" for "Seven").
     Famous films that were buried get a higher popularity, the common name becomes the title,
     and other names become searchable.
  2. Adds well-known films the base data lacks (other countries, 2024 onwards), with year,
     genres, cast, a description and a poster from Wikipedia.

Film ids never change: existing films keep their position and new ones are appended, because
members' rankings are saved by id. Run it again any time; it only adds what is missing.

Usage: python3 tools/enrich_from_wikidata.py docs/data            (uses tools/wikidata_cache.json)
       python3 tools/enrich_from_wikidata.py docs/data --refresh  (ask Wikidata again)
"""
import datetime
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "wikidata_cache.json")
UA = "film-db-builder/1.0 (static film list; python urllib)"
SPARQL = "https://query.wikidata.org/sparql"
MIN_LINKS_NEW = 20          # a new film must be covered by at least this many Wikipedias
THIS_YEAR = datetime.date.today().year
FILM_TYPES = "wd:Q11424 wd:Q24869 wd:Q202866 wd:Q29168811 wd:Q229390"  # film, feature film, animated film, animated feature film, 3D film
POSTER_PREFIX = "https://upload.wikimedia.org/wikipedia/"

# Fame (Wikipedia language count) -> the 0-100 popularity the site sorts by. Hand-picked canon
# films sit at 75-100 and ordinary films at 27 or below, so this slots famous films in between.
def pop_for(links):
    for at, pop in ((100, 72), (80, 64), (65, 56), (50, 46), (40, 38), (30, 30), (22, 24), (15, 20)):
        if links >= at:
            return pop
    return 0


def norm(title):
    return re.sub(r"[^a-z0-9]", "", title.lower().replace("&", "and"))


def http(url, data=None, tries=5):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as res:
                return json.loads(res.read().decode("utf-8"))
        except Exception as e:  # rate limits and timeouts: wait and try again
            if attempt == tries - 1:
                raise
            time.sleep(3 * (attempt + 1) + (20 if "429" in str(e) else 0))


def sparql(query):
    data = urllib.parse.urlencode({"query": query, "format": "json"}).encode()
    rows = http(SPARQL, data)["results"]["bindings"]
    return [{k: v["value"] for k, v in r.items()} for r in rows]


def strip_paren(article):
    """Wikipedia article title -> the film's common English name: "Seven (1995 film)" -> "Seven"."""
    return re.sub(r" \((?:[^()]*\bfilm\b[^()]*|\d{4})\)$", "", article)


def qid(uri):
    return uri.rsplit("/", 1)[-1]


def lit(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"@en'


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# ---------------------------------------------------------------- Wikidata lookups
def lookup_existing(titles, cache):
    """Wikipedia article title -> {q, links, label, alt[]} for films already in the database."""
    known = cache.setdefault("existing", {})
    todo = [t for t in titles if t not in known]
    for n, part in enumerate(chunks(todo, 120)):
        rows = sparql(f"""SELECT ?t ?f ?links (GROUP_CONCAT(DISTINCT ?alt; separator="|") AS ?alts) WHERE {{
          VALUES ?t {{ {' '.join(lit(t) for t in part)} }}
          ?a schema:name ?t ; schema:isPartOf <https://en.wikipedia.org/> ; schema:about ?f .
          ?f wikibase:sitelinks ?links .
          OPTIONAL {{ ?f skos:altLabel ?alt FILTER(LANG(?alt) IN ("en", "mul")) }}
        }} GROUP BY ?t ?f ?links""")
        for t in part:
            known[t] = None
        for r in rows:
            known[r["t"]] = {"q": qid(r["f"]), "links": int(r["links"]), "label": strip_paren(r["t"]), "alt": [a for a in r.get("alts", "").split("|") if a]}
        if n % 20 == 0:
            save(cache)
            print(f"  existing films looked up: {min((n + 1) * 120, len(todo))}/{len(todo)}", flush=True)
        time.sleep(0.3)
    save(cache)
    return known


def find_new(cache):
    """Every well-covered film on Wikidata with an English Wikipedia article: q -> {links, title, label, year}."""
    if "candidates" in cache:
        return cache["candidates"]
    out = {}
    spans = [(1880, 1929), (1930, 1949), (1950, 1964), (1965, 1974), (1975, 1984), (1985, 1991), (1992, 1997), (1998, 2002),
             (2003, 2006), (2007, 2009), (2010, 2012), (2013, 2015), (2016, 2018), (2019, 2021), (2022, 2023), (2024, THIS_YEAR)]
    for lo, hi in spans:
        rows = sparql(f"""SELECT ?f ?links ?t (MIN(YEAR(?d)) AS ?year) WHERE {{
          VALUES ?type {{ {FILM_TYPES} }}
          ?f wdt:P31 ?type ; wikibase:sitelinks ?links ; wdt:P577 ?d .
          FILTER(?links >= {MIN_LINKS_NEW})
          ?a schema:about ?f ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?t .
        }} GROUP BY ?f ?links ?t HAVING(MIN(YEAR(?d)) >= {lo} && MIN(YEAR(?d)) <= {hi})""")
        for r in rows:
            out[qid(r["f"])] = {"links": int(r["links"]), "title": r["t"], "label": strip_paren(r["t"]), "year": int(r["year"])}
        print(f"  {lo}-{hi}: {len(rows)} well-known films on Wikidata", flush=True)
        time.sleep(1)
    cache["candidates"] = out
    save(cache)
    return out


GENRE_WORDS = [
    ("comedy drama", ["Comedy", "Drama"]), ("comedy-drama", ["Comedy", "Drama"]), ("dramedy", ["Comedy", "Drama"]),
    ("romantic comedy", ["Romance", "Comedy"]), ("science fiction", ["Science Fiction"]), ("sci-fi", ["Science Fiction"]),
    ("film noir", ["Noir"]), ("neo-noir", ["Noir"]), ("martial arts", ["Martial Arts"]), ("superhero", ["Superhero"]),
    ("supernatural", ["Supernatural"]), ("slasher", ["Slasher"]), ("spy", ["Spy"]), ("teen", ["Teen"]), ("coming-of-age", ["Teen"]),
    ("satir", ["Satire"]), ("disaster", ["Disaster"]), ("political", ["Political"]), ("independent", ["Independent"]),
    ("silent", ["Silent"]), ("biograph", ["Biography"]), ("biopic", ["Biography"]), ("histor", ["Historical"]), ("period", ["Historical"]),
    ("documentary", ["Documentary"]), ("sport", ["Sports"]), ("family", ["Family"]), ("children", ["Family"]),
    ("animat", ["Animated"]), ("anime", ["Animated"]), ("mystery", ["Mystery"]), ("detective", ["Mystery"]), ("western", ["Western"]),
    ("musical", ["Musical"]), ("war", ["War"]), ("drama", ["Drama"]), ("comedy", ["Comedy"]), ("action", ["Action"]),
    ("thriller", ["Thriller"]), ("romance", ["Romance"]), ("romantic", ["Romance"]), ("crime", ["Crime"]), ("gangster", ["Crime"]),
    ("heist", ["Crime"]), ("horror", ["Horror"]), ("adventure", ["Adventure"]), ("fantasy", ["Fantasy"]),
]
DEFINING = ["Animated", "Superhero", "Documentary", "Horror", "Science Fiction", "Western", "Musical", "War", "Noir", "Fantasy", "Sports"]


def map_genres(labels, all_genres):
    names = []
    for label in labels:
        low = label.lower()
        for word, gs in GENRE_WORDS:
            if word in low:
                names += [g for g in gs if g not in names]
    names = [g for g in DEFINING if g in names] + [g for g in names if g not in DEFINING]
    return [all_genres.index(g) for g in names if g in all_genres][:5]


def details_for(qids, cache):
    """q -> {genres[], cast[]} with the best-known actors first."""
    known = cache.setdefault("details", {})
    todo = [q for q in qids if q not in known]
    for n, part in enumerate(chunks(todo, 60)):
        values = " ".join("wd:" + q for q in part)
        genres = sparql(f"""SELECT ?f ?g WHERE {{ VALUES ?f {{ {values} }} ?f wdt:P136 ?genre . ?genre rdfs:label ?g FILTER(LANG(?g) = "en") }}""")
        cast = sparql(f"""SELECT ?f ?name ?fame WHERE {{ VALUES ?f {{ {values} }} ?f wdt:P161 ?p . ?p wikibase:sitelinks ?fame ; rdfs:label ?name FILTER(LANG(?name) = "en") }}""")
        for q in part:
            known[q] = {"genres": [], "cast": []}
        for r in genres:
            known[qid(r["f"])]["genres"].append(r["g"])
        people = {}
        for r in cast:
            people.setdefault(qid(r["f"]), []).append((int(r["fame"]), r["name"]))
        for q, rows in people.items():
            known[q]["cast"] = [name for _, name in sorted(set(rows), reverse=True)[:8]]
        if n % 10 == 0:
            save(cache)
            print(f"  cast and genres: {min((n + 1) * 60, len(todo))}/{len(todo)}", flush=True)
        time.sleep(0.3)
    save(cache)
    return known


def summary_for(titles, cache, minutes=25):
    """Wikipedia article title -> {plot, poster}, 20 articles per request.

    Wikipedia limits anonymous traffic tightly, so this goes slowly, backs off when told to, and
    stops after `minutes`. Whatever is missing is picked up the next time the script runs.
    """
    known = cache.setdefault("summaries", {})
    todo = [t for t in titles if t not in known]
    api = "https://en.wikipedia.org/w/api.php?"
    deadline = time.time() + minutes * 60
    for n, part in enumerate(chunks(todo, 20)):
        if time.time() > deadline:
            print("  time is up for this run; run the script again later for the rest", flush=True)
            break
        params = {"action": "query", "format": "json", "formatversion": "2", "redirects": "1", "prop": "extracts|pageimages",
                  "exintro": "1", "explaintext": "1", "exlimit": "20", "piprop": "thumbnail", "pithumbsize": "330", "pilicense": "any",
                  "pilimit": "20", "titles": "|".join(part)}
        q = None
        for wait in (0, 45, 90, 180):
            time.sleep(wait)
            try:
                q = http(api + urllib.parse.urlencode(params), tries=1).get("query", {})
                break
            except Exception:
                q = None
        if q is None:
            continue  # left out of the cache, so the next run asks again
        back = {}
        for step in q.get("normalized", []) + q.get("redirects", []):
            back[step["to"]] = back.get(step["from"], step["from"])
        for page in q.get("pages", []):
            if page.get("missing"):
                continue
            known[back.get(page["title"], page["title"])] = {"plot": page.get("extract", ""), "poster": (page.get("thumbnail") or {}).get("source", "")}
        if n % 5 == 0:
            save(cache)
            print(f"  descriptions and posters: {min((n + 1) * 20, len(todo))}/{len(todo)}", flush=True)
        time.sleep(3)
    save(cache)
    return known


def descriptions_for(qids, cache):
    """q -> Wikidata's one-line description ("2001 Japanese animated film by Hayao Miyazaki"), the fallback text."""
    known = cache.setdefault("desc", {})
    todo = [q for q in qids if q not in known]
    for part in chunks(todo, 150):
        for q in part:
            known[q] = ""
        for r in sparql(f"""SELECT ?f ?d WHERE {{ VALUES ?f {{ {' '.join('wd:' + q for q in part)} }} ?f schema:description ?d FILTER(LANG(?d) = "en") }}"""):
            known[qid(r["f"])] = r["d"]
        time.sleep(0.3)
    save(cache)
    return known


def save(cache):
    tmp = CACHE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, CACHE)


# ---------------------------------------------------------------- applying it
def clean_plot(text, limit=700):
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = cut.rfind(". ")
    return cut[: end + 1] if end > 200 else cut.rstrip() + "…"


def poster_path(url):
    if not url:
        return ""
    if "/thumb/" in url:  # Wikimedia only serves thumbnails at standard widths
        url = re.sub(r"/\d+px-([^/]+)$", r"/330px-\1", url)
    return url[len(POSTER_PREFIX):] if url.startswith(POSTER_PREFIX) else url


def better_title(old, label):
    """The common English name, when it is a tidier form of the stored one."""
    m = re.match(r"^(.*), (The|A|An)$", old)
    if m:
        return f"{m.group(2)} {m.group(1)}"
    return label or old


def alt_names(title, names):
    seen, out = {norm(title)}, []
    for a in names:
        a = a.strip()
        if 2 <= len(a) <= 60 and re.search(r"[A-Za-z0-9]", a) and norm(a) not in seen and not re.search(r"[^\x00-ɏ]", a):
            seen.add(norm(a))
            out.append(a)
    return out[:4]


def main(out, refresh=False):
    cache = {} if refresh or not os.path.exists(CACHE) else json.load(open(CACHE, encoding="utf-8"))
    index_path = os.path.join(out, "index.json")
    index = json.load(open(index_path, encoding="utf-8"))
    films, shard, core = index["films"], index["shard"], index["corePosters"]
    rest_posters = json.load(open(os.path.join(out, "posters.json"), encoding="utf-8"))
    shards = {}

    def load_shard(n):
        if n not in shards:
            path = os.path.join(out, "details", f"{n}.json")
            shards[n] = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else []
        return shards[n]

    hrefs = []
    for fid in range(len(films)):
        hrefs.append((load_shard(fid // shard)[fid % shard][2] or "").replace("_", " "))

    # 1. existing films: fame, common name, other names
    print("Looking up existing films…", flush=True)
    info = lookup_existing(sorted({h for h in hrefs if h}), cache)
    have_q, renamed, boosted, aliased = set(), 0, 0, 0
    for fid, row in enumerate(films):
        w = info.get(hrefs[fid]) if hrefs[fid] else None
        if not w:
            continue
        have_q.add(w["q"])
        old = row[0]
        names = [old] + ([w["label"]] if w["label"] else []) + w["alt"]
        title = old
        if w["links"] >= 30 or re.search(r", (The|A|An)$", old):
            title = better_title(old, w["label"] if w["links"] >= 30 else "")
        if title != old:
            row[0] = title
            renamed += 1
        pop = pop_for(w["links"])
        if pop > row[4]:
            row[4] = pop
            boosted += 1
        alts = alt_names(row[0], names) if w["links"] >= 15 or title != old else alt_names(row[0], [old])
        del row[5:]
        if alts:
            row.append(alts)
            aliased += 1

    # 2. well-known films the database lacks
    print("Finding well-known films that are missing…", flush=True)
    cands = find_new(cache)
    have_key = {(norm(r[0]), r[1]) for r in films}
    have_href = {h for h in hrefs if h}
    new = []
    for q, c in cands.items():
        if q in have_q or c["title"] in have_href or not (1880 <= c["year"] <= THIS_YEAR):
            continue
        key = norm(c["label"])
        if not key or any((key, c["year"] + d) in have_key for d in (0, -1, 1)):
            continue
        new.append((q, c))
    new.sort(key=lambda x: (-x[1]["links"], x[0]))
    print(f"  {len(new)} to add", flush=True)
    det = details_for([q for q, _ in new], cache)
    desc = descriptions_for([q for q, _ in new], cache)
    summ = summary_for([c["title"] for _, c in new], cache)
    alt_new = cache.setdefault("alt_new", {})
    todo = [q for q, _ in new if q not in alt_new]
    for part in chunks(todo, 150):
        for q in part:
            alt_new[q] = []
        for r in sparql(f"""SELECT ?f ?alt WHERE {{ VALUES ?f {{ {' '.join('wd:' + q for q in part)} }} ?f skos:altLabel ?alt FILTER(LANG(?alt) IN ("en", "mul")) }}"""):
            alt_new[qid(r["f"])].append(r["alt"])
        time.sleep(0.3)
    save(cache)

    added = 0
    for q, c in new:
        d, s = det.get(q, {}), summ.get(c["title"]) or {}
        plot = s.get("plot") or (desc.get(q, "")[:1].upper() + desc.get(q, "")[1:] + "." if desc.get(q) else "")
        if not plot and not d.get("cast"):
            continue  # nothing to show for it: skip rather than add an empty film
        g = map_genres(d.get("genres", []), index["genres"])
        row = [c["label"], c["year"], g, poster_path(s.get("poster", "")), pop_for(c["links"])]
        alts = alt_names(c["label"], alt_new.get(q, []))
        if alts:
            row.append(alts)
        fid = len(films)
        films.append(row)
        rest_posters.append("")  # the poster stays in the index row, so it shows on first paint
        load_shard(fid // shard).append([d.get("cast", [])[:10], clean_plot(plot), c["title"].replace(" ", "_")])
        have_key.add((norm(c["label"]), c["year"]))
        added += 1

    # films added on an earlier run that were still waiting for their Wikipedia poster and description
    filled = 0
    for fid in range(core, len(films)):
        s = summ.get(hrefs[fid]) if fid < len(hrefs) else None
        if not s:
            continue
        if s.get("poster") and not films[fid][3] and not rest_posters[fid - core]:
            films[fid][3] = poster_path(s["poster"])
            filled += 1
        row = load_shard(fid // shard)[fid % shard]
        if s.get("plot") and len(row[1]) < 120 and len(s["plot"]) > len(row[1]):
            row[1] = clean_plot(s["plot"])
    if filled:
        print(f"  {filled} posters filled in for films added earlier")

    assert len(rest_posters) == len(films) - core
    written = []

    def dump(path, data):
        text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        written.append(text)

    dump(index_path, index)
    dump(os.path.join(out, "posters.json"), rest_posters)
    for n in sorted(shards):
        dump(os.path.join(out, "details", f"{n}.json"), shards[n])
    version = hashlib.sha1("".join(written).encode("utf-8")).hexdigest()[:12]
    js_dir = os.path.join(os.path.dirname(os.path.abspath(out)), "js")
    with open(os.path.join(js_dir, "data-version.js"), "w", encoding="utf-8") as f:
        f.write(f'// Written by the tools/ data scripts. Changes whenever the film data changes.\nexport const DATA_VERSION = "{version}";\n')
    print(f"{len(films)} films: {added} added, {boosted} made more prominent, {renamed} retitled, {aliased} with other searchable names")


if __name__ == "__main__":
    main(sys.argv[1], "--refresh" in sys.argv)

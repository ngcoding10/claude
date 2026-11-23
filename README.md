# Movi

Beli for movies. Rank every film you've seen by picking which one you liked more. Follow friends, see what they're watching, and find what to watch next.

The app lives in [`docs/`](docs/). It's plain HTML, CSS and JavaScript modules with no build step, plus a database of **36,115 films**. It runs in two modes:

- **Demo mode** (the default). Everything is saved in your browser, alongside a small made-up community of sample members so the social features have something to show. No server needed.
- **Live mode.** Real accounts and real friends, backed by Google Firebase. You turn it on by pasting two public values into `docs/config.js`; see [Backend](#backend).

## Features

**Ranking**
- **Gut check, then head-to-heads.** You say whether you loved a film, thought it was fine, or didn't like it, then pick between it and films you've already ranked. Placing a film takes about log₂(n) picks, around 5 for a 30-film list. There's a "Too close to call" button and a Back button.
- **Scores build themselves** from a film's position in your list. Loved films score 6.8–10, fine ones 3.4–6.7, and films you didn't like 0–3.3.
- **Watch details on every film:** date watched, where (Theater, Streaming, Home, TV, Plane), who you watched it with, a rewatch flag and notes.
- **Re-rank or remove** any film. A quick-add search lets you rank from anywhere (the red **+**).
- **To rank:** paste every movie you've watched in rough form ("karate kid, star wars 1, harry potter"). Movi matches each line to a film, offers to add a whole series, and saves them to rank later, one at a time or all in a row. In live mode, Claude handles nicknames and numbering like "star wars 5" → *The Empire Strikes Back*.

**Lists**
- **Been**, your ranked list. Filter by Loved / Fine / Didn't like, genre, decade and year watched. Sort by rank, recently ranked, recently watched, release year or title, or search within the list.
- **To rank**, films you've watched and listed but not ranked yet.
- **Want to watch**, your watchlist.
- **Recs for you**, films friends sent you with a message.
- **Share your top 10.**

**Social**
- **Feed** of what the people you follow rank and save, with likes, comments, and one-tap save to your watchlist. Following and Everyone tabs.
- **Follow people.** Follows are immediate; every account is visible to signed-in members.
- **Notifications** for new followers, likes, comments and recommendations.
- **Recommend** a film to friends.
- **Leaderboard** of who has ranked the most films, among friends or across everyone.
- **Find people**, ranked by how many films you have in common, plus an invite link.

**Taste**
- **Rec score:** a predicted score for any film you haven't ranked. It comes from friends' scores, weighted by how closely their taste matches yours.
- **Friends' scores and the Movi-wide average** on every film page.
- **Taste match %** with anyone, and a **Compare** tab showing where you agree, where you clash, and films they loved that you haven't ranked.
- **Taste profile:** a movie personality type, genre and decade breakdowns, where you watch, your top 4, weekly streaks, a yearly goal, and 17 badges.
- **Watch together:** pick friends and Movi suggests films nobody in the group has seen that everyone is likely to enjoy.

**Discover**
- **Quick picks:** popular films with "Seen it / Save / Skip" buttons, the fastest way to build your list.
- **Recommended for you, Trending with friends, Top rated on Movi, Because you loved…**, and rows by genre.
- **Search** 36k films by title or year with genre and decade filters, and search people.

**Account**
- Sign up with email or **Continue with Google** (live mode), password reset by email (live mode), and onboarding: rank 3 films (or paste a list), then follow people.
- Settings for name, username, bio, avatar color and yearly goal. Change your password, export your data, or delete your Movi data.

## Run it locally

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

It opens in demo mode. Create an account and start ranking.

## Backend

Live mode runs on a Firebase project that Movi shares with the owner's other apps. Everything on the server side lives in **[github.com/ngcoding10/backend-combination](https://github.com/ngcoding10/backend-combination)**: the Firestore security rules and indexes, the Cloud Functions (notifications, like and comment counts, hourly film averages, AI title matching, deleting your data), their tests, and the data model (`docs/DATA-MODEL.md`). This repo is only the website and its public config.

To go live, paste two public values from the Firebase console into [`docs/config.js`](docs/config.js):

```js
window.MOVI_CONFIG = {
  firebase: { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." }, // Project settings → Your apps → Web app
  appCheckSiteKey: "...",                                                      // App Check → reCAPTCHA Enterprise site key
};
```

Both are safe to publish: the security rules protect the data, not these values. Leave `firebase` as `null` and the site stays in demo mode. Sign-in methods (Google, email + password), the allowed website addresses and the AI key are set up in the backend repo and the Firebase console, not here.

How live mode behaves:

- **One account across the owner's apps.** Sign-in and username are shared; signing in to Movi with an account from another app keeps the username. "Delete my Movi data" removes only Movi's data, and the sign-in itself only if no other app is in use.
- **Every account is visible to signed-in members.** There are no private accounts or follow requests; guests can browse films but not profiles.
- **Scores are never stored.** A person's whole ranking is one document of film ids, best first; scores come from position (`scoreFor` in `js/model.js`, the same formula the backend uses).
- **Site-wide averages and "Top rated on Movi" are rebuilt hourly**, so they can be up to an hour behind.
- **People search matches the start** of a username or name.
- **AI title matching** for To rank has a daily limit per person; past it, the built-in matching is used.

`docs/js/core.js` is the shared Firebase module, copied unchanged from `web/core.js` in the backend repo. Don't edit it here: change it there and copy it again.

## Publish with GitHub Pages

In the repo, go to **Settings → Pages**. Under Source, pick **Deploy from a branch**, then choose the branch and the **/docs** folder. The site appears at `https://<user>.github.io/<repo>/`. On phones you can add it to the home screen and it opens full-screen like an app, with a back arrow on sub-pages.

Speed: the first screen needs about 0.5 MB of film data (compressed); posters for less popular films arrive in the background, and repeat visits reuse the browser's copy until the data changes. Link previews (Open Graph), app icons, `robots.txt`, `sitemap.xml` and a `404.html` that redirects into the app are included.

## How the code is organized

```
docs/
  index.html, styles.css
  config.js           the public Firebase settings (null = demo mode)
  data/               film database (index.json + 73 detail files, loaded on demand)
  js/app.js           router, header and tab bar, button handling
  js/state.js         the signed-in user's data and the actions that change it
  js/model.js         scoring, taste match, rec score, streaks, goals, badges
  js/films.js         film database loading and search
  js/rank-flow.js     the ranking flow, "rank all" queue and quick-add search
  js/matcher.js       turns typed movie lists into films (local matching + AI in live mode)
  js/variety.js       keeps suggestion rows fresh between visits
  js/film-sheet.js    film page, watch details, recommend, share
  js/views/           feed, discover/search, lists, profile, social, account
  js/core.js          shared Firebase module (sign-in, shared username, Firestore, functions); copied unchanged from the backend repo
  js/api/index.js     picks the data layer and documents the contract both follow
  js/api/demo.js      demo data layer (browser storage + sample community)
  js/api/firebase.js  live data layer (same functions, backed by Firebase)
tests/                browser tests (demo mode, and live mode against the Firebase emulators)
tools/                film database build script
```

The views only ever talk to `js/api/`; nothing else knows which backend is in use. Rules, indexes and Cloud Functions are in the [backend repo](https://github.com/ngcoding10/backend-combination).

## Tests

```bash
cd docs && python3 -m http.server 8765        # in one terminal
cd tests && npm install
npm run e2e:demo                              # full demo-mode walkthrough in a browser
npm run e2e:torank                            # To rank: paste a list, review, add a series, rank the queue
npm run e2e:live                              # two people using live mode against the Firebase emulators
```

`e2e:live` needs the emulators from the backend repo running (Auth 9099, Firestore 8080, Functions 5001). It opens the site as `http://localhost:8765/?emulator`, which is what points it at the emulators; that switch only works on localhost. Nothing in these tests touches a real project.

## The film database

`docs/data/index.json` holds every film's title, year, genres, poster and popularity rank. Plots, cast and Wikipedia links are split into small files under `docs/data/details/`, loaded only when a film page opens. To rebuild it:

```bash
curl -o /tmp/movies.json https://raw.githubusercontent.com/prust/wikipedia-movie-data/master/movies.json
python3 tools/build_movie_db.py /tmp/movies.json docs/data
```

TMDB fills the gaps: posters for 95% of films, genres where Wikipedia had none (TMDB's genres are listed first, with Wikipedia's finer ones like Superhero and Noir added), and descriptions for films whose Wikipedia summary was missing or very short. To refresh it, get a free API key at themoviedb.org (Settings → API), then:

```bash
TMDB_API_KEY=your_key python3 tools/fetch_tmdb_posters.py   # fills tools/tmdb_data.json (resumable)
python3 tools/build_movie_db.py /tmp/movies.json docs/data   # also writes docs/js/data-version.js
```

Coverage today: 36,115 films, 34,417 with posters, 35,887 with genres, and 35,515 with a description.

The key is only used by this script; it never goes into the website. This product uses the TMDB API but is not endorsed or certified by TMDB.

`tools/canon.txt` is a hand-picked list of well-known films that the build script puts near the top of Discover and search. Film data comes from Wikipedia under CC BY-SA, via [wikipedia-movie-data](https://github.com/prust/wikipedia-movie-data). It mostly covers American films up to 2023.

Each film's ID is its position in the database, and rankings are saved by that ID. If you rebuild the database after people have ranked films, check that existing films keep their positions.

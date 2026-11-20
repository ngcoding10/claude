# Movi

Beli for movies. Rank every film you've seen by picking which one you liked more. Follow friends, see what they're watching, and find what to watch next.

The app lives in [`docs/`](docs/). It's plain HTML, CSS and JavaScript modules with no build step, plus a database of **36,115 films**. It runs in two modes:

- **Demo mode** (the default). Everything is saved in your browser, alongside a small made-up community of sample members so the social features have something to show. No server needed.
- **Live mode.** Real accounts and real friends, backed by [Supabase](https://supabase.com). You turn it on by pasting two values into `docs/config.js`; the steps are below.

## Features

**Ranking**
- **Gut check, then head-to-heads.** You say whether you loved a film, thought it was fine, or didn't like it, then pick between it and films you've already ranked. Placing a film takes about log₂(n) picks, around 5 for a 30-film list. There's a "Too close to call" button and a Back button.
- **Scores build themselves** from a film's position in your list. Loved films score 6.8–10, fine ones 3.4–6.7, and films you didn't like 0–3.3.
- **Watch details on every film:** date watched, where (Theater, Streaming, Home, TV, Plane), who you watched it with, a rewatch flag and notes.
- **Re-rank or remove** any film. A quick-add search lets you rank from anywhere (the red **+**).
- **To rank:** paste every movie you've watched in rough form ("karate kid, star wars 1, harry potter"). Movi matches each line to a film, offers to add a whole series, and saves them to rank later, one at a time or all in a row. With the AI function set up (below), Claude handles nicknames and numbering like "star wars 5" → *The Empire Strikes Back*.

**Lists**
- **Been**, your ranked list. Filter by Loved / Fine / Didn't like, genre, decade and year watched. Sort by rank, recently ranked, recently watched, release year or title, or search within the list.
- **To rank**, films you've watched and listed but not ranked yet.
- **Want to watch**, your watchlist.
- **Recs for you**, films friends sent you with a message.
- **Share your top 10.**

**Social**
- **Feed** of what the people you follow rank and save, with likes, comments, and one-tap save to your watchlist. Following and Everyone tabs.
- **Follow people**, including **private accounts** that approve each follow request.
- **Notifications** for new followers, follow requests, likes, comments and recommendations.
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
- Sign up with email or **Continue with Google**, password reset (live mode), and onboarding: rank 3 films (or paste a list), then follow people.
- Settings for name, username, bio, avatar color, private account and yearly goal. Change your password, export your data, or delete your account.

## Run it locally

```bash
cd docs
python3 -m http.server 8000
# open http://localhost:8000
```

It opens in demo mode. Create an account and start ranking.

## Go live with Supabase (about 10 minutes)

1. **Create a project** at [supabase.com](https://supabase.com). The free tier is fine.
2. **Create the database.** In the dashboard, open **SQL Editor → New query**, paste the whole of [`supabase/migrations/20261106000000_movi.sql`](supabase/migrations/20261106000000_movi.sql), and click **Run**. This creates the tables, the security rules that decide who can see and change what, and the notification triggers.
   - If you prefer the CLI: `npx supabase link --project-ref <your-ref>` then `npx supabase db push`.
3. **Connect the app.** In **Project Settings → API**, copy the **Project URL** and the **anon public** key into [`docs/config.js`](docs/config.js):
   ```js
   window.MOVI_CONFIG = {
     supabaseUrl: "https://YOUR-PROJECT.supabase.co",
     supabaseAnonKey: "eyJ...",
   };
   ```
   Both values are safe to publish. The database's security rules protect the data, not the key.
4. **Set up email links.** In **Authentication → URL Configuration**, set **Site URL** to wherever the app is hosted, for example `https://ngcoding10.github.io/claude/`. Add the same address under **Redirect URLs**. This makes sign-up confirmation and password-reset emails link back to your site.
   - Supabase asks new users to confirm their email by default. To let people in right away while testing, turn off **Authentication → Providers → Email → Confirm email**.
5. **Run the second database update.** In the SQL Editor, run [`supabase/migrations/20261118000000_to_rank.sql`](supabase/migrations/20261118000000_to_rank.sql) the same way. It adds the To rank list and uses Google names for Google accounts. Until it's run, To rank lists are saved on each device only.
6. Reload the app. The "Demo mode" note disappears and accounts are now real.

## Sign in with Google (about 10 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com), create a project (any name, e.g. "Movi"), then open **APIs & Services → OAuth consent screen**. Choose **External**, fill in the app name (Movi), your email as support and developer contact, and save. Add yourself under **Test users** while it's in testing, or click **Publish app** so anyone can sign in.
2. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. Application type: **Web application**.
   - **Authorized JavaScript origins:** `https://ngcoding10.github.io`
   - **Authorized redirect URIs:** `https://plnqlxyzqxnhnxgdooiq.supabase.co/auth/v1/callback` (your Supabase project URL plus `/auth/v1/callback`; Supabase shows the exact value on its Google provider page).
   - Click **Create** and copy the **Client ID** and **Client secret**.
3. In Supabase, open **Authentication → Sign In / Providers → Google**, turn it on, paste the Client ID and Client secret, and save.
4. Make sure **Authentication → URL Configuration** lists your site under **Redirect URLs** (step 4 above).

The **Continue with Google** button appears on the sign-in page once the app is connected to Supabase. New Google accounts get their Google name and go through the same onboarding.

## AI title matching for To rank (about 5 minutes)

To rank works without this, using built-in matching that handles typos, numbers ("toy story 3", "rocky iv"), "part 2" and whole series. The AI step adds nicknames and franchise numbering ("lotr 2", "star wars 5").

1. Get an API key at [console.anthropic.com](https://console.anthropic.com) (**API Keys → Create Key**). Matching uses Claude Opus 5.5 at low effort; a list of 50 titles is one short request.
2. In Supabase, open **Edge Functions → Secrets** and add `ANTHROPIC_API_KEY` with that key.
3. Open **Edge Functions → Deploy a new function → Via Editor**, name it `match-films`, replace the example code with [`supabase/functions/match-films/index.ts`](supabase/functions/match-films/index.ts), and click **Deploy**. (CLI alternative: `npx supabase functions deploy match-films`.)

The key stays on Supabase's servers and never reaches the website. Only signed-in members can call the function, and each request is capped at 80 titles. When the function is live, matched lists show a "Matched with AI" tag.

## Publish with GitHub Pages

In the repo, go to **Settings → Pages**. Under Source, pick **Deploy from a branch**, then choose the branch and the **/docs** folder. The site appears at `https://<user>.github.io/<repo>/`. On phones you can add it to the home screen and it opens full-screen like an app, with a back arrow on sub-pages.

Speed: the first screen needs about 0.5 MB of film data (compressed); posters for less popular films arrive in the background, and repeat visits reuse the browser's copy until the data changes. Link previews (Open Graph), app icons, `robots.txt`, `sitemap.xml` and a `404.html` that redirects into the app are included.

## How the code is organized

```
docs/
  index.html, styles.css, config.js
  data/               film database (index.json + 73 detail files, loaded on demand)
  js/app.js           router, header and tab bar, button handling
  js/state.js         the signed-in user's data and the actions that change it
  js/model.js         scoring, taste match, rec score, streaks, goals, badges
  js/films.js         film database loading and search
  js/rank-flow.js     the ranking flow, "rank all" queue and quick-add search
  js/matcher.js       turns typed movie lists into films (local matching + optional AI)
  js/variety.js       keeps suggestion rows fresh between visits
  js/film-sheet.js    film page, watch details, recommend, share
  js/views/           feed, discover/search, lists, profile, social, account
  js/api/demo.js      demo data layer (browser storage + sample community)
  js/api/supabase.js  live data layer (same functions, backed by Supabase)
supabase/
  migrations/         database schema, security rules, functions, triggers (run in order)
  functions/          match-films Edge Function (Claude-powered title matching)
  config.toml         config for running Supabase locally (npx supabase start)
tests/                browser tests (demo + live) and database rule checks
tools/                film database build script
```

Scores are computed the same way in `model.js` and in the database function `movi_score`, so leaderboards and averages always agree with what users see.

## Tests

```bash
cd docs && python3 -m http.server 8765        # in one terminal
cd tests && npm install
npm run e2e:demo                              # full demo-mode walkthrough in a browser
npm run e2e:torank                            # To rank: paste a list, review, add a series, rank the queue
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run schema    # 33 checks of the database rules
SUPABASE_URL=... SUPABASE_ANON_KEY=... npm run e2e:live  # two users interacting on a live backend
```

Point the live tests at a local stack (`npx supabase start`) or a throwaway project, because they create test accounts.

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

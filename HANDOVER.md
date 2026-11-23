# Movi: handover

Written for the chat that will merge Movi, The Pantry and Where Have You Been into one Firebase project.
Movi is a movie ranking app: you pick which of two films you liked more, and each film gets a 0–10 score.
It also has friends, a feed, recommendations and a "To rank" list with AI title matching.

**State at handover (2026-11-23):** live on Supabase. Nothing has been migrated. No backend project, key or rule
was changed while writing this file.

---

## 1. Branches, build and deploy

| What | Where |
|---|---|
| Repo | `ngcoding10/claude` (formerly `nicorgutierrez08-eng/claude`; GitHub redirects) |
| Live branch | `claude/beli-app-template-BJhj8` (this branch). There is no `main`. |
| Other branch | `claude/install-magic-mcp-oxqdA`: an unrelated editor-tooling commit, not part of the app; ignore it. |
| Live site | https://ngcoding10.github.io/claude/ (GitHub Pages, "deploy from a branch": this branch, `/docs` folder) |
| Build | None. Plain HTML/CSS/JS ES modules in `docs/`; push and Pages serves it in about a minute. |
| Copy on ascoding | https://ascoding11.github.io/movi/ and https://ascoding11.com/movi/: a plain copy of `docs/` in `ASCoding11/ASCoding11.github.io` (`movi/`), merged by Arjun in PR #281 plus a follow-up with the legal pages. It does **not** update by itself. The ascoding copy also has one extra line in `movi/index.html`: `<script src="/offline.js" defer>` (Arjun's offline mode). |
| Unmerged / half done | Nothing is open. The fork branches `add-movi` and `movi-legal` (on `ngcoding10/ASCoding11.github.io`) are both merged. |

### `docs/` layout
- `index.html`: the single page (hash router: `#/feed`, `#/discover`, `#/lists/been|want|torank|recs`, `#/u/<username>/<tab>`, `#/film/<id>`, `#/leaderboard`, `#/notifications`, `#/people`, `#/together`, `#/settings`, `#/onboarding`, `#/welcome`).
- `config.js`: `window.MOVI_CONFIG = { supabaseUrl, supabaseAnonKey }`. Empty values switch the app to **demo mode** (`js/api/demo.js`: everything in localStorage, with a fictional sample community).
- `js/api/index.js`: picks the backend and documents the **API contract** that both backends implement. A Firebase backend only needs to implement this same contract (`js/api/firebase.js`); the rest of the app doesn't change.
- `js/api/supabase.js`: the only file that talks to Supabase.
- `js/state.js`: in-memory cache of the signed-in user's data, plus every write action.
- `js/model.js`: score formula, list helpers and taste match. Pure functions, no backend.
- `js/films.js`, `data/`: the static film database (see section 8).
- `privacy.html`, `terms.html`: legal pages (linked from sign-up, Settings and Google's consent screen).
- `404.html`: sends stray `/claude/...` paths to the matching in-app hash route. The base path `/claude/` is hard-coded.

---

## 2. Every place the front end talks to a backend

Everything goes through `api.*` (contract in `docs/js/api/index.js`, Supabase version in `docs/js/api/supabase.js`).
Supabase is reached through supabase-js 2.45.4 from jsDelivr (`+esm`).

| When | Calls (file) | Reads / writes |
|---|---|---|
| Startup | `createSupabaseApi` (`api/supabase.js`) | `GET /auth/v1/settings` (which sign-in providers are on; 4 s timeout) and `getSession` |
| Sign up / in / out, reset, delete | `signUp`, `signIn`, `signInWithGoogle`, `resetPassword`, `updatePassword`, `usernameAvailable`, `deleteAccount` (`views/account.js`); `signOut`, `userMeta` (`app.js`) | Supabase Auth; RPCs `username_available`, `delete_me` |
| After sign-in (`loadSession`, `state.js`) | `getProfile`, `getRankings`, `getWatchlist`, `getFollows`, then `getBacklog`, `unreadCount`, `rankingsOfUsers` (people you follow, for recommendation scores) | profiles, rankings, watchlist, follows, backlog, notifications, rankings of followees |
| Finishing a ranking (`rank-flow.js`, `state.js`) | `saveLists` (RPC `save_lists`), `postActivity` | Rewrites all three of the user's lists, then posts a `ranked` feed item |
| Ranking details | `updateEntry` (`state.js`) | rankings: note, watched_on, watched_where, watched_with, rewatch |
| Remove a ranking | `saveLists` | Lists without that film |
| Watchlist | `addWatch`, `removeWatch` (`state.js`); `postActivity` kind `want` | watchlist, activities |
| To rank | `getBacklog`, `addBacklog`, `removeBacklog` (`state.js`), `matchTitles` (`matcher.js`) | backlog table; Edge Function `match-films` |
| Follows | `follow`, `unfollow`, `removeFollower`, `approveFollower` (`state.js`); `getFollows` (`state.js`, `film-sheet.js`, `views/profile.js`, `views/social.js`) | follows |
| Feed | `getFeed` (`views/feed.js`, `views/profile.js`), `deleteActivity` (`app.js`), `like`/`unlike`, `getComments`/`addComment`/`deleteComment` (`views/feed.js`) | activities (+ like and comment counts), likes, comments |
| Notifications | `getNotifications`, `markNotificationsRead` (`views/social.js`), `unreadCount` (`state.js`, on load and periodically) | notifications |
| Recommendations to a friend | `sendRec` (`film-sheet.js`), `getRecsForMe` (`views/lists.js`), `deleteRec` (`app.js`) | recommendations |
| Film page | `rankingsForFilm` (friends' scores, up to 200 rows), `filmStats` (RPC `film_stats`) (`film-sheet.js`) | rankings, aggregate |
| Profiles and people | `getProfileByUsername` (`views/profile.js`), `searchUsers` (`views/discover.js`), `listProfiles` (several views), `updateProfile` (`state.js`, Settings) | profiles |
| Leaderboard / Discover | `topFilms` (RPC `top_films`, `views/discover.js`), `listProfiles` ordered by `ranked_count` (`views/social.js`) | aggregate, profiles |
| Watch together | `getWatchlist`, `rankingsOfUsers` (`views/social.js`) | watchlists and rankings of the chosen friends |

Images come straight from `image.tmdb.org` (no key). The film database is static JSON on the same site.

---

## 3. Data model (Supabase Postgres)

Source of truth: `supabase/migrations/20261106000000_movi.sql` (everything) and `supabase/migrations/20261118000000_to_rank.sql` (`backlog` table, Google-aware `handle_new_user`).
All tables have row-level security (RLS). `auth.uid()` is the signed-in user. `film_id` is a **position in `docs/data/index.json`** (0-based int), and must stay stable.

**Visibility rule `can_view(target)`:** true if `target` is me, or `target`'s profile is not private, or I have an **accepted** follow on `target`. It gates rankings, watchlist, activities, likes and comments.

| Table | Fields | Read | Write |
|---|---|---|---|
| `profiles` | `id` uuid PK = auth user id; `username` unique, `^[a-z0-9_.]{3,20}$`; `display_name` ≤ 40; `bio` ≤ 160; `avatar_hue` 0–359 (avatar = initials on a color, **no photo**); `is_private` bool; `yearly_goal` 1–1000 (default 52); `ranked_count` int (server-maintained); `created_at` | Everyone, including signed-out | Owner, only `username, display_name, bio, avatar_hue, is_private, yearly_goal`. Rows are created only by the sign-up trigger. |
| `rankings` | PK (`user_id`, `film_id`); `bucket` loved/fine/disliked; `pos` ≥ 0 (order within bucket, 0 = best); `score` 0–10 (1 decimal, computed); `note` ≤ 2000; `watched_on` date; `watched_where` ≤ 40; `watched_with` ≤ 120; `rewatch` bool; `created_at`; `updated_at` (changes only when the bucket changes) | `can_view(user_id)` | Insert/delete/positions **only via `save_lists`**. Owner may update `note, watched_on, watched_where, watched_with, rewatch`. |
| `watchlist` | PK (`user_id`, `film_id`); `from_user` (who recommended it, nullable); `created_at` | `can_view(user_id)` | Owner insert/delete |
| `backlog` ("To rank") | PK (`user_id`, `film_id`); `created_at` | Owner only | Owner insert/delete; no updates |
| `follows` | PK (`follower`, `followee`); `status` pending/accepted; `created_at`; follower ≠ followee | Accepted rows: everyone. Pending rows: the two people involved. | Insert as yourself (status forced by trigger). Delete if you're either side. Followee may update status to accepted (approve). |
| `activities` (feed posts) | `id` bigint identity; `user_id`; `kind` ranked/want; `film_id`; `bucket`; `score`; `note` ≤ 2000; `created_at` | `can_view(user_id)` | Owner insert/delete; owner may update `note, score, bucket` |
| `likes` | PK (`activity_id`, `user_id`); `created_at` | If the activity is viewable | Like a viewable activity as yourself; unlike your own |
| `comments` | `id`; `activity_id`; `user_id`; `body` 1–500; `created_at` | If the activity is viewable | Comment on a viewable activity as yourself. Delete your own comment, or any comment on your own activity. |
| `recommendations` | `id`; `from_user`; `to_user` (≠ from); `film_id`; `message` ≤ 280; `created_at` | Sender or recipient | Insert as sender; delete if sender or recipient |
| `notifications` | `id`; `user_id` (recipient); `actor_id`; `kind` follow/follow_request/follow_accepted/like/comment/rec; `activity_id`; `film_id`; `body` (first 140 chars of comment or message); `read`; `created_at` | Recipient | **Created only by triggers.** Recipient may set `read` and delete. |

Deleting an auth user cascades through every table (`on delete cascade`); `watchlist.from_user` becomes null.

### SQL functions

| Function | What it does | Called by |
|---|---|---|
| `movi_score(bucket, pos, n)` | The score formula. Loved 6.8–10, fine 3.4–6.7, disliked 0–3.3. Top of a bucket = its max, bottom = its min, linear in between. A lone film gets lo + 75% of the range. Rounded to 0.1. Same as `scoreFor()` in `docs/js/model.js`. | `save_lists` |
| `can_view(target)` | Visibility rule above (security definer). | RLS policies |
| `username_available(name)` | true if `name` matches the username pattern and isn't taken. Callable signed-out. | Sign-up form (`views/account.js`), as you type |
| `handle_new_user()` trigger on `auth.users` insert | Creates the profile. Username = the sign-up `username` metadata, else the email's local part, lowercased and cleaned, cut to 16 chars, prefixed `movi` if under 3 chars, with a random 4-digit suffix until unique. Display name = `display_name` metadata, else Google `full_name`/`name`, else the username. Random `avatar_hue`. | Supabase Auth on sign-up (email or Google) |
| `save_lists(loved int[], fine int[], disliked int[])` | One transaction. Rejects duplicates. Deletes the caller's rankings not in the lists, upserts every listed film with bucket, pos and recomputed score (keeping notes and details), bumps `updated_at` only when the bucket changes, and sets `profiles.ranked_count`. | `api.saveLists` after every ranking, removal or reorder (`state.js`) |
| `film_stats(ids int[])` | Average score and count per film **across all users** (ignores privacy). | Film page (`film-sheet.js`) |
| `top_films(min_count=2, lim=30)` | Films with at least `min_count` rankings, ordered by average score then count (`lim` ≤ 100). | Discover / leaderboard (`views/discover.js`) |
| `delete_me()` | Deletes the caller's auth user; everything cascades. | Settings → Delete account (`views/account.js`) |
| `follows_set_status()` before-insert trigger | Status = `pending` if the followee is private, else `accepted`. | Every follow |
| `notify_follow()` | Insert → `follow` or `follow_request` notification to the followee. Pending→accepted → deletes the request notification and sends `follow_accepted` to the follower. | follows insert/update |
| `notify_like()`, `notify_comment()` | Notify the activity's owner (not for your own). The comment notification carries the first 140 chars. | likes / comments insert |
| `notify_rec()` | Notifies the recipient with the first 140 chars of the message. | recommendations insert |

---

## 4. Server code

**Supabase Edge Function `match-films`** (`supabase/functions/match-films/index.ts`, Deno):
- **Purpose:** turns typed titles ("star wars 1", "lotr 2") into real films.
- **Input:** `POST { lines: [{ text, hints: [{ title, year }] }] }`
  - At most 80 lines; text ≤ 200 chars; ≤ 12 hints per line.
  - Hints are lookalike titles from the local database.
- **Output:** `{ results: [{ line, films: [{title, year}], series: [{title, year}] }] }`. The browser maps the titles back to film ids (`docs/js/matcher.js`).
- **Auth:** requires a signed-in user's token. Errors: 401 (no or invalid token), 400 (bad body or over 80 lines), 429 (Anthropic rate limit), 502 (model error), 500 (missing secret).
- **Model call:** Anthropic SDK `npm:@anthropic-ai/sdk@1.9.0`, model `claude-opus-5-5`, `effort: "low"`, structured JSON output, beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`, `max_tokens` 16000.
- **The browser sends 60 lines per request** and, if the function fails, falls back to local matching only.
- **Secrets (names only):**
  - `ANTHROPIC_API_KEY`: set by Nico in Supabase → Edge Functions → Secrets. It holds the Claude Console key named `movi-match-films`.
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY`: provided automatically by Supabase.
- **Not in the repo:** the TMDB key (`TMDB_API_KEY`, used only by the offline script `tools/fetch_tmdb_posters.py`).

There's no other server code.

---

## 5. Sign-in, usernames, follows

- **Methods:**
  - Email and password (minimum 6 characters; email confirmation is **off**).
  - "Continue with Google" through Supabase Auth. Google Cloud project `onyx-zodiac-515203-e3`, OAuth client `1079441217435-71jq3rb2lcd9apm4c1fjln6p9bga4ml0.apps.googleusercontent.com`.
  - The Google button only appears when Supabase reports Google as enabled.
- **Password reset:** by email link back to `#/settings`.
- **Redirects:** sign-in redirects back to `location.origin + location.pathname`. Supabase's allowed redirect URLs cover `ngcoding10.github.io/claude/**`, `ascoding11.github.io/movi/**` and `ascoding11.com/movi/**`.
- **Usernames:**
  - Chosen at sign-up (live availability check), and changeable in Settings.
  - Lowercase `a-z 0-9 _ .`, 3–20 chars, unique.
  - Google users get one generated from their email (see `handle_new_user`).
  - Profile URLs are `#/u/<username>`.
- **Onboarding:** first sign-in goes to `#/onboarding` (rank a few films, follow people), tracked in localStorage.
- **Follows:** one-way, Instagram-style. A public profile is followed instantly; a private one gets a request that the owner approves or declines in Notifications. Owners can remove followers. Following affects the feed, recommendation scores ("friends" = people you follow) and private-profile visibility.

---

## 6. Real users today (checked 2026-11-23, read-only)

- **1 account** (Nico's, created 2026-11-08, public profile).
- **35 rankings and 35 feed posts.** No follows.
- Watchlist, To rank, notes and notifications for that account may also exist.
- Not known from outside: whether this account signed up with Google or with email.
- **Must not lose:** the 35 rankings, **in their order within each bucket** (`bucket` + `pos`; the scores are derived from them), plus any notes/watch details, watchlist and To rank list. Export first with Settings → Your data → **Export my data** (JSON), or the Supabase table editor.

---

## 7. Browser storage

| Key | What |
|---|---|
| `sb-plnqlxyzqxnhnxgdooiq-auth-token` | supabase-js session (localStorage) |
| `movi.onboarded.<uid>` | Finished onboarding |
| `movi.skip.<uid>` | Films the user tapped "Skip" on (never suggested again) |
| `movi.recentShown` | Recently shown suggestions, pushed back for 6 hours (variety) |
| `movi.backlog.<uid>` | **Fallback only:** To rank list when the `backlog` table is missing. The table exists now, so it's unused. |
| `movi.demo.world.v1` | Demo mode's whole fake database |

The film database is fetched with `cache: "force-cache"` and versioned URLs (`docs/js/data-version.js`).

---

## 8. Static film database (no backend)

- `docs/data/index.json`: 36,115 films. **A film's id is its array index, so never re-sort the file or delete from it.** Posters for the top 3,000 are inline.
- `docs/data/posters.json`: the rest of the posters, loaded in the background.
- `docs/data/details/N.json`: 73 shards with descriptions and genres.
- Built offline by `tools/build_movie_db.py` (Wikipedia dataset) and `tools/fetch_tmdb_posters.py` (needs `TMDB_API_KEY` in the environment; never committed).

---

## 9. Tests

All need Playwright. They use the globally installed copy: `NODE_PATH=$(npm root -g)`. Serve the site first: `cd docs && python3 -m http.server 8765`.

| Test | What | Run |
|---|---|---|
| `tests/e2e-demo.cjs` | Full walk-through in **demo mode**: sign-up, onboarding, ranking, follows, likes and comments, notifications, discover, film page, recommendations, lists, profiles, settings, sign out/in, phone layout | `cd tests && node e2e-demo.cjs` |
| `tests/e2e-torank.cjs` | To rank: paste list, matching, series, queue ranking (demo mode) | `node e2e-torank.cjs` |
| `tests/e2e-live.cjs` | Same flows against a **local** Supabase | `SUPABASE_ANON_KEY=<local anon key> node e2e-live.cjs` |
| `tests/schema.test.mjs` | 33 checks of RLS, RPCs and triggers against local Supabase (needs `@supabase/supabase-js` installed next to it) | `SUPABASE_ANON_KEY=... node schema.test.mjs` |

**Local Supabase:**
```
npx -y supabase@2.54.11 start -x studio,imgproxy,logflare,vector,realtime,storage-api,postgres-meta,supavisor,mailpit
```
It needs Docker. Migrations in `supabase/migrations` apply automatically.

**Never point tests at the real project.** `docs/config.js` holds the live settings, and the tests override it to demo mode or local Supabase. For a Firebase version, the demo tests keep working unchanged, because they don't touch a backend.

---

## 10. Known bugs and loose ends

- **The ascoding copy is manual:** any change to `docs/` must be copied into the ascoding repo's `movi/` again. Keep `preview.jpg` and the `/offline.js` line there; leave out `404.html`, `robots.txt` and `sitemap.xml`.
- **Google sign-in on ascoding was not tested with a real account** (the redirect allow-list was set, per Nico).
- **Each site address keeps its own session:** a person signs in once on each address.
- **`film_stats` and `top_films` ignore privacy:** private users' scores count in public averages, and the leaderboard ranks everyone by `ranked_count` (counts only, no film details).
- **Fixed limits:**
  - `rankingsOfUsers` caps at 10,000 rows (recommendation scores for people who follow very many heavy rankers).
  - `rankingsForFilm` caps at 200.
  - The feed pages by 20.
- **`api/supabase.js` still has the local fallback for a missing `backlog` table.** It can be removed.
- **`404.html` hard-codes `/claude/`.** On ascoding, `/movi/<path>` 404s go to ascoding's own 404 page instead (only matters for shared deep links without `#`).
- **Nothing half-finished in the code.**

---

## 11. Answers for the merge

### What would break if every collection were renamed with an app prefix (`movi_`)?
- **Nothing outside Movi.** Movi is on Supabase today, so the Firebase version is new code anyway, and prefixing costs nothing.
- **Inside Movi, only `docs/js/api/` names collections.** The UI calls `api.*` only. Write `js/api/firebase.js` against the same contract with `movi_*` names; no view needs to change.
- **One thing to keep:** `film_id` stays the integer index into `docs/data/index.json`. Store it as a number (or a string of that number); don't re-key films.

### Can Movi use one shared account record (uid, username, display name, photo)?
**Yes.**
- **Shared fields Movi needs:** `uid`, `username`, `displayName`.
- **Username format:** Movi's is `^[a-z0-9_.]{3,20}$`. A shared format needs to be at least that strict, or Movi's profile URLs (`#/u/<username>`) and mentions need to accept the shared one.
- **Photo:** optional. Movi has no photo today (it shows initials on `avatar_hue`); it can show the shared photo when there is one.
- **Movi-only fields go in `movi_profiles/{uid}`:** `bio`, `is_private`, `yearly_goal`, `avatar_hue`, `ranked_count`, `created_at`.
- **Changes needed:**
  - Sign-up stops creating its own username; it uses the shared one.
  - Settings' username field edits the shared record.
  - `username_available` becomes the shared check.

### Can the Supabase users be exported into Firebase Auth with the same user IDs and passwords, and Google sign-ins?
**Yes**, with the Firebase Admin SDK `importUsers` or `firebase auth:import`, run once by someone with access to both projects.
- **User IDs:** Firebase uids can be any string up to 128 characters, so each Supabase uuid can stay the uid. Then every `user_id` reference in the data carries over unchanged.
- **Passwords:** Supabase keeps bcrypt hashes in `auth.users.encrypted_password` (`$2a$10$…`). Firebase's import supports `hash: { algorithm: 'BCRYPT' }`, so passwords keep working without a reset. Reading `auth.users` needs the dashboard SQL editor or the service-role key; never put that key in the site.
- **Google sign-ins:** export `auth.identities` (provider `google`, `provider_id` = the Google account id, the same across OAuth clients). Import with `providerData: [{ providerId: 'google.com', uid: <google id>, email, displayName }]`. Then "Sign in with Google" on the new project lands on the same uid. Turn on Google in the new project's Auth first.
- **Emails:** import with `emailVerified` from `email_confirmed_at`.
- **In practice there is 1 account (Nico's).** Re-creating it and re-importing the 35 rankings from the "Export my data" JSON is just as easy as a bulk import.

### Which features need server-side counters (or Cloud Functions) once there is no SQL?

| Today in SQL | Firebase replacement |
|---|---|
| `profiles.ranked_count` (set by `save_lists`) | Counter on `movi_profiles/{uid}`, updated in the same batch as the lists, or by a function on write. Used for the people leaderboard and sorting. |
| `film_stats` (average score + count per film, all users) | Function-maintained `movi_film_stats/{filmId}` `{ sum, count }`, updated on ranking add, remove or score change. Firestore's `average()` aggregation could work on a collection-group query, but rules must then let everyone read every ranking, which breaks private profiles. |
| `top_films` (group-by across all rankings) | Same `movi_film_stats` docs, queried `orderBy(avg)` with `count >= 2`. Can't be done client-side. |
| `save_lists` (atomic rewrite of the three lists + recomputed scores) | Store each user's lists in **one doc** (`movi_lists/{uid}`: `{ loved: [ids], fine: [ids], disliked: [ids] }`, scores computed on read by `scoreFor`), with notes and details in `movi_entries/{uid}_{filmId}`. One write keeps it atomic. Rules check the owner and that ids are unique ints. |
| Like and comment counts on feed posts (aggregates) | Counters on each `movi_activities` doc (function, or `increment()` with rules), or Firestore `count()` per post (slower on long feeds). |
| Unread notification count | Firestore `count()` query where `read == false`; no counter needed. |
| Notifications (four triggers: follow, follow request/accepted, like, comment, rec) | Cloud Functions on create/update of follows, likes, comments, recommendations. Rules alone can't safely let users write into someone else's inbox. |
| Follow status pending/accepted from the target's privacy | Function on create, or a rule that requires `status == (target.is_private ? 'pending' : 'accepted')` with a `get()` of the target's profile. |
| `can_view` (private profiles) | Rules: `get()` the owner's `movi_profiles` doc and `exists()` an accepted follow doc keyed `{follower}_{followee}`. |
| `username_available` + uniqueness | Shared `usernames/{name}` docs written in a transaction (Where Have You Been already does this). |
| `delete_me` cascade | Function on Auth user delete (or a callable) that deletes the user's docs across every `movi_*` collection. |
| `handle_new_user` profile creation | Client creates `movi_profiles/{uid}` on first sign-in (rules: only your own, only allowed fields), or a function on user create. |
| `match-films` Edge Function | Cloud Function (Blaze) with the Anthropic key in Secret Manager, checking the Firebase ID token; same input, output and limits. |

// Live backend: Firebase (Auth + Firestore + Cloud Functions), through the shared core.js.
// Every method mirrors api/demo.js; see api/index.js for the contract. Firestore documents use
// camelCase (see DATA-MODEL.md in the backend repo); this file maps them to the snake_case rows
// the views expect, so nothing outside this file knows which backend is in use.
import { createCore, loadSdkFromCdn } from "../core.js";
import { scoreFor, ORDER } from "../model.js";

const IN_MAX = 30; // Firestore allows at most 30 values in an "in" filter
const PROFILE_TTL = 60000;
const NOTE_LOOKUPS = 60; // film page: how many people's notes to fetch

const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
// Ids become part of a document path, so they must be plain names.
const okId = (id) => typeof id === "string" && id.length > 0 && id.length < 200 && !id.includes("/");
const isFilm = (v) => Number.isInteger(v) && v >= 0 && v < 10000000;
const hue = () => Math.floor(Math.random() * 360);

export async function createFirebaseApi({ config = null, appCheckSiteKey = null, emulator = false } = {}) {
  const core = createCore({ appName: "movi", sdk: await loadSdkFromCdn(), config, appCheckSiteKey, emulator });
  const F = core.F, db = core.db;
  await core.ready;

  const col = (name) => F.collection(db, name);
  const ref = (name, id) => F.doc(db, name, String(id));
  const now = () => F.serverTimestamp();
  const me = () => core.user?.uid ?? null;
  const requireUser = () => { const id = me(); if (!id) throw new Error("Please sign in first"); return id; };
  const data = (snap) => snap.data({ serverTimestamps: "estimate" });
  const iso = (t) => (t?.toDate ? t.toDate() : t != null ? new Date(t) : new Date()).toISOString();
  const friendly = (e) => {
    const code = String(e?.code ?? "");
    if (code === "permission-denied") return new Error("That isn't allowed. Try signing out and back in.");
    if (code === "unavailable") return new Error("You seem to be offline");
    return e instanceof Error ? e : new Error(String(e));
  };
  // Messages from Cloud Functions can arrive with the HTTP status tacked on ("... [429]").
  const plain = (msg) => String(msg || "Something went wrong. Try again.").replace(/\s*\[\d{3}\]\s*$/, "");
  const run = async (fn) => { try { return await fn(); } catch (e) { throw friendly(e); } };
  // Deleting a document that is already gone is refused by the rules; treat that as done.
  const remove = async (r) => {
    try { await F.deleteDoc(r); } catch (e) {
      const snap = await F.getDoc(r).catch(() => null);
      if (!snap || snap.exists()) throw friendly(e);
    }
  };
  // Creating a document that already exists (a second like or follow) is also refused; same idea.
  const createOnce = async (r, value) => {
    try { await F.setDoc(r, value); } catch (e) {
      const snap = await F.getDoc(r).catch(() => null);
      if (!snap?.exists()) throw friendly(e);
    }
  };

  // ───────── profiles ─────────
  const toProfile = (id, d) => ({
    id, username: d.username, display_name: d.displayName, bio: d.bio ?? "", avatar_hue: d.avatarHue ?? 40,
    yearly_goal: d.yearlyGoal ?? 52, ranked_count: d.rankedCount ?? 0, created_at: iso(d.createdAt),
  });
  const profileCache = new Map(); // uid -> { at, p }
  const remember = (p) => { if (p) profileCache.set(p.id, { at: Date.now(), p }); return p; };
  async function profileOf(id, fresh = false) {
    if (!okId(id) || !me()) return null;
    const hit = profileCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < PROFILE_TTL) return hit.p;
    const snap = await F.getDoc(ref("movi_profiles", id));
    if (!snap.exists()) { profileCache.delete(id); return null; }
    return remember(toProfile(id, data(snap)));
  }
  async function profilesOf(ids) {
    const list = uniq(ids);
    const ps = await Promise.all(list.map((id) => profileOf(id).catch(() => null)));
    return new Map(list.map((id, i) => [id, ps[i]]));
  }
  const withProfiles = async (rows, key = "user_id") => {
    const map = await profilesOf(rows.map((r) => r[key]));
    return rows.map((r) => ({ ...r, profile: map.get(r[key]) || null }));
  };

  /**
   * Makes sure the signed-in person has a Movi profile. Someone who already has a username from
   * another of the owner's apps keeps it; otherwise one is claimed (the name they typed, or one
   * suggested from their Google name). Account, username and profile are written all-or-nothing.
   */
  async function ensureProfile({ username = null, displayName = null } = {}) {
    const uid = me();
    if (!uid) return null;
    const existing = await profileOf(uid, true);
    if (existing) return existing;
    const [account, listsSnap] = await Promise.all([core.account.get(uid), F.getDoc(ref("movi_lists", uid))]);
    const l = listsSnap.exists() ? listsSnap.data() : null;
    const rankedCount = l ? ORDER.reduce((n, b) => n + (Array.isArray(l[b]) ? l[b].length : 0), 0) : 0;
    const profile = (name, shown) => {
      const dn = String(shown || name).trim().slice(0, 40) || name;
      return { username: name, displayName: dn, nameLower: dn.toLowerCase(), bio: "", avatarHue: hue(), yearlyGoal: 52, rankedCount, createdAt: now() };
    };
    if (account?.username) {
      await F.setDoc(ref("movi_profiles", uid), profile(account.username, displayName || account.displayName || core.user.name));
    } else {
      const shown = String(displayName || core.user.name || "").trim().slice(0, 40);
      const claim = (name) => core.account.claim(name, {
        displayName: shown || name,
        extra: (batch) => { batch.set(ref("movi_profiles", uid), profile(name, shown)); },
      });
      const typed = username ? core.account.normalize(username) : null;
      if (typed && core.account.valid(typed) && (await core.account.isFree(typed))) await claim(typed);
      else if (typed) { const e = new Error(`@${typed} is taken, so try another`); e.code = "username-taken"; throw e; }
      else await claim(await core.account.suggest(core.user.name || core.user.email || "movi"));
    }
    return profileOf(uid, true);
  }

  // ───────── my own ranking, kept in memory so saving needs no extra reads ─────────
  let mine = null; // { uid, at: {filmId: ms}, ids: Set<filmId>, entries: Map<filmId, entry doc> }
  const forget = () => { mine = null; profileCache.clear(); stamps.clear(); };
  const stamps = new Map(); // ISO time shown to the views -> exact Firestore timestamp (feed paging)
  const stamp = (t) => {
    const s = iso(t);
    if (t?.toDate) { if (stamps.size > 3000) stamps.clear(); stamps.set(s, t); }
    return s;
  };

  const ENTRY_DEFAULT = { note: "", watchedOn: null, watchedWhere: "", watchedWith: "", rewatch: false };
  const entryFields = (d = {}) => ({
    note: String(d.note ?? "").slice(0, 2000),
    watchedOn: /^\d{4}-\d{2}-\d{2}$/.test(d.watchedOn || "") ? d.watchedOn : null,
    watchedWhere: String(d.watchedWhere ?? "").slice(0, 40),
    watchedWith: String(d.watchedWith ?? "").slice(0, 120),
    rewatch: !!d.rewatch,
  });
  const entryEmpty = (e) => !e.note && !e.watchedOn && !e.watchedWhere && !e.watchedWith && !e.rewatch;

  async function loadLists(userId) {
    const [listsSnap, entriesSnap] = await Promise.all([
      F.getDoc(ref("movi_lists", userId)),
      F.getDocs(F.query(col("movi_entries"), F.where("uid", "==", userId))),
    ]);
    const lists = listsSnap.exists() ? data(listsSnap) : {};
    const entries = new Map(entriesSnap.docs.map((d) => [d.get("filmId"), data(d)]));
    return { lists, entries };
  }
  /** One movi_lists document as rows: bucket, position, score (worked out from position). */
  function listRows(userId, lists, entries = null) {
    const at = lists.at || {};
    const updated = iso(lists.updatedAt);
    const rows = [];
    const seen = new Set();
    for (const bucket of ORDER) {
      const ids = (Array.isArray(lists[bucket]) ? lists[bucket] : []).filter((id) => isFilm(id) && !seen.has(id) && seen.add(id));
      ids.forEach((film_id, pos) => {
        const created = at[film_id] != null ? iso(Number(at[film_id])) : updated;
        const row = { user_id: userId, film_id, bucket, pos, score: scoreFor(bucket, pos, ids.length), created_at: created };
        if (entries) {
          const e = entries.get(film_id);
          Object.assign(row, {
            note: e?.note ?? "", watched_on: e?.watchedOn ?? null, watched_where: e?.watchedWhere ?? "", watched_with: e?.watchedWith ?? "",
            rewatch: !!e?.rewatch, updated_at: e?.updatedAt ? iso(e.updatedAt) : updated,
          });
        }
        rows.push(row);
      });
    }
    return rows;
  }
  async function myState() {
    const uid = requireUser();
    if (mine?.uid === uid) return mine;
    const { lists, entries } = await loadLists(uid);
    mine = { uid, at: { ...(lists.at || {}) }, ids: new Set(ORDER.flatMap((b) => lists[b] || [])), entries };
    return mine;
  }

  // ───────── feed helpers ─────────
  const toActivity = (d) => {
    const a = data(d);
    return {
      id: d.id, user_id: a.uid, kind: a.kind, film_id: a.filmId, bucket: a.bucket ?? null, score: a.score == null ? null : Number(a.score),
      note: a.note || "", created_at: stamp(a.createdAt), likes: a.likeCount || 0, comments: a.commentCount || 0,
    };
  };
  async function enrichActivities(rows) {
    const uid = me();
    const [withP, liked] = await Promise.all([
      withProfiles(rows),
      Promise.all(rows.map((r) => (uid ? F.getDoc(ref("movi_likes", `${r.id}_${uid}`)).then((s) => s.exists(), () => false) : false))),
    ]);
    return withP.map((r, i) => ({ ...r, liked: liked[i] }));
  }

  // ───────── site-wide averages (rebuilt hourly by a Cloud Function; read once per session) ─────────
  const statChunks = new Map(); // chunk id -> Promise<{ filmId: [avg, n] }>
  const statChunk = (key) => {
    if (!statChunks.has(key)) {
      const p = F.getDoc(ref("movi_film_stats", key)).then((s) => (s.exists() ? s.get("films") || {} : {}));
      p.catch(() => statChunks.delete(key));
      statChunks.set(key, p);
    }
    return statChunks.get(key);
  };
  let topCache = null;

  const afterSignIn = async (opts) => { forget(); return ensureProfile(opts); };
  if (core.user) await ensureProfile().catch((e) => console.warn("Movi profile:", e?.message));

  const api = {
    mode: "firebase",
    /** Profiles, rankings and the leaderboard are visible to signed-in members only. */
    membersOnly: true,
    onChange: null,
    matchError: null,
    get uid() { return me(); },

    // ───────── auth ─────────
    supportsGoogle: true,
    /**
     * Opens Google's sign-in window. NOT async on purpose: it must be called straight from the
     * click handler with nothing awaited first, or browsers block the window.
     * Resolves with the user, or null if they closed the window.
     */
    signInWithGoogle() {
      return core.signInWithGoogle().then(async (user) => {
        if (!user) return null;
        await afterSignIn();
        return user;
      });
    },
    async signUp({ email, password, username, displayName }) {
      await core.signUpWithEmail(email.trim(), password, displayName);
      try {
        await afterSignIn({ username, displayName });
      } catch (e) {
        // The sign-in exists but the username could not be claimed: undo, so they can try again.
        await core.A.deleteUser(core.auth.currentUser).catch(() => core.signOut().catch(() => {}));
        throw e.code === "username-taken" ? e : friendly(e);
      }
      return { needsConfirm: false };
    },
    async signIn({ email, password }) {
      await core.signInWithEmail(email.trim(), password);
      await run(() => afterSignIn());
    },
    async userMeta() { const u = core.user; return u ? { name: u.name, email: u.email, providers: u.providers } : null; },
    async signOut() { await core.signOut(); forget(); },
    /** Firebase emails a link to its own page, where the new password is chosen. */
    async resetPassword(email) { await core.resetPassword(email.trim()); },
    get canChangePassword() { return !!core.user?.providers.includes("password"); },
    async updatePassword(password) { await core.updatePassword(password); },
    /** true / false, or null when it can't be checked (usernames are readable only once signed in). */
    async usernameAvailable(name) {
      const n = core.account.normalize(name);
      if (!core.account.valid(n)) return false;
      if (!me()) return null;
      try { return await core.account.isFree(n); } catch { return null; }
    },
    /** Deletes this person's Movi data (and the sign-in itself if they use none of the other apps). */
    async deleteAccount() {
      requireUser();
      try { await core.deleteMyData("movi"); } catch (e) { throw new Error(plain(e.message)); }
      await core.signOut().catch(() => {});
      forget();
    },

    // ───────── profiles ─────────
    async getProfile(id) { return run(() => profileOf(id, id === me())); },
    async getProfileByUsername(username) {
      const name = core.account.normalize(username);
      if (!me() || !core.account.valid(name)) return null;
      return run(async () => {
        const snap = await F.getDocs(F.query(col("movi_profiles"), F.where("username", "==", name), F.limit(1)));
        return snap.empty ? null : remember(toProfile(snap.docs[0].id, data(snap.docs[0])));
      });
    },
    async updateProfile(patch) {
      const uid = requireUser();
      const cur = await profileOf(uid, true);
      if (!cur) throw new Error("Your profile could not be found. Sign out and back in.");
      const displayName = String(patch.display_name ?? cur.display_name).trim().slice(0, 40) || cur.username;
      const fields = {
        displayName, nameLower: displayName.toLowerCase(),
        bio: String(patch.bio ?? cur.bio).slice(0, 160),
        avatarHue: Math.max(0, Math.min(359, Math.trunc(Number(patch.avatar_hue ?? cur.avatar_hue)) || 0)),
        yearlyGoal: Math.max(1, Math.min(1000, Math.trunc(Number(patch.yearly_goal ?? cur.yearly_goal)) || 52)),
      };
      const username = patch.username != null ? core.account.normalize(patch.username) : cur.username;
      if (username !== cur.username || displayName !== cur.display_name) {
        // The shared account holds the username and display name; core moves the Movi profile along in the same batch.
        await core.account.claim(username, { displayName, extra: (batch) => { batch.update(ref("movi_profiles", uid), fields); } });
      } else {
        await run(() => F.updateDoc(ref("movi_profiles", uid), fields));
      }
      return profileOf(uid, true);
    },
    /** Prefix match on username or display name (Firestore has no "contains"). */
    async searchUsers(q, limit = 20) {
      const s = String(q || "").trim().replace(/^@+/, "").toLowerCase();
      if (!s || !me()) return [];
      const prefix = (field) => F.getDocs(F.query(col("movi_profiles"), F.where(field, ">=", s), F.where(field, "<", s + ""), F.limit(limit)));
      return run(async () => {
        const [a, b] = await Promise.all([prefix("username"), prefix("nameLower")]);
        const out = new Map();
        for (const d of [...a.docs, ...b.docs]) out.set(d.id, remember(toProfile(d.id, data(d))));
        return [...out.values()].sort((x, y) => y.ranked_count - x.ranked_count).slice(0, limit);
      });
    },
    async listProfiles({ ids = null, limit = 50 } = {}) {
      if (!me()) return [];
      return run(async () => {
        if (ids) {
          const map = await profilesOf(ids.filter(okId));
          return [...map.values()].filter(Boolean).sort((a, b) => b.ranked_count - a.ranked_count).slice(0, limit);
        }
        const snap = await F.getDocs(F.query(col("movi_profiles"), F.orderBy("rankedCount", "desc"), F.limit(Math.min(limit, 200))));
        return snap.docs.map((d) => remember(toProfile(d.id, data(d))));
      });
    },
    /** Where a member stands by films ranked (1 = most), without downloading everyone. */
    async placeOf(profile) {
      if (!me() || !profile) return 0;
      const snap = await F.getCountFromServer(F.query(col("movi_profiles"), F.where("rankedCount", ">", profile.ranked_count || 0)));
      return snap.data().count + 1;
    },

    // ───────── rankings ─────────
    async getRankings(userId) {
      if (!okId(userId) || !me()) return [];
      return run(async () => {
        const { lists, entries } = await loadLists(userId);
        if (userId === me()) mine = { uid: userId, at: { ...(lists.at || {}) }, ids: new Set(ORDER.flatMap((b) => lists[b] || [])), entries };
        return listRows(userId, lists, entries);
      });
    },
    async rankingsOfUsers(ids) {
      const list = uniq(ids).filter(okId);
      if (!list.length || !me()) return [];
      const snaps = await Promise.all(list.map((id) => F.getDoc(ref("movi_lists", id)).catch(() => null)));
      return snaps.flatMap((s, i) => (s?.exists() ? listRows(list[i], data(s)) : []));
    },
    async rankingsForFilm(filmId) {
      if (!isFilm(filmId) || !me()) return [];
      return run(async () => {
        const snaps = await Promise.all(ORDER.map((b) => F.getDocs(F.query(col("movi_lists"), F.where(b, "array-contains", filmId), F.limit(200)))));
        const rows = [];
        const seen = new Set();
        snaps.forEach((snap, k) => snap.docs.forEach((d) => {
          if (seen.has(d.id)) return;
          seen.add(d.id);
          const lists = data(d), bucket = ORDER[k];
          const ids = lists[bucket], pos = ids.indexOf(filmId);
          rows.push({
            user_id: d.id, film_id: filmId, bucket, pos, score: scoreFor(bucket, pos, ids.length), note: "",
            created_at: lists.at?.[filmId] != null ? iso(Number(lists.at[filmId])) : iso(lists.updatedAt), updated_at: iso(lists.updatedAt),
          });
        }));
        const [withP, notes] = await Promise.all([
          withProfiles(rows),
          Promise.all(rows.slice(0, NOTE_LOOKUPS).map((r) => F.getDoc(ref("movi_entries", `${r.user_id}_${filmId}`)).then((s) => (s.exists() ? s.get("note") || "" : ""), () => ""))),
        ]);
        return withP.map((r, i) => ({ ...r, note: notes[i] || "" }));
      });
    },
    /** Saves the whole ranking. The lists and the profile's count go in one batch (the rules require it). */
    async saveLists(lists) {
      const uid = requireUser();
      const next = { loved: [...lists.loved], fine: [...lists.fine], disliked: [...lists.disliked] };
      const all = ORDER.flatMap((b) => next[b]);
      if (new Set(all).size !== all.length) throw new Error("A film can only appear once");
      if (!all.every(isFilm)) throw new Error("That film can't be ranked");
      const st = await run(() => myState());
      const at = {};
      const t = Date.now();
      for (const id of all) at[id] = st.at[id] ?? t;
      const removed = [...st.ids].filter((id) => !(id in at));
      await run(async () => {
        const batch = F.writeBatch(db);
        batch.set(ref("movi_lists", uid), { ...next, at, updatedAt: now() });
        batch.update(ref("movi_profiles", uid), { rankedCount: all.length });
        await batch.commit();
      });
      st.at = at;
      st.ids = new Set(all);
      const cached = profileCache.get(uid);
      if (cached) cached.p = { ...cached.p, ranked_count: all.length };
      // Notes and watch details of films that left the list go too (best effort; the ranking is already saved).
      await Promise.all(removed.filter((id) => st.entries.has(id)).map((id) => {
        st.entries.delete(id);
        return remove(ref("movi_entries", `${uid}_${id}`)).catch(() => {});
      }));
    },
    async updateEntry(filmId, patch) {
      const uid = requireUser();
      if (!isFilm(filmId)) return;
      const st = await run(() => myState());
      const cur = st.entries.get(filmId);
      const merged = entryFields({
        ...ENTRY_DEFAULT, ...cur,
        ...("note" in patch && { note: patch.note }),
        ...("watched_on" in patch && { watchedOn: patch.watched_on }),
        ...("watched_where" in patch && { watchedWhere: patch.watched_where }),
        ...("watched_with" in patch && { watchedWith: patch.watched_with }),
        ...("rewatch" in patch && { rewatch: patch.rewatch }),
      });
      const r = ref("movi_entries", `${uid}_${filmId}`);
      if (entryEmpty(merged)) {
        // Only films with notes or watch details have a document.
        if (cur) { await remove(r); st.entries.delete(filmId); }
        return;
      }
      await run(() => F.setDoc(r, { uid, filmId, ...merged, updatedAt: now() }, { merge: true }));
      st.entries.set(filmId, { uid, filmId, ...merged });
    },

    // ───────── watchlist ─────────
    async getWatchlist(userId) {
      if (!okId(userId) || !me()) return [];
      const snap = await run(() => F.getDoc(ref("movi_watchlists", userId)));
      const items = snap.exists() ? snap.get("items") || {} : {};
      return Object.entries(items)
        .map(([id, v]) => ({ film_id: Number(id), from_user: v?.from ?? null, created_at: iso(Number(v?.at) || 0) }))
        .filter((r) => isFilm(r.film_id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async addWatch(filmId, fromUser = null) {
      const uid = requireUser();
      if (!isFilm(filmId)) return;
      await run(() => F.setDoc(ref("movi_watchlists", uid), { items: { [filmId]: { at: Date.now(), from: okId(fromUser) ? fromUser : null } }, updatedAt: now() }, { merge: true }));
    },
    async removeWatch(filmId) {
      const uid = requireUser();
      await run(() => F.setDoc(ref("movi_watchlists", uid), { items: { [filmId]: F.deleteField() }, updatedAt: now() }, { merge: true }));
    },

    // ───────── follows (always immediate: every account is visible to members) ─────────
    async follow(id) {
      const uid = requireUser();
      if (id === uid) throw new Error("You can't follow yourself");
      if (!okId(id)) throw new Error("That member could not be found");
      await createOnce(ref("movi_follows", `${uid}_${id}`), { follower: uid, followee: id, createdAt: now() });
      return "accepted";
    },
    async unfollow(id) { const uid = requireUser(); if (okId(id)) await remove(ref("movi_follows", `${uid}_${id}`)); },
    async removeFollower(id) { const uid = requireUser(); if (okId(id)) await remove(ref("movi_follows", `${id}_${uid}`)); },
    async getFollows(userId) {
      if (!okId(userId) || !me()) return { following: [], followers: [] };
      return run(async () => {
        const [out, inc] = await Promise.all([
          F.getDocs(F.query(col("movi_follows"), F.where("follower", "==", userId))),
          F.getDocs(F.query(col("movi_follows"), F.where("followee", "==", userId))),
        ]);
        const rows = (snap, key) => snap.docs.map((d) => ({ id: d.get(key), created_at: iso(data(d).createdAt) }));
        const [following, followers] = await Promise.all([withProfiles(rows(out, "followee"), "id"), withProfiles(rows(inc, "follower"), "id")]);
        return { following: following.filter((r) => r.profile), followers: followers.filter((r) => r.profile) };
      });
    },

    // ───────── feed ─────────
    async postActivity(a) {
      const uid = requireUser();
      const doc = {
        uid, kind: a.kind, filmId: a.film_id, bucket: a.bucket ?? null, score: a.score ?? null, note: String(a.note || "").slice(0, 2000),
        createdAt: now(), likeCount: 0, commentCount: 0,
      };
      const r = await run(() => F.addDoc(col("movi_activities"), doc));
      return { id: r.id, user_id: uid, kind: doc.kind, film_id: doc.filmId, bucket: doc.bucket, score: doc.score, note: doc.note, created_at: new Date().toISOString() };
    },
    async getFeed({ userIds = null, before = null, limit = 20 } = {}) {
      if (!me()) return [];
      const older = before ? [F.where("createdAt", "<", stamps.get(before) ?? F.Timestamp.fromDate(new Date(before)))] : [];
      const page = (...filters) => F.getDocs(F.query(col("movi_activities"), ...filters, ...older, F.orderBy("createdAt", "desc"), F.limit(limit)));
      return run(async () => {
        let docs;
        if (userIds) {
          const ids = uniq(userIds).filter(okId);
          if (!ids.length) return [];
          const snaps = await Promise.all(chunk(ids, IN_MAX).map((part) => page(F.where("uid", "in", part))));
          docs = snaps.flatMap((s) => s.docs);
        } else {
          docs = (await page()).docs;
        }
        const rows = docs.map(toActivity).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
        return enrichActivities(rows);
      });
    },
    async deleteActivity(id) { requireUser(); if (okId(id)) await remove(ref("movi_activities", id)); },
    async like(id) {
      const uid = requireUser();
      if (!okId(id)) return;
      await createOnce(ref("movi_likes", `${id}_${uid}`), { activityId: id, uid, createdAt: now() });
    },
    async unlike(id) { const uid = requireUser(); if (okId(id)) await remove(ref("movi_likes", `${id}_${uid}`)); },
    async getComments(activityId) {
      if (!okId(activityId) || !me()) return [];
      return run(async () => {
        const snap = await F.getDocs(F.query(col("movi_comments"), F.where("activityId", "==", activityId), F.orderBy("createdAt")));
        return withProfiles(snap.docs.map((d) => ({ id: d.id, activity_id: activityId, user_id: d.get("uid"), body: d.get("body"), created_at: iso(data(d).createdAt) })));
      });
    },
    async addComment(activityId, body) {
      const uid = requireUser();
      const text = String(body).trim().slice(0, 500);
      if (!okId(activityId) || !text) throw new Error("Write something first");
      let r;
      try { r = await F.addDoc(col("movi_comments"), { activityId, uid, body: text, createdAt: now() }); } catch (e) {
        throw e?.code === "permission-denied" ? new Error("That post is no longer available") : friendly(e);
      }
      return { id: r.id, activity_id: activityId, user_id: uid, body: text, created_at: new Date().toISOString(), profile: await profileOf(uid) };
    },
    async deleteComment(id) { requireUser(); if (okId(id)) await remove(ref("movi_comments", id)); },

    // ───────── inbox (notifications are written by Cloud Functions, never from here) ─────────
    async getNotifications(limit = 50) {
      const uid = requireUser();
      return run(async () => {
        const snap = await F.getDocs(F.query(col("movi_notifications"), F.where("uid", "==", uid), F.orderBy("createdAt", "desc"), F.limit(limit)));
        const rows = snap.docs.map((d) => {
          const n = data(d);
          return { id: d.id, user_id: n.uid, actor_id: n.actor, kind: n.kind, activity_id: n.activityId ?? null, film_id: n.filmId ?? null, body: n.body || "", read: !!n.read, created_at: iso(n.createdAt) };
        });
        return (await withProfiles(rows, "actor_id")).map(({ profile, ...n }) => ({ ...n, actor: profile }));
      });
    },
    async unreadCount() {
      const uid = me();
      if (!uid) return 0;
      const snap = await F.getCountFromServer(F.query(col("movi_notifications"), F.where("uid", "==", uid), F.where("read", "==", false)));
      return snap.data().count;
    },
    async markNotificationsRead() {
      const uid = requireUser();
      const snap = await F.getDocs(F.query(col("movi_notifications"), F.where("uid", "==", uid), F.where("read", "==", false)));
      for (const part of chunk(snap.docs, 400)) {
        const batch = F.writeBatch(db);
        part.forEach((d) => batch.update(d.ref, { read: true }));
        await batch.commit();
      }
    },

    async sendRec(toId, filmId, message) {
      const uid = requireUser();
      if (!okId(toId) || !isFilm(filmId)) throw new Error("That recommendation can't be sent");
      await run(() => F.addDoc(col("movi_recs"), { from: uid, to: toId, filmId, message: String(message || "").slice(0, 280), createdAt: now() }));
    },
    async getRecsForMe() {
      const uid = requireUser();
      return run(async () => {
        const snap = await F.getDocs(F.query(col("movi_recs"), F.where("to", "==", uid), F.orderBy("createdAt", "desc"), F.limit(100)));
        return withProfiles(snap.docs.map((d) => ({ id: d.id, from_user: d.get("from"), to_user: uid, film_id: d.get("filmId"), message: d.get("message") || "", created_at: iso(data(d).createdAt) })), "from_user");
      });
    },
    async deleteRec(id) { requireUser(); if (okId(id)) await remove(ref("movi_recs", id)); },

    // ───────── stats (up to an hour old) ─────────
    async filmStats(ids) {
      const list = uniq(ids.filter(isFilm).map(String)).map(Number);
      if (!list.length || !me()) return new Map();
      const keys = uniq(list.map((id) => String(Math.floor(id / 2000))));
      const chunks = new Map(await Promise.all(keys.map(async (k) => [k, await statChunk(k)])));
      const out = new Map();
      for (const id of list) {
        const v = chunks.get(String(Math.floor(id / 2000)))?.[id];
        if (Array.isArray(v) && v[1] > 0) out.set(id, { film_id: id, avg_score: Number(v[0]), n: Number(v[1]) });
      }
      return out;
    },
    async topFilms(minCount = 2, limit = 30) {
      if (!me()) return [];
      if (!topCache) {
        topCache = F.getDoc(ref("movi_stats", "top")).then((s) => (s.exists() ? s.get("films") || [] : []));
        topCache.catch(() => { topCache = null; });
      }
      return (await topCache).filter((f) => f.n >= minCount).slice(0, limit).map((f) => ({ film_id: f.filmId, avg_score: Number(f.avg), n: Number(f.n) }));
    },

    // ───────── "To rank" list (private) ─────────
    async getBacklog() {
      const uid = requireUser();
      const snap = await run(() => F.getDoc(ref("movi_backlogs", uid)));
      const items = snap.exists() ? snap.get("items") || {} : {};
      return Object.entries(items)
        .map(([id, at]) => ({ film_id: Number(id), created_at: iso(Number(at) || 0) }))
        .filter((r) => isFilm(r.film_id))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
    },
    async addBacklog(ids) {
      const uid = requireUser();
      const list = uniq(ids.filter(isFilm).map(String));
      if (!list.length) return;
      const t = Date.now();
      const items = Object.fromEntries(list.map((id, i) => [id, t - i]));
      await run(() => F.setDoc(ref("movi_backlogs", uid), { items, updatedAt: now() }, { merge: true }));
    },
    async removeBacklog(id) {
      const uid = requireUser();
      await run(() => F.setDoc(ref("movi_backlogs", uid), { items: { [id]: F.deleteField() }, updatedAt: now() }, { merge: true }));
    },

    /**
     * AI title matching (Cloud Function moviMatchFilms). Returns null on any failure so the
     * built-in matcher's answers are used; `matchError` then says why, when it's worth telling.
     */
    async matchTitles(lines) {
      api.matchError = null;
      if (!me() || !lines?.length) return null;
      try {
        const res = await core.call("moviMatchFilms", { lines });
        return Array.isArray(res?.results) ? res.results : null;
      } catch (e) {
        if (e.code === "resource-exhausted") api.matchError = plain(e.message);
        return null;
      }
    },
  };

  // Local testing only (localhost + ?emulator): sign in as a made-up Google account.
  if (emulator && typeof window !== "undefined") {
    window.__emuSignIn = async (email, name) => {
      const user = await core.emulatorSignIn(email, name);
      await afterSignIn();
      return user;
    };
  }
  return api;
}

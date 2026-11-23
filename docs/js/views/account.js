import { $, esc, ICON, toast, debounce } from "../util.js";
import { film, filmCount, searchFilms } from "../films.js";
import { api } from "../api/index.js";
import { S, loadSession, clearSession, rankedCount, updateMe, rankedIds, myRows, takeReturn } from "../state.js";
import { cardHTML, userRowHTML, avatarHTML, confirmDialog } from "../ui.js";
import { followBtnHTML } from "./feed.js";
import { sample, byPopularity } from "../variety.js";

const onboardKey = () => `movi.onboarded.${S.me?.id}`;
export const needsOnboarding = () => { try { return !localStorage.getItem(onboardKey()); } catch { return false; } };
const finishOnboarding = () => { try { localStorage.setItem(onboardKey(), "1"); } catch {} };

let authTab = "signup";

// Google's multicolor "G", as Google's sign-in branding guidelines ask for on Google sign-in buttons.
const GOOGLE_G = `<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.4-4.1 7-10.1 7-17.6z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>`;

// After any successful sign-in: load the member's data and go to onboarding or the feed.
// Someone signed in who is not a Movi member yet gets the join screen instead (the router shows
// it on every address until they join), and nothing is created for them.
const reroute = () => document.dispatchEvent(new CustomEvent("movi:reroute"));
async function enterApp() {
  await loadSession();
  if (S.join) return reroute();
  if (!S.me) throw new Error("Couldn't load your profile. Try again.");
  document.dispatchEvent(new CustomEvent("movi:auth"));
  // A shared link that sent them to sign in wins over the usual landing page.
  const target = takeReturn() || (needsOnboarding() && rankedCount() === 0 && !S.backlog.length ? "#/onboarding" : "#/feed");
  if (location.hash === target) reroute(); else location.hash = target;
}

// ---------- Join Movi ----------
// Shown to someone who is signed in (through another of our apps on this site, or with Google
// for the first time) but has no Movi profile. Only the "Join Movi" button creates one.
export function renderJoin(view) {
  const j = S.join;
  const fixed = !!j.username;
  view.innerHTML = `<div class="join"><div class="auth">
      <span class="logo big">movi</span>
      <h1 class="h2m">${fixed ? `Join Movi as @${esc(j.username)}` : "Join Movi"}</h1>
      <p class="muted">${fixed
        ? `You're signed in${j.displayName ? ` as <b>${esc(j.displayName)}</b>` : ""}${j.email ? ` (${esc(j.email)})` : ""}. Your username is the one you already use in our other apps.`
        : `You're signed in${j.email ? ` as ${esc(j.email)}` : ""}. Pick the username people will see.`}</p>
      <form id="join-form" class="form" novalidate>
        ${fixed ? "" : `<label>Your name<input name="display_name" maxlength="40" autocomplete="name" required value="${esc(j.displayName)}"></label>
        <label>Username<span class="field"><span class="at">@</span><input name="username" maxlength="20" autocomplete="username" required value="${esc(j.suggested || "")}" pattern="[a-z0-9_.]{3,20}"></span><small id="u-hint" class="hint">3–20 characters: lowercase letters, numbers, _ and .</small></label>`}
        <p class="muted small">Movi profiles and rankings are visible to other signed-in members.</p>
        <p class="form-err" id="join-err" role="alert"></p>
        <button class="btn primary block" id="join-go">Join Movi</button>
        <button type="button" class="linkish center-t" id="join-no">Not now (sign out)</button>
      </form>
      <p class="legal">By joining, you agree to Movi's <a href="terms.html">Terms of service</a> and <a href="privacy.html">Privacy policy</a>.</p>
    </div></div>`;
  const form = $("#join-form"), err = $("#join-err"), u = form.username;
  if (u) bindUsernameHint(u);
  $("#join-no").addEventListener("click", async () => {
    await api.signOut().catch(() => {});
    document.dispatchEvent(new CustomEvent("movi:signedout"));
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const name = u ? u.value : j.username;
    const shown = fixed ? j.displayName : form.display_name.value.trim();
    if (!fixed && !shown) return (err.textContent = "Tell us your name");
    if (!/^[a-z0-9_.]{3,20}$/.test(name)) return (err.textContent = "Pick a username with 3–20 lowercase letters, numbers, _ or .");
    const btn = $("#join-go");
    btn.disabled = true;
    try {
      if (!fixed && (await api.usernameAvailable(name)) === false) throw new Error("That username is taken");
      await api.join({ username: name, displayName: shown });
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
    }
  });
}

// Live "available / taken" under a username box.
function bindUsernameHint(u) {
  const check = debounce(async () => {
    const hint = $("#u-hint");
    if (!hint || !u.value) return;
    if (!/^[a-z0-9_.]{3,20}$/.test(u.value)) { hint.textContent = "3–20 characters: lowercase letters, numbers, _ and ."; hint.className = "hint"; return; }
    const name = u.value;
    const ok = await api.usernameAvailable(name).catch(() => null);
    if (u.value !== name) return;
    hint.textContent = ok == null ? "3–20 characters: lowercase letters, numbers, _ and ." : ok ? `@${name} is available` : `@${name} is taken`;
    hint.className = ok == null ? "hint" : ok ? "hint good" : "hint bad";
  }, 300);
  u.addEventListener("input", () => { u.value = u.value.toLowerCase().replace(/[^a-z0-9_.]/g, ""); check(); });
  if (u.value) check();
  return check;
}

// Not async, and nothing runs before api.signInWithGoogle(): browsers only open the Google
// sign-in window when it is requested directly by the click.
export function signInWithGoogle(btn) {
  const pending = api.signInWithGoogle();
  btn.disabled = true;
  return pending
    .then((user) => (user ? enterApp() : null)) // null: they closed the window
    .catch((e) => toast(e.message))
    .finally(() => { btn.disabled = false; });
}

export function renderWelcome(view) {
  const demo = api.mode === "demo";
  view.innerHTML = `
    <div class="welcome">
      <div class="w-copy">
        <span class="logo big">movi</span>
        <h1>Rank every movie you've ever seen.</h1>
        <p class="lead">No more stars. Pick which film you liked more, a few times, and Movi builds your personal 0–10 scores and a ranked list that's truly yours.</p>
        <ul class="w-feats">
          <li>${ICON.rank}<span><b>Head-to-head ranking</b> — about 5 quick picks per film</span></li>
          <li>${ICON.users}<span><b>Friends & feed</b> — see what they watch, like and comment</span></li>
          <li>${ICON.sparkle}<span><b>Rec scores</b> — predicted scores from friends with your taste</span></li>
          <li>${ICON.trophy}<span><b>Leaderboards, streaks & badges</b> — make watching a habit</span></li>
        </ul>
        <p class="muted small">${filmCount().toLocaleString()} films · Watchlist · Taste match · Watch together</p>
      </div>
      <div class="auth">
        ${api.supportsGoogle ? `<button class="btn google block" data-act="google">${GOOGLE_G} Continue with Google</button><div class="or"><span>or use email</span></div>` : ""}
        <div class="seg" role="tablist"><button role="tab" class="${authTab === "signup" ? "on" : ""}" data-atab="signup">Create account</button><button role="tab" class="${authTab === "signin" ? "on" : ""}" data-atab="signin">Sign in</button></div>
        ${authTab === "signup" ? `
        <form id="auth-form" novalidate>
          <label>Your name<input name="display_name" maxlength="40" autocomplete="name" required placeholder="Alex Kim"></label>
          <label>Username<span class="field"><span class="at">@</span><input name="username" maxlength="20" autocomplete="username" required placeholder="alexwatches" pattern="[a-z0-9_.]{3,20}"></span><small id="u-hint" class="hint">3–20 characters: lowercase letters, numbers, _ and .</small></label>
          <label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"></label>
          <label>Password<input name="password" type="password" autocomplete="new-password" minlength="6" required placeholder="At least 6 characters"></label>
          <p class="form-err" id="auth-err" role="alert"></p>
          <button class="btn primary block" id="auth-go">Create account</button>
        </form>` : `
        <form id="auth-form" novalidate>
          <label>Email<input name="email" type="email" autocomplete="email" required></label>
          <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
          <p class="form-err" id="auth-err" role="alert"></p>
          <button class="btn primary block" id="auth-go">Sign in</button>
          ${demo ? "" : `<button type="button" class="linkish center-t" data-act="forgot">Forgot password?</button>`}
          ${demo ? "" : `<p class="muted small center-t">Use one of our other apps? Sign in the same way and you keep your username.</p>`}
        </form>`}
        ${demo ? `<div class="demo-note">${ICON.lock}<span><b>Demo mode.</b> Accounts and rankings are saved only in this browser, alongside a sample community.</span></div>` : ""}
        <a class="linkish center-t" href="#/discover">Browse without an account</a>
        <p class="legal">By continuing, you agree to Movi's <a href="terms.html">Terms of service</a> and <a href="privacy.html">Privacy policy</a>.</p>
      </div>
    </div>`;
  view.querySelectorAll("[data-atab]").forEach((b) => b.addEventListener("click", () => { authTab = b.dataset.atab; renderWelcome(view); }));
  const form = $("#auth-form");
  const err = $("#auth-err");
  const u = form.username;
  if (u) {
    const checkName = bindUsernameHint(u);
    const nameField = form.display_name;
    nameField.addEventListener("input", () => {
      if (!u.dataset.touched) { u.value = nameField.value.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20); checkName(); }
    });
    u.addEventListener("keydown", () => { u.dataset.touched = "1"; });
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const fd = Object.fromEntries(new FormData(form));
    if (authTab === "signup") {
      if (!fd.display_name.trim()) return (err.textContent = "Tell us your name");
      if (!/^[a-z0-9_.]{3,20}$/.test(fd.username)) return (err.textContent = "Pick a username with 3–20 lowercase letters, numbers, _ or .");
      if (!/^\S+@\S+\.\S+$/.test(fd.email)) return (err.textContent = "Enter a valid email");
      if ((fd.password || "").length < 6) return (err.textContent = "Password should be at least 6 characters");
    } else if (!fd.email || !fd.password) return (err.textContent = "Enter your email and password");
    const btn = $("#auth-go");
    btn.disabled = true;
    btn.textContent = authTab === "signup" ? "Creating account…" : "Signing in…";
    try {
      if (authTab === "signup") {
        // Checked before the sign-in is created, so a taken name never leaves a half-made account.
        if ((await api.usernameAvailable(fd.username)) === false) throw new Error("That username is taken");
        await api.signUp({ email: fd.email, password: fd.password, username: fd.username, displayName: fd.display_name.trim() });
      } else {
        await api.signIn({ email: fd.email, password: fd.password });
      }
      await enterApp();
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false;
      btn.textContent = authTab === "signup" ? "Create account" : "Sign in";
    }
  });
}

export async function forgotPassword() {
  const email = $("#auth-form")?.email?.value?.trim() || prompt("Your account email:");
  if (!email) return;
  try {
    await api.resetPassword(email);
    toast("If that email has an account, a reset link is on its way");
  } catch (e) { toast(e.message); }
}

// ---------- Onboarding ----------
let obStep = 1;
// Well-known films to start with: a fresh set each visit, kept steady while you work through it.
let obPicks = null;
function onboardingPicks(fresh = false) {
  const taken = new Set([...rankedIds(), ...S.skip]);
  const keep = fresh || !obPicks ? [] : obPicks.filter((id) => !taken.has(id));
  const pool = searchFilms({}).filter((f) => !taken.has(f.id) && !keep.includes(f.id)).slice(0, 400);
  obPicks = [...keep, ...sample(byPopularity(pool, 2.2), 18 - keep.length).map((f) => f.id)];
  return obPicks.map(film);
}
export function shuffleOnboarding() {
  onboardingPicks(true);
  renderOnboarding(document.querySelector("#view"));
}
export async function renderOnboarding(view) {
  const n = rankedCount();
  const steps = `<div class="ob-steps">${[1, 2].map((i) => `<i class="${obStep >= i ? "on" : ""}"></i>`).join("")}</div>`;
  if (obStep === 1) {
    const picks = onboardingPicks();
    view.innerHTML = `<div class="ob">${steps}
      <h1>Rank 3 films you've seen</h1>
      <p class="muted">Pick films you know well. ${n ? `<b>${Math.min(n, 3)} of 3 done.</b>` : "It takes a few seconds each."}</p>
      <div class="row-c"><button class="btn" data-act="quick-add">${ICON.search} Search for a film</button><a class="btn" href="#/lists/torank">${ICON.list} Paste a list of movies</a><button class="btn" data-act="ob-shuffle">${ICON.repeat} Show others</button>${n >= 3 ? `<button class="btn primary" data-act="ob-next">Next: find friends ${ICON.chevron}</button>` : `<button class="btn ghost" data-act="ob-next">Skip for now</button>`}</div>
      <div class="grid quick mt-5">${picks.map((f) => cardHTML(f, { acts: `<div class="acts"><button data-act="rank" data-id="${f.id}">Seen it</button><button data-act="skip" data-id="${f.id}">Not seen</button></div>` })).join("")}</div></div>`;
    return;
  }
  view.innerHTML = `<div class="ob">${steps}<h1>Follow people</h1><p class="muted">Their rankings power your feed, rec scores and leaderboard.</p><div id="ob-people" class="ulist"></div>
    <div class="row-c"><button class="btn primary" data-act="ob-done">Go to my feed ${ICON.chevron}</button></div></div>`;
  const ps = (await api.listProfiles({ limit: 30 })).filter((p) => p.id !== S.me.id);
  $("#ob-people").innerHTML = ps.map((p) => userRowHTML(p, followBtnHTML(p), `${p.ranked_count} ranked`)).join("") || `<p class="muted">No one else is here yet — invite your friends from your profile.</p>`;
}
export function onboardingNext() { obStep = 2; renderOnboarding($("#view")); }
export function onboardingDone() { finishOnboarding(); obStep = 1; location.hash = "#/feed"; }

// ---------- Settings ----------
export function renderSettings(view) {
  const me = S.me;
  const demo = api.mode === "demo";
  view.innerHTML = `<div class="list-head"><h1>Settings</h1></div>
    <form class="panel-card form" id="prof-form">
      <h3>Profile</h3>
      <div class="av-edit"><span id="av-prev">${avatarHTML(me, 72)}</span><label>Avatar color<input type="range" name="avatar_hue" min="0" max="359" value="${me.avatar_hue}"></label></div>
      <label>Name<input name="display_name" maxlength="40" value="${esc(me.display_name)}" required></label>
      <label>Username<span class="field"><span class="at">@</span><input name="username" maxlength="20" value="${esc(me.username)}" pattern="[a-z0-9_.]{3,20}" required></span></label>
      <label>Bio<textarea name="bio" maxlength="160" rows="2" placeholder="What do you love to watch?">${esc(me.bio)}</textarea></label>
      <label>${new Date().getFullYear()} goal<span class="field"><input name="yearly_goal" type="number" min="1" max="1000" value="${me.yearly_goal}"><span class="at">films</span></span></label>
      <p class="muted small">Your profile, rankings, watchlist and activity are visible to other signed-in members.${demo ? "" : " Your username is shared with our other apps that use the same sign-in."}</p>
      <p class="form-err" id="prof-err" role="alert"></p>
      <button class="btn primary">Save profile</button>
    </form>
    ${api.canChangePassword ? `<form class="panel-card form" id="pw-form" novalidate>
      <h3>Password</h3>
      <label>New password<input name="password" type="password" minlength="6" autocomplete="new-password" required></label>
      <p class="form-err" id="pw-err" role="alert"></p>
      <button class="btn">Update password</button>
    </form>` : demo ? "" : `<div class="panel-card form"><h3>Password</h3><p class="muted">You sign in with Google, so there's no Movi password to change.</p></div>`}
    <div class="panel-card form">
      <h3>Your data</h3>
      <p class="muted">Download everything you've ranked, noted and saved.</p>
      <div class="settings"><button class="btn sm" data-act="export">Export my data</button></div>
      <p class="legal left">Read the <a href="privacy.html">Privacy policy</a> and <a href="terms.html">Terms of service</a>.</p>
    </div>
    <div class="panel-card form">
      <h3>Account</h3>
      <p class="muted">${demo ? "Demo mode: this account lives only in this browser." : "Signed in to Movi."}</p>
      <div class="settings"><button class="btn sm" data-act="sign-out">${ICON.logout} Sign out</button><button class="btn sm danger" data-act="delete-account">${ICON.trash} Delete my Movi data</button>
      ${demo ? `<button class="btn sm ghost" data-act="reset-demo">Reset demo data</button>` : ""}</div>
    </div>
    <p class="muted small center-t">Film data from Wikipedia (CC BY-SA). Posters from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB. ${demo ? "Running in demo mode." : ""}</p>`;
  const pf = $("#prof-form");
  pf.avatar_hue.addEventListener("input", () => { $("#av-prev").innerHTML = avatarHTML({ ...me, display_name: pf.display_name.value, avatar_hue: Number(pf.avatar_hue.value) }, 72); });
  pf.username.addEventListener("input", () => { pf.username.value = pf.username.value.toLowerCase().replace(/[^a-z0-9_.]/g, ""); });
  pf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("#prof-err");
    err.textContent = "";
    const fd = new FormData(pf);
    const patch = {
      display_name: String(fd.get("display_name")).trim().slice(0, 40),
      username: String(fd.get("username")).trim(),
      bio: String(fd.get("bio")).trim().slice(0, 160),
      avatar_hue: Number(fd.get("avatar_hue")),
      yearly_goal: Math.max(1, Math.min(1000, Math.trunc(Number(fd.get("yearly_goal"))) || 52)),
    };
    if (!patch.display_name) return (err.textContent = "Name can't be empty");
    if (!/^[a-z0-9_.]{3,20}$/.test(patch.username)) return (err.textContent = "Username needs 3–20 lowercase letters, numbers, _ or .");
    try {
      const renamed = patch.username !== S.me.username;
      if (renamed && (await api.usernameAvailable(patch.username)) === false) throw new Error("That username is taken");
      await updateMe(patch);
      document.dispatchEvent(new CustomEvent("movi:auth"));
      toast("Profile saved");
      // The settings address stays the same, but links to your profile change with the username.
      if (renamed) renderSettings(view);
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
  $("#pw-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    // Errors stay on the page: "sign out and back in, then try again" (asked for after a long session) needs time to read.
    const err = $("#pw-err");
    err.textContent = "";
    if (e.target.password.value.length < 6) return (err.textContent = "Password should be at least 6 characters");
    try {
      await api.updatePassword(e.target.password.value);
      e.target.reset();
      toast("Password updated");
    } catch (ex) { err.textContent = ex.message; }
  });
}

export function exportData() {
  const data = {
    exported_at: new Date().toISOString(),
    profile: S.me,
    rankings: myRows().map((r) => ({ ...r, title: film(r.film_id).title, year: film(r.film_id).year })),
    watchlist: S.watch.map((w) => ({ ...w, title: film(w.film_id).title, year: film(w.film_id).year })),
  };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `movi-${S.me.username}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function deleteAccount() {
  const ok = await confirmDialog({
    title: "Delete your Movi data?",
    text: "This permanently deletes your Movi profile, rankings, notes, lists, follows, posts, likes and comments." + (api.mode === "demo" ? "" : " If you don't use this sign-in for any of our other apps, the sign-in and username are deleted too; otherwise you stay signed in and your other apps are untouched.") + " This can't be undone.",
    ok: "Delete forever", danger: true,
  });
  if (!ok) return;
  try {
    await api.deleteAccount();
    toast("Your Movi data was deleted");
    clearSession();
    // Still signed in (another of our apps uses this sign-in): they land on the join screen, and
    // nothing is recreated unless they choose to join again.
    if (api.uid) await enterApp();
    else document.dispatchEvent(new CustomEvent("movi:signedout"));
  } catch (e) { toast(e.message); }
}

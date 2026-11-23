// Picks the backend: Firebase when docs/config.js has the project's settings (or on localhost
// with ?emulator, for local testing against the Firebase emulators); otherwise demo mode.
//
// Contract shared by api/demo.js and api/firebase.js (all methods async unless noted):
//   auth:     uid, mode, membersOnly, signUp, signIn, signInWithGoogle (NOT async: call it straight from the click),
//             supportsGoogle, userMeta, signOut, resetPassword, canChangePassword, updatePassword,
//             usernameAvailable (true / false / null = can't tell right now), deleteAccount,
//             joinInfo + join (live only: someone signed in who is not a Movi member yet; see views/account.js)
//   profiles: getProfile, getProfileByUsername, updateProfile, searchUsers (prefix match), listProfiles, placeOf
//   rankings: getRankings, rankingsOfUsers, rankingsForFilm, saveLists, updateEntry
//   watch:    getWatchlist, addWatch, removeWatch
//   social:   follow (always immediate), unfollow, removeFollower, getFollows
//   feed:     postActivity, deleteActivity, getFeed, like, unlike, getComments, addComment, deleteComment
//   inbox:    getNotifications, unreadCount, markNotificationsRead, sendRec, getRecsForMe, deleteRec
//   stats:    filmStats, topFilms
//   to rank:  getBacklog, addBacklog, removeBacklog, matchTitles (AI; null when unavailable), matchError
// Rows use snake_case (user_id, film_id, display_name, created_at as ISO text, ...). Ids of posts,
// comments, recommendations and notifications are opaque: pass them back exactly as given.
import { wantsEmulator } from "../core.js";

export let api = null;

export async function initApi() {
  const cfg = window.MOVI_CONFIG || {};
  const emulator = wantsEmulator("movi");
  if (cfg.firebase || emulator) {
    const { createFirebaseApi } = await import("./firebase.js");
    api = await createFirebaseApi({ config: cfg.firebase || null, appCheckSiteKey: cfg.appCheckSiteKey || null, emulator });
  } else {
    const { createDemoApi } = await import("./demo.js");
    api = await createDemoApi();
  }
  return api;
}

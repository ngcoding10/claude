// End-to-end test of Movi's live mode against the Firebase emulators, through the real UI.
// Two people: Alice signs up with email + password, Bob signs in "with Google" (the Auth
// emulator's made-up Google account, via window.__emuSignIn, which only exists in emulator mode).
//
// Run: 1. in the backend repo (github.com/ngcoding10/backend-combination): start the emulators
//         (Auth 9099, Firestore 8080, Functions 5001, project demo-apps)
//      2. cd docs && python3 -m http.server 8765
//      3. cd tests && npm install && npm run e2e:live
// The page must be opened as http://localhost:<port>/?emulator (localhost, not an IP address
// other than 127.0.0.1): that is what switches the site to the emulators.
//
// Options (environment variables):
//   MOVI_URL        where docs/ is served (default http://localhost:8765/)
//   HTTPS_PROXY     proxy for the browser to reach the Firebase SDK on www.gstatic.com
//   MOVI_SDK_DIR    folder with firebase-app.js, firebase-auth.js, ... (node_modules/firebase):
//                   serve the SDK from disk instead of the CDN, for machines with no internet
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const SH = path.join(__dirname, 'screenshots', 'live');
const BASE = process.env.MOVI_URL || 'http://localhost:8765/';
fs.mkdirSync(SH, { recursive: true });
const T = Date.now().toString(36);
const errors = [];
const log = (...a) => console.log(...a);
const EMU = BASE + '?emulator';

async function newUser(browser, name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: !!process.env.HTTPS_PROXY });
  // Never touch a real project from this test, whatever docs/config.js holds.
  await ctx.route('**/config.js', r => r.fulfill({ contentType: 'application/javascript', body: 'window.MOVI_CONFIG={firebase:null,appCheckSiteKey:null};' }));
  if (process.env.MOVI_SDK_DIR) await ctx.route('https://www.gstatic.com/firebasejs/**', r => {
    const file = path.join(process.env.MOVI_SDK_DIR, path.basename(new URL(r.request().url()).pathname));
    r.fulfill({ contentType: 'application/javascript; charset=utf-8', body: fs.readFileSync(file), headers: { 'access-control-allow-origin': '*' } });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(name + ' pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::|ERR_/.test(m.text())) errors.push(name + ' console: ' + m.text().slice(0, 300)); });
  return page;
}
const step = async (name, page, fn) => {
  try { await fn(); log('ok  ', name); } catch (e) {
    const msg = e.message.split('\n')[0];
    log('FAIL', name, '—', msg);
    errors.push(name + ': ' + msg);
    await page.screenshot({ path: `${SH}/fail-${name.replace(/\W+/g, '_')}.png` }).catch(() => {});
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const go = async (page, hash) => { await page.goto(BASE + hash); };
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise(r => setTimeout(r, 400));
  }
};
async function rankOpenFlow(page, feel, note) {
  await page.waitForSelector('.feel');
  await page.click(`.feel.${feel}`);
  for (let g = 0; g < 12 && await page.$('#pick-new'); g++) { await page.click(g % 2 ? '#pick-old' : '#pick-new').catch(() => {}); await page.waitForTimeout(350); }
  await page.waitForSelector('.big-score', { timeout: 15000 });
  if (note) { await page.click('#flow [data-where="Theater"]'); await page.fill('#flow [name=note]', note); }
  await page.click('[data-act="flow-done"]');
  await page.waitForSelector('#flow[hidden]', { state: 'attached' });
}
// The Been list as the page shows it: [{ id, title, score }]
const beenList = async (page) => {
  await go(page, '#/lists/been');
  await page.waitForSelector('.rowi');
  return page.$$eval('.rowi', els => els.map(e => ({ id: Number(e.dataset.film), title: e.querySelector('.t').textContent, score: e.querySelector('.score').textContent })));
};

(async () => {
  const proxy = process.env.HTTPS_PROXY && !process.env.MOVI_SDK_DIR ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
  const browser = await chromium.launch({ proxy });
  const A = await newUser(browser, 'alice'), B = await newUser(browser, 'bob');
  const ua = `alice.${T}`, ua2 = `alice_2.${T}`, mailA = `alice.${T}@test.dev`, mailB = `bob.${T}@test.dev`;
  let ub = null, aFilms = [];

  // ───────── Alice: email sign-up ─────────
  await step('live mode: no demo note, Google button shown', A, async () => {
    await A.goto(EMU);
    await A.waitForSelector('.welcome', { timeout: 30000 });
    expect(!(await A.$('.demo-note')), 'still in demo mode');
    expect(await A.$('[data-act="google"]'), 'no Google button');
    expect(await A.evaluate(() => typeof window.__emuSignIn === 'function'), 'no emulator sign-in hook');
  });
  await step('guests cannot open the leaderboard or a profile', A, async () => {
    await go(A, '#/leaderboard');
    await A.waitForSelector('.empty h3');
    expect((await A.textContent('.empty h3')).includes('Sign in'), 'leaderboard open to guests');
    await go(A, '#/welcome');
    await A.waitForSelector('.welcome');
  });
  await step('alice signs up with email, username with a dot', A, async () => {
    await A.fill('[name=display_name]', 'Alice Live');
    await A.fill('[name=username]', ua);
    await A.fill('[name=email]', mailA);
    await A.fill('[name=password]', 'secret123');
    await A.click('#auth-go');
    await A.waitForSelector('.ob h1', { timeout: 20000 });
    await go(A, `#/u/${ua}`);
    await A.waitForSelector('.phead');
    expect((await A.textContent('.phead')).includes('@' + ua), 'profile does not show @' + ua);
    await go(A, '#/onboarding');
    await A.waitForSelector('.ob h1');
  });
  await step('alice ranks 3 films in onboarding (2 loved, 1 fine)', A, async () => {
    for (const f of ['loved', 'loved', 'fine']) {
      await A.click('.ob [data-act="rank"]');
      await rankOpenFlow(A, f, 'note for ' + f);
      await A.waitForSelector('.ob h1');
      await A.waitForTimeout(300);
    }
    await A.click('[data-act="ob-next"]');
    await A.waitForSelector('#ob-people');
    await A.click('[data-act="ob-done"]');
    await A.waitForSelector('.post', { timeout: 15000 });
    expect((await A.$$('.post [data-act=delete-post]')).length === 3, 'expected 3 own posts');
  });
  await step('alice ranks a 4th film into Didn\'t like and re-ranks one', A, async () => {
    await A.click('[data-act="quick-add"]');
    await A.fill('#qa', 'pulp fiction');
    await A.waitForTimeout(400);
    await A.click('.qa-row');
    await rankOpenFlow(A, 'disliked', 'not for me');
    const before = await beenList(A);
    expect(before.length === 4, 'rows ' + before.length);
    // Re-rank the top film as "fine".
    await A.click('.rowi');
    await A.waitForSelector('.panel [data-act="rank"]');
    await A.click('.panel [data-act="rank"]');
    await rankOpenFlow(A, 'fine', null);
    await A.keyboard.press('Escape');
    const after = await beenList(A);
    expect(after.length === 4, 'rows after re-rank ' + after.length);
    expect(after[0].id !== before[0].id, 're-ranked film is still first');
  });
  await step('rankings persist after reload: same order and scores, notes kept', A, async () => {
    const before = await beenList(A);
    aFilms = before;
    await A.reload();
    const after = await beenList(A);
    expect(JSON.stringify(before) === JSON.stringify(after), `lists differ:\n${JSON.stringify(before)}\n${JSON.stringify(after)}`);
    const text = await A.textContent('#rows');
    expect(text.includes('note for loved') && text.includes('not for me'), 'notes missing after reload');
    expect(text.includes('Theater'), 'watched-where missing after reload');
  });
  await step('watch details persist', A, async () => {
    await A.click('.rowi');
    await A.waitForSelector('#sheet #details');
    await A.fill('#sheet [name=watched_with]', 'With Sam');
    await A.fill('#sheet [name=watched_on]', '2026-01-02');
    await A.check('#sheet [name=rewatch]');
    await A.waitForTimeout(1500);
    await A.reload();
    await beenList(A);
    await A.click('.rowi');
    await A.waitForSelector('#sheet #details');
    expect((await A.inputValue('#sheet [name=watched_with]')) === 'With Sam', 'watched_with lost');
    expect((await A.inputValue('#sheet [name=watched_on]')) === '2026-01-02', 'watched_on lost');
    expect(await A.isChecked('#sheet [name=rewatch]'), 'rewatch lost');
    await A.keyboard.press('Escape');
  });
  await step('watchlist: save, persists, remove', A, async () => {
    const free = [40, 41, 42, 43, 44, 45, 46, 47].filter(id => !aFilms.some(f => f.id === id)).slice(0, 2);
    for (const x of free) {
      await go(A, `#/film/${x}`);
      await A.waitForSelector('.panel [data-act="watch"]');
      await A.click('.panel [data-act="watch"]');
      await A.waitForSelector('.panel [data-act="unwatch"]');
    }
    await A.reload();
    await go(A, '#/lists/want');
    await A.waitForSelector('#list-body .card');
    expect((await A.$$('#list-body .card')).length === 2, 'watchlist should have 2');
    await A.click('#list-body [data-act="unwatch"]');
    await A.waitForTimeout(800);
    await A.reload();
    await go(A, '#/lists/want');
    await A.waitForSelector('#list-body .card');
    expect((await A.$$('#list-body .card')).length === 1, 'watchlist should have 1 after remove');
  });
  await step('To rank: AI matching (emulator fake answers "Star Wars (1977)" for line 1), saved, persists', A, async () => {
    await go(A, '#/lists/torank');
    await A.waitForSelector('#bulk-text');
    await A.fill('#bulk-text', 'the first star war\ntoy story\nthe matrix');
    await A.click('[data-act="bulk-match"]');
    await A.waitForSelector('.match-row', { timeout: 20000 });
    const titles = await A.$$eval('.match-row .minfo b', e => e.map(x => x.textContent));
    expect(await A.$('.tag.ai'), 'no "Matched with AI" tag; matched: ' + titles.join(' | '));
    expect(titles[0] === 'Star Wars', 'line 1 matched ' + titles[0]);
    await A.click('[data-act="bulk-add"]');
    await A.waitForSelector('[data-act="rank-queue"]');
    await A.reload();
    await go(A, '#/lists/torank');
    await A.waitForSelector('[data-act="unbacklog"]');
    expect((await A.$$('[data-act="unbacklog"]')).length === 3, 'To rank should have 3 after reload');
    await A.click('[data-act="unbacklog"]');
    await A.waitForTimeout(1000);
    await A.reload();
    await go(A, '#/lists/torank');
    await A.waitForSelector('[data-act="unbacklog"]');
    expect((await A.$$('[data-act="unbacklog"]')).length === 2, 'To rank should have 2 after removing one');
  });
  await A.screenshot({ path: `${SH}/a-torank.png` });

  // ───────── Bob: Google-style sign-in ─────────
  await step('bob signs in with Google (emulator): gets a suggested username and a profile', B, async () => {
    await B.goto(EMU);
    await B.waitForSelector('.welcome', { timeout: 30000 });
    await B.evaluate(([email]) => window.__emuSignIn(email, 'Bob Tester'), [mailB]);
    await B.reload();
    await B.waitForSelector('.ob h1', { timeout: 20000 });
    await go(B, '#/settings');
    await B.waitForSelector('#prof-form');
    ub = await B.inputValue('#prof-form [name=username]');
    expect(/^bob\.tester\d*$/.test(ub), 'suggested username was ' + ub);
    expect((await B.inputValue('#prof-form [name=display_name]')) === 'Bob Tester', 'display name not taken from Google');
    expect(!(await B.$('#pw-form')), 'password form offered to a Google-only account');
  });
  await step('bob ranks a film alice ranked', B, async () => {
    await go(B, `#/film/${aFilms[0].id}`);
    await B.waitForSelector('.panel [data-act="rank"]');
    await B.click('.panel [data-act="rank"]');
    await rankOpenFlow(B, 'loved', 'bob liked it');
    await B.keyboard.press('Escape');
  });
  await step('people search by prefix (username and name), bob follows alice', B, async () => {
    await go(B, '#/search?tab=people');
    await B.fill('#q', ua.slice(0, 9));
    await B.waitForSelector('#results .urow', { timeout: 10000 });
    expect((await B.textContent('#results')).includes('@' + ua), 'username prefix did not find alice');
    await B.fill('#q', 'Alice Li');
    await until(async () => (await B.textContent('#results')).includes('@' + ua), 'name prefix to find alice');
    const row = B.locator('#results .urow', { hasText: '@' + ua });
    await row.locator('[data-act="follow"]').click();
    await row.locator('[data-act="unfollow"]').waitFor();
    expect((await row.locator('[data-act="unfollow"]').textContent()).trim() === 'Following', 'follow was not immediate');
  });
  await step('bob\'s Following feed shows alice; like and comment update the counts', B, async () => {
    await go(B, '#/feed');
    const post = B.locator('.post', { hasText: 'Alice Live' }).first();
    await post.waitFor({ timeout: 15000 });
    await post.locator('[data-act=like]').click();
    expect((await post.locator('[data-act=like] span').textContent()) === '1', 'like count not shown at once');
    await post.locator('[data-act=comments]').click();
    await post.locator('.cmt-form input').fill('Nice ranking Alice');
    await post.locator('.cmt-form button').click();
    await post.locator('.cmt', { hasText: 'Nice ranking Alice' }).waitFor();
    expect((await post.locator('[data-act=comments] span').textContent()) === '1', 'comment count not shown at once');
    // The counts on the server are kept by a Cloud Function: after a moment a fresh load shows them too.
    await until(async () => {
      await B.reload();
      const p = B.locator('.post', { hasText: 'Alice Live' }).first();
      await p.waitFor({ timeout: 15000 });
      return (await p.locator('[data-act=like] span').textContent()) === '1' && (await p.locator('[data-act=comments] span').textContent()) === '1'
        && (await p.locator('[data-act=like]').getAttribute('aria-pressed')) === 'true';
    }, 'server-side like/comment counts', 30000);
  });
  await B.screenshot({ path: `${SH}/b-feed.png` });
  await step('film page shows who ranked it, with scores', B, async () => {
    await go(B, `#/film/${aFilms[0].id}`);
    await B.waitForSelector('.panel .who', { timeout: 15000 });
    const who = B.locator('.panel .who', { hasText: 'Alice Live' });
    await who.waitFor();
    expect((await who.locator('.score').textContent()) === aFilms[0].score, `alice's score on the film page is ${await who.locator('.score').textContent()}, her list says ${aFilms[0].score}`);
    await B.screenshot({ path: `${SH}/b-sheet.png` });
    await B.keyboard.press('Escape');
  });
  await step('bob recommends a film to alice', B, async () => {
    await go(B, '#/film/12');
    await B.waitForSelector('.panel [data-act="recommend"]');
    await B.click('.panel [data-act="recommend"]');
    await B.waitForSelector('.pick-people .pp');
    await B.click('.pick-people .pp');
    await B.fill('#rec-msg', 'Watch this Alice');
    await B.click('#rec-send');
    await B.waitForSelector('#modal[hidden]', { state: 'attached' });
    await B.keyboard.press('Escape');
  });
  await step('alice gets notifications for the follow, like, comment and recommendation', A, async () => {
    await until(async () => {
      await go(A, '#/notifications');
      await A.reload();
      await A.waitForSelector('#nbox .note-row, #nbox .empty', { timeout: 15000 });
      const t = await A.textContent('#nbox');
      return ['started following you', 'liked your ranking', 'commented', 'Nice ranking Alice', 'recommended', 'Watch this Alice'].every(w => t.includes(w));
    }, 'all four notifications', 40000);
  });
  await A.screenshot({ path: `${SH}/a-notifications.png` });
  await step('alice sees the like and comment counts on her post', A, async () => {
    await go(A, '#/feed');
    await A.waitForSelector('.post');
    const counts = await A.$$eval('.post', ps => ps.map(p => [p.querySelector('[data-act=like] span').textContent, p.querySelector('[data-act=comments] span').textContent].join('/')));
    expect(counts.includes('1/1'), 'no post with 1 like / 1 comment: ' + counts.join(' '));
  });
  await step('alice\'s Recs tab shows the recommendation; saving it goes to her watchlist', A, async () => {
    await go(A, '#/lists/recs');
    await A.waitForSelector('.rec');
    expect((await A.textContent('.rec')).includes('Watch this Alice'), 'rec message missing');
    await A.click('.rec [data-act="watch-from"]');
    await A.waitForTimeout(800);
    await go(A, '#/lists/want');
    await A.waitForSelector('#list-body .card');
    expect((await A.textContent('#list-body')).includes('Recommended'), 'recommended film not on watchlist');
  });
  await step('leaderboard (friends and everyone), compare, taste', B, async () => {
    await go(B, '#/leaderboard');
    await B.waitForSelector('.board li.me');
    expect((await B.textContent('.board')).includes('@' + ua), 'alice not on bob\'s friends board');
    await B.click('[data-btab="everyone"]');
    await B.waitForSelector('.board li.me');
    await go(B, `#/u/${ua}/compare`);
    await B.waitForSelector('.compare-hero');
    await go(B, `#/u/${ua}/rankings`);
    await B.waitForSelector('#prow .rowi');
    expect((await B.$$('#prow .rowi')).length === 4, 'alice\'s rankings not all visible to bob');
    expect((await B.textContent('.pstats')).includes('on Movi'), 'no place on Movi');
    await go(B, `#/u/${ub}/taste`);
    await B.waitForSelector('.badges');
  });
  await step('alice changes her username', A, async () => {
    await go(A, '#/settings');
    await A.waitForSelector('#prof-form');
    await A.fill('#prof-form [name=username]', ua2);
    await A.fill('#prof-form [name=bio]', 'I rank everything');
    await A.click('#prof-form .btn.primary');
    await until(async () => (await A.textContent('#toast')).includes('Profile saved') || (await A.textContent('#prof-err')), 'profile save');
    expect(!(await A.textContent('#prof-err')), 'save failed: ' + await A.textContent('#prof-err'));
    await A.reload();
    await go(A, `#/u/${ua2}`);
    await A.waitForSelector('.phead .bio');
    await go(B, `#/u/${ua2}`);
    await B.waitForSelector('.phead [data-act="unfollow"]');
    await go(B, `#/u/${ua}`);
    await B.waitForSelector('.empty h3');
  });
  await step('alice changes her password, signs out, signs in with the new one', A, async () => {
    await go(A, '#/settings');
    await A.waitForSelector('#pw-form');
    await A.fill('#pw-form [name=password]', 'newsecret456');
    await A.click('#pw-form .btn');
    await until(async () => (await A.textContent('#toast')).includes('Password updated'), 'password update');
    await A.click('[data-act="sign-out"]');
    await A.waitForSelector('.welcome');
    await A.click('[data-atab="signin"]');
    await A.fill('#auth-form [name=email]', mailA);
    await A.fill('#auth-form [name=password]', 'secret123');
    await A.click('#auth-go');
    await A.waitForFunction(() => document.querySelector('#auth-err')?.textContent.includes('Wrong'));
    await A.fill('#auth-form [name=password]', 'newsecret456');
    await A.click('#auth-go');
    await A.waitForSelector('.post', { timeout: 20000 });
    expect((await beenList(A)).length === 4, 'rankings missing after signing back in');
  });
  await step('alice removes a film: it leaves the list and the scores shift', A, async () => {
    await beenList(A);
    await A.click('.rowi');
    await A.waitForSelector('.panel [data-act="remove"]');
    await A.click('.panel [data-act="remove"]');
    await A.click('#dlg-ok');
    await A.waitForTimeout(1200);
    await A.reload();
    expect((await beenList(A)).length === 3, 'rows after remove');
  });
  await step('bob deletes his Movi data', B, async () => {
    await go(B, '#/settings');
    await B.waitForSelector('[data-act="delete-account"]');
    expect((await B.textContent('[data-act="delete-account"]')).includes('Delete my Movi data'), 'button wording');
    await B.click('[data-act="delete-account"]');
    await B.click('#dlg-ok');
    await B.waitForSelector('.welcome', { timeout: 30000 });
    await go(A, `#/u/${ub}`);
    await A.waitForSelector('.empty h3');
    expect((await A.textContent('.empty h3')).includes('No one by that name'), 'bob\'s profile still there');
    await go(A, `#/u/${ua2}`);
    await A.waitForSelector('.pstats');
    await until(async () => { await A.reload(); await A.waitForSelector('.pstats'); return (await A.textContent('.pstats')).includes('0 followers'); }, 'bob to leave alice\'s followers', 20000);
  });

  log('ERRORS', JSON.stringify(errors, null, 1));
  process.exitCode = errors.length ? 1 : 0;
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

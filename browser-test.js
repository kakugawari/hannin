/*
 * ブラウザで実際に動かして確かめるテスト。
 *
 *   npm i -D playwright && npm run test:ui
 *
 * 画面まわりの不具合は node のテストでは捕まらない。ここでは本物の
 * ブラウザを立ち上げ、指の操作をそのまま再現して確かめる。
 *
 * ★ アプリを作ったら「ここにアプリごとの確認を足す」に書き足すこと。
 *   直した不具合には、かならず見張り役をここに置く。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');
const fs = require('node:fs');

const PORT = Number(process.env.PORT || 8123);
const URL = `http://localhost:${PORT}/`;
const ROOT = __dirname;
const CHROMIUM = process.env.CHROMIUM_PATH;   // 手元の Chromium を使いたいとき

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log('  \x1b[32m✓\x1b[0m ' + message);
  } else {
    failed++;
    console.log('  \x1b[31m✗ FAIL\x1b[0m ' + message);
  }
}

function skip(message) {
  console.log('  \x1b[90m- とばした: ' + message + '\x1b[0m');
}

function section(name) {
  console.log('\n' + name);
}

function waitForServer() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      http.get(URL, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - started > 10000) reject(new Error('サーバーが起動しない'));
          else setTimeout(tick, 100);
        });
    };
    tick();
  });
}

/**
 * 何かした直後に、その要素が本来の場所からどれだけずれるかを
 * 1 フレームずつ測る。「置いた瞬間に一瞬とぶ」たぐいの不具合はこれで見つかる。
 *
 * @returns {Promise<number>} 最大のずれ (px)
 */
function measureJump(page, selector, act) {
  return page.evaluate(async ({ sel, code }) => {
    const before = document.querySelector(sel).getBoundingClientRect();
    // eslint-disable-next-line no-new-func
    new Function(code)();
    let worst = 0;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const el = document.querySelector(sel);
      if (!el) { worst = Infinity; break; }
      const now = el.getBoundingClientRect();
      worst = Math.max(worst, Math.abs(now.left - before.left), Math.abs(now.top - before.top));
    }
    return Math.round(worst);
  }, { sel: selector, code: act });
}

async function run() {
  let chromium;
  let devices;
  try {
    ({ chromium, devices } = require('playwright'));
  } catch (e) {
    console.error('playwright が必要です:  npm i -D playwright');
    process.exit(1);
  }

  const server = spawn(process.execPath, [path.join(ROOT, 'serve.js'), String(PORT)], {
    stdio: 'ignore'
  });
  await waitForServer();

  const browser = await chromium.launch(CHROMIUM ? { executablePath: CHROMIUM } : {});
  const errors = [];

  try {
    // ------------------------------------------------ スマホで開く
    section('スマホで開く');
    const context = await browser.newContext({ ...devices['iPhone 13'] });
    const phone = await context.newPage();
    phone.on('pageerror', (e) => errors.push('スマホ: ' + e.message));
    phone.on('console', (m) => { if (m.type() === 'error') errors.push('スマホ: ' + m.text()); });
    await phone.goto(URL, { waitUntil: 'load' });
    ok(true, 'ページが開く');

    const fit = await phone.evaluate(() => ({
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      title: document.title.trim(),
      painted: document.body.innerText.trim().length + document.querySelectorAll('canvas, svg, img').length
    }));
    ok(fit.wide <= 1, 'スマホ幅で横スクロールが出ない');
    ok(fit.title.length > 0, `ページの名前 (title) がある (${fit.title})`);
    ok(fit.painted > 0, '画面に何か出ている (真っ白ではない)');

    // ホーム画面から開いたとき、時計や電池の帯の下まで描く指定がそろっている
    // (無いと、画面のいちばん上が theme-color の板になる。帯そのものは実機でしか見られない)
    const bar = await phone.evaluate(() => {
      const meta = (n) => (document.querySelector(`meta[name="${n}"]`) || {}).content || '';
      return {
        capable: meta('apple-mobile-web-app-capable'),
        style: meta('apple-mobile-web-app-status-bar-style'),
        cover: /viewport-fit=cover/.test(meta('viewport')),
        theme: meta('theme-color')
      };
    });
    ok(bar.capable === 'yes' && bar.style === 'black-translucent' && bar.cover,
      `ホーム画面から開くと帯の下まで描く指定がある (${JSON.stringify(bar)})`);
    ok(/^#[0-9a-f]{6}$/i.test(bar.theme), `帯の色 (theme-color) が決めてある (${bar.theme})`);

    // ------------------------------------------------ ここにアプリごとの確認を足す
    section('アプリの操作 (はんにんダンス)');
    // 配り方で道すじが分かれるので、乱数を決め打ちにして 3 通り試す
    //   2: 手札に「取り引き」(相手をタップしてえらぶ)
    //   16: ほかの人の「情報操作」で、自分も渡す札をえらぶ番がはさまる
    //   18: 自分が第一発見者 (表示は「あなた の番」と、すき間が入る)
    for (const seed of [2, 16, 18]) {
      const ctx = await browser.newContext({ ...devices['iPhone 13'] });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push(`はんにん(${seed}): ` + e.message));
      await pg.addInitScript((sd) => {
        let a = sd >>> 0;
        Math.random = () => {
          a = (a + 0x6d2b79f5) >>> 0; let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }, seed);
      await pg.goto(URL, { waitUntil: 'load' });
      await pg.locator('#hsStart').tap();
      await pg.locator('#start').tap();
      // 記録の欄は古い行から消えるので、出てきた行をぜんぶ控えておく
      await pg.evaluate(() => {
        window.__seenLog = [];
        const box = document.querySelector('#log');
        const grab = () => { for (const l of box.innerText.split('\n')) if (l.trim() && !window.__seenLog.includes(l.trim())) window.__seenLog.push(l.trim()); };
        grab();
        new MutationObserver(grab).observe(box, { childList: true, subtree: true, characterData: true });
      });
      const state = () => pg.evaluate(() => ({
        info: document.querySelector('#infoTxt').textContent,
        prompt: document.querySelector('#prompt').innerText,
        picks: document.querySelectorAll('#players .pl.pick').length
      }));
      // 知らせ (OK)・渡す札・相手えらびを片づけながら、「カードを1まい出そう」の番まで進める
      const settle = async (untilMyTurn) => {
        for (let i = 0; i < 80; i++) {
          const okBtn = pg.locator('#modal button:visible');
          if (await okBtn.count()) { await okBtn.first().tap().catch(() => {}); await pg.waitForTimeout(300); continue; }
          const st = await state();
          if (st.picks) { await pg.locator('#players .pl.pick').first().tap().catch(() => {}); await pg.waitForTimeout(300); continue; }
          if (/わたすカード/.test(st.info + st.prompt)) {
            await pg.locator('#hand .card').first().tap().catch(() => {});
            const go = pg.locator('#go:not([disabled]):visible');
            if (await go.count()) await go.tap().catch(() => {});
            await pg.waitForTimeout(300); continue;
          }
          if (untilMyTurn && /カードを1まい出そう/.test(st.prompt)) return true;
          if (!untilMyTurn && !/えらんで|タップして/.test(st.info)) return true;
          await pg.waitForTimeout(300);
        }
        return false;
      };
      const myTurn = await settle(true);
      ok(myTurn, `配り方${seed}: 知らせや相手の札を片づけながら、自分の番がくる`);
      if (!myTurn) { await ctx.close(); continue; }
      const names = await pg.locator('#hand .card .cn').evaluateAll((els) => els.map((e) => e.textContent.trim()));
      const pick = names.includes('取り引き') ? names.indexOf('取り引き') : 0;
      await pg.locator('#hand .card').nth(pick).tap();
      await pg.locator('#go:not([disabled])').tap({ timeout: 3000 });
      await settle(false);
      await pg.waitForTimeout(500);
      const mine = (await pg.evaluate(() => window.__seenLog)).filter((l) => /^あなた は/.test(l));
      ok(mine.some((l) => l.includes(names[pick])),
        `配り方${seed}: 自分のカードを出せる (${names[pick]} / 記録: ${mine.join(' / ').slice(0, 50)})`);
      await ctx.close();
    }
    if (!(await phone.locator('#btnAction').count())) {
      // 雛形のボタンは無い
    } else {
    await phone.locator('#btnAction').tap();
    await phone.waitForTimeout(120);
    const after = await phone.evaluate(() => ({
      count: window.__app.state().count,
      shown: document.getElementById('result').textContent
    }));
    ok(after.count === 1 && after.shown !== '—', `ボタンを押すと結果が出る (${after.shown})`);

    // 押した直後に表示が飛ばないか (CSS アニメーションの上書き事故よけ)
    const jump = await measureJump(phone, '#result', 'document.getElementById("btnAction").click()');
    ok(jump < 12, `押した直後に表示が飛ばない (最大ずれ ${jump}px)`);
    }

    // ------------------------------------------------ 明るい画面・暗い画面
    section('明るい画面と暗い画面');
    for (const scheme of ['light', 'dark']) {
      const themed = await browser.newContext({ ...devices['iPhone 13'], colorScheme: scheme });
      const page = await themed.newPage();
      page.on('pageerror', (e) => errors.push(scheme + ': ' + e.message));
      await page.goto(URL, { waitUntil: 'load' });
      const colors = await page.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        fg: getComputedStyle(document.body).color
      }));
      ok(colors.bg !== colors.fg, `${scheme}: 文字と背景の色が違う (${colors.bg} / ${colors.fg})`);
      await themed.close();
    }

    // ------------------------------------------------ アイコン (用意していれば)
    section('アイコン');
    const desk = await browser.newPage();
    await desk.goto(URL);
    const apple = await desk.evaluate(() =>
      document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'));
    // 対象は iPhone のホーム画面から開く使い方なので、無ければとばさずに落とす
    // (とばしにしていたら、れんだメーターでアイコンが無いまま公開した。CLAUDE.md の落とし穴)
    ok(!!apple, 'ホーム画面用のアイコン (apple-touch-icon) の指定がある');
    if (apple) {
      // iOS は SVG のアイコンを使えない
      ok(apple.endsWith('.png'), `ホーム画面用アイコンが PNG (${apple})`);
      const res = await desk.request.get(URL + apple.replace('./', ''));
      ok(res.ok(), `${apple} が配信される`);
    }

    // ------------------------------------------------ 更新とオフライン (sw.js があれば)
    section('更新とオフライン');
    if (!fs.existsSync(path.join(ROOT, 'sw.js'))) {
      skip('サービスワーカーはまだ無い (オフライン対応するときに用意する)');
    } else {
      const swCtx = await browser.newContext();
      const swPage = await swCtx.newPage();
      await swPage.goto(URL, { waitUntil: 'load' });
      ok(await swPage.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active).catch(() => false)),
        'サービスワーカーが動く');
      await swPage.waitForTimeout(800);

      // 直したものが 1 回のリロードで出るか (キャッシュ優先だと古い画面が出る)
      const indexPath = path.join(ROOT, 'index.html');
      const original = fs.readFileSync(indexPath, 'utf8');
      // 画面を JS で描くアプリもあるので、<h1> ではなく <title> を書き換えて見る
      const marker = original.match(/<title[^>]*>([^<]*)<\/title>/);
      fs.writeFileSync(indexPath, original.replace(marker[0], '<title>こうしんかくにん</title>'));
      await swPage.reload();
      await swPage.waitForTimeout(400);
      const title = await swPage.title();
      fs.writeFileSync(indexPath, original);
      ok(title.trim() === 'こうしんかくにん', `直したものが 1 回のリロードで出る (${title.trim()})`);

      await swPage.reload();
      await swPage.waitForTimeout(500);
      await swCtx.setOffline(true);
      await swPage.reload().catch(() => {});
      await swPage.waitForTimeout(400);
      // 画面が絵だけで字が無いアプリもあるので、字の量ではなくページの名前で見る (はんにんダンスで踏んだ)
      ok(await swPage.evaluate(() => document.title.length > 0 && document.body.children.length > 0).catch(() => false),
        'ネットにつながらなくても開ける');
      await swCtx.setOffline(false);
    }

    section('エラー');
    ok(errors.length === 0, errors.length ? '画面のエラー: ' + errors.join(' / ') : 'JS エラーなし');
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${passed} 件合格 / ${failed} 件失敗`);
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

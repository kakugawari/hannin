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
    let callSeen = 0;
    for (const seed of [2, 16, 18]) {
      // 対象の端末 (iPhone 16 Plus 430x932) で。下の安全域 (34pt) ぶん低くしても場の札が場に収まるかも見るため、高さは 898
      const ctx = await browser.newContext({ viewport: { width: 430, height: 898 }, hasTouch: true, isMobile: true });
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
        const grab = () => { for (const l of [...box.querySelectorAll('div')].map((d) => d.textContent)) if (l.trim() && !window.__seenLog.includes(l.trim())) window.__seenLog.push(l.trim()); };
        grab();
        new MutationObserver(grab).observe(box, { childList: true, subtree: true, characterData: true });
      });
      const state = () => pg.evaluate(() => ({
        info: document.querySelector('#infoTxt').textContent,
        prompt: document.querySelector('#prompt').textContent,
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
            // えらぶ番は、場に大きな札が出て、手札がゆれる (前は手札の上の 16px の 1 行だけで、気づかなかった)
            if (!sawCall) sawCall = await pg.evaluate(() => {
              const c = document.querySelector('#callout'), r = c.getBoundingClientRect(), t = document.querySelector('#table').getBoundingClientRect();
              const ct = c.querySelector('.ct'), p = document.querySelector('#played').getBoundingClientRect();
              return { rc: [r.top, r.bottom, r.left, r.right].map(Math.round), rt: [t.top, t.bottom, t.left, t.right].map(Math.round), shown: !c.hidden && r.height > 40, text: c.textContent.trim(), font: ct ? parseFloat(getComputedStyle(ct).fontSize) : 0,
                inside: r.top >= t.top && r.bottom <= t.bottom + 1 && r.left >= t.left && r.right <= t.right, clear: r.top >= p.bottom - 1,
                shake: [...document.querySelectorAll('#hand .card')].some((e) => e.getAnimations().length > 0) };
            });
            await pg.locator('#hand .card').first().tap({ force: true }).catch(() => {});
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
      let sawCall = null;
      const myTurn = await settle(true);
      ok(myTurn, `配り方${seed}: 知らせや相手の札を片づけながら、自分の番がくる`);
      if (!myTurn) { await ctx.close(); continue; }
      const names = await pg.locator('#hand .card .cn').evaluateAll((els) => els.map((e) => e.textContent.trim()));
      const pick = names.includes('取り引き') ? names.indexOf('取り引き') : 0;
      await pg.locator('#hand .card').nth(pick).tap({ force: true });
      await pg.locator('#go:not([disabled])').tap({ timeout: 3000 });
      await settle(false);
      await pg.waitForTimeout(500);
      // 出したカードの行は画面では顔の列で見せるので、記録そのもの (G.log) を見る
      const mine = (await pg.evaluate(() => G.log.map((l) => l.replace(/[\u0001\u0003]|\u0002/g, '').replace(/^0(?=「)/, 'あなた')))).filter((l) => /^あなた「/.test(l));
      if (sawCall) {
        ok(sawCall.shown && sawCall.font >= 20 && /わたす/.test(sawCall.text) && sawCall.inside && sawCall.clear && sawCall.shake,
          `配り方${seed}: わたすカードをえらぶ番は、場に大きな札 (${sawCall.font}px「${sawCall.text.slice(0, 26)}」) が出て、手札がゆれる`);
        callSeen++;
      }
      ok(mine.some((l) => l.includes(names[pick])),
        `配り方${seed}: 自分のカードを出せる (${names[pick]} / 記録: ${mine.join(' / ').slice(0, 50)})`);
      await ctx.close();
    }
    ok(callSeen >= 1, `わたすカードをえらぶ番を、${callSeen} 通りの配り方で試した (配り方16 は情報操作がはさまる)`);
    section('タイトルの絵 (使う人がくれた絵)');
    {
      const pg = await browser.newPage({ viewport: { width: 430, height: 932 } });
      await pg.goto(URL, { waitUntil: 'load' });
      const t = await pg.evaluate(() => {
        const img = document.querySelector('#title .tbg img'), b = img.getBoundingClientRect();
        return { filter: getComputedStyle(img).filter, w: img.naturalWidth, h: img.naturalHeight, top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right),
          after: getComputedStyle(document.querySelector('#title .tbg'), '::after').content };
      });
      // くれた絵をそのまま出す (色を変える加工やざらつきは重ねない)。画面いっぱいに収まる
      ok(t.w === 851 && t.h === 1847 && t.filter === 'none' && (t.after === 'none' || t.after === 'normal'),
        `タイトルは くれた絵 (${t.w}x${t.h}) を加工せずに出す (filter ${t.filter})`);
      ok(t.top >= -1 && t.bottom <= 933 && t.left >= -1 && t.right <= 431 && t.bottom - t.top > 925, `絵が画面いっぱいに収まる (${t.left},${t.top}〜${t.right},${t.bottom})`);
      // 絵に描き込まれていた時計・電池・下のバーを消した (本物と二重に見える)。上の帯の所は空の色だけ
      const px = await pg.evaluate(async () => {
        const img = document.querySelector('#title .tbg img'), c = document.createElement('canvas'); c.width = 851; c.height = 1847;
        const g = c.getContext('2d'); g.drawImage(img, 0, 0);
        const bright = (x0, y0, x1, y1) => { const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) n++; return n; };
        return { clock: bright(88, 38, 232, 84), battery: bright(712, 42, 782, 78), bar: bright(274, 1818, 576, 1832) };
      });
      ok(px.clock < 5 && px.battery < 5 && px.bar < 5, `絵に描き込まれた時計・電池・下のバーを消した (白い画素 ${px.clock} / ${px.battery} / ${px.bar})`);
      // 透明な当たりが、絵のボタンの上にある。タップは動きの層を通って届く
      for (const [id, want] of [['#hsStart', '#setup'], ['#howBtn', '#modal'], ['#setBtn', '#modal'], ['#rankBtn', '#modal']]) {
        await pg.locator(id).click();
        const opened = await pg.evaluate((q) => !document.querySelector(q).hidden, want);
        ok(opened, `${id} を押すと開く`);
        await pg.evaluate(() => { document.querySelector('#setup').hidden = true; document.querySelector('#modal').hidden = true; });
      }
      await pg.close();
    }

    section('有料アプリの見直し (タイトル・知らせ・手札・画面)');
    {
      const pg = await browser.newPage({ viewport: { width: 430, height: 932 }, hasTouch: true });
      await pg.goto(URL, { waitUntil: 'load' });
      await pg.waitForTimeout(600);
      // タイトル: 動いている (月・星・音符・はじめるの光)。動きの層はタップを通す
      const t = await pg.evaluate(() => ({
        anim: (document.querySelector('#title .tfx')?.getAnimations({ subtree: true }).length || 0) + document.querySelector('#hsStart').getAnimations({ subtree: true }).length,
        through: document.querySelector('#title .tfx') ? getComputedStyle(document.querySelector('#title .tfx')).pointerEvents : 'なし',
      }));
      ok(t.anim >= 8 && t.through === 'none', `タイトルが動いている (動き ${t.anim} 個)。動きの層はタップを通す`);
      // あそびかた: ページを送って読む。字は大きく
      await pg.locator('#howBtn').tap();
      const p1 = await pg.evaluate(() => ({ t: document.querySelector('#rpage .pt')?.textContent || 'なし', f: parseFloat(getComputedStyle(document.querySelector('#modal .rules p')).fontSize) }));
      await pg.locator('#rnext').tap({ timeout: 1500 }).catch(() => {});
      const p2 = await pg.evaluate(() => document.querySelector('#rpage .pt')?.textContent || 'なし');
      await pg.locator('#modal .btns button').last().tap();
      ok(p1.t !== 'なし' && p1.t !== p2 && p1.f >= 16, `あそびかたは ページ送りで、字が大きい (${p1.t} → ${p2} / ${p1.f}px)`);
      // せってい: 今の状態が見える切りかえ。押すと切りかわって覚える
      await pg.locator('#setBtn').tap();
      await pg.locator('.srow .seg[data-k="speed"] button[data-v="fast"]').tap({ timeout: 1500 }).catch(() => {});
      const sp = await pg.evaluate(() => ({ on: document.querySelector('.srow .seg[data-k="speed"] button.on')?.textContent || 'なし', saved: JSON.parse(localStorage.getItem('yakata-settings') || '{}').speed }));
      ok(sp.on === 'はやい' && sp.saved === 'fast', `せっていは 今の状態が見え、押すと切りかわる (${sp.on} / 保存 ${sp.saved})`);
      await pg.locator('.srow .seg[data-k="speed"] button[data-v="normal"]').tap({ timeout: 1500 }).catch(() => {});
      await pg.locator('#modal .btns button').last().tap();
      // ランキング: 記録が無いときも、キャラと案内が出る
      await pg.locator('#rankBtn').tap();
      ok(await pg.evaluate(() => document.querySelectorAll('#modal .empty .av').length === 4), 'ランキングは 記録が無くても キャラと案内が出る');
      await pg.locator('#modal .btns button').first().tap();
      await pg.close();
    }
    {
      // 配り方18 で 1 ゲーム遊ぶ。OK を押させる知らせは、ないしょの手札 (目撃者) と 結果の 2 つだけ (前は 8 回)
      const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, hasTouch: true, isMobile: true });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push('見直し: ' + e.message));
      await pg.addInitScript(() => {
        let a = 18;
        Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
        window.__modals = 0;
        new MutationObserver(() => { const m = document.querySelector('#modal'); if (m && !m.hidden && !m.__open) { m.__open = true; window.__modals++; } if (m && m.hidden) m.__open = false; })
          .observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
      });
      await pg.goto(URL, { waitUntil: 'load' });
      await pg.locator('#hsStart').tap();
      await pg.locator('#start').tap();
      // 上のタイル: 手札の枚数はカードの裏 (細い枠の四角は字の出ない豆腐に見えた)。名前が「あなた」なら「あなた」の札は重ねない
      await pg.waitForTimeout(300);
      const tile = await pg.evaluate(() => {
        const i = document.querySelector('#players .pl .cnt i'), cs = getComputedStyle(i), r = i.getBoundingClientRect();
        const hand = [...document.querySelectorAll('#hand .card')].map((c) => c.getBoundingClientRect());
        return { w: r.width, h: r.height, bg: cs.backgroundImage, you: document.querySelectorAll('#players .you').length,
          n: hand.length, hfit: hand.every((c) => c.left >= 0 && c.right <= 430) };
      });
      ok(tile.w >= 12 && tile.h >= 18 && /gradient/.test(tile.bg), `手札の枚数は 小さなカードの裏 (${Math.round(tile.w)}x${Math.round(tile.h)}pt)`);
      ok(tile.you === 0, '名前が「あなた」のとき、「あなた」の札を重ねない');
      ok(tile.n >= 4 && tile.hfit, `はじめの手札 ${tile.n} まいが 横にはみ出さない (カードを大きくしたら 4 まいで左端が切れた)`);
      let fit = true, sizes = [];
      for (let k = 0; k < 400; k++) {
        const st = await pg.evaluate(() => ({ m: !document.querySelector('#modal').hidden, over: typeof G !== 'undefined' && G && G.over, pr: document.querySelector('#prompt').textContent,
          picks: document.querySelectorAll('#players .pl.pick').length, go: !document.querySelector('#go').disabled }));
        if (st.m) { if (st.over) break; await pg.locator('#modal button:visible').first().tap().catch(() => {}); continue; }
        if (st.picks) { await pg.locator('#players .pl.pick').first().tap().catch(() => {}); continue; }
        if (/出そう|わたす/.test(st.pr) && !st.go) {
          // 手札は枚数によらず横にはみ出さない
          const h = await pg.evaluate(() => [...document.querySelectorAll('#hand .card')].map((c) => c.getBoundingClientRect()));
          sizes.push(h.length);
          if (h.some((r) => r.left < 0 || r.right > 430)) fit = false;
          await pg.locator('#hand .card').first().tap({ force: true }).catch(() => {});
          await pg.locator('#go:not([disabled])').tap().catch(() => {});
          continue;
        }
        await pg.waitForTimeout(250);
      }
      const res = await pg.evaluate(() => ({ modals: window.__modals, flights: UI.flights || 0, over: G && G.over, eng: /WIN|LOSE/.test(document.querySelector('#modal').innerText) }));
      ok(res.over && res.modals <= 2, `1 ゲームで OK を押させる知らせは ${res.modals} 回 (ないしょの手札と結果だけ。前は 8 回)`);
      ok(res.flights >= 8, `カードが 飛んでいく動きで見せる (${res.flights} 回)`);
      ok(fit, `手札が横にはみ出さない (${[...new Set(sizes)].join('・')} まいのとき)`);
      ok(!res.eng, '結果に英語 (WIN / LOSE) を使わない');
      await ctx.close();
    }

    {
      // 実機の高さ (安全域 上59・下34 を差し込む) で: 「かんがえ中」の顔が帯からはみ出さない / 場のカード・出した人・説明が重ならない
      // (顔の大きさを決め忘れて帯の下に大きな顔が見切れた。手札を大きくしたら場が低くなり、名札と説明が重なった)
      const pg = await browser.newPage({ viewport: { width: 430, height: 932 }, hasTouch: true });
      await pg.addInitScript(() => { let a = 18; Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; });
      await pg.goto(URL, { waitUntil: 'load' });
      await pg.addStyleTag({ content: '#game{padding-top:67px!important;padding-bottom:44px!important}' });
      await pg.locator('#hsStart').tap();
      await pg.locator('#start').tap();
      await pg.waitForFunction(() => /かんがえ中/.test(document.querySelector('#infoTxt').innerText), null, { timeout: 15000 });
      const think = await pg.evaluate(() => {
        const info = document.querySelector('#info').getBoundingClientRect();
        return [...document.querySelectorAll('#info img')].map((i) => i.getBoundingClientRect()).map((r) => ({ in: r.top >= info.top - 1 && r.bottom <= info.bottom + 1, h: Math.round(r.height) }));
      });
      ok(think.length >= 1 && think.every((r) => r.in), `「かんがえ中」の顔が 帯の中に収まる (顔の高さ ${think.map((r) => r.h).join(',')}pt)`);
      await pg.waitForFunction(() => /タップで/.test(document.querySelector('#infoTxt').innerText) && document.querySelectorAll('#log div').length, null, { timeout: 15000 });
      const tb = await pg.evaluate(() => {
        const r = (q) => document.querySelector(q).getBoundingClientRect();
        const t = r('#table'), c = r('#played .card'), by = r('#played .by'), log = r('#log div');
        return { order: c.bottom <= by.top + 1 && by.bottom <= log.top + 1, inside: c.top >= t.top && r('#log').bottom <= t.bottom + 1, w: Math.round(c.width) };
      });
      ok(tb.order && tb.inside, `実機の高さで、場のカード → 出した人 → 説明 が重ならず、場の中に収まる (カード幅 ${tb.w}pt)`);
      // 場がもう 34pt 低くても重ならない (前は下の安全域が二重で、実機の場はこの高さだった。そこで名札と説明が重なった)
      await pg.setViewportSize({ width: 430, height: 898 });
      await pg.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const low = await pg.evaluate(() => {
        const r = (q) => document.querySelector(q).getBoundingClientRect();
        const t = r('#table'), c = r('#played .card'), by = r('#played .by'), log = r('#log div');
        return { ok: c.bottom <= by.top + 1 && by.bottom <= log.top + 1 && c.top >= t.top && r('#log').bottom <= t.bottom + 1, w: Math.round(c.width), h: Math.round(t.height) };
      });
      ok(low.ok, `場が低くても (${low.h}pt) カードが小さくなって 重ならない (カード幅 ${low.w}pt)`);
      await pg.close();
    }

    section('場 (いちばんの見せ場)');
    {
      // 配り方18: あなたが第一発見者 → CPU 3 人が出したあと、あなたの番。対象の iPhone 16 Plus の大きさで見る (決めごと)
      const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push('場: ' + e.message));
      await pg.addInitScript(() => {
        let a = 18;
        Math.random = () => {
          a = (a + 0x6d2b79f5) >>> 0; let t = a;
          t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      });
      await pg.goto(URL, { waitUntil: 'load' });
      await pg.locator('#hsStart').tap();
      await pg.locator('#start').tap();
      // 第一発見者の知らせは OK で止めない (場の上に重なり、時間がたつと消える)
      for (let i = 0; i < 80; i++) {     // 読む間はタップで進め、自分の番まで
        if (await pg.evaluate(() => /カードを1まい出そう/.test(document.querySelector('#prompt').textContent))) break;
        const okBtn = pg.locator('#modal button:visible');
        if (await okBtn.count()) { await okBtn.first().tap().catch(() => {}); continue; }
        if (await pg.evaluate(() => /タップで つぎへ/.test(document.querySelector('#infoTxt').textContent))) {
          const box = await pg.locator('#table').boundingBox();
          await pg.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 10);
        }
        await pg.waitForTimeout(250);
      }
      const size = await pg.evaluate(() => {
        const c = document.querySelector('#played .card').getBoundingClientRect();
        // 出したカードで何も起きないときは説明の行が無い。そのときは仮の行を入れて字の大きさを測る
        const box = document.querySelector('#log'), tmp = box.querySelector('div') ? null : box.appendChild(document.createElement('div'));
        const last = box.querySelector('div:last-child'), font = parseFloat(getComputedStyle(last).fontSize);
        if (tmp) tmp.remove();
        return { w: Math.round(c.width), font };
      });
      ok(size.w >= 130 && size.w <= 150, `場のカードが大きすぎず小さすぎない (幅 ${size.w}pt / 取り込み時 107pt・170pt では説明の字が負けた)`);
      ok(size.font >= 19, `いちばん新しい説明の字が大きい (${size.font}px / 取り込み時 13px)`);
      // カードは白い台紙なしで、そのカードの色に塗る (色でぱっと見分けるため)。名前は白
      const look = await pg.evaluate(() => {
        const c = document.querySelector('#played .card');
        return { bg: getComputedStyle(c).backgroundImage, name: getComputedStyle(c.querySelector('.cn')).color,
          colors: new Set(Object.values(CARDS).map((k) => k.c.toLowerCase())).size, kinds: Object.keys(CARDS).length };
      });
      ok(!/246, 236, 214/.test(look.bg) && /linear-gradient/.test(look.bg) && look.name === 'rgb(255, 255, 255)',
        `カードが色で塗られ、名前が白い (${look.name})`);
      ok(look.colors === look.kinds, `カードの色が 12 種類ぜんぶ違う (${look.colors}/${look.kinds})`);
      // 人のタイル: キャラの色の名札 + タイルの上のふちから出る顔。札 (あなた・なかま) は顔に重ねない
      await pg.evaluate(() => { G.players[0].acc = true; G.players[2].acc = true; UI.render(); });
      const tiles = await pg.evaluate(() => {
        const ov = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        return [...document.querySelectorAll('#players .pl')].map((t) => {
          const box = t.getBoundingClientRect(), av = t.querySelector('.av').getBoundingClientRect();
          const badges = [...t.querySelectorAll('.you,.tag')].map((e) => e.getBoundingClientRect());
          return { plate: getComputedStyle(t.querySelector('.nm')).backgroundColor, pop: Math.round(box.top - av.top),
            hit: badges.some((b) => ov(b, av)) || (badges.length === 2 && ov(badges[0], badges[1])) };
        });
      });
      ok(new Set(tiles.map((t) => t.plate)).size === tiles.length && tiles.every((t) => t.plate !== 'rgba(0, 0, 0, 0)'),
        `名札がキャラの色で、${tiles.length} 人とも違う (${tiles.map((t) => t.plate).join(' / ')})`);
      ok(tiles.every((t) => t.pop >= 8), `顔がタイルの上のふちから出ている (${tiles.map((t) => t.pop).join(', ')}pt)`);
      ok(tiles.every((t) => !t.hit), 'あなた・なかま の札が、顔にも札どうしにも重ならない');
      await pg.evaluate(() => { G.players[0].acc = false; G.players[2].acc = false; UI.render(); });
      // 下の並び: 案内は手札のすぐ上、決定の帯はいちばん下。押せないボタンは出さない
      const low = await pg.evaluate(() => {
        const r = (q) => document.querySelector(q).getBoundingClientRect();
        return { prompt: r('#prompt'), hand: r('#hand'), info: r('#info'), go: getComputedStyle(document.querySelector('#go')).display };
      });
      ok(low.prompt.bottom <= low.hand.top + 2 && low.hand.top - low.prompt.bottom < 12 && low.info.top >= low.hand.bottom - 1,
        `案内 → 手札 → 決定の帯 の順に並ぶ (案内の下 ${Math.round(low.prompt.bottom)} / 手札 ${Math.round(low.hand.top)}〜${Math.round(low.hand.bottom)} / 帯 ${Math.round(low.info.top)})`);
      ok(low.go === 'none', `カードをえらぶまで、押せないボタンは出さない (${low.go})`);
      // 12 種類のカードの説明が、出せる・出せないのどちらでも帯に収まる (はみ出すと説明が切れて読めない)
      const fit = await pg.evaluate(() => {
        const box = document.querySelector('#infoTxt'), go = document.querySelector('#go');
        go.disabled = false; go.hidden = false; go.textContent = 'わたす';
        const bad = [];
        for (const t of Object.keys(CARDS)) {
          for (const ng of [false, true]) {
            const why = ng ? (whyNot({ hand: [] }, { type: t }) || '手札が3まい以下になったら 使える') : '';
            box.innerHTML = `<b>${CARDS[t].n}</b>　${ng ? `<span class="ng">※ ${why}</span>` : CARDS[t].t}`;
            if (box.scrollHeight > box.clientHeight + 1) bad.push(t + (ng ? '(出せない)' : ''));
          }
        }
        UI.render();
        return bad;
      });
      ok(fit.length === 0, `12 種類のカードの説明が帯に収まる (はみ出し: ${fit.join(', ') || 'なし'})`);
      // 場のカードの下は、出した人 (と相手) の顔 + 名札。説明の行は、そのカードで起きたことだけ・顔つき・2 行まで (字を減らす)
      const who = await pg.evaluate(() => {
        // 出したカードの行のあとに、起きたことが 3 行つづいた形を作って描く (あとで元に戻す)
        const keep = G.log.slice();
        G.log.push('\u0003\u00013\u0002「たくらみ」', 'いち', '\u00013\u0002 は 犯人のなかまに なった!', 'さん');
        UI.render();
        const by = document.querySelector('#played .by');
        const lines = [...document.querySelectorAll('#log div')];
        const r = { faces: by.querySelectorAll('img.av').length, plate: getComputedStyle(by.querySelector('b')).backgroundColor,
          by: by.textContent, lines: lines.length, text: lines.map((d) => d.textContent).join(' / '),
          names: lines.filter((d) => /くろねこ|きつね|ふくろう|あなた/.test(d.textContent)).length,
          hasName: lines.some((d) => d.querySelector('.chip[aria-label] img.av')) };
        G.log = keep; UI.render();
        return r;
      });
      ok(who.faces >= 1 && who.plate !== 'rgba(0, 0, 0, 0)', `場のカードの下に、出した人の顔とキャラの色の名札がある (${who.by} / 顔 ${who.faces})`);
      ok(who.lines === 2 && !/「.+」/.test(who.text), `説明の行は 2 行まで、出したカードの行はくり返さない (${who.text})`);
      // 上の行に 顔 + 名札 があるので、説明の行は顔だけ (名前の字までくり返すとうるさい、と言われた)
      ok(who.names === 0 && who.hasName, `説明の行の名前は顔だけで、名前の字は出さない (${who.text})`);
      // 手札をえらぶと画面が描き直される。場のカードは作り直さない (作り直すと「ぽん」が毎回出る)
      await pg.evaluate(() => { window.__pc = document.querySelector('#played .card'); });
      await pg.locator('#hand .card').first().tap({ force: true });
      await pg.waitForTimeout(200);
      const same = await pg.evaluate(() => window.__pc === document.querySelector('#played .card') && document.querySelector('#hand .card.sel') !== null);
      ok(same, '手札をえらんで描き直しても、場のカードは作り直されない');
      await ctx.close();
    }

    section('はやさ (CPU が出したカードを読む間)');
    {
      // 配り方13: くろねこが第一発見者 → きつね → ふくろう と CPU が続く。あなたの番はそのあと
      const pace = async (preset, tapAfter) => {
        const ctx = await browser.newContext({ ...devices['iPhone 13'] });
        const pg = await ctx.newPage();
        pg.on('pageerror', (e) => errors.push('はやさ: ' + e.message));
        await pg.addInitScript(({ sd, preset }) => {
          let a = sd >>> 0;
          Math.random = () => {
            a = (a + 0x6d2b79f5) >>> 0; let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
          if (preset) localStorage.setItem('yakata-settings', JSON.stringify(preset));
        }, { sd: 13, preset });
        await pg.goto(URL, { waitUntil: 'load' });
        const speed = await pg.evaluate(() => (JSON.parse(localStorage.getItem('yakata-settings') || '{}').speed) || null);
        await pg.evaluate(() => {
          window.__plays = []; const t0 = performance.now();
          new MutationObserver(() => {
            const by = (document.querySelector('#played .by') || {}).textContent || '';
            const l = window.__plays[window.__plays.length - 1];
            if (/が出した|▶/.test(by) && (!l || l.by !== by)) window.__plays.push({ by, t: performance.now() - t0 });
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await pg.locator('#hsStart').tap();
        await pg.locator('#start').tap();
        // 第一発見者の知らせは OK で止めない (場の上に重なり、時間がたつと消える)
        await pg.waitForFunction(() => window.__plays.some((e) => /^きつね/.test(e.by)), null, { timeout: 8000 });
        if (tapAfter) {
          await pg.waitForTimeout(tapAfter);
          const box = await pg.locator('#table').boundingBox();
          await pg.touchscreen.tap(box.x + box.width / 2, box.y + box.height - 10);
        }
        await pg.waitForFunction(() => window.__plays.some((e) => /^ふくろう/.test(e.by)), null, { timeout: 10000 });
        const r = await pg.evaluate(() => {
          const k = window.__plays.find((e) => /^きつね/.test(e.by)), f = window.__plays.find((e) => /^ふくろう/.test(e.by));
          return Math.round(f.t - k.t);
        });
        await ctx.close();
        return { gap: r, speed };
      };
      const normal = await pace(null, 0);
      ok(normal.gap >= 2500, `ふつうの速さで、CPU のカードが読めるだけ場に残る (${normal.gap}ms / 直す前は 1350ms)`);
      const skipped = await pace(null, 500);
      ok(skipped.gap < 1800, `待っている間に場をタップすると、すぐ次へ進む (${skipped.gap}ms)`);
      // 前の版で遊んだブラウザ: はやさの無い設定が残っている (落とし穴の表「初期値は、保存があっても足す」)
      const old = { n: 4, seats: [{ name: 'あなた', cpu: false }, { name: 'くろねこ', cpu: true }, { name: 'きつね', cpu: true }, { name: 'ふくろう', cpu: true }], sound: false };
      const fromOld = await pace(old, 0);
      ok(fromOld.gap >= 2500, `前の版の設定が残っていても、ふつうの速さで始まる (${fromOld.gap}ms)`);
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

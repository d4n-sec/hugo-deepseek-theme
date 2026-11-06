// Optional browser integration check. Serve exampleSite and set SITE_URL,
// PLAYWRIGHT_CORE_PATH, and CHROMIUM_PATH for the local environment.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');

const base = (process.env.SITE_URL || 'http://127.0.0.1:1313').replace(/\/$/, '');
const origin = new URL(base).origin;
const articlePath = '/p/hello-world/';
const codeText = '    first line\n\n    ' + 'x'.repeat(260) + '\n';
const codeFixture = '<div class="highlight" id="test-code"><div class="chroma">' +
  '<table class="lntable"><tr><td class="lntd"><pre><code><span class="lnt">1\n2\n3\n</span></code></pre></td>' +
  '<td class="lntd"><pre><code data-lang="text"><span class="line"><span class="cl">' +
  codeText + '</span></span></code></pre></td></tr></table></div></div>';
const tableFixture = '<table id="test-table"><tr><td>' + 't'.repeat(300) + '</td></tr></table>';

async function openArticle(browser, { mode = 'constant', prefix = '', hash = '', reducedMotion = 'no-preference' } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: '2025-01-01T00:00:00Z' });
  await page.clock.pauseAt('2025-01-01T00:00:01Z');
  await page.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).origin !== origin) return route.abort();
    if (!request.isNavigationRequest() || !new URL(request.url()).pathname.endsWith(articlePath)) {
      return route.continue();
    }
    const response = await route.fetch();
    let html = await response.text();
    const configPattern = /(<script type="application\/json" id="site-config">)([\s\S]*?)(<\/script>)/;
    assert.match(html, configPattern);
    html = html.replace(configPattern, (_, start, json, end) => {
      const config = JSON.parse(json);
      config.reader.mode = mode;
      return start + JSON.stringify(config) + end;
    });
    const bodyStart = '<div class="article-prose" data-article-body>';
    assert.ok(html.includes(bodyStart));
    html = html.replace(bodyStart, bodyStart + prefix);
    return route.fulfill({ response, body: html });
  });
  await page.goto(base + articlePath + hash, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-article-page][data-reader-state]');
  return { context, page, errors };
}

async function progress(test) {
  await test.page.clock.runFor(1500); // Includes the 500 ms Thinking state.
  return test.page.evaluate(() => {
    const article = document.querySelector('[data-article-page]');
    return {
      state: article.getAttribute('data-reader-state'),
      duration: Number(article.getAttribute('data-reader-duration')),
      weight: Number(article.getAttribute('data-reader-characters')),
      shown: (document.getElementById('test-leading') || {}).textContent?.length || 0
    };
  });
}

(async () => {
  const launch = { headless: true };
  if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  try {
    const short = await openArticle(browser, { prefix: '<p id="test-leading">' + 'a'.repeat(1200) + '</p>' });
    const long = await openArticle(browser, { prefix: '<p id="test-leading">' + 'a'.repeat(6000) + '</p>' });
    const shortProgress = await progress(short);
    const longProgress = await progress(long);
    assert.equal(shortProgress.state, 'streaming');
    assert.equal(longProgress.state, 'streaming');
    assert.ok(longProgress.duration > 25714);
    assert.ok(Math.abs(shortProgress.weight / shortProgress.duration - longProgress.weight / longProgress.duration) < 0.0001);
    assert.ok(shortProgress.shown > 70 && shortProgress.shown < 100);
    assert.ok(Math.abs(shortProgress.shown - longProgress.shown) <= 2,
      `Short and long articles should reveal at the same rate: ${JSON.stringify({ shortProgress, longProgress })}`);
    assert.deepEqual(short.errors, []);
    assert.deepEqual(long.errors, []);
    await short.context.close();
    await long.context.close();

    const capped = await openArticle(browser, { mode: 'capped', prefix: codeFixture + '<p>' + 'a'.repeat(6000) + '</p>' });
    assert.equal(Number(await capped.page.locator('[data-article-page]').getAttribute('data-reader-duration')), 25714);
    await capped.page.clock.runFor(2500);
    assert.equal(await capped.page.locator('#test-code code[data-lang]').textContent(), codeText);
    assert.equal(await capped.page.locator('#test-code').isVisible(), true);
    await capped.context.close();

    const instant = await openArticle(browser, { mode: 'instant', prefix: '<p id="test-leading">' + 'a'.repeat(6000) + '</p>' });
    assert.equal(await instant.page.locator('[data-article-page]').getAttribute('data-reader-state'), 'static');
    assert.equal((await instant.page.locator('#test-leading').textContent()).length, 6000);
    await instant.context.close();

    const code = await openArticle(browser, { prefix: codeFixture });
    await code.page.clock.runFor(1500);
    const partialCode = await code.page.locator('#test-code code[data-lang]').textContent();
    assert.ok(partialCode.length > 0 && partialCode.length < codeText.length);
    await code.page.evaluate(() => {
      window.DSH.copyText = value => { window.__copiedCode = value; return Promise.resolve(); };
    });
    await code.page.locator('#test-code .code-copy').click({ force: true });
    assert.equal(await code.page.locator('[data-article-page]').getAttribute('data-reader-state'), 'complete');
    assert.equal(await code.page.evaluate(() => window.__copiedCode), codeText);
    assert.deepEqual(code.errors, []);
    await code.context.close();

    const table = await openArticle(browser, { prefix: tableFixture });
    await table.page.clock.runFor(1500);
    const partialTable = await table.page.locator('#test-table').textContent();
    assert.ok(partialTable.length > 0 && partialTable.length < 300);
    await table.page.locator('[data-reader-skip]').click();
    assert.equal((await table.page.locator('#test-table').textContent()).length, 300);
    await table.context.close();

    const completed = await openArticle(browser, { prefix: '<p id="test-leading">Done.</p>' });
    const duration = Number(await completed.page.locator('[data-article-page]').getAttribute('data-reader-duration'));
    await completed.page.clock.runFor(duration + 1000);
    assert.equal(await completed.page.locator('[data-article-page]').getAttribute('data-reader-state'), 'complete');
    assert.equal(await completed.page.locator('.is-reader-pending').count(), 0);
    assert.equal(await completed.page.locator('#test-leading').textContent(), 'Done.');
    await completed.context.close();

    for (const options of [{ hash: '#a-little-example' }, { reducedMotion: 'reduce' }]) {
      const skipped = await openArticle(browser, options);
      assert.equal(await skipped.page.locator('[data-article-page]').getAttribute('data-reader-state'), 'static');
      await skipped.context.close();
    }
    console.log('Reader modes, constant rate, code/table output, copy, skip, anchor and reduced motion passed.');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });

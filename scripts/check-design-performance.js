async hostPage => {
  const base = hostPage.url().startsWith('https://apvsap.jiawwo11.workers.dev/') ? 'https://apvsap.jiawwo11.workers.dev' : 'http://localhost:8787'
  if (!hostPage.url().startsWith(base + '/')) throw new Error('Known project site only')
  const browser = hostPage.context().browser(), runs = []
  for (const { mobile, reduced } of [{ mobile: false, reduced: false }, { mobile: true, reduced: false }, { mobile: true, reduced: false }, { mobile: true, reduced: false }, { mobile: true, reduced: true }]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference', isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    const page = await context.newPage(), thirdParty = [], errors = []
    page.on('request', request => { if (!request.url().startsWith(base + '/') && !request.url().startsWith('data:')) thirdParty.push(request.url()) })
    page.on('pageerror', error => errors.push(error.message))
    try {
      await page.addInitScript(() => {
        window.designVitals = { cls: 0, lcp: null }
        new PerformanceObserver(list => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.designVitals.cls += entry.value }).observe({ type: 'layout-shift', buffered: true })
        new PerformanceObserver(list => { for (const entry of list.getEntries()) { window.designVitals.lcp = entry.startTime; window.designVitals.lcpElement = entry.element?.tagName } }).observe({ type: 'largest-contentful-paint', buffered: true })
      })
      const cdp = await context.newCDPSession(page)
      await cdp.send('Network.enable')
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
      if (mobile) {
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 204800, uploadThroughput: 96000 })
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
      }
      const response = await page.goto(base + '/')
      await page.getByRole('button', { name: '以游客身份游玩' }).waitFor()
      await page.evaluate(() => document.fonts.ready)
      // A lab measurement window for buffered paint/shift observers, not a fixed UI wait.
      await page.waitForFunction(() => performance.now() > 3500)
      const metrics = await page.evaluate(() => ({ ...window.designVitals, fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime, ttfb: performance.getEntriesByType('navigation')[0]?.responseStart, resources: performance.getEntriesByType('resource').map(entry => ({ name: new URL(entry.name).pathname, bytes: entry.transferSize, duration: entry.duration })), nodes: document.querySelectorAll('*').length, overflow: document.documentElement.scrollWidth > innerWidth }))
      runs.push({ mobile, reducedMotion: reduced, throttling: mobile ? '150ms RTT / 1.6384Mbps down / 4x CPU / cache off' : 'unthrottled / cache off', status: response.status(), cspPresent: Boolean(response.headers()['content-security-policy']), thirdParty, errors, ...metrics })
    } finally { await context.close() }
  }
  if (runs.some(run => run.errors.length || run.thirdParty.length || run.overflow || !run.cspPresent)) throw new Error('Runtime, external asset, overflow or CSP regression: ' + JSON.stringify(runs))
  return { base, runs }
}

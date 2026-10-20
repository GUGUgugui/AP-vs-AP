async hostPage => {
  if (!hostPage.url().startsWith('http://localhost:8787/')) throw new Error('Local admin design QA only')
  const context = await hostPage.context().browser().newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage(), checks = [], errors = []
  const check = (value, message) => { if (!value) throw new Error(message) }
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto('http://localhost:8787/admin')
    await page.locator('#admin-password').fill('local-qa-features')
    await page.getByRole('button', { name: '进入', exact: true }).click()
    await page.locator('.admin-primary-nav').waitFor()
    for (const view of [
      { name: 'live', label: /实时监察$/, wait: '.admin-message-stream' },
      { name: 'history', label: /历史档案$/, wait: '.archive-transcript' },
      { name: 'metrics', label: /运行指标$/, wait: '.observability-kpis' },
      { name: 'community', label: /反馈与训练$/, wait: '.community-board' },
    ]) {
      await page.getByRole('button', { name: view.label }).click()
      await page.locator(view.wait).first().waitFor()
      for (const width of [1440, 1024, 768, 320]) {
        await page.setViewportSize({ width, height: width === 320 ? 760 : 900 })
        await page.evaluate(() => document.fonts.ready)
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${view.name} ${width}: horizontal overflow`)
        if (view.name === 'live') {
          const bounds = await page.evaluate(() => {
            const transcript = document.querySelector('.admin-transcript').getBoundingClientRect(), intervention = document.querySelector('.admin-intervention').getBoundingClientRect(), list = document.querySelector('.admin-match-list')
            return { transcript: { right: transcript.right, bottom: transcript.bottom }, intervention: { left: intervention.left, top: intervention.top }, listScrollable: list.scrollHeight > list.clientHeight }
          })
          check(width === 1440 ? bounds.intervention.left >= bounds.transcript.right : bounds.intervention.top >= bounds.transcript.bottom, `live ${width}: intervention overlaps transcript`)
          check(bounds.listScrollable, `live ${width}: long index must scroll internally`)
          if (width === 1440) check(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'desktop console should fit viewport')
        }
        checks.push(`${view.name} / ${width}: no overflow or transcript obstruction`)
        if (width === 1440 || width === 320) await page.screenshot({ path: `.playwright-cli/design-final-admin-${view.name}-${width}.png`, fullPage: true })
      }
    }
    check(errors.length === 0, 'admin runtime errors: ' + errors.join(', '))
    return { passed: checks.length, checks }
  } finally { await context.close() }
}

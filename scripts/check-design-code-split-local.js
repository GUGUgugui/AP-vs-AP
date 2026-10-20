async hostPage => {
  if (!hostPage.url().startsWith('http://localhost:8787/')) throw new Error('Local bundle QA only')
  const context = await hostPage.context().browser().newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage(), adminRequests = []
  page.on('request', request => { if (/\/assets\/AdminApp-.*\.js/.test(request.url())) adminRequests.push(request.url()) })
  try {
    await page.goto('http://localhost:8787/')
    await page.getByRole('button', { name: '以游客身份游玩' }).waitFor()
    if (adminRequests.length) throw new Error('Player entry downloads administrator code')
    await page.goto('http://localhost:8787/admin')
    await page.locator('#admin-password').waitFor()
    if (adminRequests.length !== 1) throw new Error('Admin route must load its code on demand')
    await context.route('**/assets/AdminApp-*.js', route => route.abort('failed'))
    await page.goto('http://localhost:8787/admin')
    await page.getByRole('button', { name: '重新加载', exact: true }).waitFor()
    if (!await page.getByRole('link', { name: '← 返回玩家入口' }).isVisible()) throw new Error('Missing navigation recovery')
    await context.unroute('**/assets/AdminApp-*.js')
    await page.getByRole('button', { name: '重新加载', exact: true }).click()
    await page.locator('#admin-password').waitFor()
    return { passed: 3, checks: ['player entry never downloads admin code', 'admin route loads its own chunk', 'failed chunk gives a clear reload/navigation path and recovers'] }
  } finally { await context.close() }
}

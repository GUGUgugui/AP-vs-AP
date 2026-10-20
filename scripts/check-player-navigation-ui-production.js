async page => {
  if (!page.url().startsWith('https://apvsap.jiawwo11.workers.dev/')) throw new Error('Deployment QA only')
  const check = (value, message) => { if (!value) throw new Error(message) }
  await page.reload()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '以游客身份游玩' }).click()
  await page.getByRole('button', { name: '开始匹配', exact: true }).waitFor()
  try {
    const before = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).player.id)
    await page.getByRole('button', { name: '首页', exact: true }).click()
    check(await page.getByRole('button', { name: '开始匹配', exact: true }).isVisible(), 'home available')
    await page.getByRole('button', { name: '登录 / 注册' }).click()
    await page.getByRole('dialog').getByRole('button', { name: '注册', exact: true }).click()
    check(await page.locator('#player-confirm').isVisible(), 'registration modal works')
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile no overflow')
    await page.getByRole('button', { name: '取消，继续游玩' }).click()
    check(await page.getByRole('dialog').count() === 0, 'cancel closes dialog')
    check(await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).player.id) === before, 'cancel preserves guest identity')
    const asset = await page.locator('script[src]').getAttribute('src')
    const bundle = await page.evaluate(async url => { const response = await fetch(url); return { status: response.status, body: await response.text() } }, asset)
    check(bundle.status === 200 && bundle.body.includes('返回当前对话') && bundle.body.includes('查看上一局结果'), 'navigation bundle deployed')
    return { passed: 2, checks: ['online mobile home and dismissible login/register dialog', 'latest deployed bundle and preserved guest identity'] }
  } finally {
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await page.getByRole('button', { name: '以游客身份游玩' }).waitFor()
  }
}

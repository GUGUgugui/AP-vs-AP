async hostPage => {
  if (!hostPage.url().startsWith('http://localhost:8787/')) throw new Error('Local design QA only')
  const check = (value, message) => { if (!value) throw new Error(message) }
  // Independent contexts: no CSP bypass, no existing user session, no paid AI provider.
  const browser = hostPage.context().browser()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const peerContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const page = await context.newPage(), peer = await peerContext.newPage()
  const layouts = [], errors = [], checks = []
  for (const target of [page, peer]) target.on('pageerror', error => errors.push(error.message))
  const sizes = [{ width: 1920, height: 1080 }, { width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 768, height: 1024 }, { width: 390, height: 844 }, { width: 320, height: 568 }]
  const matrix = async (name, primary, chat = false) => {
    for (const size of sizes) {
      await page.setViewportSize(size)
      await page.evaluate(() => document.fonts.ready)
      const bounds = await page.evaluate(({ primary, chat }) => {
        const main = document.querySelector(primary), box = main?.getBoundingClientRect()
        const composer = document.querySelector('.composer')?.getBoundingClientRect()
        const messages = document.querySelector('.message-field')?.getBoundingClientRect()
        const guess = document.querySelector('.guess-panel')?.getBoundingClientRect()
        return { overflow: document.documentElement.scrollWidth > innerWidth, primary: box && { top: box.top, bottom: box.bottom, width: box.width, height: box.height }, composer: chat && composer && { top: composer.top, bottom: composer.bottom }, messages: chat && messages && { height: messages.height }, guess: chat && guess && { bottom: guess.bottom } }
      }, { primary, chat })
      if (name === 'chat-verdict' && size.width === 320) await page.screenshot({ path: '.playwright-cli/design-final-short-verdict-320.png' })
      check(!bounds.overflow, `${name} ${size.width}: horizontal overflow`)
      if (name === 'entry' || name === 'lobby') check(bounds.primary?.bottom <= size.height, `${name} ${size.width}: main entry below fold`)
      if (chat) {
        check(bounds.composer.bottom <= size.height + 1, `${name} ${size.width}: composer below viewport`)
        check(bounds.messages.height >= 80, `${name} ${size.width}: no usable conversation space ${JSON.stringify(bounds)}`)
        if (size.width <= 720 && bounds.guess) check(bounds.guess.bottom <= bounds.composer.top, `${name} ${size.width}: verdict covers input`)
      }
      layouts.push({ name, viewport: size, ...bounds })
      if (size.width === 1440 || size.width === 390) await page.screenshot({ path: `.playwright-cli/design-final-${name}-${size.width}.png`, fullPage: !chat })
    }
  }
  const join = async target => {
    await target.getByRole('button', { name: /^(开始匹配|开始下一局)$/ }).click()
    await target.locator('.game-layout').waitFor({ timeout: 12000 })
  }
  const send = async (target, content, count) => {
    await target.getByRole('textbox', { name: '发送消息' }).fill(content)
    await target.waitForFunction(() => !document.querySelector('.composer button[type=submit]')?.disabled)
    await target.getByRole('textbox', { name: '发送消息' }).press('Enter')
    await target.waitForFunction(expected => document.querySelectorAll('.message-row.self').length === expected, count)
  }
  try {
    await page.goto('http://localhost:8787/')
    await page.getByRole('button', { name: '以游客身份游玩' }).waitFor()
    await matrix('entry', '.entry-guest button')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.reload()
    await page.getByRole('button', { name: '以游客身份游玩' }).waitFor()
    await page.keyboard.press('Tab')
    check(await page.locator('.skip-link').evaluate(el => document.activeElement === el), 'first tab offers skip navigation')
    await page.keyboard.press('Enter')
    check(await page.locator('#page-content').evaluate(el => document.activeElement === el), 'skip navigation focuses main content')
    checks.push('keyboard skip navigation works')
    for (const target of [page, peer]) {
      if (target === peer) await target.goto('http://localhost:8787/')
      await target.getByRole('button', { name: '以游客身份游玩' }).click()
      await target.getByRole('button', { name: '开始匹配', exact: true }).waitFor()
    }
    await matrix('lobby', '.lobby .primary-action')
    await page.setViewportSize({ width: 1440, height: 900 })
    let matched = false
    for (let attempt = 0; attempt < 10; attempt++) {
      await Promise.all([join(page), join(peer)])
      if (await page.locator('.conversation-header .panel-kicker').innerText() === await peer.locator('.conversation-header .panel-kicker').innerText()) { matched = true; break }
      for (const target of [page, peer]) {
        await target.getByRole('button', { name: '结束对话', exact: true }).click()
        await target.getByRole('button', { name: '确认结束', exact: true }).click()
        await target.locator('.reveal-screen').waitFor()
      }
    }
    check(matched, 'two separate guests must establish a real human match')
    check(await page.locator('.guess-panel').count() === 0, 'identity verdict absent initially')
    await matrix('chat-initial', '.composer', true)
    await page.setViewportSize({ width: 1440, height: 900 })
    await send(page, '你平时也会半夜突然想吃点什么吗', 1)
    await send(peer, '会，我昨晚还翻了半天冰箱', 1)
    await send(page, '哈哈我每次打开冰箱都像在等它变出新东西', 2)
    await send(peer, '然后关上，过五分钟再开一次对吧', 2)
    await send(page, '对，结果最后还是泡了碗面', 3)
    await send(peer, '那泡面就是你最后的底牌了', 3)
    await page.getByText('那泡面就是你最后的底牌了', { exact: true }).waitFor()
    await page.locator('.guess-panel').waitFor()
    check(await page.getByRole('textbox', { name: '发送消息' }).evaluate(el => document.activeElement === el), 'nonmodal verdict preserves composer focus')
    await matrix('chat-verdict', '.composer', true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('textbox', { name: '发送消息' }).focus()
    await page.keyboard.press('Escape')
    check(await page.locator('.guess-panel').count() === 0, 'Escape dismisses verdict while typing')
    check(await page.getByRole('textbox', { name: '发送消息' }).evaluate(el => document.activeElement === el), 'dismissal preserves typing focus')
    await page.getByRole('region', { name: '对话消息记录' }).focus()
    const beforeScroll = await page.locator('.message-field').evaluate(el => { el.scrollTop = el.scrollHeight; return el.scrollTop })
    check(beforeScroll > 0, 'fixture must contain a scrollable message log')
    await page.keyboard.press('Home')
    await page.waitForFunction(previous => document.querySelector('.message-field').scrollTop < previous, beforeScroll)
    const animations = await page.evaluate(() => Array.from(document.querySelectorAll('*')).filter(el => getComputedStyle(el).animationName !== 'none').length)
    check(animations === 0, 'reduced-motion disables animation')
    checks.push('initial identity hidden; nonmodal verdict and Escape preserve focus; keyboard message scrolling; reduced motion respected')
    await page.getByRole('button', { name: '判断身份', exact: true }).click()
    await page.getByRole('button', { name: /^真人(?: HUMAN)?$/ }).click()
    await page.getByRole('button', { name: '提交判断 / 揭晓' }).click()
    await page.getByText('猜对了', { exact: true }).waitFor()
    await matrix('result', '.verdict-word h1')
    await page.getByRole('button', { name: '我的', exact: true }).click()
    await page.locator('.badge-grid').waitFor()
    await page.locator('.notebook-history > aside > button').filter({ hasText: '正常揭晓' }).first().click()
    await page.locator('.notebook-messages article').first().waitFor()
    await matrix('notebook', '.notebook-heading')
    await page.setViewportSize({ width: 320, height: 568 })
    await page.getByRole('button', { name: '登录 / 注册' }).click()
    const dialog = page.getByRole('dialog', { name: '注册或登录' })
    await dialog.getByRole('button', { name: '注册', exact: true }).click()
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'short mobile registration has no horizontal overflow')
    await dialog.getByRole('button', { name: '注册并继续' }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: '.playwright-cli/design-final-registration-320.png' })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    check(errors.length === 0, 'runtime errors: ' + errors.join(', '))
    checks.push('36 viewport/state combinations, mobile register dialog, real result/history, no runtime errors')
    return { passed: checks.length, checks, layouts }
  } catch (error) {
    await page.screenshot({ path: '.playwright-cli/design-layout-failure.png', fullPage: true })
    throw new Error(`${error.message} [page: ${page.url()}]`)
  } finally { await context.close(); await peerContext.close() }
}

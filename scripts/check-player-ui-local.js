async page => {
  if (!page.url().startsWith('http://localhost:8787')) throw new Error('Local QA only')
  await page.context().clearCookies()
  await page.goto('http://localhost:8787/')
  const check = (value, message) => { if (!value) throw new Error(message) }
  const username = 'ui_' + Date.now().toString(36)
  const password = 'qa-only-ui-long-password'
  const browser = page.context().browser()
  const peerContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const peer = await peerContext.newPage()
  const checks = []
  try {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('button', { name: '注册', exact: true }).click()
    await page.locator('#player-username').fill(username)
    await page.locator('#player-password').fill(password)
    await page.locator('#player-confirm').fill('different-long-password')
    await page.getByRole('button', { name: '注册并进入大厅' }).click()
    await page.getByRole('alert').filter({ hasText: '两次输入的密码不一致' }).waitFor()
    await page.locator('#player-confirm').fill(password)
    await page.getByRole('button', { name: '注册并进入大厅' }).click()
    await page.getByRole('button', { name: '开始匹配', exact: true }).waitFor()
    const identity = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).player)
    check(identity.kind === 'account', 'register account')
    check(await page.evaluate(() => !document.cookie.includes('apvsap_player')), 'HttpOnly cookie hidden')
    checks.push('registration UI, confirmation validation and HttpOnly session')
    await peer.goto('http://localhost:8787/')
    await peer.getByRole('button', { name: '以游客身份游玩' }).click()
    await peer.getByRole('button', { name: '开始匹配', exact: true }).waitFor()
    checks.push('guest entry UI')

    const join = async target => {
      await target.getByRole('button', { name: /^(开始匹配|开始下一局)$/ }).click()
      await target.locator('.game-layout').waitFor({ timeout: 12000 })
    }
    const send = async (target, content, count) => {
      await target.getByRole('textbox', { name: '发送消息' }).fill(content)
      await target.getByRole('textbox', { name: '发送消息' }).press('Enter')
      await target.waitForFunction(expected => document.querySelectorAll('.message-row.self').length === expected, count)
    }
    let sameMatch = false
    for (let attempt = 0; attempt < 5; attempt++) {
      await Promise.all([join(page), join(peer)])
      const [aId, bId] = await Promise.all([page.locator('.conversation-header .panel-kicker').innerText(), peer.locator('.conversation-header .panel-kicker').innerText()])
      if (aId === bId) { sameMatch = true; break }
      // Finish local AI fixtures without any model call (local key is empty).
      for (const target of [page, peer]) {
        for (let count = 1; count <= 3; count++) {
          await target.locator('.toast-notice').waitFor({ state: 'hidden', timeout: 10000 })
          await send(target, '本地重试 ' + count, count)
          await target.locator('.toast-notice').filter({ hasText: '对话暂时中断' }).waitFor({ timeout: 10000 })
        }
        await target.getByRole('button', { name: /^AI(?: MACHINE)?$/ }).click()
        await target.getByRole('button', { name: '提交判断 / 揭晓' }).click()
        await target.locator('.reveal-screen').waitFor()
      }
    }
    check(sameMatch, 'two independent identities matched to human room')
    check(await page.locator('.guess-panel').count() === 0, 'no initial verdict')
    check(await page.getByRole('button', { name: '判断身份', exact: true }).count() === 0, 'no initial verdict trigger')
    await page.screenshot({ path: '.playwright-cli/accounts-chat-initial-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    check(!(await peer.locator('.conversation-header').innerText()).includes(username), 'account name not exposed to peer')
    for (let count = 1; count <= 3; count++) await send(peer, '对方测试消息 ' + count, count)
    await peer.getByRole('complementary', { name: '身份判断' }).waitFor()
    await peer.screenshot({ path: '.playwright-cli/accounts-verdict-desktop.png' })
    await page.getByText('对方测试消息 3', { exact: true }).waitFor()
    check(await page.locator('.guess-panel').count() === 0, 'peer messages do not unlock own verdict')
    for (let count = 1; count <= 3; count++) {
      await send(page, '自己的测试消息 ' + count, count)
      if (count < 3) check(await page.locator('.guess-panel').count() === 0, 'first two messages no verdict')
    }
    await page.getByRole('complementary', { name: '身份判断' }).waitFor()
    check(await page.getByRole('textbox', { name: '发送消息' }).evaluate(el => document.activeElement === el), 'automatic prompt does not steal typing focus')
    check(await page.locator('[aria-modal=true], .guess-backdrop').count() === 0, 'no modal or overlay')
    const inputBox = await page.locator('.composer').boundingBox()
    const guessBox = await page.locator('.guess-panel').boundingBox()
    check(guessBox.y + guessBox.height <= inputBox.y && inputBox.y + inputBox.height <= 844, 'verdict does not cover mobile input')
    await page.screenshot({ path: '.playwright-cli/accounts-verdict-mobile.png' })
    checks.push('verdict hidden until three own messages; peer messages excluded; no focus theft or mobile overlay')
    await page.getByRole('button', { name: '关闭判断面板' }).click()
    await send(page, '继续聊天，提示已经收起', 4)
    check(await page.locator('.guess-panel').count() === 0, 'dismiss remains dismissed after another message')
    await page.reload()
    await page.locator('.game-layout').waitFor()
    check(await page.locator('.guess-panel').count() === 0, 'dismiss survives refresh')
    await page.getByRole('button', { name: '判断身份', exact: true }).click()
    await page.getByRole('button', { name: /^真人(?: HUMAN)?$/ }).click()
    await page.getByRole('button', { name: '提交判断 / 揭晓' }).click()
    await page.getByText('猜对了', { exact: true }).waitFor()
    await peer.getByText('未判断', { exact: true }).waitFor()
    checks.push('continue after dismiss, restore after refresh, reopen, binary result and unjudged peer')

    const sibling = await page.context().newPage()
    await sibling.goto('http://localhost:8787/')
    await sibling.locator('.reveal-screen').waitFor()
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await page.getByRole('button', { name: '登录并进入大厅' }).waitFor()
    await sibling.getByRole('button', { name: '登录并进入大厅' }).waitFor()
    await page.locator('#player-username').fill(username.toUpperCase())
    await page.locator('#player-password').fill(password)
    await page.getByRole('button', { name: '登录并进入大厅' }).click()
    await page.locator('.reveal-screen').waitFor()
    await sibling.locator('.reveal-screen').waitFor()
    const restored = await page.evaluate(async () => (await (await fetch('/api/auth/session')).json()).player)
    check(restored.id === identity.id, 'login restores account identity')
    check(await sibling.locator('.station-meta').innerText().then(text => text.includes('connected')), 'other tab reconnects after session rotation')
    checks.push('login/logout synchronized across tabs and account identity restored')
    await sibling.close()
    await page.setViewportSize({ width: 320, height: 760 })
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await page.getByRole('button', { name: '以游客身份游玩' }).waitFor()
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px no horizontal overflow')
    await page.screenshot({ path: '.playwright-cli/accounts-entry-mobile.png', fullPage: true })
    checks.push('320px mobile access layout')
    return { passed: checks.length, checks }
  } finally { await peerContext.close() }
}

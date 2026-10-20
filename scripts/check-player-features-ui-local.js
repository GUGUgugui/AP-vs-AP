async page => {
  if (!page.url().startsWith('http://localhost:8787/')) throw new Error('Local QA only')
  const check=(value,message)=>{if(!value)throw new Error(message)},checks=[],errors=[]
  page.on('pageerror',error=>errors.push(error.message));await page.context().clearCookies();await page.setViewportSize({width:1440,height:900});await page.emulateMedia({reducedMotion:'reduce'})
  const browser=page.context().browser(),peerContext=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'}),adminContext=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),peer=await peerContext.newPage(),admin=await adminContext.newPage()
  const send=async(target,text,count)=>{await target.getByRole('textbox',{name:'发送消息'}).fill(text);await target.waitForFunction(()=>!document.querySelector('.composer-bottom button')?.disabled);await target.getByRole('textbox',{name:'发送消息'}).press('Enter');await target.waitForFunction(expected=>document.querySelectorAll('.message-row.self').length===expected,count)}
  const join=async target=>{await target.getByRole('button',{name:/^(开始匹配|开始下一局)$/}).click();await target.locator('.game-layout').waitFor({timeout:12000})}
  try {
    for(const target of[page,peer]){await target.goto('http://localhost:8787/');await target.getByRole('button',{name:'以游客身份游玩'}).click();await target.getByRole('button',{name:'开始匹配',exact:true}).waitFor()}
    await page.setViewportSize({width:320,height:760});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px guest header');await page.getByRole('button',{name:'我的',exact:true}).click();await page.getByRole('heading',{name:'我的观察档案'}).waitFor();await page.locator('.badge-grid').waitFor();check(await page.locator('.badge-grid .unlocked').count()===0,'no fake badges');await page.getByRole('button',{name:'首页',exact:true}).click();await page.setViewportSize({width:1440,height:900})
    let matched=false
    for(let attempt=0;attempt<8;attempt++){
      await Promise.all([join(page),join(peer)])
      if(await page.locator('.conversation-header .panel-kicker').innerText()===await peer.locator('.conversation-header .panel-kicker').innerText()){matched=true;break}
      for(const target of[page,peer]){await target.getByRole('button',{name:'结束对话',exact:true}).click();await target.getByRole('button',{name:'确认结束',exact:true}).click();await target.locator('.reveal-screen').waitFor();check(await target.getByText('本局提前结束，不算猜错，不计入正确率与成就。',{exact:true}).isVisible(),'early exit no loss')}
    }
    check(matched,'human pair')
    await page.getByRole('textbox',{name:'发送消息'}).fill('原来的草稿')
    await page.getByRole('button',{name:'破冰话题 +',exact:true}).click();await page.getByRole('button',{name:'最近有没有一件很小但让你开心的事？',exact:true}).click()
    check((await page.getByRole('textbox',{name:'发送消息'}).inputValue()).startsWith('原来的草稿\n'),'topic appends rather than overwrites')
    check(await page.locator('.message-row.self').count()===0,'topic never auto-sends')
    await page.getByRole('textbox',{name:'发送消息'}).press('Enter');await page.waitForFunction(()=>document.querySelectorAll('.message-row.self').length===1)
    await send(peer,'最近吃到一个挺好吃的东西',1);await send(page,'我最近喜欢散步看街边的小店',2);await send(peer,'散步时不做计划比较舒服',2);await send(page,'我也喜欢这种慢一点的感觉',3);await send(peer,'可以走到哪里算哪里',3)
    await peer.getByRole('button',{name:/^真人(?: HUMAN)?$/}).click();await page.getByRole('button',{name:/^真人(?: HUMAN)?$/}).click();await page.getByRole('button',{name:'提交判断 / 揭晓'}).click();await page.getByText('猜对了',{exact:true}).waitFor();await peer.locator('.reveal-screen').waitFor()
    check(await page.locator('.evidence-list article').count()===3,'no duplicate peer messages after reveal')
    const history=await page.evaluate(async()=>await(await fetch('/api/player/history')).json()),id=history.items.find(item=>item.end_reason==='judged').id
    await page.getByRole('button',{name:'很自然',exact:true}).click();await page.getByRole('button',{name:'保存反馈',exact:true}).click();await page.getByText('反馈已保存，可重新选择并更新。',{exact:true}).waitFor()
    const consentName='授权本局原句用于模型训练数据集（可选）'
    check(!await page.getByRole('checkbox',{name:consentName}).isChecked(),'raw-text consent defaults off')
    await page.getByRole('checkbox',{name:consentName}).check();await page.getByText('原句授权已保存。双方同意且样本合格后进入待审核训练集。',{exact:true}).waitFor();await peer.getByRole('checkbox',{name:consentName}).check();await peer.getByText('原句授权已保存。双方同意且样本合格后进入待审核训练集。',{exact:true}).waitFor()
    checks.push('optional draft-only icebreakers, normal judgment, saved feedback and explicit two-party raw-text consent')
    await page.setViewportSize({width:390,height:844});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile results overflow');await page.screenshot({path:'.playwright-cli/features-results-mobile.png',fullPage:true})
    await page.getByRole('button',{name:'我的',exact:true}).click();await page.locator('.badge-grid .unlocked').waitFor();check(await page.locator('.notebook-stats').innerText().then(text=>text.includes('100%')),'real accuracy shown');await page.locator('.notebook-history > aside > button').filter({hasText:'正常揭晓'}).first().click();await page.locator('.notebook-messages article').first().waitFor();check(await page.locator('.notebook-messages article').count()===6,'complete private history')
    await page.setViewportSize({width:320,height:760});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile notebook overflow');await page.screenshot({path:'.playwright-cli/features-notebook-mobile.png',fullPage:true})
    await page.getByRole('button',{name:'注册或登录保留身份'}).click();const dialog=page.getByRole('dialog',{name:'注册或登录'}),username='featui_'+Date.now().toString(36),password='local-feature-ui-password'
    await dialog.locator('#player-username').fill(username);await dialog.locator('#player-password').fill(password);await dialog.locator('#player-confirm').fill(password);await dialog.getByRole('button',{name:'注册并继续'}).click();await dialog.waitFor({state:'hidden'});await page.locator('.badge-grid .unlocked').waitFor();check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px account header')
    checks.push('private notebook, actual badge, full history and guest registration preservation on mobile')
    await admin.goto('http://localhost:8787/admin');await admin.locator('#admin-password').fill('local-qa-features');await admin.getByRole('button',{name:'进入',exact:true}).click();await admin.getByRole('button',{name:'04反馈与训练',exact:true}).click();await admin.getByRole('heading',{name:'反馈、举报与训练集'}).waitFor()
    const sample=admin.locator('.community-board article').filter({hasText:id.slice(0,8)})
    await sample.getByRole('button',{name:'审核原句'}).click();await admin.locator('.community-review article').first().waitFor();await sample.getByRole('button',{name:'批准入集'}).click();await sample.getByText('已通过',{exact:true}).waitFor();await admin.screenshot({path:'.playwright-cli/features-admin-desktop.png',fullPage:true})
    const exported=await admin.evaluate(async()=>await(await fetch('/admin/api/training/export')).text());check(exported.includes('最近有没有一件很小但让你开心的事'),'real original messages in exported training data')
    const downloadPromise=admin.waitForEvent('download')
    await admin.getByRole('button',{name:'导出已审核训练集',exact:true}).click()
    const download=await downloadPromise
    check(download.suggestedFilename().endsWith('.jsonl'),'actual training download')
    await download.saveAs('.playwright-cli/features-training-fixture.jsonl')
    await peer.getByRole('checkbox',{name:consentName}).uncheck();await peer.getByText('原句授权已撤回，站内训练样本已移除。已导出的副本不能自动收回。',{exact:true}).waitFor()
    check(!(await admin.evaluate(async()=>await(await fetch('/admin/api/training/export')).text())).includes('最近有没有一件很小但让你开心的事'),'withdrawal prevents export')
    checks.push('admin sample preview, approval, genuine original-text export and withdrawal removal')
    const reportDescription='功能测试：广告举报 '+id
    await page.getByRole('button',{name:'首页',exact:true}).click()
    await page.getByRole('button',{name:'开始匹配',exact:true}).click()
    await page.locator('.game-layout').waitFor()
    const beforeSkip=await page.locator('.conversation-header .panel-kicker').innerText()
    await page.getByRole('button',{name:'跳过 / 换一个',exact:true}).click()
    await page.getByRole('button',{name:'确认跳过',exact:true}).click()
    await page.waitForFunction(previous=>{const title=document.querySelector('.conversation-header .panel-kicker');return title&&title.textContent!==previous},beforeSkip)
    await page.getByRole('button',{name:'举报',exact:true}).click()
    const report=page.getByRole('dialog',{name:'举报对话'})
    await report.locator('#report-reason').selectOption('spam')
    await report.locator('#report-description').fill(reportDescription)
    await report.getByRole('button',{name:'提交举报',exact:true}).click()
    await report.waitFor({state:'hidden'})
    await page.getByText('本局提前结束，不算猜错，不计入正确率与成就。',{exact:true}).waitFor()
    await admin.getByRole('button',{name:'刷新',exact:true}).click()
    const reportRow=admin.locator('.community-board article').filter({hasText:reportDescription})
    await reportRow.getByRole('button',{name:'查看举报对话'}).click()
    await reportRow.getByRole('button',{name:'标记已处理'}).click()
    await reportRow.getByText('已处理',{exact:true}).waitFor()
    await admin.setViewportSize({width:390,height:844})
    check(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile admin overflow')
    checks.push('confirmed skip, active-room report, excluded losses and real moderation queue resolution')
    check(errors.length===0,'browser runtime errors: '+errors.join(', '));return{passed:checks.length,checks}
  }finally{await peerContext.close();await adminContext.close()}
}

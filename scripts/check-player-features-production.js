async page => {
  const base='https://apvsap.jiawwo11.workers.dev'
  if(!page.url().startsWith(base+'/'))throw new Error('Production smoke only')
  await page.context().clearCookies();await page.reload();await page.setViewportSize({width:390,height:844})
  const checks=[],check=(value,message)=>{if(!value)throw new Error(message)}
  let fixture=null
  const result=await page.evaluate(async()=>{
    const api=async(path,body)=>{const response=await fetch(path,{method:body===undefined?'GET':'POST',cache:'no-store',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});return{status:response.status,data:await response.json()}}
    const check=(value,message)=>{if(!value)throw new Error(message)},checks=[]
    let fixture=null,error=null
    try{
      check((await api('/api/health')).data.status==='ok','health')
      check((await api('/api/player/profile')).status===401,'anonymous profile denied')
      check((await api('/admin/api/training/export')).status===401,'training export protected')
      checks.push('health and authenticated player/admin boundaries')
      const guest=await api('/api/auth/guest',{}),profile=await api('/api/player/profile'),history=await api('/api/player/history')
      check(profile.status===200&&profile.data.stats.judged===0,'new guest profile');check(profile.data.badges.every(badge=>badge.unlockedAt===null),'new guest no fake badges');check(history.status===200&&history.data.items.length===0,'new guest private history')
      check((await api('/api/player/feedback',{matchId:crypto.randomUUID(),tags:['natural']})).status===404,'cannot submit feedback to a foreign match')
      checks.push('new profile/history schema, unearned badges and foreign match rejection')
      const username='qaf_'+Date.now().toString(36)+'_'+crypto.randomUUID().slice(0,4),password='qa-only-'+crypto.randomUUID()
      const registered=await api('/api/auth/register',{username,password});check(registered.status===201,'real account registration');check(registered.data.player.id===guest.data.player.id,'preserve guest seat');fixture={username}
      check((await api('/api/player/profile')).status===200,'registered profile');await api('/api/auth/logout',{});const login=await api('/api/auth/login',{username,password});check(login.status===200&&login.data.player.id===guest.data.player.id,'login restores seat');check((await api('/admin/api/community')).status===401,'account never becomes admin')
      checks.push('real guest-to-account binding, login and administrator separation')
    }catch(cause){error=cause.message}
    finally{await api('/api/auth/logout',{})}
    return{passed:checks.length,checks,error,fixture}
  })
  fixture=result.fixture;check(!result.error,result.error);checks.push(...result.checks)
  await page.reload();await page.getByRole('button',{name:'以游客身份游玩'}).click();await page.getByRole('button',{name:'我的',exact:true}).click();await page.getByRole('heading',{name:'我的观察档案'}).waitFor();await page.locator('.badge-grid').waitFor()
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile profile no overflow');check(await page.locator('.badge-grid article').count()===4,'four badge definitions');await page.screenshot({path:'.playwright-cli/features-production-mobile.png',fullPage:true})
  await page.getByRole('button',{name:'首页',exact:true}).click();await page.getByRole('button',{name:'登录 / 注册'}).click();await page.getByRole('dialog').getByRole('button',{name:'取消，继续游玩'}).click();checks.push('online mobile notebook, home navigation and cancelable guest login')
  await page.getByRole('button',{name:'退出',exact:true}).click();await page.getByRole('button',{name:'以游客身份游玩'}).waitFor()
  return{passed:checks.length,checks,fixture}
}

async page => {
  if (!page.url().startsWith('https://apvsap.jiawwo11.workers.dev/')) throw new Error('Deployment QA only')
  return await page.evaluate(async () => {
    const username = `qa_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 6)}`
    const password = `qa-only-${crypto.randomUUID()}`
    const checks = []
    let userId = null
    let error = null
    const check = (value, message) => { if (!value) throw new Error(message) }
    const api = async (path, body) => {
      const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      return { status: response.status, payload: await response.json() }
    }
    try {
      check((await api('/api/health')).payload.status === 'ok', 'health')
      check((await api('/api/auth/session')).payload.player === null, 'initial session')
      checks.push('health and anonymous session')
      const registered = await api('/api/auth/register', { username, password })
      check(registered.status === 201, `register status ${registered.status}`)
      const playerId = registered.payload.player.id
      userId = playerId.slice('user:'.length)
      check((await api('/api/auth/session')).payload.player.id === playerId, 'session persists')
      check(!document.cookie.includes('apvsap_player'), 'HttpOnly token inaccessible to JavaScript')
      check((await api('/admin/api/session')).payload.authenticated === false, 'no admin session')
      check((await api('/admin/api/history')).status === 401, 'no admin privileges')
      checks.push('real registration, password hashing runtime, HttpOnly session and separate admin privileges')
      await api('/api/auth/logout', {})
      check((await api('/api/auth/session')).payload.player === null, 'logout')
      const login = await api('/api/auth/login', { username: username.toUpperCase(), password })
      check(login.status === 200, `login status ${login.status}`)
      check(login.payload.player.id === playerId, 'same account')
      checks.push('logout and real password login')
      await api('/api/auth/logout', {})
      const guest = await api('/api/auth/guest', {})
      check(guest.status === 200 && guest.payload.player.kind === 'guest', 'guest creation')
      check((await api('/api/auth/session')).payload.player.id === guest.payload.player.id, 'guest persists')
      checks.push('guest entry and persistence')
      const upgraded = await api('/api/auth/login', { username, password })
      check(upgraded.status === 200, 'guest login')
      check(upgraded.payload.player.kind === 'account' && upgraded.payload.player.id === guest.payload.player.id, 'guest seat preserved after login')
      check((await api('/api/auth/session')).payload.player.id === guest.payload.player.id, 'upgraded account session persists')
      checks.push('guest login preserves the anonymous seat in production')
    } catch (cause) { error = cause.message }
    finally { await api('/api/auth/logout', {}) }
    return { passed: checks.length, checks, error, fixture: { username, userId } }
  })
}

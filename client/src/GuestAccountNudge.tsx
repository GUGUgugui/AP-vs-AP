import { useEffect, useState } from 'react'

const seenInMemory = new Set<string>()

export default function GuestAccountNudge({ playerId, onAccess }: { playerId: string; onAccess: (mode: 'login' | 'register') => void }) {
  const key = `apvsap-account-nudge:${playerId}`
  const [visible, setVisible] = useState(() => {
    if (seenInMemory.has(key)) return false
    try { return sessionStorage.getItem(key) !== 'seen' } catch { return true }
  })
  useEffect(() => { if (visible) { seenInMemory.add(key); try { sessionStorage.setItem(key, 'seen') } catch { /* The in-memory fallback prevents repeated prompts. */ } } }, [key, visible])
  if (!visible) return null
  return <aside className="guest-account-nudge" aria-label="账号建议">
    <p className="panel-kicker">session.complete / 可选</p>
    <h2>想保留这个身份？</h2>
    <p>注册后可以在其他设备登录同一账号，对外仍是匿名代号。也可以继续以游客游玩。</p>
    <div className="nudge-actions"><button onClick={() => onAccess('register')}>注册账号</button><button onClick={() => onAccess('login')}>已有账号，登录</button><button onClick={() => setVisible(false)}>暂不注册</button></div>
  </aside>
}

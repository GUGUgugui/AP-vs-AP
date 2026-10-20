import { useCallback, useEffect, useRef, useState } from 'react'

export interface PlayerIdentity {
  id: string
  sessionKey: string
  kind: 'account' | 'guest'
  username: string | null
}

export function usePlayerAuth() {
  const [player, setPlayer] = useState<PlayerIdentity | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const channel = useRef<BroadcastChannel | null>(null)
  const requestVersion = useRef(0)
  const mutationInFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (mutationInFlight.current) return
    const version = ++requestVersion.current
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' })
      if (!response.ok) throw new Error('无法确认登录状态，请稍后重试。')
      const data = await response.json() as { player: PlayerIdentity | null }
      if (version !== requestVersion.current) return
      setPlayer(data.player)
      setError(null)
    } catch (cause) {
      if (version !== requestVersion.current) return
      setError(cause instanceof Error ? cause.message : '网络连接失败，请重试。')
    } finally { if (version === requestVersion.current) setLoading(false) }
  }, [])

  useEffect(() => {
    void refresh()
    if ('BroadcastChannel' in window) {
      channel.current = new BroadcastChannel('apvsap-auth')
      channel.current.onmessage = () => { void refresh() }
    }
    const onFocus = () => { void refresh() }
    window.addEventListener('focus', onFocus)
    return () => { window.removeEventListener('focus', onFocus); channel.current?.close() }
  }, [refresh])

  const authenticate = useCallback(async (mode: 'login' | 'register' | 'guest' | 'logout', credentials?: { username: string; password: string }) => {
    if (mutationInFlight.current) return false
    mutationInFlight.current = true
    ++requestVersion.current
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials || {}),
      })
      const data = await response.json() as { player?: PlayerIdentity | null; error?: string }
      if (!response.ok) throw new Error(data.error || '操作失败，请重试。')
      setPlayer(data.player || null)
      channel.current?.postMessage('changed')
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '网络连接失败，请重试。')
      return false
    } finally { mutationInFlight.current = false; setBusy(false); setLoading(false) }
  }, [])

  return { player, loading, busy, error, refresh, authenticate, clearError: () => setError(null) }
}

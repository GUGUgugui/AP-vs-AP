import { useCallback, useEffect, useRef, useState } from 'react'
import { appendMessage, uniqueMessages } from '../message-log'

export type GamePhase = 'lobby' | 'matching' | 'playing' | 'revealed'
export type IdentityGuess = 'human' | 'ai'

export interface MatchMessage {
  id: string
  side: 'self' | 'opponent'
  content: string
  createdAt: number
  source?: 'human' | 'ai' | 'admin'
}

export interface MatchSnapshot {
  id: string
  status: 'active' | 'revealed'
  selfCodename: string
  opponentCodename: string
  opponentConnected: boolean
  styleOptIn?: boolean
  minimumMessages?: number
  guess: IdentityGuess | null
  messages: MatchMessage[]
  truth?: 'human' | 'ai'
  correct?: boolean | null
  endReason?: 'judged' | 'left' | 'skipped' | 'reported'
  intervened?: boolean
}

interface ServerEnvelope<T = unknown> {
  type: string
  payload: T
}

function websocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws`
}

export function useGame(sessionKey: string, onSessionExpired: () => void) {
  const socketRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<number | null>(null)
  const [connected, setConnected] = useState(false)
  const [phase, setPhase] = useState<GamePhase>('lobby')
  const [codename, setCodename] = useState('匿名观察者')
  const [match, setMatch] = useState<MatchSnapshot | null>(null)
  const [opponentTyping, setOpponentTyping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    setConnected(false)

    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(websocketUrl())
      socketRef.current = socket

      socket.addEventListener('open', () => { if (!disposed) setConnected(true) })
      socket.addEventListener('close', (event) => {
        if (disposed) return
        setConnected(false)
        onSessionExpired()
        if (event.code === 4001) return
        reconnectTimer.current = window.setTimeout(connect, 1400)
      })
      socket.addEventListener('error', () => { if (!disposed) setConnected(false) })
      socket.addEventListener('message', (event) => {
        if (disposed) return
        let envelope: ServerEnvelope
        try {
          envelope = JSON.parse(String(event.data))
        } catch {
          return
        }

        switch (envelope.type) {
          case 'player:ready':
            setCodename((envelope.payload as { codename: string }).codename)
            break
          case 'match:searching':
            setPhase('matching')
            setMatch(null)
            setNotice(null)
            break
          case 'match:idle':
            setPhase('lobby'); setMatch(null); setOpponentTyping(false)
            break
          case 'match:found':
            setMatch({ ...(envelope.payload as MatchSnapshot), messages: uniqueMessages((envelope.payload as MatchSnapshot).messages) })
            setPhase('playing')
            setOpponentTyping(false)
            break
          case 'message:accepted':
            setMatch((current) => current?.status === 'active' ? { ...current, messages: appendMessage(current.messages, envelope.payload as MatchMessage) } : current)
            break
          case 'message:receive':
            setOpponentTyping(false)
            setMatch((current) => current?.status === 'active' ? { ...current, messages: appendMessage(current.messages, envelope.payload as MatchMessage) } : current)
            break
          case 'opponent:typing':
            setOpponentTyping(Boolean(envelope.payload))
            break
          case 'opponent:disconnected':
            setOpponentTyping(false)
            setNotice('对方的信号暂时离线，仍可锁定判断并揭晓。')
            setMatch((current) => current ? { ...current, opponentConnected: false } : current)
            break
          case 'opponent:connected':
            setMatch((current) => current ? { ...current, opponentConnected: true } : current)
            setNotice((current) => current === '对方的信号暂时离线，仍可锁定判断并揭晓。' ? null : current)
            break
          case 'style:consent':
            setMatch((current) => current ? { ...current, styleOptIn: (envelope.payload as { enabled: boolean }).enabled } : current)
            break
          case 'guess:updated':
            setMatch((current) => current ? {
              ...current,
              guess: (envelope.payload as { guess: IdentityGuess }).guess,
            } : current)
            break
          case 'match:revealed':
            setMatch({ ...(envelope.payload as MatchSnapshot), messages: uniqueMessages((envelope.payload as MatchSnapshot).messages) })
            setPhase('revealed')
            setOpponentTyping(false)
            break
          case 'error:message':
            setNotice((envelope.payload as { message: string }).message)
            window.setTimeout(() => setNotice(null), 3600)
            break
        }
      })
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer.current) window.clearTimeout(reconnectTimer.current)
      socketRef.current?.close(1000, 'component disposed')
    }
  }, [sessionKey, onSessionExpired])

  const send = useCallback((type: string, payload: Record<string, unknown> = {}) => {
    const socket = socketRef.current
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, payload }))
  }, [])

  const joinMatch = useCallback((styleOptIn = true) => send('match:join', { styleOptIn }), [send])
  const revokeStyleConsent = useCallback(() => send('style:revoke'), [send])
  const leaveMatch = useCallback((skip = false, styleOptIn = true) => { if (match) send(skip ? 'match:skip' : 'match:leave', { matchId: match.id, styleOptIn }) }, [match?.id, send])
  const cancelMatch = useCallback(() => send('match:cancel'), [send])

  const sendMessage = useCallback((content: string) => {
    send('typing:update', { typing: false })
    send('message:send', { content })
  }, [send])

  const sendTyping = useCallback((typing: boolean) => send('typing:update', { typing }), [send])

  const updateGuess = useCallback((guess: IdentityGuess) => {
    setMatch((current) => current ? { ...current, guess } : current)
    send('guess:update', { guess })
  }, [send])

  const reveal = useCallback(() => {
    if (match?.guess) send('match:reveal', { guess: match.guess })
  }, [match?.guess, send])

  return {
    connected, phase, codename, match, opponentTyping, notice,
    joinMatch, revokeStyleConsent, sendMessage, sendTyping, updateGuess, reveal, leaveMatch, cancelMatch,
  }
}

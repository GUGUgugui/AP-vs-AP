import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AdminHistory } from './AdminHistory'
import { AdminObservability } from './AdminObservability'
import { AdminCommunity } from './AdminCommunity'
import { SignalMark } from '../SignalIdentity'

interface AdminParticipant {
  sessionId: string
  codename: string
  connected: boolean
  guess: 'human' | 'ai' | null
}

interface AdminMessage {
  id: string
  authorId: string
  authorCodename: string
  content: string
  source: 'human' | 'ai' | 'admin'
  createdAt: number
  targetSessionIds: string[]
}

interface AdminMatch {
  id: string
  kind: 'human' | 'ai'
  status: 'active' | 'revealed'
  createdAt: number
  revealedAt?: number
  aiBusy: boolean
  participants: AdminParticipant[]
  aiPersona?: { codename: string }
  messages: AdminMessage[]
}

interface AdminSnapshot {
  generatedAt: number
  stats: {
    connectedPlayers: number
    waitingPlayers: number
    activeMatches: number
    totalMatches: number
    interventions: number
  }
  matches: AdminMatch[]
}

type Filter = 'active' | 'revealed' | 'all'
type AdminView = 'live' | 'history' | 'metrics' | 'community'

const emptySnapshot: AdminSnapshot = {
  generatedAt: 0,
  stats: { connectedPlayers: 0, waitingPlayers: 0, activeMatches: 0, totalMatches: 0, interventions: 0 },
  matches: [],
}

function adminWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/admin/ws`
}

function formatClock(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp)
}

function durationLabel(match: AdminMatch): string {
  const seconds = Math.max(0, Math.floor(((match.revealedAt || Date.now()) - match.createdAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

export default function AdminApp() {
  const [authState, setAuthState] = useState<'checking' | 'guest' | 'authenticated'>('checking')
  const [snapshot, setSnapshot] = useState<AdminSnapshot>(emptySnapshot)
  const [connected, setConnected] = useState(false)
  const [filter, setFilter] = useState<Filter>('active')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [view, setView] = useState<AdminView>('live')
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch('/admin/api/session', { credentials: 'same-origin' })
      .then((response) => response.json() as Promise<{ authenticated?: boolean }>)
      .then((body) => setAuthState(body.authenticated ? 'authenticated' : 'guest'))
      .catch(() => setAuthState('guest'))
  }, [])

  useEffect(() => {
    if (authState !== 'authenticated') return
    let disposed = false
    let reconnectTimer: number | undefined

    const connect = () => {
      if (disposed) return
      const socket = new WebSocket(adminWebSocketUrl())
      socketRef.current = socket
      socket.addEventListener('open', () => setConnected(true))
      socket.addEventListener('message', (event) => {
        let envelope: { type?: string; payload?: unknown }
        try { envelope = JSON.parse(String(event.data)) } catch { return }
        if (envelope.type === 'admin:snapshot') {
          setSnapshot(envelope.payload as AdminSnapshot)
        } else if (envelope.type === 'admin:injected') {
          setNotice('介入消息已投递并写入审计记录')
          window.setTimeout(() => setNotice(null), 3200)
        } else if (envelope.type === 'admin:error') {
          setNotice((envelope.payload as { message?: string })?.message || '操作失败')
        }
      })
      socket.addEventListener('close', (event) => {
        setConnected(false)
        if (event.code === 1008) setAuthState('guest')
        else if (!disposed) reconnectTimer = window.setTimeout(connect, 1500)
      })
      socket.addEventListener('error', () => setConnected(false))
    }

    connect()
    return () => {
      disposed = true
      if (reconnectTimer) window.clearTimeout(reconnectTimer)
      socketRef.current?.close(1000, 'admin view closed')
    }
  }, [authState])

  const visibleMatches = useMemo(() => snapshot.matches.filter((match) => {
    if (filter !== 'all' && match.status !== filter) return false
    const haystack = [match.id, match.aiPersona?.codename, ...match.participants.map((item) => item.codename)].join(' ').toLowerCase()
    return haystack.includes(query.trim().toLowerCase())
  }), [filter, query, snapshot.matches])

  useEffect(() => {
    if (!visibleMatches.some((match) => match.id === selectedId)) setSelectedId(visibleMatches[0]?.id || null)
  }, [selectedId, visibleMatches])

  const selected = snapshot.matches.find((match) => match.id === selectedId) || null

  const send = (type: string, payload: Record<string, unknown> = {}) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type, payload }))
      return true
    }
    setNotice('实时控制通道尚未连接')
    return false
  }

  const logout = async () => {
    await fetch('/admin/api/logout', { method: 'POST', credentials: 'same-origin' })
    setAuthState('guest')
    setSnapshot(emptySnapshot)
  }

  if (authState !== 'authenticated') {
    return <AdminLogin checking={authState === 'checking'} onAuthenticated={() => setAuthState('authenticated')} />
  }

  return (
    <main className="admin-console">
      <div className="admin-grid-noise" aria-hidden="true" />
      <header className="admin-topbar">
        <div className="admin-brand">
          <span className="admin-brand-code"><SignalMark /> AP/AP</span>
          <div><strong>信号监察台</strong><small>CONVERSATION CONTROL</small></div>
        </div>
        <nav className="admin-primary-nav" aria-label="管理后台栏目">
          <button className={view === 'live' ? 'active' : ''} onClick={() => setView('live')}><span>01</span>实时监察</button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><span>02</span>历史档案</button>
          <button className={view === 'metrics' ? 'active' : ''} onClick={() => setView('metrics')}><span>03</span>运行指标</button>
          <button className={view === 'community' ? 'active' : ''} onClick={() => setView('community')}><span>04</span>反馈与训练</button>
        </nav>
        <div className="admin-system-state">
          <span className={connected ? 'is-live' : ''} />
          {connected ? '实时链路已建立' : '正在恢复实时链路'}
          <button onClick={() => send('admin:refresh')}>同步</button>
          <button onClick={logout}>退出</button>
        </div>
      </header>

      {view === 'live' && <h1 className="visually-hidden">实时对话监察</h1>}
      {view === 'live' && <section className="admin-metrics" aria-label="实时统计">
        <Metric index="01" label="在线玩家" value={snapshot.stats.connectedPlayers} accent />
        <Metric index="02" label="等待匹配" value={snapshot.stats.waitingPlayers} />
        <Metric index="03" label="进行中" value={snapshot.stats.activeMatches} />
        <Metric index="04" label="对话总数" value={snapshot.stats.totalMatches} />
        <Metric index="05" label="人工介入" value={snapshot.stats.interventions} warning />
      </section>}

      {view === 'live' && <section className="admin-workspace">
        <aside className="admin-index">
          <div className="admin-section-head">
            <span>对话索引</span><small>{visibleMatches.length.toString().padStart(2, '0')} CHANNELS</small>
          </div>
          <div className="admin-filters">
            {(['active', 'revealed', 'all'] as Filter[]).map((item) => (
              <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>
                {item === 'active' ? '进行中' : item === 'revealed' ? '已结束' : '全部'}
              </button>
            ))}
          </div>
          <label className="admin-search">
            <span>⌕</span>
            <input aria-label="筛选实时对话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="代号或会话编号" />
          </label>
          <div className="admin-match-list">
            {visibleMatches.length === 0 && <div className="admin-empty-list">当前筛选下没有信号</div>}
            {visibleMatches.map((match) => (
              <button key={match.id} className={selectedId === match.id ? 'selected' : ''} onClick={() => setSelectedId(match.id)}>
                <span className={`match-state ${match.status}`} />
                <div>
                  <strong>{match.kind === 'ai' ? match.aiPersona?.codename : match.participants.map((item) => item.codename).join(' × ')}</strong>
                  <small>{match.id.slice(0, 8).toUpperCase()} · {match.messages.length} 条 · {durationLabel(match)}</small>
                </div>
                <em>{match.kind === 'ai' ? 'AI' : 'H/H'}</em>
              </button>
            ))}
          </div>
        </aside>

        {selected ? (
          <>
            <ConversationMonitor match={selected} />
            <InterventionPanel match={selected} connected={connected} onInject={(targetSessionId, content) => (
              send('admin:inject', { matchId: selected.id, targetSessionId, content })
            )} />
          </>
        ) : (
          <div className="admin-no-selection">
            <span>∅</span><strong>没有选中的对话</strong><p>从左侧选择一个频道查看完整记录。</p>
          </div>
        )}
      </section>}
      {view === 'history' && <AdminHistory onNotice={setNotice} />}
      {view === 'metrics' && <AdminObservability />}
      {view === 'community' && <AdminCommunity />}
      {notice && <div className="admin-notice">{notice}</div>}
    </main>
  )
}

function AdminLogin({ checking, onAuthenticated }: { checking: boolean; onAuthenticated: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const response = await fetch('/admin/api/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }),
      })
      const body = await response.json() as { authenticated?: boolean; error?: string }
      if (!response.ok || !body.authenticated) throw new Error(body.error || '认证失败')
      setPassword('')
      onAuthenticated()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法连接管理服务')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="admin-login">
      <div className="admin-grid-noise" aria-hidden="true" />
      <section className="admin-login-card">
        <p className="admin-login-index">RESTRICTED CHANNEL / 00</p>
        <div className="admin-login-brand"><SignalMark /><span>AP/AP</span></div>
        <h1>信号<br />监察台</h1>
        <p>这里包含未公开的对话记录和人工介入能力。所有操作都会留下来源标记。</p>
        <form onSubmit={submit}>
          <label htmlFor="admin-password">管理员口令</label>
          <div className="admin-password-row">
            <input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} disabled={checking || submitting} />
            <button type="submit" disabled={checking || submitting || !password}>{checking ? '检查中' : submitting ? '验证中' : '进入'}</button>
          </div>
          {error && <div className="admin-login-error">{error}</div>}
        </form>
        <a href="/">← 返回玩家入口</a>
      </section>
    </main>
  )
}

function Metric({ index, label, value, accent, warning }: { index: string; label: string; value: number; accent?: boolean; warning?: boolean }) {
  return <article className={`${accent ? 'accent' : ''} ${warning ? 'warning' : ''}`}><small>{index}</small><span>{label}</span><strong>{value.toString().padStart(2, '0')}</strong></article>
}

function ConversationMonitor({ match }: { match: AdminMatch }) {
  const transcriptRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }, [match.messages])

  return (
    <section className="admin-transcript">
      <header>
        <div>
          <p>LIVE TRANSCRIPT / {match.id.slice(0, 8).toUpperCase()}</p>
          <h2>{match.kind === 'ai' ? match.aiPersona?.codename : match.participants.map((item) => item.codename).join(' ↔ ')}</h2>
        </div>
        <div className="transcript-tags">
          <span>{match.kind === 'ai' ? '真人 / AI' : '真人 / 真人'}</span>
          <span className={match.status}>{match.status === 'active' ? '对话进行中' : '已经揭晓'}</span>
        </div>
      </header>
      <div className="participant-strip">
        {match.participants.map((participant) => (
          <div key={participant.sessionId}>
            <span className={participant.connected ? 'online' : ''} />
            <strong>{participant.codename}</strong>
            <small>判断：{participant.guess === 'human' ? '真人' : participant.guess === 'ai' ? 'AI' : '未选择'}</small>
          </div>
        ))}
        {match.aiPersona && <div><span className="machine" /><strong>{match.aiPersona.codename}</strong><small>机器端</small></div>}
      </div>
      <div className="admin-message-stream" ref={transcriptRef} role="region" aria-label="实时对话完整记录" tabIndex={0}>
        {match.messages.length === 0 && <div className="admin-empty-transcript">频道已经建立，尚无内容。</div>}
        {match.messages.map((message, index) => (
          <article key={message.id} className={`source-${message.source}`}>
            <div className="admin-message-meta">
              <span>{String(index + 1).padStart(3, '0')}</span>
              <strong>{message.authorCodename}</strong>
              <em>{message.source === 'admin' ? 'OPERATOR' : message.source.toUpperCase()}</em>
              <time>{formatClock(message.createdAt)}</time>
            </div>
            <p>{message.content}</p>
            {message.source === 'admin' && (
              <small>定向投递 → {match.participants.filter((item) => message.targetSessionIds.includes(item.sessionId)).map((item) => item.codename).join('、')}</small>
            )}
          </article>
        ))}
      </div>
    </section>
  )
}

function InterventionPanel({ match, connected, onInject }: {
  match: AdminMatch
  connected: boolean
  onInject: (targetSessionId: string, content: string) => boolean
}) {
  const [target, setTarget] = useState(match.participants[0]?.sessionId || '')
  const [content, setContent] = useState('')

  useEffect(() => {
    setTarget(match.participants[0]?.sessionId || '')
  }, [match.id, match.participants])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!content.trim() || !target || match.status !== 'active') return
    if (onInject(target, content.trim())) setContent('')
  }

  return (
    <aside className="admin-intervention">
      <div className="admin-section-head"><span>人工介入</span><small>OPERATOR INPUT</small></div>
      <div className="intervention-warning"><strong>!</strong><p>消息会以“对方”的身份定向出现，但在后台永久标记为管理员来源。</p></div>
      <form onSubmit={submit}>
        <label>投递目标</label>
        <div className="target-options">
          {match.participants.map((participant) => (
            <button type="button" key={participant.sessionId} className={target === participant.sessionId ? 'active' : ''} onClick={() => setTarget(participant.sessionId)}>
              <span className={participant.connected ? 'online' : ''} />
              <strong>{participant.codename}</strong>
              <small>{participant.connected ? '在线' : '离线'}</small>
            </button>
          ))}
        </div>
        <label htmlFor="operator-message">介入内容</label>
        <textarea id="operator-message" value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} rows={7} placeholder="以对方身份发送一条消息……" disabled={match.status !== 'active'} />
        <div className="intervention-count"><span>{content.length} / 2000</span><span>目标只会看到消息内容</span></div>
        <button className="inject-action" type="submit" disabled={!connected || !content.trim() || !target || match.status !== 'active'}>
          <span>发送介入信号</span><b>↗</b>
        </button>
      </form>
      <dl className="match-facts">
        <div><dt>开始时间</dt><dd>{formatClock(match.createdAt)}</dd></div>
        <div><dt>持续时长</dt><dd>{durationLabel(match)}</dd></div>
        <div><dt>消息数量</dt><dd>{match.messages.length}</dd></div>
        <div><dt>会话类型</dt><dd>{match.kind === 'ai' ? '人机' : '真人'}</dd></div>
      </dl>
    </aside>
  )
}

import { Component, lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useGame, type IdentityGuess, type MatchMessage, type MatchSnapshot } from './hooks/useGame'
import AccessScreen from './AccessScreen'
import { usePlayerAuth, type PlayerIdentity } from './hooks/usePlayerAuth'
import AccountDialog from './AccountDialog'
import GuestAccountNudge from './GuestAccountNudge'
import { FeedbackEditor, Icebreakers, PlayerNotebook, ReportDialog, RoomActions, endLabels } from './PlayerFeatures'
import { FieldFooter, SignalArtwork, SignalMark } from './SignalIdentity'

const AdminApp = lazy(() => import('./admin/AdminApp'))

class AdminLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() {
    if (this.state.failed) return <main className="admin-login"><section className="admin-login-card"><div className="admin-login-brand"><SignalMark /><span>AP/AP</span></div><h1>页面需要<br />重新加载</h1><p>可能刚刚发布了新版，或网络中断。请重新加载后再打开监察台；不会改变正在进行的对话。</p><button className="inject-action" onClick={() => window.location.reload()}>重新加载</button><a href="/">← 返回玩家入口</a></section></main>
    return this.props.children
  }
}

const ArrowIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" /></svg>
)

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>
)

function App() {
  return window.location.pathname.startsWith('/admin') ? <AdminLoadBoundary><Suspense fallback={<main className="admin-login" role="status"><h1 className="visually-hidden">正在打开监察台</h1><p>正在打开监察台…</p></main>}><AdminApp /></Suspense></AdminLoadBoundary> : <PlayerApp />
}

function PlayerApp() {
  const auth = usePlayerAuth()
  if (auth.loading) return <div className="app-shell"><SiteHeader connected={false} codename="确认登录状态" /><main className="access-loading" role="status">正在确认身份…</main></div>
  if (!auth.player) return <div className="app-shell"><SiteHeader connected={false} codename="玩家入口" /><AccessScreen busy={auth.busy} error={auth.error} onClearError={auth.clearError} onAuthenticate={auth.authenticate} /></div>
  return <PlayerGame key={auth.player.id} player={auth.player} busy={auth.busy} authError={auth.error} onClearError={auth.clearError} onAuthenticate={auth.authenticate} onLogout={() => { void auth.authenticate('logout') }} onSessionExpired={auth.refresh} />
}

function PlayerGame({ player, busy, authError, onClearError, onAuthenticate, onLogout, onSessionExpired }: {
  player: PlayerIdentity
  busy: boolean
  authError: string | null
  onClearError: () => void
  onAuthenticate: (mode: 'login' | 'register' | 'guest', credentials?: { username: string; password: string }) => Promise<boolean>
  onLogout: () => void
  onSessionExpired: () => void
}) {
  const game = useGame(player.sessionKey, onSessionExpired)
  const [styleOptIn, setStyleOptIn] = useState(true)
  const [showHome, setShowHome] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [reportMatchId, setReportMatchId] = useState<string | null>(null)
  const [accessMode, setAccessMode] = useState<'login' | 'register' | null>(null)
  const canSwitchIdentity = game.phase === 'lobby' || game.phase === 'revealed'
  const onAccess = (mode: 'login' | 'register' = 'login') => { game.sendTyping(false); onClearError(); setAccessMode(mode) }
  const goHome = () => { game.sendTyping(false); setShowProfile(false); setShowHome(true) }
  const openReport = (id: string) => { game.sendTyping(false); setReportMatchId(id) }
  const startOrResume = () => {
    setShowHome(false)
    setShowProfile(false)
    if (game.phase !== 'playing' && game.phase !== 'matching') game.joinMatch(styleOptIn)
  }
  const resumeLabel = game.phase === 'playing' ? '返回当前对话' : game.phase === 'matching' ? '查看匹配进度' : undefined

  return (
    <div className="app-shell">
      <SiteHeader connected={game.connected} codename={game.codename} player={player} busy={busy} disabled={!canSwitchIdentity} activePage={showProfile ? 'profile' : showHome || game.phase === 'lobby' ? 'home' : 'room'} onAccess={() => onAccess()} onLogout={onLogout} onHome={goHome} onProfile={() => { game.sendTyping(false); setShowProfile(true) }} />
      {!accessMode && authError && <p className="account-error" role="alert">{authError}</p>}
      <div id="page-content" className="page-content" tabIndex={-1}>
      {!showProfile && (game.phase === 'lobby' || showHome) && (
        <Lobby connected={game.connected} styleOptIn={styleOptIn} onStyleOptIn={setStyleOptIn} onJoin={startOrResume} resumeLabel={resumeLabel} onResult={game.phase === 'revealed' ? () => setShowHome(false) : undefined} />
      )}
      {showProfile && <PlayerNotebook player={player} onResume={startOrResume} resumeLabel={resumeLabel} onReport={openReport} onAccess={() => onAccess('register')} />}
      {game.phase === 'matching' && <div hidden={showHome || showProfile}><Matching onCancel={game.cancelMatch} /></div>}
      {game.phase === 'playing' && game.match && (
        <div hidden={showHome || showProfile}>
        <GameRoom
          key={game.match.id}
          match={game.match}
          disabled={!game.connected || busy}
          opponentTyping={game.opponentTyping}
          notice={game.notice}
          onSend={game.sendMessage}
          onTyping={game.sendTyping}
          onGuess={game.updateGuess}
          onReveal={game.reveal}
          onRevokeStyle={() => { setStyleOptIn(false); game.revokeStyleConsent() }}
          onLeave={() => game.leaveMatch(false)}
          onSkip={() => { setShowHome(false); setShowProfile(false); game.leaveMatch(true, styleOptIn) }}
          onReport={() => openReport(game.match!.id)}
        />
        </div>
      )}
      {game.phase === 'revealed' && game.match && (
        <div hidden={showHome || showProfile}><RevealResult key={game.match.id} match={game.match} styleOptIn={styleOptIn} onStyleOptIn={setStyleOptIn} onAgain={startOrResume} guestId={player.kind === 'guest' && !showHome && !showProfile ? player.id : undefined} onAccess={onAccess} onReport={() => openReport(game.match!.id)} /></div>
      )}
      </div>
      {accessMode && <AccountDialog mode={accessMode} busy={busy} error={authError} onClearError={onClearError} onClose={() => { onClearError(); setAccessMode(null) }} onAuthenticate={async (mode, credentials) => { const success = await onAuthenticate(mode, credentials); if (success) setAccessMode(null); return success }} />}
      {reportMatchId && <ReportDialog matchId={reportMatchId} onClose={() => setReportMatchId(null)} />}
    </div>
  )
}

function SiteHeader({ connected, codename, player, busy, disabled, activePage, onAccess, onLogout, onHome, onProfile }: {
  connected: boolean; codename: string; player?: PlayerIdentity; busy?: boolean; disabled?: boolean; activePage?: 'home' | 'profile' | 'room'; onAccess?: () => void; onLogout?: () => void; onHome?: () => void; onProfile?: () => void
}) {
  return (
    <header className="site-header" id="top">
      <a className="skip-link" href="#page-content">跳到主要内容</a>
      <a className="brand-mark" href="#top" aria-label="人机迷雾首页" onClick={event => { if (onHome) { event.preventDefault(); onHome() } }}>
        <SignalMark />
        <span className="brand-title">AP/AP <small>人机迷雾</small></span>
      </a>
      {player ? <nav className="player-account-controls" aria-label="玩家导航"><button aria-current={activePage === 'home' ? 'page' : undefined} onClick={onHome}>首页</button><button aria-current={activePage === 'profile' ? 'page' : undefined} onClick={onProfile}>我的</button><span className={player.kind === 'guest' ? 'guest-label' : ''} title={player.username || '游客'}>{player.kind === 'account' ? player.username : '游客'}</span>{player.kind === 'guest' && <button className="header-access" disabled={busy} onClick={onAccess} aria-label="登录 / 注册"><span className="wide-label">登录 / 注册</span><span className="short-label" aria-hidden="true">登录</span></button>}<button className="logout-control" disabled={busy || disabled} onClick={onLogout} title={disabled ? '本局结束后可退出' : undefined}>退出</button></nav> : <a className="public-access-link" href="#access-panel">登录 / 注册 <span aria-hidden="true">↗</span></a>}
      <span className="header-route">ANONYMOUS / ONE TO ONE</span>
      <div className="station-meta">
        {player ? <><span className={`connection-dot ${connected ? 'online' : ''}`} /><span>{connected ? 'connected' : 'reconnecting'}</span><span className="meta-divider" /><span>{codename}</span></> : <span>两种可能，一段对话。</span>}
      </div>
    </header>
  )
}

function Lobby({ connected, styleOptIn, onStyleOptIn, onJoin, resumeLabel, onResult }: {
  connected: boolean
  styleOptIn: boolean
  onStyleOptIn: (enabled: boolean) => void
  onJoin: () => void
  resumeLabel?: string
  onResult?: () => void
}) {
  return (
    <main className="lobby">
      <section className="lobby-copy">
        <p className="eyebrow"><span className="eyebrow-square" aria-hidden="true" /> THE HUMAN / MACHINE EXPERIMENT</p>
        <p className="lobby-tag">匿名连接 / 身份未知</p>
        <h1>先聊一会儿。<br /><em>再相信直觉。</em></h1>
        <p className="lobby-lead">
          随机连接一位真人或 AI。自由聊，没有题目，也没有固定轮数。
          对方是谁，藏在每一句回答里。
        </p>
        <label className="style-consent-card">
          <input type="checkbox" checked={styleOptIn} onChange={(event) => onStyleOptIn(event.target.checked)} />
          <span className="style-consent-mark" aria-hidden="true" />
          <span className="style-consent-copy"><strong>{resumeLabel ? '下一局参与真人风格学习' : '参与真人风格学习'} <small>默认开启</small></strong><em>仅统计真人局的句长、问句比例和回复间隔，学习表不存原句，最多保留 30 天。任一方在揭晓前关闭，该局就不纳入学习。</em></span>
        </label>
        <button className="primary-action" onClick={onJoin} disabled={!connected}>
          <span>{connected ? resumeLabel || '开始匹配' : '正在连接服务器'}</span>
          <ArrowIcon />
        </button>
        {resumeLabel && <p className="resume-note" role="status">当前会话仍在进行，返回首页不会结束对话；新消息会保留。</p>}
        {onResult && <button className="previous-result" onClick={onResult}>查看上一局结果</button>}
        <p className="action-hint">账号和游客均可游玩 <span>/</span> 身份在揭晓前保持隐藏</p>
        <p className="consent-note">管理员可审阅和介入对话。请勿发送联系方式或可识别个人身份的信息；原句训练须双方另行明确授权。</p>
      </section>

      <section className="protocol-terminal" aria-label="匹配规则">
        <SignalArtwork />
        <div className="terminal-body">
          <dl className="config-list">
            <div><dt>对话轮数</dt><dd>不设上限</dd></div>
            <div><dt>身份判断</dt><dd>发送 3 条消息后开放</dd></div>
            <div><dt>风格统计</dt><dd className={styleOptIn ? 'config-enabled' : ''}>{styleOptIn ? '开启 / 不收集原句' : '关闭 / 不参与统计'}</dd></div>
          </dl>
          <p className="terminal-comment terminal-tip">语言是线索，不是证据。你可以慢慢判断。</p>
        </div>
        <footer className="terminal-status"><span className={connected ? 'terminal-ready' : ''}>{connected ? '● ready to connect' : '○ connecting'}</span><span>1 : 1</span></footer>
      </section>

      <section className="protocol-strip">
        <div><span>01 / CONNECT</span><strong>连接未知。</strong><p>对面可能是真人，也可能是 AI。</p></div>
        <div><span>02 / CONVERSE</span><strong>认真听一句。</strong><p>没有测试题。聊你真正想聊的。</p></div>
        <div><span>03 / REVEAL</span><strong>相信你的判断。</strong><p>选择真人或 AI，再揭晓答案。</p></div>
      </section>
      <FieldFooter />
    </main>
  )
}

function Matching({ onCancel }: { onCancel: () => void }) {
  return (
    <main className="matching-screen">
      <div className="matching-terminal" role="status" aria-live="polite">
        <header className="terminal-title"><span><i aria-hidden="true" />matchmaking</span><small>RUNNING</small></header>
        <div className="matching-body">
          <p className="eyebrow"><span className="prompt-symbol">$</span> connect --random</p>
          <h2>正在匹配对端<span className="terminal-cursor" aria-hidden="true">_</span></h2>
          <p className="matching-log"><span>[queue]</span> 已加入匹配队列</p>
          <p className="matching-log"><span>[peer]</span> 等待建立匿名连接…</p>
          <div className="matching-progress" aria-hidden="true"><span /></div>
          <p className="matching-note">对方的身份会在你提交判断后揭晓。</p>
          <button className="previous-result" onClick={onCancel}>取消匹配</button>
        </div>
      </div>
    </main>
  )
}

interface GameRoomProps {
  match: MatchSnapshot
  disabled: boolean
  opponentTyping: boolean
  notice: string | null
  onSend: (content: string) => void
  onTyping: (typing: boolean) => void
  onGuess: (guess: IdentityGuess) => void
  onReveal: () => void
  onRevokeStyle: () => void
  onLeave: () => void
  onSkip: () => void
  onReport: () => void
}

function GameRoom(props: GameRoomProps) {
  const [guessOpen, setGuessOpen] = useState(false)
  const [startedAt] = useState(() => props.match.messages[0]?.createdAt || Date.now())
  const sentCount = props.match.messages.filter((message) => message.side === 'self').length
  const guessAvailable = sentCount >= (props.match.minimumMessages || 3)
  const prompted = useRef(false)

  useEffect(() => {
    if (!guessAvailable || prompted.current) return
    prompted.current = true
    let dismissed = false
    try { dismissed = sessionStorage.getItem(`apvsap-verdict-dismissed:${props.match.id}`) === 'yes' } catch { /* Storage may be blocked; the in-memory state still works. */ }
    if (!dismissed) setGuessOpen(true)
  }, [guessAvailable, props.match.id])

  const closeGuess = () => {
    if ((document.activeElement as HTMLElement | null)?.closest('.guess-panel')) document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
    setGuessOpen(false)
    try { sessionStorage.setItem(`apvsap-verdict-dismissed:${props.match.id}`, 'yes') } catch { /* Dismissing still works without browser storage. */ }
  }
  const verdict = guessAvailable && guessOpen ? <GuessPanel guess={props.match.guess} onClose={closeGuess} onGuess={props.onGuess} onReveal={props.onReveal} /> : null

  return (
    <main className={`game-layout ${verdict ? 'judging' : 'chat-only'}`} onKeyDown={event => { if (event.key === 'Escape' && guessOpen && !event.defaultPrevented) { event.preventDefault(); closeGuess() } }}>
      <aside className="session-rail">
        <p className="rail-label">SESSION</p>
        <div className="rail-code">{props.match.id.slice(0, 8).toUpperCase()}</div>
        <div className="rail-line" />
        <div className="rail-block">
          <span>你的昵称</span>
          <strong>{props.match.selfCodename}</strong>
        </div>
        <div className="rail-block">
          <span>对方状态</span>
          <strong className={props.match.opponentConnected ? 'status-live' : 'status-lost'}>
            {props.match.opponentConnected ? 'online' : 'offline'}
          </strong>
        </div>
        <div className="rail-block rail-clock">
          <span>会话时长</span>
          <ElapsedTime since={startedAt} />
        </div>
        <p className="rail-footnote">一对一匿名连接<br />身份未揭晓<br /><br />不要发送个人身份信息。</p>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-header">
          <div>
            <p className="panel-kicker">chat.log / {props.match.id.slice(0, 8)}</p>
            <h1>{props.match.opponentCodename}</h1>
          </div>
          <span className="message-count">{props.match.messages.length} messages</span>
          {guessAvailable && <button className="mobile-guess-button" onClick={() => guessOpen ? closeGuess() : setGuessOpen(true)} aria-expanded={guessOpen}>
            <EyeIcon />判断身份
          </button>}
        </header>
        <MessageList messages={props.match.messages} opponentTyping={props.opponentTyping} />
        <RoomActions disabled={props.disabled} onLeave={props.onLeave} onSkip={props.onSkip} onReport={props.onReport} />
        {props.notice && <div className="toast-notice">{props.notice}</div>}
        {guessAvailable && <p className="verdict-ready" role="status">已开放身份判断，继续聊天也可以。{!guessOpen && <button onClick={() => setGuessOpen(true)}>打开判断</button>}</p>}
        <div className="mobile-verdict-slot">{verdict}</div>
        <div className={`style-consent-active ${props.match.styleOptIn ? '' : 'disabled'}`}><span><i aria-hidden="true" />{props.match.styleOptIn ? '风格学习已开启 · 仅双方都未关闭的真人局贡献统计' : '风格学习已关闭 · 本局不贡献统计'}</span>{props.match.styleOptIn && <button onClick={props.onRevokeStyle}>关闭本局学习</button>}</div>
        <Composer disabled={props.disabled || props.opponentTyping} onSend={props.onSend} onTyping={props.onTyping} />
      </section>

      {verdict && <div className="desktop-verdict-slot" aria-hidden="true" />}
    </main>
  )
}

function ElapsedTime({ since }: { since: number }) {
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.floor((Date.now() - since) / 1000)))
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000))), 1000)
    return () => window.clearInterval(timer)
  }, [since])
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0')
  const rest = (seconds % 60).toString().padStart(2, '0')
  return <strong>{minutes}:{rest}</strong>
}

function MessageList({ messages, opponentTyping }: { messages: MatchMessage[]; opponentTyping: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
      bottomRef.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' })
  }, [messages, opponentTyping])

  return (
    <div className="message-field" role="region" aria-label="对话消息记录" tabIndex={0}>
      {messages.length === 0 && (
        <div className="empty-transmission">
          <small>[session established]</small>
          <span>连接已建立。</span>
          <p>从一句「你好」开始，或者直接聊你想聊的。</p>
        </div>
      )}
      {messages.map((message, index) => (
        <article key={message.id} className={`message-row ${message.side}`}>
          <span className="message-index">{String(index + 1).padStart(3, '0')}</span>
          <div className="message-body">
            <div className="message-meta"><span className="message-author">{message.side === 'self' ? 'you' : 'peer'}</span><time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour12: false })}</time></div>
            <p>{message.content}</p>
          </div>
        </article>
      ))}
      {opponentTyping && (
        <div className="typing-signal"><span /><span /><span /><small>对方正在打字</small></div>
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function Composer({ disabled, onSend, onTyping }: {
  disabled: boolean
  onSend: (content: string) => void
  onTyping: (typing: boolean) => void
}) {
  const [value, setValue] = useState('')
  const typingTimer = useRef<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => () => { if (typingTimer.current) window.clearTimeout(typingTimer.current) }, [])

  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    if (!value.trim() || disabled) return
    onSend(value.trim())
    setValue('')
    onTyping(false)
  }

  const handleChange = (next: string) => {
    setValue(next)
    onTyping(Boolean(next.trim()))
    if (typingTimer.current) window.clearTimeout(typingTimer.current)
    typingTimer.current = window.setTimeout(() => onTyping(false), 1500)
  }

  return (
    <form className="composer" onSubmit={submit}>
      <Icebreakers onPick={text => { handleChange(((value ? value + '\n' : '') + text).slice(0, 2000)); inputRef.current?.focus() }} />
      <span className="composer-prompt" aria-hidden="true">&gt;</span>
      <textarea
        ref={inputRef}
        value={value}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault()
            submit()
          }
        }}
        placeholder={disabled ? '可先输入，等待对方回复后发送…' : '输入消息…'}
        maxLength={2000}
        rows={1}
        aria-label="发送消息"
      />
      <div className="composer-bottom">
        <span>Enter 发送 <i>/</i> Shift + Enter 换行</span>
        <small>{value.length}/2000</small>
        <button type="submit" disabled={disabled || !value.trim()} aria-label="发送">发送 <ArrowIcon /></button>
      </div>
    </form>
  )
}

function GuessPanel({ guess, onClose, onGuess, onReveal }: {
  guess: IdentityGuess | null
  onClose: () => void
  onGuess: (guess: IdentityGuess) => void
  onReveal: () => void
}) {
  return (
    <aside className="guess-panel" aria-label="身份判断" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose() } }}>
      <button className="guess-close" onClick={onClose} aria-label="关闭判断面板">×</button>
      <p className="panel-kicker">verdict.pending</p>
      <h2>身份判断</h2>
      <p className="guess-question">聊到这里，你觉得对面是谁？</p>
      <div className="identity-choices" role="group" aria-label="选择对方身份">
        <button onClick={() => onGuess('human')} className={guess === 'human' ? 'selected' : ''} aria-pressed={guess === 'human'}><span className="choice-check" aria-hidden="true">{guess === 'human' ? '✓' : ''}</span><strong>真人</strong><small>HUMAN</small></button>
        <button onClick={() => onGuess('ai')} className={guess === 'ai' ? 'selected' : ''} aria-pressed={guess === 'ai'}><span className="choice-check" aria-hidden="true">{guess === 'ai' ? '✓' : ''}</span><strong>AI</strong><small>MACHINE</small></button>
      </div>
      <p className="guess-selection" role="status">{guess === 'human' ? '已选择：真人' : guess === 'ai' ? '已选择：AI' : '尚未选择'}</p>
      <p className="guess-explainer">选择后仍可继续聊天或更改判断。提交并揭晓后，本局对话结束。</p>
      <button className="reveal-action" onClick={onReveal} disabled={!guess}>
        <EyeIcon /><span>提交判断 / 揭晓</span>
      </button>
    </aside>
  )
}

function RevealResult({ match, styleOptIn, onStyleOptIn, onAgain, guestId, onAccess, onReport }: {
  match: MatchSnapshot
  styleOptIn: boolean
  onStyleOptIn: (enabled: boolean) => void
  onAgain: () => void
  guestId?: string
  onAccess: (mode: 'login' | 'register') => void
  onReport: () => void
}) {
  const isHuman = match.truth === 'human'
  const hasIntervention = Boolean(match.intervened) || match.messages.some((message) => message.source === 'admin')
  const endedEarly = Boolean(match.endReason && match.endReason !== 'judged')
  const opponentMessages = match.messages.filter((message) => message.side === 'opponent')

  return (
    <main className={`reveal-screen ${isHuman ? 'human-result' : 'ai-result'}`}>
      <section className="reveal-verdict">
        <p className="eyebrow"><span>RESULT / {endedEarly ? endLabels[match.endReason!] : '身份已揭晓'}</span><span>{match.id.slice(0, 8).toUpperCase()}</span></p>
        <div className="verdict-word">
          <span>peer.type = {isHuman ? 'human' : 'ai'}</span>
          <h1>{isHuman ? '真人' : '机器'}</h1>
        </div>
        <p className="verdict-copy">
          {isHuman ? '对面是一位真人玩家，和你一样参与这场身份猜测。' : '对面是由 AI 驱动的虚构角色。'}
          {hasIntervention && ' 本局包含管理员介入，消息来源已在记录中标注。'}
        </p>
        <div className="result-card">
          <div><span>你的判断</span><strong>{match.guess === 'human' ? '真人' : match.guess === 'ai' ? 'AI' : '未选择'}</strong></div>
          <div><span>最终结果</span><strong className={match.correct === true ? 'result-correct' : match.correct === false ? 'result-incorrect' : ''}>{match.correct == null ? '未判断' : match.correct ? '猜对了' : '猜错了'}</strong></div>
        </div>
        {endedEarly ? <p className="unanswered-note">本局提前结束，不算猜错，不计入正确率与成就。</p> : hasIntervention ? <p className="unanswered-note">本局有管理员介入，不计入正确率与成就。</p> : !match.guess && <p className="unanswered-note">对方先揭晓了身份，你尚未选择，本局不计入你的命中率。</p>}
        {guestId && !endedEarly && <GuestAccountNudge playerId={guestId} onAccess={onAccess} />}
        <label className="next-style-choice"><input type="checkbox" checked={styleOptIn} onChange={(event) => onStyleOptIn(event.target.checked)} /><span>下一局开启风格学习</span></label>
        <button className="primary-action inverse" onClick={onAgain}><span>开始下一局</span><ArrowIcon /></button>
        <FeedbackEditor matchId={match.id} trainingEligible={isHuman && !endedEarly && !hasIntervention} onReport={onReport} />
      </section>

      <section className="reveal-evidence">
        <p className="panel-kicker">peer.messages / 最近 6 条</p>
        <h2>对话回看</h2>
        <div className="evidence-list">
          {opponentMessages.length === 0 && <p className="no-evidence">你在收到回复前就揭晓了身份。</p>}
          {opponentMessages.slice(-6).map((message, index) => (
            <article key={message.id}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <p>{message.content}</p>
              <small>{message.source === 'ai' ? 'MACHINE ORIGIN' : message.source === 'admin' ? 'OPERATOR INTERVENTION' : 'HUMAN ORIGIN'}</small>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App

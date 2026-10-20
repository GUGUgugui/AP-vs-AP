import { useState, type FormEvent } from 'react'
import { FieldFooter, SignalArtwork } from './SignalIdentity'

export default function AccessScreen({ busy, error, onAuthenticate, onBack, onClearError, compact = false, initialMode = 'login' }: {
  busy: boolean
  error: string | null
  onAuthenticate: (mode: 'login' | 'register' | 'guest', credentials?: { username: string; password: string }) => Promise<boolean>
  onBack?: () => void
  onClearError?: () => void
  compact?: boolean
  initialMode?: 'login' | 'register'
}) {
  const [mode, setMode] = useState<'login' | 'register'>(initialMode)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const Root = compact ? 'div' : 'main'

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setLocalError(null)
    if (mode === 'register' && password !== confirmation) { setLocalError('两次输入的密码不一致。'); return }
    if (await onAuthenticate(mode, { username: username.trim(), password })) { setPassword(''); setConfirmation('') }
  }

  return (
    <Root id={compact ? undefined : 'page-content'} tabIndex={compact ? undefined : -1} className={`access-screen ${compact ? 'compact' : ''}`}>
      <section className="access-intro">
        <p className="eyebrow"><span className="eyebrow-square" aria-hidden="true" /> THE HUMAN / MACHINE EXPERIMENT</p>
        <h1>隔着屏幕，<br /><em>谁在回答？</em></h1>
        <p className="access-description">一句话，两种可能。<br />随机连接真人或 AI，凭对话判断屏幕另一端。</p>
        {!compact && <div className="entry-guest"><button className="guest-action" disabled={busy} onClick={() => { void onAuthenticate('guest') }}>以游客身份游玩 <span aria-hidden="true">↗</span></button><small>无需注册 · 完整游玩 · 对外只显示匿名代号</small></div>}
        <SignalArtwork compact />
      </section>
      <section id={compact ? undefined : 'access-panel'} className="access-terminal" aria-label="玩家入口">
        <header className="terminal-title"><span><i aria-hidden="true" />PLAYER ACCESS</span><small>账号连接</small></header>
        <div className="access-body">
          {!compact && <div className="access-heading"><h2>保留你的观察记录。</h2><p>跨设备登录同一账号，对话依然匿名。</p></div>}
          <div className="access-tabs" role="group" aria-label="登录或注册">
            <button type="button" aria-pressed={mode === 'login'} disabled={busy} onClick={() => { onClearError?.(); setMode('login'); setLocalError(null); setPassword(''); setConfirmation('') }}>登录</button>
            <button type="button" aria-pressed={mode === 'register'} disabled={busy} onClick={() => { onClearError?.(); setMode('register'); setLocalError(null); setPassword(''); setConfirmation('') }}>注册</button>
          </div>
          <form onSubmit={submit}>
            <label htmlFor="player-username">用户名 <small>3–24 位字母、数字或下划线</small></label>
            <input id="player-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} pattern="[A-Za-z0-9_]{3,24}" minLength={3} maxLength={24} required value={username} disabled={busy} onChange={(event) => setUsername(event.target.value)} />
            <label htmlFor="player-password">密码 <small>10–128 个字符</small></label>
            <div className="password-field">
              <input id="player-password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={10} maxLength={128} required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
              <button type="button" disabled={busy} aria-label={showPassword ? '隐藏密码' : '显示密码'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? '隐藏' : '显示'}</button>
            </div>
            {mode === 'register' && <><label htmlFor="player-confirm">确认密码</label><input id="player-confirm" name="password_confirmation" type={showPassword ? 'text' : 'password'} autoComplete="new-password" minLength={10} maxLength={128} required value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} /></>}
            {(localError || error) && <p className="access-error" role="alert">{localError || error}</p>}
            <button className="primary-action" type="submit" disabled={busy}>{busy ? '正在处理…' : mode === 'login' ? compact ? '登录并继续' : '登录并进入大厅' : compact ? '注册并继续' : '注册并进入大厅'}<span aria-hidden="true">→</span></button>
          </form>
          <p className="access-note">{compact ? '注册会保留本局，对外仍是匿名代号。登录时若双方各有不同的进行中对局，会提示冲突，不覆盖对话。' : '游客身份在此浏览器保留 30 天，清除 Cookie 后无法恢复。'}账号暂不支持密码找回，请妥善保存密码。</p>
          {onBack && <button className="access-back" onClick={onBack} disabled={busy}>← 返回大厅</button>}
        </div>
      </section>
      {!compact && <>
        <section className="entry-protocol" aria-label="游玩方式"><p className="panel-kicker">HOW IT WORKS / 游玩方式</p><div><article><span>01</span><h2>连接未知。</h2><p>随机匹配真人或 AI。账号与游客都能完整游玩。</p></article><article><span>02</span><h2>自由对话。</h2><p>没有固定话题与轮数。自己发出三条消息后开放判断。</p></article><article><span>03</span><h2>揭晓答案。</h2><p>选择真人或 AI，提交后揭晓。也可以继续聊，再做决定。</p></article></div><p className="entry-privacy">匿名不是隐私承诺。管理员可审阅和介入对话，请勿发送可识别个人身份的信息。原句训练需要双方另行明确授权。</p></section>
        <FieldFooter />
      </>}
    </Root>
  )
}

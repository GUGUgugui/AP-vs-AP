import { useEffect, useRef, useState } from 'react'
import type { PlayerIdentity } from './hooks/usePlayerAuth'
import { BadgeSymbol } from './SignalIdentity'

export const feedbackLabels: Record<string, string> = { natural: '很自然', too_fast: '回复太快', formal: '说话太正式', repetitive: '复读', incoherent: '不连贯' }
const reportLabels: Record<string, string> = { harassment: '骚扰或辱骂', privacy: '索取或泄露隐私', spam: '广告或刷屏', unsafe: '危险或违法内容', other: '其他问题' }
export const endLabels: Record<string, string> = { judged: '正常揭晓', left: '提前结束', skipped: '跳过对话', reported: '举报后结束' }
export async function playerApi<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。')
  return data as T
}
export function FeedbackEditor({ matchId, trainingEligible, onReport }: { matchId: string; trainingEligible: boolean; onReport: () => void }) {
  const [tags, setTags] = useState<string[]>([]), [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void playerApi<{ feedback: string[]; trainingConsent: boolean }>(`/api/player/history/${matchId}`, undefined, controller.signal).then(data => { setTags(data.feedback); setConsent(data.trainingConsent) }).catch(error => { if (error.name !== 'AbortError') setNotice('记录归档中，可稍后再提交。') })
    return () => controller.abort()
  }, [matchId])
  const save = async () => {
    setBusy(true); setNotice('')
    try { await playerApi('/api/player/feedback', { matchId, tags }); setNotice('反馈已保存，可重新选择并更新。') } catch (error) { setNotice((error as Error).message) } finally { setBusy(false) }
  }
  const toggleConsent = async (next: boolean) => {
    const previous = consent
    setConsent(next); setBusy(true); setNotice('')
    try { await playerApi('/api/player/training-consent', { matchId, consent: next }); setNotice(next ? '原句授权已保存。双方同意且样本合格后进入待审核训练集。' : '原句授权已撤回，站内训练样本已移除。已导出的副本不能自动收回。') } catch (error) { setConsent(previous); setNotice((error as Error).message) } finally { setBusy(false) }
  }
  return <section className="postgame-tools" aria-label="赛后反馈">
    <p className="panel-kicker">feedback / 可选</p><h2>这段对话给你的感觉？</h2>
    <div className="feedback-tags">{Object.entries(feedbackLabels).map(([tag, label]) => <button key={tag} disabled={busy} aria-pressed={tags.includes(tag)} onClick={() => setTags(current => tag === 'natural' ? current.includes(tag) ? [] : [tag] : current.includes(tag) ? current.filter(value => value !== tag) : [...current.filter(value => value !== 'natural'), tag])}>{label}</button>)}</div>
    <div className="postgame-actions"><button disabled={busy || !tags.length} onClick={save}>{busy ? '处理中…' : '保存反馈'}</button><button disabled={busy} onClick={onReport}>举报这段对话</button></div>
    {trainingEligible && <div className="training-consent"><label><input type="checkbox" checked={consent} disabled={busy} onChange={event => { void toggleConsent(event.target.checked) }} /><span>授权本局原句用于模型训练数据集（可选）</span></label><p>仅双方明确同意的真人局入集，包含聊天原句，不是风格统计。管理员审核后可导出；请勿授权含个人信息的内容。训练环境尚未接入，不会自动训练模型。撤回会删除站内样本，无法自动收回已导出副本。</p></div>}
    {notice && <p className="feature-notice" role="status">{notice}</p>}
  </section>
}
export function ReportDialog({ matchId, onClose }: { matchId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null), [reason, setReason] = useState('harassment'), [description, setDescription] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => { ref.current?.showModal(); return () => ref.current?.close() }, [])
  return <dialog ref={ref} className="account-dialog report-dialog" aria-labelledby="report-title" onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <header className="account-dialog-header"><div><p className="panel-kicker">report.issue</p><h2 id="report-title">举报对话</h2></div><button disabled={busy} onClick={onClose} aria-label="关闭举报">×</button></header>
    <form className="report-body" onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await playerApi('/api/player/report', { matchId, reason, description }); onClose() } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) } }}>
      <p>若本局仍在进行，提交后会结束对话，不计入猜错。举报只交给管理员，不自动处罚对方。</p>
      <label htmlFor="report-reason">举报原因</label><select id="report-reason" value={reason} disabled={busy} onChange={event => setReason(event.target.value)}>{Object.entries(reportLabels).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select>
      <label htmlFor="report-description">补充说明（可选，勿填写个人信息）</label><textarea id="report-description" value={description} disabled={busy} maxLength={400} onChange={event => setDescription(event.target.value)} rows={4} />
      {error && <p className="access-error" role="alert">{error}</p>}<button className="primary-action" disabled={busy}>{busy ? '提交中…' : '提交举报'}</button>
    </form><button className="dialog-cancel" disabled={busy} onClick={onClose}>取消，继续游玩</button>
  </dialog>
}
interface HistoryItem { id: string; truth: 'human' | 'ai'; end_reason: string; created_at: number; self_codename: string; opponent_codename: string; correct: number | null; guess: string | null; intervention_count: number; message_count: number }
interface HistoryDetail { match: HistoryItem; messages: Array<{ id: string; side: string; source: string; content: string; created_at: number }> }
interface Profile { stats: { total: number; judged: number; correct: number; accuracy: number | null; skipped: number; unanswered: number; interventions: number; streak: number }; retentionDays: number; badges: Array<{ code: string; title: string; description: string; unlockedAt: number | null }> }
export function PlayerNotebook({ player, onResume, resumeLabel, onReport, onAccess }: { player: PlayerIdentity; onResume: () => void; resumeLabel?: string; onReport: (id: string) => void; onAccess: () => void }) {
  const [profile, setProfile] = useState<Profile | null>(null), [items, setItems] = useState<HistoryItem[]>([]), [cursor, setCursor] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null), [detail, setDetail] = useState<HistoryDetail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController(); setError(''); setProfile(null); setSelected(null); setDetail(null)
    void Promise.all([playerApi<Profile>('/api/player/profile', undefined, controller.signal), playerApi<{ items: HistoryItem[]; nextCursor: string | null }>('/api/player/history', undefined, controller.signal)]).then(([data, history]) => { setProfile(data); setItems(history.items); setCursor(history.nextCursor) }).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message) })
    return () => controller.abort()
  }, [player.sessionKey, refresh])
  useEffect(() => {
    setDetail(null); if (!selected) return
    const controller = new AbortController()
    void playerApi<HistoryDetail>(`/api/player/history/${selected}`, undefined, controller.signal).then(setDetail).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message) })
    return () => controller.abort()
  }, [selected])
  const more = async () => { setBusy(true); try { const data = await playerApi<{ items: HistoryItem[]; nextCursor: string | null }>(`/api/player/history?cursor=${encodeURIComponent(cursor || '')}`); setItems(current => [...current, ...data.items]); setCursor(data.nextCursor) } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) } }
  return <main className="player-notebook">
    <header className="notebook-heading"><div><p className="panel-kicker">observer.notebook / PRIVATE</p><h1>我的观察档案</h1></div><div><button onClick={() => setRefresh(value => value + 1)}>刷新档案</button>{resumeLabel && <button onClick={onResume}>{resumeLabel}</button>}</div></header>
    {player.kind === 'guest' && <p className="notebook-guest">游客也可查看当前身份的记录，清除 Cookie 后无法找回。<button onClick={onAccess}>注册或登录保留身份</button></p>}
    {error && <p className="feature-notice" role="alert">{error}</p>}
    {!profile && !error && <p role="status">正在读取档案…</p>}
    {profile && <>
      <section className="notebook-stats" aria-label="个人战绩">{[['有效判断', profile.stats.judged], ['判断正确', profile.stats.correct], ['正确率', profile.stats.accuracy === null ? '—' : `${profile.stats.accuracy}%`], ['当前连续正确', profile.stats.streak]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</section>
      <p className="notebook-explainer">战绩统计最近 {profile.retentionDays} 天。提前结束 / 跳过 {profile.stats.skipped} 局，未判断 {profile.stats.unanswered} 局，管理员介入 {profile.stats.interventions} 局；这些局不计入正确率与成就。成就解锁后保留。</p>
      <section className="badge-grid" aria-label="个人成就">{profile.badges.map(badge => <article key={badge.code} className={badge.unlockedAt ? 'unlocked' : ''}><span>{badge.unlockedAt ? '[UNLOCKED]' : '[LOCKED]'}</span><BadgeSymbol code={badge.code} /><h2>{badge.title}</h2><p>{badge.description}</p>{badge.unlockedAt && <time>{new Date(badge.unlockedAt).toLocaleDateString('zh-CN')}</time>}</article>)}</section>
    </>}
    <section className="notebook-history"><aside><h2>对话回看</h2><p>只显示你参与的已结束对话。</p>{items.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}><strong>{item.opponent_codename}</strong><span>{endLabels[item.end_reason] || '已结束'} · {item.intervention_count ? '管理员介入' : item.correct === null ? '未计入战绩' : item.correct ? '猜对' : '猜错'}</span><small>{new Date(item.created_at).toLocaleString('zh-CN')} · {item.message_count} 条</small></button>)}{!items.length && profile && <p className="notebook-empty">还没有结束的对话，完成一局后再来看看。</p>}{cursor && <button disabled={busy} onClick={() => { void more() }}>{busy ? '读取中…' : '加载更多'}</button>}</aside>
      <article className="notebook-detail">{!selected && <p className="notebook-empty">选择一局，回看你看到的完整消息。</p>}{selected && !detail && <p role="status">正在读取对话…</p>}{detail && <><header><p className="panel-kicker">{detail.match.id.slice(0, 8)} / {detail.match.truth === 'human' ? '真人' : 'AI'} / {endLabels[detail.match.end_reason]}</p><h2>{detail.match.opponent_codename}</h2></header><div className="notebook-messages">{detail.messages.map(message => <article key={message.id}><small>{message.side === 'self' ? 'YOU' : 'PEER'} · {message.source === 'admin' ? '管理员介入' : message.source === 'ai' ? 'AI' : '真人'} · {new Date(message.created_at).toLocaleTimeString('zh-CN')}</small><p>{message.content}</p></article>)}</div><FeedbackEditor key={detail.match.id} matchId={detail.match.id} trainingEligible={detail.match.truth === 'human' && detail.match.end_reason === 'judged' && !detail.match.intervention_count} onReport={() => onReport(detail.match.id)} /></>}</article>
    </section>
  </main>
}
export function RoomActions({ disabled, onLeave, onSkip, onReport }: { disabled: boolean; onLeave: () => void; onSkip: () => void; onReport: () => void }) {
  const [armed, setArmed] = useState<'leave' | 'skip' | null>(null)
  return <div className="room-actions">
    {armed ? <div className="leave-confirmation" role="alert"><span>{armed === 'skip' ? '结束本局并重新匹配？' : '结束当前对话？'} 本局不算猜错，双方都会结束聊天。</span><button disabled={disabled} onClick={armed === 'skip' ? onSkip : onLeave}>{armed === 'skip' ? '确认跳过' : '确认结束'}</button><button onClick={() => setArmed(null)}>继续聊</button></div> : <><button disabled={disabled} onClick={() => setArmed('leave')}>结束对话</button><button disabled={disabled} onClick={() => setArmed('skip')}>跳过 / 换一个</button><button disabled={disabled} onClick={onReport}>举报</button></>}
  </div>
}
const topics = ['最近有没有一件很小但让你开心的事？', '如果明天可以完全休息，你会怎么过？', '你有什么别人不太理解的小习惯？', '最近反复听的一首歌是什么？', '有没有一种食物，你以前讨厌现在却很喜欢？', '你更喜欢计划好的旅行，还是随意走走？', '什么东西你明知道没用，却舍不得扔？', '如果今天能重来一次，你会改哪个小决定？']
export function Icebreakers({ onPick }: { onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false), [offset, setOffset] = useState(0)
  return <div className="icebreaker-tools"><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>破冰话题 {open ? '−' : '+'}</button>{open && <div className="icebreaker-list"><p>只是可选开场，不限制话题与轮数；点击填入草稿，由你决定是否发送。</p>{Array.from({ length: 3 }, (_, index) => topics[(offset + index) % topics.length]).map(topic => <button type="button" key={topic} onClick={() => { onPick(topic); setOpen(false) }}>{topic}</button>)}<button type="button" onClick={() => setOffset(value => (value + 3) % topics.length)}>换一组</button></div>}</div>
}

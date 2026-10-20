import { useEffect, useState, type FormEvent } from 'react'

interface HistoryItem {
  id: string
  kind: 'human' | 'ai'
  status: string
  ai_codename: string | null
  created_at: number
  revealed_at: number | null
  duration_ms: number
  message_count: number
  participant_count: number
  truth: 'human' | 'ai'
  participant_codenames: string | null
  intervention_count: number
}

interface HistoryParticipant {
  session_id: string
  codename: string
  guess: 'human' | 'ai' | null
  correct: number | null
}

interface HistoryMessage {
  id: string
  author_codename: string
  source: 'human' | 'ai' | 'admin'
  content: string
  created_at: number
  target_session_ids: string[]
}

interface HistoryDetail {
  match: HistoryItem
  participants: HistoryParticipant[]
  messages: HistoryMessage[]
  aiEvents: Array<{ status: string; error_code: string | null; latency_ms: number; created_at: number }>
  adminActions: Array<{ id: string; action_type: string; content: string; created_at: number }>
}

function archiveTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp)
}

function archiveDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60000))
  return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

export function AdminHistory({ onNotice }: { onNotice: (message: string | null) => void }) {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [cursor, setCursor] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [kind, setKind] = useState<'all' | 'human' | 'ai'>('all')
  const [retentionDays, setRetentionDays] = useState(30)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<HistoryDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [deleteArmed, setDeleteArmed] = useState(false)

  const loadPage = async (reset: boolean, nextCursor?: number | null) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: '25' })
      if (kind !== 'all') params.set('kind', kind)
      if (submittedQuery) params.set('q', submittedQuery)
      if (!reset && nextCursor) params.set('cursor', String(nextCursor))
      const response = await fetch(`/admin/api/history?${params}`, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('历史档案读取失败')
      const body = await response.json() as { items: HistoryItem[]; nextCursor: number | null; retentionDays: number }
      setItems((current) => reset ? body.items : [...current, ...body.items])
      setCursor(body.nextCursor)
      setRetentionDays(body.retentionDays)
      if (reset) setSelectedId(body.items[0]?.id || null)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : '历史档案读取失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadPage(true) }, [kind, submittedQuery])

  useEffect(() => {
    setDeleteArmed(false)
    if (!selectedId) { setDetail(null); return }
    setDetail(null)
    fetch(`/admin/api/history/${selectedId}`, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error('档案内容读取失败')
        return response.json() as Promise<HistoryDetail>
      })
      .then(setDetail)
      .catch((error) => onNotice(error instanceof Error ? error.message : '档案内容读取失败'))
  }, [onNotice, selectedId])

  const search = (event: FormEvent) => {
    event.preventDefault()
    setSubmittedQuery(query.trim())
  }

  const remove = async () => {
    if (!selectedId) return
    if (!deleteArmed) { setDeleteArmed(true); return }
    const response = await fetch(`/admin/api/history/${selectedId}`, { method: 'DELETE', credentials: 'same-origin' })
    if (!response.ok) { onNotice('删除失败'); return }
    const remaining = items.filter((item) => item.id !== selectedId)
    setItems(remaining)
    setSelectedId(remaining[0]?.id || null)
    setDetail(null)
    setDeleteArmed(false)
    onNotice('历史对话及关联指标已删除')
  }

  return (
    <section className="archive-shell">
      <aside className="archive-index">
        <header><div><small>ARCHIVE / D1</small><h1>历史档案</h1></div><span>保留 {retentionDays} 天</span></header>
        <form className="archive-search" onSubmit={search}>
          <input aria-label="检索历史对话" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="会话编号、代号" />
          <button>检索</button>
        </form>
        <div className="archive-kind-filter">
          {(['all', 'human', 'ai'] as const).map((value) => <button key={value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>{value === 'all' ? '全部' : value === 'human' ? '真人局' : '人机局'}</button>)}
        </div>
        <div className="archive-list">
          {items.map((item) => (
            <button key={item.id} className={selectedId === item.id ? 'selected' : ''} onClick={() => setSelectedId(item.id)}>
              <span>{item.kind === 'ai' ? 'A/I' : 'H/H'}</span>
              <div><strong>{item.ai_codename || item.participant_codenames || '匿名对话'}</strong><small>{archiveTime(item.created_at)} · {item.message_count} 条</small></div>
              {Number(item.intervention_count) > 0 && <em>介入 {item.intervention_count}</em>}
            </button>
          ))}
          {!items.length && !loading && <p className="archive-empty">暂无已归档的对话。对局揭晓后会自动进入这里。</p>}
          {cursor && <button className="archive-more" disabled={loading} onClick={() => loadPage(false, cursor)}>{loading ? '读取中' : '加载更早记录'}</button>}
        </div>
      </aside>

      <article className="archive-detail" role="region" aria-label="历史对话完整档案" tabIndex={0}>
        {!selectedId && <div className="archive-blank"><span>ARCHIVE</span><p>选择一条历史记录查看完整对话。</p></div>}
        {selectedId && !detail && <div className="archive-blank"><span>···</span><p>正在解码档案</p></div>}
        {detail && (
          <>
            <header className="archive-detail-head">
              <div><small>{detail.match.id.toUpperCase()}</small><h2>{detail.match.ai_codename || detail.match.participant_codenames || '匿名对话'}</h2></div>
              <div className="archive-actions">
                <span>{detail.match.kind === 'ai' ? '真人 / AI' : '真人 / 真人'}</span>
                <button className={deleteArmed ? 'armed' : ''} onClick={remove}>{deleteArmed ? '再次点击永久删除' : '删除档案'}</button>
              </div>
            </header>
            <section className="archive-facts">
              <div><small>开始</small><strong>{archiveTime(detail.match.created_at)}</strong></div>
              <div><small>时长</small><strong>{archiveDuration(detail.match.duration_ms)}</strong></div>
              <div><small>消息</small><strong>{detail.match.message_count}</strong></div>
              <div><small>模型请求</small><strong>{detail.aiEvents.length}</strong></div>
            </section>
            <section className="archive-judgments">
              {detail.participants.map((participant) => (
                <div key={participant.session_id}><strong>{participant.codename}</strong><span>判断：{participant.guess === 'human' ? '真人' : participant.guess === 'ai' ? 'AI' : '未选择'}</span><em>{participant.correct == null ? '未判断' : participant.correct ? '猜对' : '猜错'}</em></div>
              ))}
            </section>
            <div className="archive-transcript">
              {detail.messages.map((message, index) => (
                <article key={message.id} className={`source-${message.source}`}>
                  <div><span>{String(index + 1).padStart(3, '0')}</span><strong>{message.author_codename}</strong><em>{message.source === 'admin' ? 'OPERATOR' : message.source.toUpperCase()}</em><time>{archiveTime(message.created_at)}</time></div>
                  <p>{message.content}</p>
                </article>
              ))}
            </div>
          </>
        )}
      </article>
    </section>
  )
}

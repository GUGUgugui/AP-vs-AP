import { useEffect, useState } from 'react'
import { feedbackLabels } from '../PlayerFeatures'
interface Report { id: string; match_id: string; reason: string; description: string; status: string; reporter_codename: string; created_at: number }
interface Sample { match_id: string; status: string; created_at: number; feedback: string | null }
interface Community { reports: Report[]; samples: Sample[]; feedback: Array<{ kind: string; persona: string | null; prompt_version: string; tag: string; count: number }> }
interface Detail { match: { id: string }; messages: Array<{ id: string; author_codename: string; source: string; content: string }> }
const reasons: Record<string, string> = { harassment: '骚扰或辱骂', privacy: '隐私问题', spam: '广告或刷屏', unsafe: '危险内容', other: '其他问题' }
const statuses: Record<string, string> = { pending: '待处理', resolved: '已处理', dismissed: '已驳回', approved: '已通过', rejected: '已拒绝' }
export function AdminCommunity() {
  const [data, setData] = useState<Community | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [revision, setRevision] = useState(0), [selected, setSelected] = useState<string | null>(null), [loadedDetail, setDetail] = useState<Detail | null>(null)
  const detail = loadedDetail?.match.id === selected ? loadedDetail : null
  const [exportCursor, setExportCursor] = useState<string | null>(null), [exportPart, setExportPart] = useState(1)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/admin/api/community', { cache: 'no-store', signal: controller.signal }).then(async response => { if (!response.ok) throw new Error('管理数据读取失败'); return response.json() }).then(setData).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message) })
    return () => controller.abort()
  }, [revision])
  useEffect(() => {
    setDetail(null); if (!selected) return
    const controller = new AbortController()
    void fetch(`/admin/api/history/${selected}`, { signal: controller.signal }).then(async response => { if (!response.ok) throw new Error('对话读取失败或已过保留期'); return response.json() }).then(setDetail).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message) })
    return () => controller.abort()
  }, [selected])
  const review = async (path: string, status: string) => {
    setBusy(true); setError('')
    try { const response = await fetch(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); if (!response.ok) throw new Error((await response.json()).error || '操作失败'); setRevision(value => value + 1) } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
  }
  const exportSamples = async (more = false) => {
    setBusy(true); setError('')
    try { const response = await fetch('/admin/api/training/export' + (more && exportCursor ? `?cursor=${encodeURIComponent(exportCursor)}` : '')); if (!response.ok) throw new Error('导出失败'); const blob = await response.blob(); if (!blob.size) throw new Error('还没有通过审核且授权有效的样本'); const url = URL.createObjectURL(blob), link = document.createElement('a'), part = more ? exportPart + 1 : 1; link.href = url; link.download = `apvsap-training-${part}.jsonl`; link.click(); setExportPart(part); setExportCursor(response.headers.get('X-Next-Cursor') || null); window.setTimeout(() => URL.revokeObjectURL(url), 1000) } catch (cause) { setError((cause as Error).message) } finally { setBusy(false) }
  }
  return <section className="admin-community">
    <header><div><small>COMMUNITY / REVIEW</small><h1>反馈、举报与训练集</h1></div><button disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新</button></header>
    {error && <p className="community-error" role="alert">{error}</p>}{!data && !error && <p role="status">读取中…</p>}
    {data && <div className="community-grid"><div>
      <section className="community-board"><h2>举报处理队列</h2><p>先查看对话，再标记处理结果；不会自动封禁玩家。</p>{!data.reports.length && <p>暂无举报。</p>}{data.reports.map(report => <article key={report.id}><header><strong>{reasons[report.reason]} · {report.reporter_codename}</strong><span>{statuses[report.status]}</span></header><p>{report.description || '未填写补充说明'}</p><small>{new Date(report.created_at).toLocaleString('zh-CN')}</small><div><button onClick={() => setSelected(report.match_id)}>查看举报对话</button><button disabled={busy || report.status !== 'pending' || selected !== report.match_id || !detail} onClick={() => { void review(`/admin/api/reports/${report.id}`, 'resolved') }}>标记已处理</button><button disabled={busy || report.status !== 'pending' || selected !== report.match_id || !detail} onClick={() => { void review(`/admin/api/reports/${report.id}`, 'dismissed') }}>驳回举报</button></div></article>)}</section>
      <section className="community-board"><h2>原句训练数据集</h2><p>训练环境尚未接入。只收录双方单独授权、无介入、无举报的合格真人局；自动筛查不等于可靠脱敏，审核时仍须检查隐私和内容质量。每份文件最多 50 局，每局最多两条 JSONL 训练记录，可继续分批下载；导出不代表模型已经训练。</p><button disabled={busy} onClick={() => { void exportSamples() }}>导出已审核训练集</button>{exportCursor && <button disabled={busy} onClick={() => { void exportSamples(true) }}>继续导出下一份</button>}{!data.samples.length && <p>暂无双方授权的合格样本。</p>}{data.samples.map(sample => <article key={sample.match_id}><header><strong>{sample.match_id.slice(0, 8)}</strong><span>{statuses[sample.status]}</span></header><p>反馈标签：{sample.feedback || '暂无反馈'}</p><div><button onClick={() => setSelected(sample.match_id)}>审核原句</button><button disabled={busy || selected !== sample.match_id || !detail || sample.status === 'approved'} onClick={() => { void review(`/admin/api/training/${sample.match_id}`, 'approved') }}>批准入集</button><button disabled={busy || selected !== sample.match_id || !detail || sample.status === 'rejected'} onClick={() => { void review(`/admin/api/training/${sample.match_id}`, 'rejected') }}>拒绝入集</button></div></article>)}</section>
      <section className="community-board"><h2>赛后反馈汇总</h2><p>按对手类别、人格与提示词版本分组；标签是玩家感受，不是模型质量的客观评分。</p>{!data.feedback.length && <p>暂无反馈。</p>}<div className="community-table"><table><thead><tr><th>对手 / 版本</th><th>感受</th><th>次数</th></tr></thead><tbody>{data.feedback.map((row, index) => <tr key={index}><td>{row.kind === 'human' ? '真人' : row.persona || 'AI'}<small>{row.prompt_version}</small></td><td>{feedbackLabels[row.tag] || row.tag}</td><td>{row.count}</td></tr>)}</tbody></table></div></section>
    </div><aside className="community-review"><h2>审核对话</h2>{!selected && <p>从举报或训练样本中选择一局。</p>}{selected && !detail && <p role="status">读取原句中…</p>}{detail?.messages.map(message => <article key={message.id}><small>{message.author_codename} / {message.source}</small><p>{message.content}</p></article>)}</aside></div>}
  </section>
}

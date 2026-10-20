import { useEffect, useMemo, useState } from 'react'

interface MetricsPayload {
  days: number
  generatedAt: number
  matches: { total: number; ai: number; human: number; avgDurationMs: number; avgMessages: number }
  judgments: { total: number; accuracy: number }
  ai: { requests: number; successes: number; fallbacks: number; successRate: number; fallbackRate: number; avgLatencyMs: number; maxLatencyMs: number }
  daily: Array<{ day: string; matches: number; requests: number; fallbacks: number }>
  errors: Array<{ code: string; count: number }>
  personas: Array<{ persona: string; matches: number; judged: number; detection_accuracy: number | null }>
  styleLearning: { matches: number; messages: number; active: boolean }
  styleExperiment: Array<{ variant: 'learned' | 'baseline'; matches: number; judged: number; detection_accuracy: number | null }>
}

function shortDuration(milliseconds: number): string {
  if (!milliseconds) return '0s'
  const seconds = Math.round(milliseconds / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function AdminObservability() {
  const [days, setDays] = useState(7)
  const [data, setData] = useState<MetricsPayload | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    setError('')
    fetch(`/admin/api/metrics?days=${days}`, { credentials: 'same-origin' })
      .then((response) => {
        if (!response.ok) throw new Error('指标读取失败')
        return response.json() as Promise<MetricsPayload>
      })
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : '指标读取失败'))
  }, [days])

  const dailyMaximum = useMemo(() => Math.max(1, ...(data?.daily.map((item) => Math.max(item.matches, item.requests)) || [1])), [data])
  const baseline = data?.styleExperiment.find((item) => item.variant === 'baseline')
  const learned = data?.styleExperiment.find((item) => item.variant === 'learned')

  if (!data) return <section className="observability-shell"><div className="observability-loading">{error || '正在汇集边缘信号……'}</div></section>

  return (
    <section className="observability-shell">
      <header className="observability-head">
        <div><small>EDGE TELEMETRY / D1</small><h1>运行指标</h1><p>只记录运行状态和匿名统计；完整内容仍只在历史档案中按权限读取。</p></div>
        <div className="period-switch">{[7, 30, 90].map((value) => <button key={value} className={days === value ? 'active' : ''} onClick={() => setDays(value)}>{value} 天</button>)}</div>
      </header>

      <section className="observability-kpis">
        <Kpi index="A1" label="模型成功率" value={`${data.ai.successRate}%`} tone={data.ai.successRate >= 98 ? 'good' : 'alert'} note={`${data.ai.successes}/${data.ai.requests} 次`} />
        <Kpi index="A2" label="兜底率" value={`${data.ai.fallbackRate}%`} tone={data.ai.fallbackRate <= 2 ? 'good' : 'alert'} note={`${data.ai.fallbacks} 次异常`} />
        <Kpi index="A3" label="平均延迟" value={`${data.ai.avgLatencyMs}ms`} note={`峰值 ${data.ai.maxLatencyMs}ms`} />
        <Kpi index="P1" label="判断准确率" value={`${data.judgments.accuracy}%`} note={`${data.judgments.total} 次判断`} />
        <Kpi index="P2" label="平均消息数" value={String(data.matches.avgMessages)} note={`平均 ${shortDuration(data.matches.avgDurationMs)}`} />
        <Kpi index="P3" label="对局总数" value={String(data.matches.total)} note={`AI ${data.matches.ai} / 真人 ${data.matches.human}`} />
      </section>

      <section className="observability-grid">
        <article className="telemetry-chart">
          <header><div><small>DAILY VOLUME</small><h2>每日信号量</h2></div><div className="chart-legend"><span className="requests">模型请求</span><span className="matches">已归档对局</span><span className="fallbacks">兜底</span></div></header>
          <div className="daily-bars">
            {data.daily.map((item) => (
              <div key={item.day} className="daily-column">
                <div className="bar-stack">
                  <i className="requests" style={{ height: `${Math.max(2, item.requests / dailyMaximum * 100)}%` }} title={`模型请求 ${item.requests}`} />
                  <i className="matches" style={{ height: `${Math.max(2, item.matches / dailyMaximum * 100)}%` }} title={`对局 ${item.matches}`} />
                  {item.fallbacks > 0 && <i className="fallbacks" style={{ height: `${Math.max(3, item.fallbacks / dailyMaximum * 100)}%` }} title={`兜底 ${item.fallbacks}`} />}
                </div>
                <span>{item.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="error-ledger">
          <header><small>FAILURE LEDGER</small><h2>异常分布</h2></header>
          {!data.errors.length && <div className="healthy-state"><span>✓</span><strong>当前周期无兜底事件</strong></div>}
          {data.errors.map((item, index) => (
            <div key={item.code}><span>{String(index + 1).padStart(2, '0')}</span><strong>{item.code}</strong><em>{item.count}</em></div>
          ))}
        </article>

        <article className="persona-board">
          <header><small>PERSONA RESISTANCE</small><h2>人格伪装表现</h2><p>“骗过率”表示已判断的玩家把 AI 选成真人的比例；未判断不计入。</p></header>
          {!data.personas.length && <div className="persona-empty">需要完成更多人机对局后才能比较人格。</div>}
          {data.personas.map((persona) => {
            const fooledRate = persona.detection_accuracy == null ? 0 : Math.max(0, 100 - Number(persona.detection_accuracy))
            return (
              <div key={persona.persona} className="persona-row">
                <div><strong>{persona.persona || '未命名人格'}</strong><small>{persona.matches} 局 · {persona.judged} 次有效判断</small></div>
                <div className="persona-meter"><i style={{ width: `${fooledRate}%` }} /></div>
                <em>{persona.detection_accuracy == null ? '—' : `${fooledRate.toFixed(0)}%`}</em>
              </div>
            )
          })}
        </article>

        <article className="quality-notes">
          <header><small>READING GUIDE</small><h2>判断阈值</h2></header>
          <div><span className={data.styleLearning.active ? 'good' : 'bad'} /> <p><strong>真人风格学习：{data.styleLearning.active ? '已启用' : '等待样本'}</strong>近 30 天参与学习的真人局 {data.styleLearning.matches}/12 局、有效消息 {data.styleLearning.messages}/72 条。默认开启，任一方关闭即排除该局；只提取句长、问句和回复间隔，不把原句用于学习。</p></div>
          <div><span className={(baseline?.judged || 0) >= 10 && (learned?.judged || 0) >= 10 ? 'good' : 'bad'} /> <p><strong>学习组 / 对照组</strong>{learned?.matches || 0} / {baseline?.matches || 0} 局。{(baseline?.judged || 0) >= 10 && (learned?.judged || 0) >= 10 ? `AI 识别率：学习组 ${Number(learned?.detection_accuracy || 0).toFixed(0)}%，对照组 ${Number(baseline?.detection_accuracy || 0).toFixed(0)}%。` : '两组各至少 10 次有效判断后再比较效果；目前不能断言改进。'}</p></div>
          <div><span className={data.ai.fallbackRate <= 2 ? 'good' : 'bad'} /> <p><strong>兜底率 ≤ 2%</strong>超过时优先排查密钥、限速和上游状态。</p></div>
          <div><span className={data.ai.avgLatencyMs <= 5000 ? 'good' : 'bad'} /> <p><strong>平均延迟 ≤ 5s</strong>不包含人为输入等待；过高会破坏聊天节奏。</p></div>
          <div><span className={data.judgments.accuracy <= 65 ? 'good' : 'bad'} /> <p><strong>AI 识别率不应过高</strong>需要结合人格骗过率而非只看总体准确率。</p></div>
        </article>
      </section>
    </section>
  )
}

function Kpi({ index, label, value, note, tone }: { index: string; label: string; value: string; note: string; tone?: 'good' | 'alert' }) {
  return <article className={tone || ''}><small>{index}</small><span>{label}</span><strong>{value}</strong><p>{note}</p></article>
}

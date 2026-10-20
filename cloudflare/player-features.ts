import { playerSession, type PlayerSession } from './player-auth'
import { BADGES, FEEDBACK_TAGS, earnedBadges, feedbackTags, summarizeResults, validReport, type ResultRow } from './player-rules'
import { refreshTrainingSample } from './training-dataset'

interface FeatureEnv { DB: D1Database; RETENTION_DAYS: string; PLAYER_AUTH_SECRET?: string }
type EnsureMatch = (playerId: string, matchId: string, report: boolean) => Promise<Response>
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } })
const OWNER = `(p.session_id = ? OR p.session_id IN (SELECT player_id FROM player_seat_owners WHERE account_id = ?)) AND p.session_id=(SELECT MIN(member.session_id) FROM participants member WHERE member.match_id=m.id AND (member.session_id=? OR member.session_id IN (SELECT player_id FROM player_seat_owners WHERE account_id=?)))`
const identityBindings = (session: PlayerSession) => [session.playerId, session.userId || '', session.playerId, session.userId || '']
const SELECT_RESULT = `SELECT m.id, m.truth, m.end_reason, m.created_at, m.revealed_at, m.duration_ms, m.message_count, p.session_id AS viewer_id, p.codename AS self_codename, p.correct, p.human_probability,
  COALESCE(m.ai_codename, (SELECT codename FROM participants peer WHERE peer.match_id=m.id AND peer.session_id!=p.session_id LIMIT 1), '未知信号') AS opponent_codename,
  MAX(m.intervention_count,(SELECT COUNT(*) FROM messages WHERE match_id=m.id AND source='admin')) AS intervention_count
  FROM matches m JOIN participants p ON p.match_id=m.id`
const bounds = (env: FeatureEnv) => ({ days: Math.min(365, Math.max(1, Number(env.RETENTION_DAYS) || 30)), since: Date.now() - Math.min(365, Math.max(1, Number(env.RETENTION_DAYS) || 30)) * 86400000 })
type Owned = ResultRow & { viewer_id: string; self_codename: string; opponent_codename: string; human_probability: number; duration_ms: number; message_count: number }
const toPublic = ({ viewer_id: _viewer, human_probability, ...row }: Owned) => ({ ...row, guess: human_probability === 50 ? null : human_probability > 50 ? 'human' : 'ai' })
async function ownedMatch(env: FeatureEnv, session: PlayerSession, id: string): Promise<Owned | null> {
  return env.DB.prepare(`${SELECT_RESULT} WHERE m.id=? AND m.created_at>=? AND ${OWNER}`).bind(id, bounds(env).since, ...identityBindings(session)).first<Owned>()
}
async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get('Content-Length') || 0) > 4096) return null
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []; let length = 0
  while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4096) { await reader.cancel(); return null } chunks.push(value) }
  const bytes = new Uint8Array(length); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { const body: unknown = JSON.parse(new TextDecoder().decode(bytes)); return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null } catch { return null }
}
async function allResults(env: FeatureEnv, session: PlayerSession): Promise<Owned[]> {
  const result = await env.DB.prepare(`${SELECT_RESULT} WHERE m.created_at>=? AND ${OWNER} ORDER BY m.created_at DESC, m.id DESC`).bind(bounds(env).since, ...identityBindings(session)).all<Owned>()
  // A player may own several old anonymous seats. Never count the same match twice.
  return [...new Map((result.results || []).map(row => [row.id, row])).values()]
}
export async function unlockPlayerBadges(env: FeatureEnv, playerId: string) {
  const owner = await env.DB.prepare('SELECT account_id FROM player_seat_owners WHERE player_id=?').bind(playerId).first<{ account_id: string }>()
  const rows = await allResults(env, { playerId, userId: owner?.account_id || null, tokenHash: '', username: null, expiresAt: 0 })
  const codes = earnedBadges(rows)
  if (codes.length) await env.DB.batch(codes.map(code => env.DB.prepare('INSERT OR IGNORE INTO player_achievements(player_id,code,unlocked_at) VALUES(?,?,?)').bind(playerId, code, Date.now())))
}
export async function playerFeatures(request: Request, env: FeatureEnv, ensure: EnsureMatch): Promise<Response> {
  const session = await playerSession(request, env)
  if (!session) return json({ error: '请先登录或以游客身份进入。' }, 401)
  const url = new URL(request.url), path = url.pathname
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: '请求来源不正确。' }, 403)
  if (path === '/api/player/profile' && request.method === 'GET') {
    await unlockPlayerBadges(env, session.playerId)
    const rows = await allResults(env, session)
    const badges = await env.DB.prepare(`SELECT code,MIN(unlocked_at) AS unlocked_at FROM player_achievements WHERE player_id=? OR player_id IN (SELECT player_id FROM player_seat_owners WHERE account_id=?) GROUP BY code`).bind(session.playerId, session.userId || '').all<{ code: string; unlocked_at: number }>()
    return json({ stats: summarizeResults(rows), retentionDays: bounds(env).days, badges: BADGES.map(badge => ({ ...badge, unlockedAt: badges.results?.find(row => row.code === badge.code)?.unlocked_at || null })) })
  }
  if (path === '/api/player/history' && request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') || '', [created, id] = cursor.split(':')
    if (cursor && (!/^\d+$/.test(created) || !Number.isSafeInteger(Number(created)) || !/^[a-f0-9-]{36}$/.test(id))) return json({ error: '分页参数无效。' }, 400)
    const result = await env.DB.prepare(`${SELECT_RESULT} WHERE m.created_at>=? AND ${OWNER} ${cursor ? 'AND (m.created_at<? OR (m.created_at=? AND m.id<?))' : ''} ORDER BY m.created_at DESC,m.id DESC LIMIT 26`).bind(bounds(env).since, ...identityBindings(session), ...(cursor ? [Number(created), Number(created), id] : [])).all<Owned>()
    const rows = result.results || [], last = rows[24]
    return json({ items: rows.slice(0, 25).map(toPublic), nextCursor: rows.length > 25 ? `${last.created_at}:${last.id}` : null, retentionDays: bounds(env).days })
  }
  const detail = path.match(/^\/api\/player\/history\/([a-f0-9-]{36})$/)
  if (detail && request.method === 'GET') {
    let match = await ownedMatch(env, session, detail[1])
    if (!match) { await ensure(session.playerId, detail[1], false); match = await ownedMatch(env, session, detail[1]) }
    if (!match) return json({ error: '记录不存在、尚未结束或不属于你。' }, 404)
    const messages = await env.DB.prepare(`SELECT id,author_id,content,source,created_at FROM messages WHERE match_id=? AND EXISTS(SELECT 1 FROM json_each(messages.target_session_ids) WHERE value=?) ORDER BY message_index,created_at,id`).bind(match.id, match.viewer_id).all<{ id: string; author_id: string; content: string; source: string; created_at: number }>()
    const feedback = await env.DB.prepare('SELECT tags FROM match_feedback WHERE match_id=? AND player_id=?').bind(match.id, match.viewer_id).first<{ tags: string }>()
    const consent = await env.DB.prepare('SELECT consent FROM training_consents WHERE match_id=? AND player_id=?').bind(match.id, match.viewer_id).first<{ consent: number }>()
    return json({ match: toPublic(match), messages: (messages.results || []).map(({ author_id, ...message }) => ({ ...message, side: author_id === match!.viewer_id ? 'self' : 'opponent' })), feedback: feedback ? JSON.parse(feedback.tags) : [], trainingConsent: Boolean(consent?.consent) })
  }
  if (['/api/player/feedback', '/api/player/report', '/api/player/training-consent'].includes(path) && request.method === 'POST') {
    const body = await readBody(request)
    if (!body || typeof body.matchId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.matchId)) return json({ error: '提交内容无效。' }, 400)
    const consent = path.endsWith('/training-consent'), report = path.endsWith('/report'), tags = report || consent ? null : feedbackTags(body.tags), issue = report ? validReport(body) : null
    if (consent ? typeof body.consent !== 'boolean' : report ? !issue : !tags) return json({ error: report ? '请选择举报原因，说明最多 400 字。' : '请选择有效反馈；“很自然”不能与问题标签同时选。' }, 400)
    // Limit authenticated writes, not just IPs; keep prior submissions intact.
    const key = `player-feature:${session.playerId}:${Math.floor(Date.now() / 900000)}`
    const limit = await env.DB.prepare(`INSERT INTO player_auth_limits(key,attempts,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 RETURNING attempts`).bind(key, Date.now() + 900000).first<{ attempts: number }>()
    if (Number(limit?.attempts) > 30) return json({ error: '提交过于频繁，请稍后再试。' }, 429)
    let match = await ownedMatch(env, session, body.matchId)
    if (!match) { const ready = await ensure(session.playerId, body.matchId, report); if (!ready.ok && ready.status !== 404) return json({ error: '对局尚未结束或暂时无法归档，请稍后重试。' }, ready.status); match = await ownedMatch(env, session, body.matchId) }
    if (!match) return json({ error: '对局不存在或不属于你。' }, 404)
    if (consent) {
      if (body.consent && (match.truth !== 'human' || match.end_reason !== 'judged' || Number(match.intervention_count))) return json({ error: '只接受正常结束、无管理员介入的真人局。' }, 409)
      await env.DB.batch([
        env.DB.prepare(`INSERT INTO training_consents(match_id,player_id,consent,updated_at) VALUES(?,?,?,?) ON CONFLICT(match_id,player_id) DO UPDATE SET consent=excluded.consent,updated_at=excluded.updated_at,consent_version=1`).bind(match.id, match.viewer_id, body.consent ? 1 : 0, Date.now()),
        ...(!body.consent ? [env.DB.prepare('DELETE FROM training_samples WHERE match_id=?').bind(match.id)] : []),
      ])
      if (body.consent) await refreshTrainingSample(env.DB, match.id)
      return json({ consent: body.consent })
    }
    if (report) {
      const result = await env.DB.prepare(`INSERT OR IGNORE INTO player_reports(id,match_id,reporter_id,reason,description,created_at) VALUES(?,?,?,?,?,?) RETURNING id`).bind(crypto.randomUUID(), match.id, match.viewer_id, issue!.reason, issue!.description, Date.now()).first()
      await env.DB.prepare('DELETE FROM training_samples WHERE match_id=?').bind(match.id).run()
      return json({ submitted: true, duplicate: !result })
    }
    await env.DB.prepare(`INSERT INTO match_feedback(match_id,player_id,tags,created_at) VALUES(?,?,?,?) ON CONFLICT(match_id,player_id) DO UPDATE SET tags=excluded.tags,created_at=excluded.created_at`).bind(match.id, match.viewer_id, JSON.stringify(tags), Date.now()).run()
    return json({ saved: true, tags })
  }
  return json({ error: '接口或请求方法无效。' }, 405)
}
export async function communityFeatures(request: Request, env: FeatureEnv): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/admin/api/community' && request.method === 'GET') {
    const [reports, aggregate, samples] = await Promise.all([
      env.DB.prepare(`SELECT r.*,p.codename AS reporter_codename,m.end_reason,m.truth FROM player_reports r JOIN matches m ON m.id=r.match_id LEFT JOIN participants p ON p.match_id=r.match_id AND p.session_id=r.reporter_id ORDER BY CASE WHEN r.status='pending' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 100`).all(),
      env.DB.prepare(`SELECT m.kind,m.ai_codename AS persona,COALESCE((SELECT e.prompt_version FROM ai_events e WHERE e.match_id=m.id ORDER BY e.created_at DESC LIMIT 1),'no-model-event') AS prompt_version,j.value AS tag,COUNT(*) AS count FROM match_feedback f JOIN matches m ON m.id=f.match_id JOIN json_each(f.tags) j GROUP BY m.kind,m.ai_codename,prompt_version,j.value ORDER BY count DESC`).all(),
      env.DB.prepare(`SELECT s.match_id,s.status,s.created_at,(SELECT GROUP_CONCAT(tags) FROM match_feedback f WHERE f.match_id=s.match_id) AS feedback FROM training_samples s ORDER BY CASE WHEN s.status='pending' THEN 0 ELSE 1 END,s.created_at DESC LIMIT 100`).all(),
    ])
    return json({ reports: reports.results || [], feedback: aggregate.results || [], samples: samples.results || [], tags: FEEDBACK_TAGS, trainingStatus: 'awaiting-training-environment' })
  }
  if (path === '/admin/api/training/export' && request.method === 'GET') {
    const cursor = new URL(request.url).searchParams.get('cursor') || '', [time, id] = cursor.split(':')
    if (cursor && (!/^\d+$/.test(time) || !Number.isSafeInteger(Number(time)) || !/^[a-f0-9-]{36}$/.test(id))) return json({ error: '分页参数无效。' }, 400)
    const samples = await env.DB.prepare(`SELECT match_id,created_at,examples_json FROM training_samples s WHERE status='approved' AND (SELECT COUNT(*) FROM training_consents c WHERE c.match_id=s.match_id AND consent=1 AND consent_version=1)=2 AND NOT EXISTS(SELECT 1 FROM player_reports WHERE match_id=s.match_id) ${cursor ? 'AND (created_at<? OR (created_at=? AND match_id<?))' : ''} ORDER BY created_at DESC,match_id DESC LIMIT 51`).bind(...(cursor ? [Number(time), Number(time), id] : [])).all<{ match_id: string; created_at: number; examples_json: string }>()
    const rows = samples.results || [], lines = rows.slice(0,50).flatMap(row => JSON.parse(row.examples_json).map((example: unknown) => JSON.stringify(example))), last = rows[49]
    return new Response(lines.join('\n') + (lines.length ? '\n' : ''), { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Content-Disposition': 'attachment; filename="apvsap-training.jsonl"', 'Cache-Control': 'no-store', 'X-Next-Cursor': rows.length > 50 ? `${last.created_at}:${last.match_id}` : '' } })
  }
  const sampleId = path.match(/^\/admin\/api\/training\/([a-f0-9-]{36})$/)
  if (sampleId && request.method === 'PATCH') {
    const body = await readBody(request)
    if (!body || typeof body.status !== 'string' || !['approved', 'rejected'].includes(body.status)) return json({ error: '审核状态无效。' }, 400)
    const sample = await env.DB.prepare(`UPDATE training_samples SET status=?,reviewed_at=? WHERE match_id=? RETURNING match_id`).bind(body.status, Date.now(), sampleId[1]).first()
    if (!sample) return json({ error: '样本不存在或授权已撤回。' }, 404)
    await env.DB.prepare('INSERT INTO admin_actions(id,match_id,target_session_id,action_type,content,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), sampleId[1], 'dataset', 'review_training', String(body.status), Date.now()).run()
    return json({ reviewed: true })
  }
  const reportId = path.match(/^\/admin\/api\/reports\/([a-f0-9-]{36})$/)
  if (reportId && request.method === 'PATCH') {
    const body = await readBody(request)
    if (!body || typeof body.status !== 'string' || !['resolved', 'dismissed'].includes(body.status)) return json({ error: '处理状态无效。' }, 400)
    const result = await env.DB.prepare('UPDATE player_reports SET status=?,reviewed_at=? WHERE id=? RETURNING match_id,reporter_id').bind(body.status, Date.now(), reportId[1]).first<{ match_id: string; reporter_id: string }>()
    if (!result) return json({ error: '举报不存在。' }, 404)
    await env.DB.prepare('INSERT INTO admin_actions(id,match_id,target_session_id,action_type,content,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), result.match_id, result.reporter_id, 'review_report', String(body.status), Date.now()).run()
    return json({ reviewed: true })
  }
  return json({ error: '接口或请求方法无效。' }, 405)
}

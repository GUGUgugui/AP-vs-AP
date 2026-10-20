import { useId } from 'react'

/** The same two signal forms: a visual metaphor, never opponent identity data. */
export function SignalMark() {
  return <svg className="signal-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M3 6h7v20H3M29 6h-7v20h7M14 10h4v12h-4" /></svg>
}

export function SignalArtwork({ compact = false }: { compact?: boolean }) {
  const id = useId().replace(/:/g, '')
  const heights = [38, 56, 82, 64, 100, 122, 104, 136, 92, 118, 68, 86, 42]
  return <figure className={`signal-artwork ${compact ? 'compact-artwork' : ''}`}>
    <div className="art-caption"><span>ORIGIN / UNKNOWN</span><span>双盲对话 · 概念示意</span></div>
    <svg viewBox="0 0 640 282" aria-hidden="true" focusable="false">
      <defs><clipPath id={id}><rect x="24" y="10" width="592" height="248" /></clipPath></defs>
      <g className="art-registration"><path d="M24 34V10h24M592 10h24v24M24 234v24h24M592 258h24v-24" /><path d="M320 10v10M320 248v10" /></g>
      <g clipPath={`url(#${id})`}>
        <g className="art-signal">{heights.map((height, index) => <rect key={index} x={55 + index * 12} y={139 - height / 2} width="5" height={height} />)}</g>
        <g className="art-signal art-signal-peer">{heights.map((height, index) => <rect key={index} x={436 + index * 12} y={139 - height / 2} width="5" height={height} />)}</g>
        <path className="art-channel" d="M228 139h45M365 139h48" />
        <rect className="art-unknown-frame" x="273" y="70" width="94" height="138" />
        <text className="art-question" x="320" y="183" textAnchor="middle">?</text>
        <path className="art-cut" d="M0 139h640" />
      </g>
      <g className="art-label"><text x="55" y="238">YOU</text><text x="437" y="238">PEER</text><text x="320" y="47" textAnchor="middle">IDENTITY HIDDEN</text></g>
    </svg>
    <figcaption><span>相同的界面。<br />未知的来处。</span><strong>HUMAN<span> / </span>AI</strong></figcaption>
  </figure>
}

export function FieldFooter() {
  return <footer className="field-footer"><span><SignalMark /> AP/AP · 人机迷雾</span><span>先对话，再判断。</span><a href="/admin">管理员入口 <span aria-hidden="true">↗</span></a></footer>
}

export function BadgeSymbol({ code }: { code: string }) {
  return <svg className="badge-symbol" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    {code === 'first_judgment' ? <><path d="M8 10h8M8 10v28h8M40 10h-8M40 10v28h-8" /><circle cx="24" cy="24" r="7" /></> : code === 'first_ai' ? <><rect x="14" y="14" width="20" height="20" /><path d="M20 7v7M28 7v7M20 34v7M28 34v7M7 20h7M7 28h7M34 20h7M34 28h7M21 21h6v6h-6Z" /></> : code === 'ten_judgments' ? <>{[0,1].map(row => <g key={row} transform={`translate(0 ${row*19})`}><path d="M12 8v12M20 8v12M28 8v12M36 8v12M8 18l32-9" /></g>)}</> : <><path d="M7 32l9-16 8 16 8-16 9 16" /><circle cx="7" cy="32" r="2" /><circle cx="16" cy="16" r="2" /><circle cx="24" cy="32" r="2" /><circle cx="32" cy="16" r="2" /><circle cx="41" cy="32" r="2" /></>}
  </svg>
}

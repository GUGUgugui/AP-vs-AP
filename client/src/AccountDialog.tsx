import { useEffect, useRef } from 'react'
import AccessScreen from './AccessScreen'

export default function AccountDialog({ mode, busy, error, onClose, onClearError, onAuthenticate }: {
  mode: 'login' | 'register'
  busy: boolean
  error: string | null
  onClose: () => void
  onClearError: () => void
  onAuthenticate: (mode: 'login' | 'register' | 'guest', credentials?: { username: string; password: string }) => Promise<boolean>
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = dialogRef.current
    dialog?.showModal()
    return () => { dialog?.close() }
  }, [])
  return <dialog ref={dialogRef} className="account-dialog" aria-labelledby="account-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <header className="account-dialog-header"><div><p className="panel-kicker">identity.upgrade</p><h2 id="account-dialog-title">注册或登录</h2></div><button disabled={busy} onClick={onClose} aria-label="关闭注册登录">×</button></header>
    <AccessScreen key={mode} initialMode={mode} compact busy={busy} error={error} onClearError={onClearError} onAuthenticate={onAuthenticate} />
    <button className="dialog-cancel" onClick={onClose} disabled={busy}>取消，继续游玩</button>
  </dialog>
}

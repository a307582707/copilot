import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

type WechatQrCardProps = {
  qrUrl?: string
  hint: string
  statusLabel: string
  expiresAt?: number
  onRefresh: () => void
  onOpenWindow?: () => void
  onFocusWindow?: () => void
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', 'true')
  el.style.position = 'absolute'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  document.body.removeChild(el)
}

export function WechatQrCard(props: WechatQrCardProps) {
  const [copyHint, setCopyHint] = useState('')
  const [qrImageUrl, setQrImageUrl] = useState('')
  const [qrErr, setQrErr] = useState('')
  const hasQrUrl = Boolean((props.qrUrl || '').trim())
  const showQrFailure = !hasQrUrl && /失败|未开启|过期|异常/i.test(`${props.statusLabel} ${props.hint}`)

  useEffect(() => {
    let cancelled = false
    const url = (props.qrUrl || '').trim()
    if (!url) {
      setQrImageUrl('')
      setQrErr('')
      return
    }
    setQrImageUrl('')
    setQrErr('')
    void QRCode.toDataURL(url, {
      width: 220,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111827', light: '#ffffff' },
    })
      .then((dataUrl: string) => {
        if (!cancelled) setQrImageUrl(dataUrl)
      })
      .catch(() => {
        if (!cancelled) setQrErr('二维码生成失败，请尝试重新生成或在新窗口打开。')
      })
    return () => {
      cancelled = true
    }
  }, [props.qrUrl])

  async function onCopyLink() {
    if (!props.qrUrl) return
    try {
      await copyText(props.qrUrl)
      setCopyHint('扫码链接已复制')
      window.setTimeout(() => setCopyHint(''), 1800)
    } catch {
      setCopyHint('复制失败，请手动打开')
      window.setTimeout(() => setCopyHint(''), 1800)
    }
  }

  return (
    <div
      style={{
        borderRadius: 14,
        border: '1px solid rgba(255,255,255,0.10)',
        background: 'rgba(255,255,255,0.03)',
        padding: 16,
        display: 'grid',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, lineHeight: 1.7, opacity: 0.86 }}>{props.hint}</div>

      <div
        style={{
          display: 'grid',
          justifyContent: 'center',
          gap: 10,
          padding: '8px 0 4px',
        }}
      >
        <div
          style={{
            width: 220,
            height: 220,
            borderRadius: 16,
            border: '1px solid rgba(255,255,255,0.10)',
            background: '#fff',
            overflow: 'hidden',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 10px 30px rgba(0,0,0,0.24)',
          }}
        >
          {qrImageUrl ? (
            <img src={qrImageUrl} alt="微信扫码二维码" width={220} height={220} style={{ display: 'block', width: '100%', height: '100%' }} />
          ) : showQrFailure ? (
            <div
              style={{
                padding: 18,
                textAlign: 'center',
                display: 'grid',
                gap: 10,
                color: '#334155',
              }}
            >
              <div style={{ fontSize: 32, lineHeight: 1 }}>!</div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>暂时无法生成二维码</div>
              <div style={{ fontSize: 12, lineHeight: 1.7, color: '#64748b' }}>{props.hint}</div>
            </div>
          ) : qrErr ? (
            <div style={{ padding: 18, fontSize: 12, lineHeight: 1.7, color: '#b91c1c', textAlign: 'center' }}>{qrErr}</div>
          ) : (
            <div style={{ fontSize: 12, color: 'rgba(17,17,17,0.65)' }}>二维码生成中...</div>
          )}
        </div>
        <div style={{ textAlign: 'center', fontSize: 12, opacity: 0.72 }}>{hasQrUrl ? '微信扫一扫' : '微信登录状态'}</div>
      </div>

      <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.7 }}>当前状态：{props.statusLabel}</div>
      {props.expiresAt ? <div style={{ fontSize: 12, opacity: 0.55 }}>过期时间：{new Date(props.expiresAt).toLocaleString()}</div> : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button type="button" style={ghostBtnStyle} onClick={props.onRefresh}>
          重新生成
        </button>
        <button type="button" style={ghostBtnStyle} onClick={props.onOpenWindow} disabled={!props.qrUrl}>
          在新窗口打开
        </button>
        <button type="button" style={ghostBtnStyle} onClick={() => void onCopyLink()} disabled={!props.qrUrl}>
          复制链接
        </button>
        <button type="button" style={ghostBtnStyle} onClick={props.onFocusWindow} disabled={!props.qrUrl}>
          聚焦扫码窗口
        </button>
      </div>

      {copyHint ? <div style={{ fontSize: 12, opacity: 0.7 }}>{copyHint}</div> : null}
    </div>
  )
}

const ghostBtnStyle: React.CSSProperties = {
  height: 40,
  borderRadius: 12,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.04)',
  cursor: 'pointer',
  fontWeight: 700,
  color: 'rgba(255,255,255,0.92)',
  padding: '0 14px',
}

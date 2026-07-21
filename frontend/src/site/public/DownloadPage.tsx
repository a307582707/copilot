import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PublicLayout } from './layout'

type ReleaseAsset = {
  platform: 'windows' | 'mac'
  kind: 'installer' | 'portable'
  version: string
  fileName: string
  url: string
  sha256?: string
  sizeBytes?: number
  publishedAt?: string
}

type ReleaseResp = {
  ok: boolean
  assets: ReleaseAsset[]
  note?: string
}

export function DownloadPage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [data, setData] = useState<ReleaseResp | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        setLoading(true)
        setErr(null)
        const r = await fetch('/api/public/releases', { headers: { Accept: 'application/json' } })
        const j = (await r.json()) as ReleaseResp
        if (!alive) return
        setData(j)
      } catch (e) {
        if (!alive) return
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const windows = useMemo(() => {
    const assets = data?.assets ?? []
    return assets.filter((a) => a.platform === 'windows').slice().reverse()
  }, [data])

  const recommended = useMemo(() => {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
    const isWin = /Windows/i.test(ua)
    const arch = /WOW64|Win64|x64|amd64/i.test(ua) ? 'x64' : 'x86'
    const installer = windows.find((a) => a.kind === 'installer') || windows[0]
    const portable = windows.find((a) => a.kind === 'portable')
    return { isWin, arch, installer, portable }
  }, [windows])

  async function copySha(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // ignore
    }
  }

  return (
    <PublicLayout>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 18px 60px' }}>
        <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: -0.6, color: '#0f172a' }}>下载 CodeSprite AI 客户端</div>
        <div style={{ marginTop: 10, fontSize: 16, lineHeight: 1.75, color: '#64748b' }}>
          当前提供 Windows 客户端，后续补充 macOS 版本。登录同一账号即可在 Web 与客户端之间切换使用。
        </div>

        <div style={{ marginTop: 18 }} className="dlMain">
          {loading ? (
            <Box>正在加载版本列表…</Box>
          ) : err ? (
            <Box>
              版本列表加载失败：{err}（后端尚未部署时属于正常现象）
              <div style={{ marginTop: 8, opacity: 0.8 }}>
                你也可以先看 <Link to="/docs/publish">发布说明</Link>（如何生成版本清单）。
              </div>
            </Box>
          ) : windows.length === 0 ? (
            <Box>
              暂无可用 Windows 版本（请先发布构建产物）。
              <div style={{ marginTop: 8, opacity: 0.8 }}>
                参考：<Link to="/docs/publish">发布说明</Link>
              </div>
            </Box>
          ) : (
            <div className="dlMainGrid">
              <div className="dlLeft">
                <div style={{ fontWeight: 900, marginBottom: 10 }}>
                  检测到您是：{recommended.isWin ? 'Windows' : '非 Windows'} {recommended.arch}
                </div>

                <div className="dlPrimaryBox">
                  <div style={{ fontWeight: 900, fontSize: 16 }}>📥 立即下载（安装版）</div>
                  <div style={{ marginTop: 6, opacity: 0.8, fontSize: 13 }}>
                    {recommended.installer ? `v${recommended.installer.version}` : '暂无版本'}
                    {recommended.installer?.sizeBytes ? ` · ${formatBytes(recommended.installer.sizeBytes)}` : ''}
                  </div>
                  <a className="dlPrimaryBtn" href={recommended.installer?.url || '#'} aria-disabled={!recommended.installer}>
                    下载 CodeSprite AI Windows 安装版
                  </a>

                  {recommended.portable ? (
                    <div style={{ marginTop: 10, fontSize: 13, opacity: 0.82 }}>
                      备用链接：<a href={recommended.portable.url}>下载便携版（.zip）</a>
                    </div>
                  ) : null}

                  {recommended.installer?.sha256 ? (
                    <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85, lineHeight: 1.7 }}>
                      SHA256：
                      <button type="button" className="dlCopyBtn" onClick={() => copySha(recommended.installer!.sha256!)}>
                        {copied ? '已复制' : '点击复制'}
                      </button>
                      <code style={{ marginLeft: 8, opacity: 0.92 }}>{recommended.installer.sha256}</code>
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="dlRight">
                <div className="dlShot">
                  <div style={{ opacity: 0.75, fontSize: 12, padding: 12 }}>（客户端界面截图占位：CodeSprite 深色 AI 工作台）</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="dlSection">
          <div className="dlSectionTitle">安装指引</div>
          <ol className="dlList">
            <li>下载安装包</li>
            <li>运行 Setup.exe</li>
            <li>登录账号即可同步（Web / Client 同一账号）</li>
          </ol>
        </div>

        <div className="dlSection">
          <div className="dlSectionTitle">历史版本 / 更新日志</div>
          {loading || err || windows.length === 0 ? (
            <div style={{ opacity: 0.75 }}>暂无版本列表（需要后端 /api/public/releases 输出 releases 清单）。</div>
          ) : (
            <div className="dlHistory">
              {windows.slice(0, 6).map((a, idx) => (
                <div key={a.url} className="dlHistoryItem">
                  <div style={{ fontWeight: 900 }}>
                    v{a.version} {idx === 0 ? '（最新）' : ''}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 13, opacity: 0.78 }}>
                    {a.publishedAt ? `发布时间：${a.publishedAt} · ` : ''}
                    {a.kind === 'installer' ? '安装版' : '绿色版'} · {a.fileName}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <a href={a.url}>下载 v{a.version}</a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dlSection">
          <div className="dlSectionTitle">系统要求</div>
          <ul className="dlList">
            <li>OS：Windows 10/11（64 位）</li>
            <li>内存：8GB+</li>
            <li>硬盘：500MB+</li>
          </ul>
        </div>
      </div>
    </PublicLayout>
  )
}

function Box(props: { children: React.ReactNode }) {
  return (
    <div
      style={{
        border: '1px solid #e2e8f0',
        borderRadius: 14,
        padding: 18,
        background: '#f8fafc',
        lineHeight: 1.75,
        color: '#475569',
        fontSize: 14,
      }}
    >
      {props.children}
    </div>
  )
}

function formatBytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}




import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '../../../ui/Button'
import { Card } from '../../../ui/Card'
import { AssetSummaryDashboard, type AssetSummary } from '../components/AssetSummaryDashboard'
import { AssetCliAccountModal, type CliAccountOption, type CloudAccountOption } from '../components/AssetCliAccountModal'
import { AssetSyncScheduleModal, type SyncScheduleRow } from '../components/AssetSyncScheduleModal'

type ByTypeRow = { key: string; componentKey?: string; label?: string; count: number }
type SummaryResp = AssetSummary & { ok?: boolean; detail?: string }
type SyncOptionsResp = { ok: boolean; cloudAccounts?: CloudAccountOption[]; cliAccounts?: CliAccountOption[] }
type SyncRunRow = {
  id: string
  cloud_account_key: string
  cli_account_id: string
  region: string
  trigger_mode: string
  status: string
  started_at?: number | null
  finished_at?: number | null
  summary?: string | null
  error?: string | null
  created_at?: number | null
}
type SyncRunResp = { ok?: boolean; queued?: boolean; message?: string; detail?: string; runId?: string; run?: SyncRunRow }
type SyncRunsResp = { ok?: boolean; items?: SyncRunRow[]; run?: SyncRunRow }
type SyncSchedulesResp = { ok?: boolean; items?: SyncScheduleRow[] }

const REGION_LABELS: Record<string, string> = {
  'cn-hangzhou': '华东1 (杭州)',
  'cn-shanghai': '华东2 (上海)',
  'cn-nanjing': '华东5 (南京)',
  'cn-fuzhou': '华东6 (福州)',
  'cn-qingdao': '华北1 (青岛)',
  'cn-beijing': '华北2 (北京)',
  'cn-zhangjiakou': '华北3 (张家口)',
  'cn-huhehaote': '华北5 (呼和浩特)',
  'cn-wulanchabu': '华北6 (乌兰察布)',
  'cn-shenzhen': '华南1 (深圳)',
  'cn-heyuan': '华南2 (河源)',
  'cn-guangzhou': '华南3 (广州)',
  'cn-chengdu': '西南1 (成都)',
  'cn-hongkong': '中国香港',
  'us-west-1': '美国 (硅谷)',
  'us-east-1': '美国 (弗吉尼亚)',
  'ap-southeast-1': '新加坡',
  'ap-southeast-2': '澳大利亚 (悉尼)',
  'ap-southeast-3': '马来西亚 (吉隆坡)',
  'ap-southeast-5': '印度尼西亚 (雅加达)',
  'ap-southeast-6': '菲律宾 (马尼拉)',
  'ap-southeast-7': '泰国 (曼谷)',
  'ap-northeast-1': '日本 (东京)',
  'ap-northeast-2': '韩国 (首尔)',
  'ap-south-1': '印度 (孟买)',
  'eu-central-1': '德国 (法兰克福)',
  'eu-west-1': '英国 (伦敦)',
  'me-east-1': '阿联酋 (迪拜)',
  'me-central-1': '沙特 (利雅得)',
  'global': '全局',
}

function regionLabel(key: string): string {
  return REGION_LABELS[key] || key
}

function fmtTs(ts?: number | null): string {
  if (!ts) return '-'
  try {
    return new Date(ts * 1000).toLocaleString('zh-CN')
  } catch {
    return String(ts)
  }
}

function countByKey(byType: ByTypeRow[], resourceType: string): number {
  return byType.find((r) => r.key === resourceType)?.count ?? 0
}

function deriveBigData(byType: ByTypeRow[]) {
  return {
    starrocks: {
      clusters: countByKey(byType, 'StarRocks_Cluster'),
      warehouses: countByKey(byType, 'StarRocks_Warehouse'),
      be: countByKey(byType, 'StarRocks_BE_Node'),
      fe: countByKey(byType, 'StarRocks_FE_Node'),
    },
    flink: {
      workspaces: countByKey(byType, 'Flink_Workspace'),
      namespaces: countByKey(byType, 'Flink_Namespace'),
      deployments: countByKey(byType, 'Flink_Deployment'),
    },
    dataworks: {
      projects: countByKey(byType, 'DataWorks_Project'),
      resourceGroups: countByKey(byType, 'DataWorks_ResourceGroup'),
    },
  }
}

const selectStyle: React.CSSProperties = {
  height: 36,
  minWidth: 180,
  borderRadius: 10,
  border: '1px solid #e2e8f0',
  background: '#ffffff',
  padding: '0 12px',
  outline: 'none',
  color: '#0f172a',
  fontSize: 13,
}

const optionStyle: React.CSSProperties = {
  background: '#ffffff',
  color: '#0f172a',
}

const thCenter: React.CSSProperties = {
  textAlign: 'center',
  padding: '10px 14px',
  borderBottom: '1px solid #e2e8f0',
  color: '#64748b',
  fontWeight: 800,
  fontSize: 12,
}
const tdCenter: React.CSSProperties = {
  textAlign: 'center',
  padding: '10px 14px',
  borderBottom: '1px solid #f1f5f9',
  fontSize: 15,
  fontWeight: 800,
}

const thLeft: React.CSSProperties = { ...thCenter, textAlign: 'left' }
const thRight: React.CSSProperties = { ...thCenter, textAlign: 'right' }
const tdLeft: React.CSSProperties = { ...tdCenter, textAlign: 'left', fontSize: 13, fontWeight: 400 }
const tdRight: React.CSSProperties = { ...tdCenter, textAlign: 'right' }

export function AssetOverviewPage() {
  const [summary, setSummary] = useState<AssetSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [optionsLoading, setOptionsLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [cliModalOpen, setCliModalOpen] = useState(false)
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false)
  const [account, setAccount] = useState('')
  const [cliAccountId, setCliAccountId] = useState('')
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccountOption[]>([])
  const [cliAccounts, setCliAccounts] = useState<CliAccountOption[]>([])
  const [runs, setRuns] = useState<SyncRunRow[]>([])
  const [runLoading, setRunLoading] = useState(false)
  const [schedules, setSchedules] = useState<SyncScheduleRow[]>([])
  const [scheduleLoading, setScheduleLoading] = useState(false)
  const [currentRunId, setCurrentRunId] = useState('')
  const [region, setRegion] = useState('')

  function fetchSummary(regionParam: string, accountParam: string) {
    setLoading(true)
    const params = new URLSearchParams()
    if (regionParam) params.set('region', regionParam)
    if (accountParam) params.set('account', accountParam)
    const qs = params.toString() ? `?${params.toString()}` : ''
    fetch(`/api/aiops/assets/summary${qs}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: SummaryResp) => {
        setSummary(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }

  function fetchOptions(accountParam: string) {
    setOptionsLoading(true)
    const qs = accountParam ? `?account=${encodeURIComponent(accountParam)}` : ''
    fetch(`/api/aiops/sync/options${qs}`, { credentials: 'include' })
      .then((r) => r.json())
      .then((data: SyncOptionsResp) => {
        const nextCloudAccounts = Array.isArray(data.cloudAccounts) ? data.cloudAccounts : []
        const nextCliAccounts = Array.isArray(data.cliAccounts) ? data.cliAccounts : []
        setCloudAccounts(nextCloudAccounts)
        setCliAccounts(nextCliAccounts)
        if (!accountParam && nextCloudAccounts.length > 0) {
          setAccount(nextCloudAccounts[0].key)
        }
        if (cliAccountId && !nextCliAccounts.some((item) => item.id === cliAccountId)) {
          setCliAccountId('')
        }
        setOptionsLoading(false)
      })
      .catch(() => {
        setCloudAccounts([])
        setCliAccounts([])
        setOptionsLoading(false)
      })
  }

  function fetchRuns(accountParam: string) {
    setRunLoading(true)
    const qs = accountParam ? `?account=${encodeURIComponent(accountParam)}` : ''
    fetch(`/api/aiops/sync/runs${qs}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: SyncRunsResp) => {
        setRuns(Array.isArray(data.items) ? data.items : [])
        setRunLoading(false)
      })
      .catch(() => {
        setRuns([])
        setRunLoading(false)
      })
  }

  function fetchSchedules() {
    setScheduleLoading(true)
    fetch('/api/aiops/sync/schedules', { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: SyncSchedulesResp) => {
        setSchedules(Array.isArray(data.items) ? data.items : [])
        setScheduleLoading(false)
      })
      .catch(() => {
        setSchedules([])
        setScheduleLoading(false)
      })
  }

  function fetchRunDetail(runId: string) {
    fetch(`/api/aiops/sync/runs/${encodeURIComponent(runId)}`, { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((data: SyncRunsResp) => {
        const run = data.run
        if (!run) return
        setRuns((prev) => {
          const rest = prev.filter((item) => item.id !== run.id)
          return [run, ...rest]
        })
        if (run.status === 'success' || run.status === 'failed') {
          setCurrentRunId('')
          fetchSummary(region, account)
          fetchRuns(account)
        }
      })
      .catch(() => null)
  }

  useEffect(() => {
    fetchSummary(region, account)
  }, [region, account])

  useEffect(() => {
    fetchOptions(account)
    fetchRuns(account)
    fetchSchedules()
  }, [account])

  useEffect(() => {
    if (!currentRunId) return
    const timer = window.setInterval(() => {
      fetchRunDetail(currentRunId)
    }, 5000)
    fetchRunDetail(currentRunId)
    return () => window.clearInterval(timer)
  }, [currentRunId, account, region])

  const regions = summary?.byRegion ?? []
  const byType = summary?.byType ?? []
  const byEnv = summary?.byEnv ?? []
  const bd = useMemo(() => deriveBigData(byType), [byType])

  const nonBigDataTypes = byType.filter(
    (r) => !r.key.startsWith('StarRocks_') && !r.key.startsWith('Flink_') && !r.key.startsWith('DataWorks_'),
  )

  const srTotal = bd.starrocks.clusters + bd.starrocks.warehouses + bd.starrocks.be + bd.starrocks.fe
  const flinkTotal = bd.flink.workspaces + bd.flink.namespaces + bd.flink.deployments
  const dwTotal = bd.dataworks.projects + bd.dataworks.resourceGroups

  const currentAccountLabel = cloudAccounts.find((item) => item.key === account)?.label || ''
  const cliDisabled = !account
  const activeRun = runs.find((item) => item.status === 'queued' || item.status === 'running') || null
  const latestRun = runs[0] || null
  const accountSchedules = schedules.filter((item) => !account || item.cloud_account_key === account)

  async function runSync() {
    if (!account) {
      setToast('请先选择阿里云账号。')
      return
    }
    if (cliAccounts.length === 0) {
      setToast('当前阿里云账号还没有可用的 CLI 账号，请先点击“+ 新增 CLI 账号”。')
      return
    }
    if (!cliAccountId) {
      setToast('请先选择 CLI 账号；如果还没有，请点击“+ 新增 CLI 账号”。')
      return
    }
    setSyncing(true)
    setToast('')
    try {
      const resp = await fetch('/api/aiops/sync/run', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, cliAccountId, region }),
      })
      const data = (await resp.json().catch(() => ({}))) as SyncRunResp
      if (!resp.ok) throw new Error(data?.detail || data?.message || `HTTP ${resp.status}`)
      setToast(data?.message || '已发起同步。')
      if (data.runId) setCurrentRunId(data.runId)
      fetchRuns(account)
      fetchSchedules()
    } catch (e: any) {
      setToast(`同步失败：${String(e?.message || e)}`)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div style={{ display: 'grid', gap: 22 }}>
      {/* ── 顶部工具区 ── */}
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 950, fontSize: 20, letterSpacing: 0.2 }}>资产总览</div>
            <div style={{ marginTop: 6, opacity: 0.65, fontSize: 13 }}>
              数据来自资产域模型，页面直接读库
              {currentAccountLabel ? `，当前账号: ${currentAccountLabel}` : ''}
              {region ? `，当前区域: ${regionLabel(region)}` : ''}
            </div>
          </div>
        </div>

        <Card style={{ padding: 16 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={account} onChange={(e) => setAccount(e.target.value)} style={selectStyle}>
              {cloudAccounts.map((item) => (
                <option key={item.key} value={item.key} style={optionStyle}>
                  {item.label}
                </option>
              ))}
            </select>

            <select value={cliAccountId} onChange={(e) => setCliAccountId(e.target.value)} style={selectStyle} disabled={cliDisabled}>
              {!account ? (
                <option value="" style={optionStyle}>
                  请先选择阿里云账号
                </option>
              ) : cliAccounts.length === 0 ? (
                <option value="" style={optionStyle}>
                  暂无 CLI 账号，可点右侧新增
                </option>
              ) : null}
              {cliAccounts.map((item) => (
                <option key={item.id} value={item.id} style={optionStyle}>
                  {item.name}
                </option>
              ))}
            </select>

            <Button variant="ghost" onClick={() => setCliModalOpen(true)}>
              + 新增 CLI 账号
            </Button>

            <Button variant="ghost" onClick={() => setScheduleModalOpen(true)}>
              定时同步设置
            </Button>

            <select value={region} onChange={(e) => setRegion(e.target.value)} style={selectStyle}>
              <option value="" style={optionStyle}>全部区域</option>
              {regions.map((r) => (
                <option key={r.key} value={r.key} style={optionStyle}>
                  {regionLabel(r.key)}
                </option>
              ))}
            </select>

            <Button variant="primary" onClick={() => void runSync()} disabled={syncing || optionsLoading}>
              {syncing ? '同步中…' : '同步资产'}
            </Button>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.68, lineHeight: 1.7 }}>
            {!account
              ? '先选择阿里云账号，再选择 CLI 账号。'
              : cliAccounts.length === 0
                ? '当前账号下还没有可用 CLI 账号，直接点“+ 新增 CLI 账号”即可。'
                : 'CLI 下拉框只展示真实账号，不会放“暂无数据”这类伪选项。'}
          </div>

          {toast ? <div style={{ marginTop: 10, fontSize: 12, color: '#475569' }}>{toast}</div> : null}
        </Card>

        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 12 }}>
          <Card style={{ padding: 16 }}>
            <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 10 }}>同步任务状态</div>
            {runLoading ? (
              <div style={{ opacity: 0.6, fontSize: 13 }}>加载中…</div>
            ) : activeRun ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 13 }}>
                  当前任务：<span style={{ fontWeight: 900 }}>{activeRun.status}</span> · {activeRun.region === 'all' ? '全部区域' : regionLabel(activeRun.region)}
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>开始时间：{fmtTs(activeRun.started_at || activeRun.created_at)}</div>
                <div style={{ fontSize: 12, opacity: 0.82 }}>{activeRun.summary || '后台正在执行发现脚本…'}</div>
              </div>
            ) : latestRun ? (
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 13 }}>
                  最近任务：<span style={{ fontWeight: 900 }}>{latestRun.status}</span> · {latestRun.region === 'all' ? '全部区域' : regionLabel(latestRun.region)}
                </div>
                <div style={{ fontSize: 12, opacity: 0.72 }}>完成时间：{fmtTs(latestRun.finished_at || latestRun.created_at)}</div>
                <div style={{ fontSize: 12, opacity: 0.82 }}>{latestRun.error || latestRun.summary || '暂无摘要'}</div>
              </div>
            ) : (
              <div style={{ opacity: 0.58, fontSize: 13 }}>当前账号下还没有同步记录。</div>
            )}
          </Card>

          <Card style={{ padding: 16 }}>
            <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 10 }}>定时同步</div>
            {scheduleLoading ? (
              <div style={{ opacity: 0.6, fontSize: 13 }}>加载中…</div>
            ) : accountSchedules.length === 0 ? (
              <div style={{ opacity: 0.58, fontSize: 13 }}>当前账号下还没有定时任务，点“定时同步设置”就能加。</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {accountSchedules.slice(0, 2).map((item) => (
                  <div key={item.id} style={{ fontSize: 12, lineHeight: 1.7 }}>
                    <div style={{ fontWeight: 800 }}>{item.region === 'all' ? '全部区域' : regionLabel(item.region)}</div>
                    <div style={{ opacity: 0.72 }}>cron: {item.cron_expr}</div>
                    <div style={{ opacity: 0.72 }}>下次执行：{fmtTs(item.next_run_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {loading ? (
        <div style={{ opacity: 0.65 }}>加载中…</div>
      ) : (
        <>
          {/* ── 大数据组件总览 ── */}
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12, opacity: 0.85 }}>大数据组件总览</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>

              {/* StarRocks */}
              <Card style={{ padding: 18 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                  <div style={{ fontWeight: 900, fontSize: 15 }}>StarRocks</div>
                  {srTotal > 0 ? (
                    <Link to="/app/assets/starrocks" style={{ fontSize: 12, opacity: 0.7 }}>查看台账</Link>
                  ) : null}
                </div>
                {srTotal === 0 ? (
                  <div style={{ opacity: 0.5, fontSize: 13 }}>暂无数据</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thCenter}>集群</th>
                        <th style={thCenter}>计算组</th>
                        <th style={thCenter}>BE</th>
                        <th style={thCenter}>FE</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={tdCenter}>{bd.starrocks.clusters}</td>
                        <td style={tdCenter}>{bd.starrocks.warehouses}</td>
                        <td style={tdCenter}>{bd.starrocks.be}</td>
                        <td style={tdCenter}>{bd.starrocks.fe}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </Card>

              {/* Flink */}
              <Card style={{ padding: 18 }}>
                <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>实时计算 Flink</div>
                {flinkTotal === 0 ? (
                  <div style={{ opacity: 0.5, fontSize: 13 }}>暂无数据</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thCenter}>Workspace</th>
                        <th style={thCenter}>Namespace</th>
                        <th style={thCenter}>Deployment</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={tdCenter}>{bd.flink.workspaces}</td>
                        <td style={tdCenter}>{bd.flink.namespaces}</td>
                        <td style={tdCenter}>{bd.flink.deployments}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </Card>

              {/* DataWorks */}
              <Card style={{ padding: 18 }}>
                <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 14 }}>DataWorks</div>
                {dwTotal === 0 ? (
                  <div style={{ opacity: 0.5, fontSize: 13 }}>暂无数据</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        <th style={thCenter}>项目</th>
                        <th style={thCenter}>资源组</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td style={tdCenter}>{bd.dataworks.projects}</td>
                        <td style={tdCenter}>{bd.dataworks.resourceGroups}</td>
                      </tr>
                    </tbody>
                  </table>
                )}
              </Card>
            </div>
          </div>

          {/* ── 全局资产总览 ── */}
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, marginBottom: 12, opacity: 0.85 }}>资产健康概览</div>
            <AssetSummaryDashboard summary={summary} />
          </div>

          {/* ── 分布信息 ── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>

            {/* 其余资源类型 */}
            <Card style={{ padding: 18 }}>
              <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 12 }}>其他资源类型</div>
              {nonBigDataTypes.length === 0 ? (
                <div style={{ opacity: 0.5, fontSize: 13 }}>暂无</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thLeft}>类型</th>
                      <th style={thLeft}>分类</th>
                      <th style={thRight}>数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nonBigDataTypes.map((row) => (
                      <tr key={row.key}>
                        <td style={tdLeft}>{row.key}</td>
                        <td style={{ ...tdLeft, opacity: 0.72 }}>{row.label || row.componentKey || '-'}</td>
                        <td style={tdRight}>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {/* 按区域 */}
            <Card style={{ padding: 18 }}>
              <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 12 }}>按区域</div>
              {regions.length === 0 ? (
                <div style={{ opacity: 0.5, fontSize: 13 }}>暂无</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thLeft}>区域</th>
                      <th style={thRight}>数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regions.map((row) => (
                      <tr key={row.key} style={row.key === region ? { background: 'rgba(124,92,255,0.05)' } : undefined}>
                        <td style={tdLeft}>{regionLabel(row.key)}</td>
                        <td style={tdRight}>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            {/* 按环境 */}
            <Card style={{ padding: 18 }}>
              <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 12 }}>按环境</div>
              {byEnv.length === 0 ? (
                <div style={{ opacity: 0.5, fontSize: 13 }}>暂无</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thLeft}>环境</th>
                      <th style={thRight}>数量</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byEnv.map((row) => (
                      <tr key={row.key}>
                        <td style={tdLeft}>{row.key}</td>
                        <td style={tdRight}>{row.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </>
      )}

      <AssetCliAccountModal
        open={cliModalOpen}
        presetAccountKey={account}
        onClose={() => setCliModalOpen(false)}
        onSaved={(item) => {
          setCliModalOpen(false)
          fetchOptions(account)
          if (account && (item.cloudAccountKeys || []).includes(account)) {
            setCliAccountId(item.id)
            setToast(`已新增 CLI 账号：${item.name}`)
          }
        }}
      />
      <AssetSyncScheduleModal
        open={scheduleModalOpen}
        account={account}
        cliAccountId={cliAccountId}
        region={region || 'all'}
        cloudAccounts={cloudAccounts}
        cliAccounts={cliAccounts}
        schedules={schedules}
        onClose={() => setScheduleModalOpen(false)}
        onSaved={(message) => {
          setToast(message)
          setScheduleModalOpen(false)
          fetchSchedules()
        }}
      />
    </div>
  )
}

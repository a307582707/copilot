import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { Asset, ClientStateV2, ID } from './types'

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`
}

type DemoBigData = {
  id: string
  component_key: string
  name: string
  bucket?: 'ungrouped' | 'emapreduce' | 'flinkCluster'
  env?: string
  region?: string
}

const LEDGER_TYPES = [
  { key: 'overview', label: '资产总览', path: '/app/assets/overview', ready: true },
  { key: 'starrocks', label: 'StarRocks 集群', path: '/app/assets/starrocks', ready: true },
  { key: 'flink', label: 'Flink 作业', path: '/app/assets/flink', ready: false },
  { key: 'dataworks', label: 'DataWorks', path: '/app/assets/dataworks', ready: false },
  { key: 'ecs', label: 'ECS 主机', path: '/app/assets/ecs', ready: false },
  { key: 'oss', label: 'OSS 存储', path: '/app/assets/oss', ready: false },
] as const

function isLedgerRoute(pathname: string) {
  return pathname === '/app/assets/ledger' || LEDGER_TYPES.some((entry) => pathname === entry.path || pathname.startsWith(`${entry.path}/`))
}

export function HostSidebar(props: {
  state: ClientStateV2
  onStateChange: (s: ClientStateV2) => void
  onEditAsset: (id: ID | null) => void
  onSelectAsset?: (id: ID) => void
  onSelectBigData?: (id: string) => void
  onConnectAsset?: (assetId: ID) => void
  onDeleteAsset?: (assetId: ID) => void
  onNewHost?: () => void
  onImport?: () => void
  onToast?: (msg: string) => void
  onRequestConfirm?: (opts: { title: string; desc?: string; confirmText?: string; onConfirm: () => void }) => void
  disableDemoSeed?: boolean
}) {
  const { state, onStateChange, onEditAsset, onSelectAsset, onSelectBigData, onConnectAsset, onDeleteAsset, onNewHost, onImport, onToast, onRequestConfirm, disableDemoSeed } =
    props
  const nav = useNavigate()
  const location = useLocation()
  const [showInventory, setShowInventory] = useState(() => (Array.isArray(state.assets) && state.assets.length > 0 ? true : false))
  const prevAssetCountRef = useRef<number>(Array.isArray(state.assets) ? state.assets.length : 0)

  const inventoryRef = useRef<HTMLDivElement | null>(null)
  const invMenuRef = useRef<HTMLDivElement | null>(null)
  const [openInvMenuForId, setOpenInvMenuForId] = useState<string | null>(null)
  const [openInvMenuKind, setOpenInvMenuKind] = useState<'host' | 'bigdata'>('host')
  const [invMenuStep, setInvMenuStep] = useState<'root' | 'move'>('root')
  const [invMenuPos, setInvMenuPos] = useState<{ left: number; top: number } | null>(null)

  const assets = state.assets || []

  const [activeCategory, setActiveCategory] = useState<'all' | 'host' | 'bigdata' | 'ledger'>('all')
  const [activeBigDataId, setActiveBigDataId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => ({
    // Default: match HTML prototype (both sections expanded)
    all_host: true,
    all_bigdata: true,

    // Host tree
    host_ungrouped: true,

    // Bigdata tree
    bd_ungrouped: true,
    bd_emapreduce: true,
    bd_flinkCluster: true,
  }))
  const defaultBigData: DemoBigData[] = useMemo(
    () => [
      // StarRocks (bucket: emapreduce)
      { id: 'starrocks1', component_key: 'starrocks', name: 'starrocks1', bucket: 'emapreduce', env: 'prod', region: 'us-west-1' },
      { id: 'starrocks2', component_key: 'starrocks', name: 'starrocks2', bucket: 'emapreduce', env: 'prod', region: 'us-west-1' },
      { id: 'starrocks3', component_key: 'starrocks', name: 'starrocks3', bucket: 'emapreduce', env: 'prod', region: 'us-west-1' },
      { id: 'starrocks4', component_key: 'starrocks', name: 'starrocks4', bucket: 'emapreduce', env: 'prod', region: 'us-west-1' },
      { id: 'starrocks5', component_key: 'starrocks', name: 'starrocks5', bucket: 'emapreduce', env: 'prod', region: 'us-west-1' },
      { id: 'starrocks6', component_key: 'starrocks', name: 'starrocks6', bucket: 'emapreduce', env: 'prod', region: 'us-west-1' },

      // Flink (bucket: flinkCluster)
      { id: 'flink1', component_key: 'flink', name: 'flink1', bucket: 'flinkCluster', env: 'prod', region: 'us-west-1' },
      { id: 'flink2', component_key: 'flink', name: 'flink2', bucket: 'flinkCluster', env: 'prod', region: 'us-west-1' },
      { id: 'flink3', component_key: 'flink', name: 'flink3', bucket: 'flinkCluster', env: 'prod', region: 'us-west-1' },
      { id: 'flink4', component_key: 'flink', name: 'flink4', bucket: 'flinkCluster', env: 'prod', region: 'us-west-1' },
      { id: 'flink5', component_key: 'flink', name: 'flink5', bucket: 'flinkCluster', env: 'prod', region: 'us-west-1' },
      { id: 'flink6', component_key: 'flink', name: 'flink6', bucket: 'flinkCluster', env: 'prod', region: 'us-west-1' },

      // DataWorks & others (bucket: ungrouped)
      { id: 'dataworks1', component_key: 'dataworks', name: 'dataworks1', bucket: 'ungrouped', env: 'prod', region: 'us-west-1' },
      { id: 'dataworks2', component_key: 'dataworks', name: 'dataworks2', bucket: 'ungrouped', env: 'prod', region: 'us-west-1' },
      { id: 'dataworks3', component_key: 'dataworks', name: 'dataworks3', bucket: 'ungrouped', env: 'prod', region: 'us-west-1' },
      { id: 'dlf1', component_key: 'dlf', name: 'dlf1', bucket: 'ungrouped', env: 'prod', region: 'us-west-1' },
      { id: 'network1', component_key: 'network', name: 'network1', bucket: 'ungrouped', env: 'prod', region: 'us-west-1' },
    ],
    [],
  )

  const bigDataAssets: DemoBigData[] = useMemo(() => {
    const v = (state as any).bigDataAssets
    return Array.isArray(v) ? (v as DemoBigData[]) : []
  }, [state])

  // UX: when user adds the first asset, auto-expand inventory so it's immediately visible.
  useEffect(() => {
    const prev = prevAssetCountRef.current
    const next = Array.isArray(state.assets) ? state.assets.length : 0
    prevAssetCountRef.current = next
    if (prev === 0 && next > 0) setShowInventory(true)
  }, [state.assets])

  useEffect(() => {
    const inLedger = isLedgerRoute(location.pathname)
    setActiveCategory((prev) => {
      if (inLedger) return prev === 'ledger' ? prev : 'ledger'
      return prev === 'ledger' ? 'all' : prev
    })
  }, [location.pathname])

  // Demo seed: inject a few fake hosts + groups + bigdata assets (UI only, no API changes)
  useEffect(() => {
    if (disableDemoSeed) return
    const hasAnyHostsGroups = (state.assets || []).length > 0 || (state.groups || []).length > 0
    const hasAnyBigData = Array.isArray((state as any).bigDataAssets) && ((state as any).bigDataAssets as any[]).length > 0
    if (hasAnyHostsGroups && hasAnyBigData) return
    const now = Date.now()
    const g1 = { id: uid('grp'), name: 'group1', sort: 1, createdAt: now, updatedAt: now }
    const g2 = { id: uid('grp'), name: 'group2', sort: 2, createdAt: now, updatedAt: now }
    const demoHosts: Asset[] = []
    const mk = (n: number, groupId: ID | null) => ({
      id: uid('host'),
      name: `app-test${n === 0 ? '' : n}`,
      address: `192.168.1.${10 + n}`,
      port: 22,
      username: 'root',
      tagIds: [],
      status: 'enabled' as const,
      createdAt: now,
      updatedAt: now,
      groupId,
    })
    // Add enough items to visibly test scrolling in “全部/主机” tabs.
    demoHosts.push(mk(0, null))
    for (let i = 1; i <= 8; i++) demoHosts.push(mk(i, g1.id))
    for (let i = 9; i <= 16; i++) demoHosts.push(mk(i, g2.id))
    for (let i = 17; i <= 20; i++) demoHosts.push(mk(i, null))
    const next: any = { ...state }
    if (!hasAnyHostsGroups) {
      next.groups = [g1 as any, g2 as any]
      next.assets = demoHosts
      next.hosts = demoHosts
      next.activeHostId = demoHosts[0]?.id ?? null
      setShowInventory(true)
    }
    if (!hasAnyBigData) {
      next.bigDataAssets = defaultBigData
    }
    onStateChange(next as ClientStateV2)
    onToast?.('已加载演示资产（仅 UI 展示，可删改）')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filteredAssets = useMemo(() => assets, [assets])

  function closeInvMenu() {
    setOpenInvMenuForId(null)
    setInvMenuPos(null)
    setInvMenuStep('root')
  }

  // Click outside -> close (but allow scroll/drag inside menu)
  useEffect(() => {
    if (!openInvMenuForId) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const root = invMenuRef.current
      const target = e.target as Node | null
      if (!root || !target) return
      if (root.contains(target)) return
      const el = target as HTMLElement
      if (el && el.closest?.('[data-inv-menu-anchor="1"]')) return
      closeInvMenu()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeInvMenu()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', closeInvMenu)
    window.addEventListener('scroll', closeInvMenu, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('resize', closeInvMenu)
      window.removeEventListener('scroll', closeInvMenu)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openInvMenuForId])

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      onToast?.(`已复制：${text}`)
    } catch {
      window.prompt('复制到剪贴板（浏览器限制，手动复制）', text)
    }
  }

  function toggleExpand(key: string) {
    setExpanded((p) => ({ ...p, [key]: !p[key] }))
  }

  const hostUngrouped = useMemo(() => filteredAssets.filter((a) => !a.groupId), [filteredAssets])
  const hostByGroup = useMemo(() => {
    const out = new Map<ID, Asset[]>()
    for (const a of filteredAssets) {
      const gid = a.groupId
      if (!gid) continue
      const list = out.get(gid) || []
      list.push(a)
      out.set(gid, list)
    }
    return out
  }, [filteredAssets])

  function renderHostTree() {
    return (
      <>
        <div className="assetGroup">
          <button type="button" className="assetGroupHeaderBtn" onClick={() => toggleExpand('host_ungrouped')}>
            <span className={`assetGroupArrow ${expanded.host_ungrouped ? 'assetGroupArrowOpen' : ''}`}>▸</span>
            <span>未分组</span>
          </button>
          {expanded.host_ungrouped ? (
            <div className="assetGroupContent">
              {hostUngrouped.map((a) => (
                <AssetItem
                  key={a.id}
                  asset={a}
                  active={a.id === state.activeHostId}
                  onSelect={() => onSelectAsset?.(a.id)}
                  onCopyName={() => copyText(a.name)}
                  onOpenMenu={(el) => openInvMenu('host', a.id, el)}
                />
              ))}
            </div>
          ) : null}
        </div>

        {(state.groups || []).map((g: any) => {
          const gid = String(g.id) as ID
          const list = hostByGroup.get(gid) || []
          if (list.length === 0) return null
          const key = `host_g_${gid}`
          const open = expanded[key] ?? true
          return (
            <div key={gid} className="assetGroup">
              <button type="button" className="assetGroupHeaderBtn" onClick={() => toggleExpand(key)}>
                <span className={`assetGroupArrow ${open ? 'assetGroupArrowOpen' : ''}`}>▸</span>
                <span>{String(g.name || gid)}</span>
              </button>
              {open ? (
                <div className="assetGroupContent">
                  {list.map((a) => (
                    <AssetItem
                      key={a.id}
                      asset={a}
                      active={a.id === state.activeHostId}
                      onSelect={() => onSelectAsset?.(a.id)}
                      onCopyName={() => copyText(a.name)}
                      onOpenMenu={(el) => openInvMenu('host', a.id, el)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </>
    )
  }

  function bigDataBucket(it: DemoBigData) {
    if (it.bucket) return it.bucket
    const k = String(it.component_key || '').toLowerCase()
    if (k.includes('flink')) return 'flinkCluster'
    if (k.includes('starrocks')) return 'emapreduce'
    return 'ungrouped'
  }

  const bdGroups = useMemo(() => {
    const out: Record<string, DemoBigData[]> = { ungrouped: [], emapreduce: [], flinkCluster: [] }
    for (const it of bigDataAssets) out[bigDataBucket(it)].push(it)
    return out
  }, [bigDataAssets])

  function renderBigDataTree() {
    const sections: Array<{ id: string; label: string; items: DemoBigData[] }> = [
      { id: 'bd_ungrouped', label: '未分组', items: bdGroups.ungrouped },
      { id: 'bd_emapreduce', label: 'E-mapreduce', items: bdGroups.emapreduce },
      { id: 'bd_flinkCluster', label: 'flink集群', items: bdGroups.flinkCluster },
    ]
    return (
      <>
        {sections.map((s) => {
          if (s.items.length === 0) return null
          const open = expanded[s.id] ?? true
          return (
            <div key={s.id} className="assetGroup">
              <button type="button" className="assetGroupHeaderBtn" onClick={() => toggleExpand(s.id)}>
                <span className={`assetGroupArrow ${open ? 'assetGroupArrowOpen' : ''}`}>▸</span>
                <span>{s.label}</span>
              </button>
              {open ? (
                <div className="assetGroupContent">
                  {s.items.map((it) => (
                    <div key={it.id} className={`assetRow ${activeBigDataId === it.id ? 'assetRowActive' : ''}`}>
                      <button
                        type="button"
                        className="assetRowMain"
                        title={it.name}
                        onClick={() => {
                          setActiveBigDataId(it.id)
                          onToast?.(`已选中：${it.name}`)
                          onSelectBigData?.(it.id)
                        }}
                      >
                        {it.name}
                      </button>
                      <div className="assetRowActions">
                        <button
                          type="button"
                          className="miniBtn invIconBtn"
                          title="复制名称"
                          onClick={(e) => {
                            e.stopPropagation()
                            void copyText(it.name)
                          }}
                        >
                          ⎘
                        </button>
                        <button
                          type="button"
                          className="miniBtn invIconBtn"
                          title="更多"
                          data-inv-menu-anchor="1"
                          onClick={(e) => {
                            e.stopPropagation()
                            setActiveBigDataId(it.id)
                            openInvMenu('bigdata', it.id, e.currentTarget as HTMLElement)
                          }}
                        >
                          ⋯
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}
      </>
    )
  }

  function renderLedgerTree() {
    const activeLedgerPath =
      LEDGER_TYPES.find((entry) => location.pathname === entry.path || location.pathname.startsWith(`${entry.path}/`))?.path ?? null

    return (
      <div className="assetGroup">
        <div className="assetGroupContent assetGroupContentFlat">
          {LEDGER_TYPES.map((entry) => {
            const active = activeLedgerPath === entry.path
            return (
              <button
                key={entry.key}
                type="button"
                className="assetGroupHeaderBtn"
                disabled={!entry.ready}
                aria-current={active ? 'page' : undefined}
                onClick={() => {
                  if (!entry.ready) return
                  nav(entry.path)
                }}
                style={{
                  marginBottom: 8,
                  opacity: entry.ready ? 1 : 0.55,
                  borderColor: active ? 'rgba(124, 92, 255, 0.35)' : undefined,
                  background: active ? 'rgba(124, 92, 255, 0.10)' : undefined,
                  cursor: entry.ready ? 'pointer' : 'not-allowed',
                }}
              >
                <span>{entry.label}</span>
                <span style={{ fontSize: 11, opacity: active ? 0.9 : 0.72 }}>{entry.ready ? '已接入' : '规划中'}</span>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  function updateAssetById(assetId: ID, patch: Partial<Asset>) {
    const now = Date.now()
    const nextAssets = (state.assets || []).map((a) => (a.id === assetId ? { ...a, ...patch, updatedAt: now } : a))
    onStateChange({ ...state, assets: nextAssets, hosts: nextAssets })
  }

  function updateBigDataById(id: string, patch: Partial<DemoBigData>) {
    const next = bigDataAssets.map((it) => (it.id === id ? { ...it, ...patch } : it))
    onStateChange({ ...(state as any), bigDataAssets: next } as ClientStateV2)
  }

  function deleteBigDataById(id: string) {
    const next = bigDataAssets.filter((it) => it.id !== id)
    onStateChange({ ...(state as any), bigDataAssets: next } as ClientStateV2)
    setActiveBigDataId((cur) => (cur === id ? null : cur))
  }

  function requestDeleteBigData(id: string) {
    const it = bigDataAssets.find((x) => x.id === id) || null
    const name = it?.name || id
    const desc = `将删除：${name}。该操作仅影响演示数据展示。`
    if (onRequestConfirm) {
      onRequestConfirm({
        title: '删除大数据资产',
        desc,
        confirmText: '删除',
        onConfirm: () => {
          deleteBigDataById(id)
          onToast?.('已删除（演示）')
        },
      })
      return
    }
    // Fallback (should be rare): keep legacy behavior without browser confirm.
    deleteBigDataById(id)
    onToast?.('已删除（演示）')
  }

  function openInvMenu(kind: 'host' | 'bigdata', id: string, anchorEl: HTMLElement) {
    const rect = anchorEl.getBoundingClientRect()
    const menuW = 100
    const menuH = 160
    const gap = 2
    const rightPad = 10
    const containerRight = inventoryRef.current?.getBoundingClientRect().right ?? rect.right
    const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, containerRight - menuW - rightPad))
    let top = rect.bottom + gap
    if (top + menuH > window.innerHeight - 8) top = Math.max(8, rect.top - menuH - gap)
    setInvMenuPos({ left, top })
    setInvMenuStep('root')
    setOpenInvMenuKind(kind)
    setOpenInvMenuForId((prev) => (prev === id ? null : id))
  }

  return (
    <div className="sideList assetSideRoot">
      <div className="assetNav">
        <div className="assetNavTitleRow">
          <div className="assetNavTitle">资产库</div>
          {activeCategory !== 'ledger' ? (
            <button
              type="button"
              className="sideAddBtn"
              title="新增资产"
              onClick={() => {
                onEditAsset(null)
              }}
            >
              +
            </button>
          ) : null}
        </div>
        <div className="assetNavTabs">
          <button
            type="button"
            className={`assetNavTab ${activeCategory === 'all' ? 'assetNavTabActive' : ''}`}
            onClick={() => {
              setActiveCategory('all')
              if (isLedgerRoute(location.pathname)) nav('/app/assets')
            }}
          >
            全部
          </button>
          <button
            type="button"
            className={`assetNavTab ${activeCategory === 'host' ? 'assetNavTabActive' : ''}`}
            onClick={() => {
              setActiveCategory('host')
              if (isLedgerRoute(location.pathname)) nav('/app/assets')
            }}
          >
            主机
          </button>
          <button
            type="button"
            className={`assetNavTab ${activeCategory === 'bigdata' ? 'assetNavTabActive' : ''}`}
            onClick={() => {
              setActiveCategory('bigdata')
              if (isLedgerRoute(location.pathname)) nav('/app/assets')
            }}
          >
            大数据
          </button>
          <button
            type="button"
            className={`assetNavTab ${activeCategory === 'ledger' ? 'assetNavTabActive' : ''}`}
            onClick={() => {
              setActiveCategory('ledger')
              nav('/app/assets/ledger')
            }}
            title="资产台账"
          >
            台账
          </button>
        </div>
      </div>

      <div ref={inventoryRef} className="assetListWrap">
        {activeCategory === 'host' ? (
          renderHostTree()
        ) : activeCategory === 'ledger' ? (
          renderLedgerTree()
        ) : activeCategory === 'bigdata' ? (
          renderBigDataTree()
        ) : (
          <>
            <div className="assetGroup">
              <button type="button" className="assetGroupHeaderBtn" onClick={() => toggleExpand('all_host')}>
                <span className={`assetGroupArrow ${expanded.all_host ? 'assetGroupArrowOpen' : ''}`}>▸</span>
                <span>主机资产</span>
              </button>
              {(expanded.all_host ?? true) ? <div className="assetGroupContent assetGroupContentFlat">{renderHostTree()}</div> : null}
            </div>
            <div className="assetGroup">
              <button type="button" className="assetGroupHeaderBtn" onClick={() => toggleExpand('all_bigdata')}>
                <span className={`assetGroupArrow ${(expanded.all_bigdata ?? true) ? 'assetGroupArrowOpen' : ''}`}>▸</span>
                <span>大数据资产</span>
              </button>
              {(expanded.all_bigdata ?? true) ? <div className="assetGroupContent assetGroupContentFlat">{renderBigDataTree()}</div> : null}
            </div>
          </>
        )}
      </div>

      {openInvMenuForId && invMenuPos ? (
        <div
          ref={invMenuRef}
          className="invDropdownMenu"
          style={{ left: invMenuPos.left, top: invMenuPos.top }}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onWheel={(e) => e.stopPropagation()}
          role="menu"
        >
          {invMenuStep === 'root' ? (
            <>
              <button
                type="button"
                className="invDropdownItem"
                onClick={() => {
                  if (openInvMenuKind === 'host') onConnectAsset?.(openInvMenuForId as ID)
                  else {
                    onToast?.('演示：打开大数据控制台/详情页')
                    nav('/app/assets')
                  }
                  closeInvMenu()
                }}
              >
                连接
              </button>
              <button type="button" className="invDropdownItem" onClick={() => { onToast?.('测试连通性（待接入）'); closeInvMenu() }}>
                测试
              </button>
              <button
                type="button"
                className="invDropdownItem"
                onClick={() => {
                  if (openInvMenuKind === 'host') onEditAsset(openInvMenuForId as ID)
                  else onToast?.('演示：大数据编辑（待接入）')
                  closeInvMenu()
                }}
              >
                编辑
              </button>
              <button
                type="button"
                className="invDropdownItem"
                onClick={() => {
                  setInvMenuStep('move')
                }}
              >
                移动
              </button>
              <button
                type="button"
                className="invDropdownItem"
                onClick={() => {
                  if (openInvMenuKind !== 'host') {
                    onToast?.('演示：大数据重命名（待接入）')
                    closeInvMenu()
                    return
                  }
                  const cur = (state.assets || []).find((x) => x.id === (openInvMenuForId as ID))?.name || ''
                  const next = window.prompt('重命名资产', cur)
                  if (next != null) updateAssetById(openInvMenuForId as ID, { name: String(next).trim() || cur })
                  closeInvMenu()
                }}
              >
                重命名
              </button>
              <button
                type="button"
                className="invDropdownItem invDropdownItemDanger"
                onClick={() => {
                  if (openInvMenuKind === 'host') onDeleteAsset?.(openInvMenuForId as ID)
                  else {
                    requestDeleteBigData(openInvMenuForId)
                  }
                  closeInvMenu()
                }}
              >
                删除
              </button>
            </>
          ) : (
            <>
              <button type="button" className="invDropdownItem" onClick={() => setInvMenuStep('root')}>
                返回
              </button>
              {openInvMenuKind === 'host' ? (
                <>
                  <button
                    type="button"
                    className="invDropdownItem"
                    onClick={() => {
                      updateAssetById(openInvMenuForId as ID, { groupId: null })
                      closeInvMenu()
                    }}
                  >
                    未分组
                  </button>
                  {(state.groups || [])
                    .slice()
                    .sort((a: any, b: any) => String(a?.name || '').localeCompare(String(b?.name || '')))
                    .map((g: any) => (
                      <button
                        key={String(g.id)}
                        type="button"
                        className="invDropdownItem"
                        onClick={() => {
                          updateAssetById(openInvMenuForId as ID, { groupId: String(g.id) })
                          closeInvMenu()
                        }}
                        title={String(g.name || '')}
                      >
                        {String(g.name || '')}
                      </button>
                    ))}
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="invDropdownItem"
                    onClick={() => {
                      updateBigDataById(openInvMenuForId, { bucket: 'ungrouped' })
                      onToast?.('已移动到：未分组（演示）')
                      closeInvMenu()
                    }}
                  >
                    未分组
                  </button>
                  <button
                    type="button"
                    className="invDropdownItem"
                    onClick={() => {
                      updateBigDataById(openInvMenuForId, { bucket: 'emapreduce' })
                      onToast?.('已移动到：E-mapreduce（演示）')
                      closeInvMenu()
                    }}
                  >
                    E-mapreduce
                  </button>
                  <button
                    type="button"
                    className="invDropdownItem"
                    onClick={() => {
                      updateBigDataById(openInvMenuForId, { bucket: 'flinkCluster' })
                      onToast?.('已移动到：flink集群（演示）')
                      closeInvMenu()
                    }}
                  >
                    flink集群
                  </button>
                </>
              )}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}

function AssetItem(props: {
  asset: Asset
  active: boolean
  onSelect: () => void
  onCopyName: () => void
  onOpenMenu: (el: HTMLElement) => void
}) {
  const { asset, active, onSelect, onCopyName, onOpenMenu } = props
  const portPart = asset.port && asset.port !== 22 ? `:${asset.port}` : ''
  return (
    <div
      className={`sideItem assetSideItem ${active ? 'sideItemActive' : ''}`}
      style={{ opacity: 0.95 }}
      onClick={onSelect}
      title="查看详情"
    >
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div className="sideItemTitle">{asset.name}</div>
        <div className="sideItemMeta">
          {asset.username ? `${asset.username}@` : ''}{asset.address}{portPart}
        </div>
      </div>
      <div className="sideItemActions">
        <button
          className="miniBtn invIconBtn"
          type="button"
          title="复制名称"
          onClick={(e) => {
            e.stopPropagation()
            onCopyName()
          }}
        >
          ⎘
        </button>
        <button
          className="miniBtn invIconBtn"
          type="button"
          title="更多"
          data-inv-menu-anchor="1"
          onClick={(e) => {
            e.stopPropagation()
            onOpenMenu(e.currentTarget as HTMLElement)
          }}
        >
          ⋯
        </button>
      </div>
    </div>
  )
}

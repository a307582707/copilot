import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import './App.css'
import 'xterm/css/xterm.css'
import { Terminal as XTerm } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import type { Asset, ClientStateV2 as HostConfigStateV1, Credential, Group, HostAuthType, ID, Tag } from './host-config/types'
// Legacy aliases for App.tsx compatibility
type Host = Asset
import { HostSidebar } from './host-config/HostSidebar'
import { HOST_CONFIG_KEY, fixHostConfigState, loadHostConfigState, saveHostConfigState } from './host-config/storage'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import { IconButton } from './ui/IconButton'
import { Input } from './ui/Input'
import { Drawer } from './ui/Drawer'
import { Modal } from './ui/Modal'
import { ConfirmDialog } from './ui/ConfirmDialog'
import { Menu, MenuItem } from './ui/Menu'
import { Select } from './ui/Select'
import { DASHBOARD_ENABLED, WINDOWS_SSH_GUIDE_ENABLED } from './flags'
import { DEFAULT_PREFS, loadPrefs, normalizePrefs, savePrefs, type Prefs, type ThemeMode } from './prefs'
import { OpsWorkspace } from './site/ops/OpsWorkspace'

type Role = 'user' | 'assistant'

type MessageKind = 'chat' | 'tool_result' | 'system'

type AiUiMode = 'ask' | 'plan' | 'agent' | 'debug'

type ChatImage = {
  id: string
  name: string
  dataUrl: string
  size: number
}

type PendingConfirmStatus = 'pending' | 'approved' | 'rejected'
type PendingConfirmType = 'command' | 'tool'
type PendingConfirmItem =
  | {
      kind: 'command'
      command: string
      reason?: string
    }
  | {
      kind: 'tool'
      tool: string
      args: any
      reason?: string
    }

type PendingConfirm = {
  type: PendingConfirmType
  items: PendingConfirmItem[]
  sourceLabel: string
  allowRemember: boolean
  status: PendingConfirmStatus
  createdAt: number
}

type ChatMessage = {
  id: string
  role: Role
  // Cursor-like: keep system/tool outputs distinct from AI natural language.
  // - undefined => legacy chat message
  kind?: MessageKind
  content: string
  ts: number
  images?: ChatImage[]
  streaming?: boolean
  error?: string
  // tool/system decoration (optional)
  title?: string
  meta?: string[]
  // Cursor-like: inline approval UI attached to the originating assistant message.
  pendingConfirm?: PendingConfirm
}

type ChatSession = {
  id: string
  title: string
  messages: ChatMessage[]
  closed?: boolean
}

type PersistedState = {
  version: 1
  activeId: string
  sessions: ChatSession[]
}

type SidebarMode = 'dashboard' | 'chat' | 'ssh' | 'workspace' | 'plugins'

type DashTab = 'recent' | 'hosts' | 'workspaces'

const PLUGINS_ENABLED = false

type UiStateV1 = {
  // NOTE: backend inventory API currently enforces json.version==2 for ALL spaces.
  // So ui_state_v1 must also use version=2 to be persisted.
  version: 2
  mode: SidebarMode
  workspaceHostId?: ID | null
}

type ToastState = {
  id: string
  message: string
  actionLabel?: string
  onAction?: () => void
}

type DashDrawerState =
  | { open: false }
  | { open: true; type: 'create_workspace' }
  | { open: true; type: 'host_detail'; hostId: ID }
  | { open: true; type: 'workspace_detail'; workspaceId: ID }

type BigDataKind = 'starrocks' | 'flink' | 'dataworks' | 'other'

type PluginItem = {
  id: string
  name: string
  desc?: string
  installed?: boolean
  hasUpdate?: boolean
}

type HealthState =
  | { state: 'checking' }
  | { state: 'ok' }
  | { state: 'error'; detail?: string }


function migrateCursorLikeStorageKeys() {
  try {
    const keys = Object.keys(localStorage)
    for (const k of keys) {
      if (!k.startsWith('cursor_like_')) continue
      const next = 'codesprite_' + k.slice('cursor_like_'.length)
      if (localStorage.getItem(next) == null) {
        const v = localStorage.getItem(k)
        if (v != null) localStorage.setItem(next, v)
      }
    }
    // One-off: older sidebar key used a non-prefixed name.
    const oldSidebar = 'cursor_sidebar_collapsed_v2'
    const newSidebar = 'codesprite_sidebar_collapsed_v2'
    if (localStorage.getItem(newSidebar) == null) {
      const v = localStorage.getItem(oldSidebar)
      if (v != null) localStorage.setItem(newSidebar, v)
    }
  } catch {
    // ignore
  }
}
migrateCursorLikeStorageKeys()

const STORAGE_KEY = 'codesprite_chat_state_v1'
const MODEL_KEY = 'codesprite_selected_model_v1'
const SIDEBAR_W_KEY = 'codesprite_sidebar_w_v1'
const SIDEBAR_COLLAPSED_KEY = 'codesprite_sidebar_collapsed_v2'
const MODE_KEY = 'codesprite_sidebar_mode_v1'
const API_BASE_KEY = 'codesprite_api_base_v1'
const DASH_FULLSCREEN_KEY = 'codesprite_dashboard_fullscreen_v1'
const ACTIVE_CONN_KEY = 'codesprite_active_conn_v1'
const WORKSPACE_SPLIT_W_KEY = 'codesprite_workspace_split_w_v1'
const WORKSPACE_TOOLS_OPEN_KEY = 'codesprite_workspace_tools_open_v1'
const DASH_GUIDE_DISMISS_DAY_KEY = 'codesprite_dashboard_halfempty_dismiss_day_v1'
// Spec §8: Context switcher (spaces) - users can switch "space/config" sets.
const SPACE_LIST_KEY = 'codesprite_spaces_v1'
const SPACE_ACTIVE_KEY = 'codesprite_active_space_v1'
type Space = { id: string; name: string; lastUsedAt: number }
// Backend sync switch for host inventory (rollback lever).
const INVENTORY_SYNC_ENABLED_KEY = 'codesprite_inventory_sync_enabled_v1'
// UI state sync (cross-browser): store last opened module per user.
const UI_STATE_SPACE_ID = 'ui_state_v1'
// Prefs sync (cross-browser): store UI prefs/layout per user.
const PREFS_SPACE_ID = 'prefs_v1'

// Cursor-aligned AI behavior mode (UI-level). Manual/Shell is NOT an AI mode.
const AI_UI_MODE_KEY = 'codesprite_ai_ui_mode_v1'

function normalizeApiBase(input: string) {
  const v = (input || '').trim()
  if (!v) return ''
  return v.replace(/\/+$/, '')
}

function isHttpOrigin() {
  const p = typeof window !== 'undefined' ? window.location.protocol : ''
  return p === 'http:' || p === 'https:'
}

function defaultApiBase() {
  // Web: use same-origin (/api/*) so nginx/proxy can route.
  if (isHttpOrigin()) return ''
  // Desktop (tauri/file): default to local backend.
  return 'http://127.0.0.1:8030'
}

function loadApiBase(): string {
  try {
    const raw = localStorage.getItem(API_BASE_KEY) ?? ''
    return normalizeApiBase(raw) || defaultApiBase()
  } catch {
    return defaultApiBase()
  }
}

// Use unicode escapes so the source file stays ASCII-only (avoids Windows encoding issues).
const I18N = {
  appSub: 'CodeSprite \u00b7 AI \u5de5\u4f5c\u53f0',
  newChat: '\u65b0\u5efa\u4f1a\u8bdd',
  newSession: '\u65b0\u4f1a\u8bdd',
  untitled: '\u672a\u547d\u540d',
  noMessages: '\u6682\u65e0\u6d88\u606f',
  chat: '\u4f1a\u8bdd',
  hintKeys: 'Enter \u53d1\u9001 \u00b7 Shift+Enter \u6362\u884c',
  inputPlaceholder: '\u8f93\u5165\u6d88\u606f\u2026',
  sending: '\u53d1\u9001\u4e2d\u2026',
  send: '\u53d1\u9001',
  stop: '\u6682\u505c',
  stopTitle: '\u6682\u505c\u751f\u6210',
  stopped: '\uff08\u5df2\u6682\u505c\uff09',
  backendChecking: '\u540e\u7aef\uff1a\u68c0\u6d4b\u4e2d',
  backendOk: '\u540e\u7aef\uff1a\u5df2\u8054\u901a',
  backendErr: '\u540e\u7aef\uff1a\u4e0d\u53ef\u8fbe',
  proxyTip:
    '\u70b9\u51fb\u53ef\u8bbe\u7f6e\u540e\u7aef\u5730\u5740\uff08\u9ed8\u8ba4\u4f7f\u7528 /api/*\uff1b\u684c\u9762\u7aef\u9ed8\u8ba4 http://127.0.0.1:8030\uff09',
  apiBaseTitle: '\u540e\u7aef\u8bbe\u7f6e',
  apiBaseLabel: '\u540e\u7aef\u5730\u5740\uff08API Base\uff09',
  apiBaseHint:
    '\u7559\u7a7a\u8868\u793a\u4f7f\u7528\u5f53\u524d\u7ad9\u70b9\u7684 /api/*\u3002\u4f8b\u5982\uff1ahttps://codesprite.example.com',
  apiBaseSave: '\u4fdd\u5b58',
  apiBaseCancel: '\u53d6\u6d88',
  apiBaseTest: '\u6d4b\u8bd5\u8fde\u901a',
  apiBaseCurrent: '\u5f53\u524d\uff1a',
  apiBaseOk: '\u5df2\u8054\u901a',
  apiBaseBad: '\u4e0d\u53ef\u8fbe',
  hintFooter:
    '\u5df2\u63a5\u5165\u540e\u7aef /api/chat\uff08\u6d41\u5f0f\uff09\u3002\u4f1a\u8bdd\u81ea\u52a8\u4fdd\u5b58\u5230\u672c\u5730\uff08localStorage\uff09\u3002',
  intro:
    '\u4f60\u597d\uff01\u8fd9\u662f CodeSprite \u7684 AI \u5de5\u4f5c\u53f0\uff08Web + Client\uff09\u3002\n\n- \u5de6\u4fa7\uff1a\u4f1a\u8bdd\u5217\u8868\n- \u53f3\u4fa7\uff1a\u5bf9\u8bdd + \u8f93\u5165\n- \u53f3\u4e0a\u89d2\uff1a\u540e\u7aef\u8fde\u901a\u72b6\u6001\uff08\u70b9\u51fb\u53ef\u8bbe\u7f6e\u540e\u7aef\u5730\u5740\uff09\n\n\u73b0\u5728\uff1a\u53ef\u4ee5\u5728\u8f93\u5165\u6846\u53f3\u4fa7\u9009\u62e9\u6a21\u578b\uff0c\u53d1\u9001\u65f6\u5c06 model \u4e00\u8d77\u4f20\u7ed9 /api/chat\u3002',
  newChatHello: '\u65b0\u4f1a\u8bdd\u5df2\u521b\u5efa\u3002\u4f60\u53ef\u4ee5\u5f00\u59cb\u63d0\u95ee\u4e86\u3002',
  requestFailed: '\uff08\u8bf7\u6c42\u5931\u8d25\uff09',
  modelLabel: '\u6a21\u578b',
  modelLoading: '\u6a21\u578b\u5217\u8868\u52a0\u8f7d\u4e2d\u2026',
  modelUnavailable: '\u65e0\u6cd5\u83b7\u53d6\u6a21\u578b\u5217\u8868',

  navChat: '\u804a\u5929',
  navDashboard: '\u63a7\u5236\u53f0',
  navSsh: '\u8d44\u4ea7\u7ba1\u7406',
  navPlugins: '\u63d2\u4ef6',
  navAccount: '\u8d26\u6237',
  navBilling: '\u5145\u503c\u4e2d\u5fc3',

  sshTitle: '\u8d44\u4ea7\u7ba1\u7406',
  sshCloseDetail: '\u5173\u95ed\u8be6\u60c5',
  sshFav: '\u6536\u85cf',
  sshGroups: '\u5206\u7ec4',
  sshRecent: '\u6700\u8fd1\u8fde\u63a5',
  sshEmpty: '\u8fd8\u6ca1\u6709\u4e3b\u673a\u3002\u70b9\u4e0a\u65b9 + \u6dfb\u52a0\u4e00\u53f0\u4e3b\u673a\u3002',
  sshSearchPlaceholder: '\u641c\u7d22\u4e3b\u673a\u540d/\u5730\u5740/\u7528\u6237/\u6807\u7b7e/\u5206\u7ec4\u2026',
  sshClearSearch: '\u6e05\u9664\u641c\u7d22',
  sshSearchResults: '\u641c\u7d22\u7ed3\u679c',
  sshNoResults: '\u65e0\u641c\u7d22\u7ed3\u679c',
  sshNoRecent: '\u6682\u65e0\u6700\u8fd1\u8fde\u63a5',
  sshNewHost: '\u65b0\u589e\u4e3b\u673a',
  sshNewGroup: '\u65b0\u5efa\u5206\u7ec4',
  sshManageGroups: '\u7ba1\u7406\u5206\u7ec4',
  sshManageTags: '\u7ba1\u7406\u6807\u7b7e',
  sshImport: '\u5bfc\u5165',
  sshExport: '\u5bfc\u51fa',
  sshEditHost: '\u7f16\u8f91\u4e3b\u673a',
  sshDeleteHost: '\u5220\u9664\u4e3b\u673a',
  sshDeleteConfirm: '\u786e\u5b9a\u5220\u9664\u8fd9\u53f0\u4e3b\u673a\u5417\uff1f\u8be5\u64cd\u4f5c\u4ec5\u5f71\u54cd\u672c\u5730\u914d\u7f6e\u3002',
  sshDetailEmpty: '\u8bf7\u4ece\u5de6\u4fa7\u9009\u62e9\u4e3b\u673a\uff0c\u6216\u70b9\u4e0a\u65b9 + \u65b0\u589e\u4e00\u53f0\u4e3b\u673a\u3002',
  sshFieldName: '\u540d\u79f0',
  sshFieldAddress: '\u5730\u5740',
  sshFieldPort: '\u7aef\u53e3',
  sshFieldUser: '\u7528\u6237\u540d',
  sshFieldGroup: '\u5206\u7ec4',
  sshFieldTags: '\u6807\u7b7e',
  sshFieldAuth: '\u8ba4\u8bc1\u65b9\u5f0f',
  sshAuthPassword: '\u5bc6\u7801',
  sshAuthKey: '\u79c1\u94a5',
  sshAuthAgent: '\u4ee3\u7406',
  sshAuthNone: '\u65e0',
  sshSave: '\u4fdd\u5b58',
  sshCancel: '\u53d6\u6d88',
  sshCopyAddr: '\u590d\u5236\u5730\u5740',
  sshCopied: '\u5df2\u590d\u5236',
  sshToggleFav: '\u5207\u6362\u6536\u85cf',
  sshMarkConnected: '\u6807\u8bb0\u4e3a\u5df2\u8fde\u63a5',
  sshUntitledGroup: '\u672a\u5206\u7ec4',
  groupMenuNewHost: '\u5728\u8be5\u5206\u7ec4\u65b0\u589e\u4e3b\u673a',
  groupMenuRename: '\u91cd\u547d\u540d\u5206\u7ec4',
  groupMenuDelete: '\u5220\u9664\u5206\u7ec4',
  groupMenuOpenManager: '\u6253\u5f00\u7ba1\u7406\u4e2d\u5fc3',
  groupDeleteConfirm: '\u786e\u5b9a\u5220\u9664\u8be5\u5206\u7ec4\u5417\uff1f\u8be5\u5206\u7ec4\u4e0b\u7684\u4e3b\u673a\u4f1a\u79fb\u51fa\u5206\u7ec4\uff08\u4e0d\u4f1a\u5220\u9664\u4e3b\u673a\uff09\u3002',
  importTitle: '\u5bfc\u5165\u4e3b\u673a\u914d\u7f6e',
  importPickFile: '\u9009\u62e9\u6587\u4ef6',
  importPreview: '\u9884\u89c8',
  importConfirm: '\u786e\u8ba4\u5bfc\u5165',
  importCancel: '\u53d6\u6d88',
  importInvalid: '\u6587\u4ef6\u683c\u5f0f\u4e0d\u6b63\u786e\uff0c\u65e0\u6cd5\u5bfc\u5165\u3002',
  exportFilename: 'host_config_v1_export.json',
  groupsTitle: '\u5206\u7ec4\u7ba1\u7406',
  tagsTitle: '\u6807\u7b7e\u7ba1\u7406',
  add: '\u65b0\u589e',
  rename: '\u91cd\u547d\u540d',
  remove: '\u5220\u9664',
  nameRequired: '\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a',
  ok: '\u786e\u5b9a',
  placeholderTitle: '\u5f85\u5b9e\u73b0',
  placeholderSsh: '\u4e0b\u4e00\u6b65\u53ef\u4ee5\u52a0\uff1a\u4e3b\u673a\u8be6\u60c5/\u8fde\u63a5\u914d\u7f6e/\u5bc6\u94a5\u7ba1\u7406/\u7ec8\u7aef\u6d4f\u89c8\u3002',
  placeholderPlugins: '\u4e0b\u4e00\u6b65\u53ef\u4ee5\u52a0\uff1a\u63d2\u4ef6\u8be6\u60c5/\u5b89\u88c5/\u66f4\u65b0/\u79bb\u7ebf\u5305\u3002',

  pluginsTitle: '\u63d2\u4ef6\u4e2d\u5fc3',
  pluginsInstalled: '\u5df2\u5b89\u88c5',
  pluginsMarket: '\u63d2\u4ef6\u5e02\u573a',
  pluginsUpdates: '\u53ef\u66f4\u65b0',
  pluginsNoUpdates: '\u6682\u65e0\u53ef\u66f4\u65b0\u63d2\u4ef6',

  more: '\u66f4\u591a',
  closeSession: '\u5173\u95ed\u4f1a\u8bdd',
  deleteSession: '\u5220\u9664\u4f1a\u8bdd',
} as const

function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`
}

function isValidIPv4(input: string) {
  const s = (input || '').trim()
  // strict IPv4: 4 octets 0-255
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i])
    if (!Number.isInteger(n) || n < 0 || n > 255) return false
  }
  return true
}

function isValidHostname(input: string) {
  const s = (input || '').trim()
  if (!s) return false
  // allow localhost
  if (s === 'localhost') return true
  // basic RFC1123-ish: labels 1-63, overall <=253, no underscores
  if (s.length > 253) return false
  if (s.endsWith('.')) return false
  const labels = s.split('.')
  if (labels.some((l) => !l || l.length > 63)) return false
  const re = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/
  if (!labels.every((l) => re.test(l))) return false
  return true
}

function formatTime(ts: number) {
  const d = new Date(ts)
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatHostAddr(h: Host) {
  const base = `${h.address}:${h.port}`
  return h.user ? `${h.user}@${base}` : base
}

function loadState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedState
    if (parsed?.version !== 1) return null
    if (!Array.isArray(parsed.sessions) || typeof parsed.activeId !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function saveState(state: PersistedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // ignore quota / private mode
  }
}

function createDefaultSession(): ChatSession {
  return {
    id: uid('s'),
    title: I18N.newSession,
    messages: [
      {
        id: uid('m'),
        role: 'assistant',
        kind: 'chat',
        content: I18N.intro,
        ts: Date.now(),
      },
    ],
  }
}

function appendStoppedTag(content: string) {
  if (!content) return I18N.stopped
  if (content.includes(I18N.stopped)) return content
  return `${content}\n\n${I18N.stopped}`
}

export default function App() {
  const loc = useLocation()
  const nav = useNavigate()
  // Robust ops path detection: guard against any basename / router edge-cases.
  const opsPath =
    (loc.pathname || '').startsWith('/app/ops') ||
    (loc.pathname || '').startsWith('/app/assets') ||
    (typeof window !== 'undefined' && (window.location.pathname.startsWith('/app/ops') || window.location.pathname.startsWith('/app/assets')))

  // #region agent log
  const __dbgEnabled = useMemo(() => {
    try {
      if (typeof window === 'undefined') return false
      const url = new URL(window.location.href)
      const sp = url.searchParams
      if (sp.get('dbg') === '1' || sp.get('__dbg') === '1') return true
      return localStorage.getItem('codesprite_dbg') === '1' || localStorage.getItem('__dbg') === '1'
    } catch {
      return false
    }
  }, [])
  const __dbgRunIdRef = useRef<string>(`run_${Date.now()}_${Math.random().toString(16).slice(2)}`)
  // NOTE: do not log secrets (password/key/token/PII). Only UI/layout signals.
  const __dbgPost = (payload: { hypothesisId: string; location: string; message: string; data?: any }) => {
    if (!__dbgEnabled) return
    try {
      fetch('http://localhost:7242/ingest/c86192b4-880f-40af-8e2d-7b48bac70cfb', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, runId: (__dbgRunIdRef.current as any) || 'run', timestamp: Date.now() }),
      }).catch(() => {})
    } catch {
      // ignore
    }
  }

  const __dbgOverlaySnapshot = (message: string) => {
    if (!__dbgEnabled) return
    const pick = (x: number, y: number) => {
      const el = document.elementFromPoint(x, y) as any
      if (!el) return null
      const cs = window.getComputedStyle(el)
      const r = el.getBoundingClientRect?.()
      const s = (el.textContent || '').toString().replace(/\s+/g, ' ').trim()
      return {
        tag: String(el.tagName || '').toLowerCase(),
        id: String(el.id || ''),
        cls: String(el.className || ''),
        role: String(el.getAttribute?.('role') || ''),
        aria: String(el.getAttribute?.('aria-label') || ''),
        title: String(el.getAttribute?.('title') || ''),
        text: s ? s.slice(0, 60) : '',
        pe: cs.pointerEvents,
        zi: cs.zIndex,
        pos: cs.position,
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
      }
    }
    const vh = window.innerHeight
    const vw = window.innerWidth
    const clampY = (y: number) => Math.max(1, Math.min(vh - 2, y))
    const railPoints = [
      { name: 'railTop', x: 24, y: 12 },
      { name: 'railChat', x: 24, y: 72 },
      { name: 'railAssets', x: 24, y: 112 },
      { name: 'railPlugins', x: 24, y: 152 },
      { name: 'railMid', x: 24, y: Math.round(vh / 2) },
    ].map((p) => ({ ...p, y: clampY(p.y) }))

    const drawerEl = document.querySelector('.ui-drawer') as HTMLElement | null
    const drawerRect = drawerEl?.getBoundingClientRect?.() || null
    __dbgPost({
      hypothesisId: 'overlayBlocksRail',
      location: 'App.tsx:overlayProbe',
      message,
      data: {
        path: window.location.pathname,
        opsPath,
        vw,
        vh,
        hasIconRail: Boolean(document.querySelector('.sidebarIconRail')),
        hasFlyoutOverlay: Boolean(document.querySelector('.wsNavFlyoutOverlay')),
        hasDrawerOverlay: Boolean(document.querySelector('.ui-drawerOverlay')),
        drawer: drawerEl
          ? {
              cls: String((drawerEl as any).className || ''),
              aria: String(drawerEl.getAttribute('aria-label') || ''),
              rect: drawerRect
                ? { x: Math.round(drawerRect.x), y: Math.round(drawerRect.y), w: Math.round(drawerRect.width), h: Math.round(drawerRect.height) }
                : null,
            }
          : null,
        leftTop: pick(10, clampY(60)),
        leftMid: pick(10, clampY(180)),
        railHits: railPoints.reduce((acc: any, p) => {
          acc[p.name] = pick(p.x, p.y)
          return acc
        }, {}),
        topRight: pick(vw - 10, clampY(20)),
      },
    })
  }
  // #endregion

  // Debug hook (safe): helps confirm what path the app thinks it's on.
  try {
    ;(window as any).__OPS_DEBUG__ = { pathname: loc.pathname, href: window.location.href, opsPath }
  } catch {
    // ignore
  }

  // Panic reset (URL-driven): helps recover from bad persisted UI state (e.g. stuck drag / collapsed panes).
  // Usage: open https://codesprite.example.com/app?reset=1 in a normal browser (non-incognito).
  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      const sp = url.searchParams
      const reset = sp.get('reset')
      if (reset !== '1' && reset !== 'true') return

      // Best-effort: clear all CodeSprite/CursorLike persisted keys (layout, chat state, connection pointers, etc).
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i) || ''
          if (k.startsWith('codesprite_') || k.startsWith('codesprite_')) localStorage.removeItem(k)
        }
      } catch {
        // ignore
      }

      // Also ensure any lingering global drag styles are cleared.
      try {
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      } catch {
        // ignore
      }

      // Remove reset param to avoid repeated clearing on subsequent refresh.
      sp.delete('reset')
      const clean = url.pathname + (sp.toString() ? `?${sp.toString()}` : '') + url.hash
      window.history.replaceState({}, '', clean)
    } catch {
      // ignore
    }
  }, [])

  // #region agent log
  // Capture overlay/rail/tool layout facts in runtime.
  useEffect(() => {
    if (!__dbgEnabled) return
    try {
      __dbgOverlaySnapshot('probe elementFromPoint & key overlays')
    } catch (e) {
      __dbgPost({
        hypothesisId: 'overlayBlocksRail',
        location: 'App.tsx:overlayProbe',
        message: 'probe failed',
        data: { err: e instanceof Error ? e.message : String(e) },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsPath])

  useEffect(() => {
    if (!__dbgEnabled) return
    const onResize = () => {
      try {
        __dbgOverlaySnapshot('resize')
      } catch {
        // ignore
      }
    }
    try {
      window.addEventListener('resize', onResize)
    } catch {}
    return () => {
      try {
        window.removeEventListener('resize', onResize)
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsPath])
  // #endregion

  // #region agent log
  // When user clicks near the left rail area, record the true hit target (capture phase).
  useEffect(() => {
    if (!__dbgEnabled) return
    const onPointerDown = (e: PointerEvent) => {
      try {
        if (e.clientX > 60) return
        const el = document.elementFromPoint(e.clientX, e.clientY) as any
        const cs = el ? window.getComputedStyle(el) : null
        __dbgPost({
          hypothesisId: 'overlayBlocksRail',
          location: 'App.tsx:railPointerDown',
          message: 'pointerdown near rail (capture)',
          data: {
            x: Math.round(e.clientX),
            y: Math.round(e.clientY),
            tag: el ? String(el.tagName || '').toLowerCase() : null,
            cls: el ? String(el.className || '') : null,
            role: el ? String(el.getAttribute?.('role') || '') : null,
            aria: el ? String(el.getAttribute?.('aria-label') || '') : null,
            pe: cs ? cs.pointerEvents : null,
            zi: cs ? cs.zIndex : null,
            pos: cs ? cs.position : null,
          },
        })
      } catch {
        // ignore
      }
    }
    const onClickCapture = (e: MouseEvent) => {
      try {
        const x = (e as any).clientX as number
        const y = (e as any).clientY as number
        if (typeof x !== 'number' || typeof y !== 'number') return
        if (x > 60) return
        const el = document.elementFromPoint(x, y) as any
        const cs = el ? window.getComputedStyle(el) : null
        __dbgPost({
          hypothesisId: 'overlayBlocksRail',
          location: 'App.tsx:railClickCapture',
          message: 'click near rail (capture)',
          data: {
            x: Math.round(x),
            y: Math.round(y),
            defaultPrevented: Boolean(e.defaultPrevented),
            tag: el ? String(el.tagName || '').toLowerCase() : null,
            cls: el ? String(el.className || '') : null,
            role: el ? String(el.getAttribute?.('role') || '') : null,
            aria: el ? String(el.getAttribute?.('aria-label') || '') : null,
            pe: cs ? cs.pointerEvents : null,
            zi: cs ? cs.zIndex : null,
            pos: cs ? cs.position : null,
          },
        })
      } catch {
        // ignore
      }
    }
    try {
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('click', onClickCapture, true)
    } catch {}
    return () => {
      try {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('click', onClickCapture, true)
      } catch {}
    }
  }, [])
  // #endregion

  const initial = useMemo(() => {
    const persisted = loadState()
    if (persisted && persisted.sessions.length > 0) return persisted

    const s = createDefaultSession()
    return { version: 1 as const, activeId: s.id, sessions: [s] }
  }, [])

  const [sessions, setSessions] = useState<ChatSession[]>(initial.sessions)
  const [activeId, setActiveId] = useState<string>(initial.activeId)
  const [input, setInput] = useState('')
  const [health, setHealth] = useState<HealthState>({ state: 'checking' })
  const [apiBase, setApiBase] = useState<string>(() => loadApiBase())
  const [apiCfgOpen, setApiCfgOpen] = useState(false)
  const [apiCfgDraft, setApiCfgDraft] = useState<string>(() => (apiBase ? apiBase : ''))
  const [apiCfgTest, setApiCfgTest] = useState<{ state: 'idle' | 'ok' | 'error'; detail?: string }>({
    state: 'idle',
  })
  const [sending, setSending] = useState(false)
  const [prefs, setPrefs] = useState<Prefs>(() => loadPrefs())
  const [prefsOpen, setPrefsOpen] = useState(false)

  // Apply theme to entire app (CSS reads `html[data-theme]`).
  useEffect(() => {
    try {
      document.documentElement.dataset.theme = prefs.themeMode || DEFAULT_PREFS.themeMode
    } catch {
      // ignore
    }
  }, [prefs.themeMode])

  const [mode, setMode] = useState<SidebarMode>(() => {
    try {
      // If there's an active remote session pointer, prefer restoring workspace view on refresh.
      const rawConn = localStorage.getItem(ACTIVE_CONN_KEY)
      if (rawConn) {
        const j = JSON.parse(rawConn) as any
        const sid = String(j?.sessionId || '').trim()
        const hid = String(j?.hostId || '').trim()
        if (sid && hid) return 'workspace'
      }

      // Preference: either restore last module, or always start from a default module.
      const p = (() => {
        try {
          return loadPrefs()
        } catch {
          return DEFAULT_PREFS
        }
      })()
      if (!p.rememberLastMode) {
        // Never start in workspace without a live connection.
        return p.defaultMode
      }

      const raw = localStorage.getItem(MODE_KEY)
      if (raw === 'ssh' || raw === 'chat' || raw === 'workspace') return raw as SidebarMode
      if (raw === 'plugins' && PLUGINS_ENABLED) return raw as SidebarMode
      if (raw === 'dashboard' && DASHBOARD_ENABLED) return 'dashboard'
      return p.defaultMode
    } catch {
      return DEFAULT_PREFS.defaultMode
    }
  })

  const opsPathInitialRedirectDoneRef = useRef(false)

  // If user lands on /app/ops/*, keep using the original App shell (sidebar),
  // but render ops workspace inside the "资产管理" module to avoid confusing left-nav changes.
  useEffect(() => {
    if (!opsPath) return
    if (mode !== 'workspace') {
      if (!loadPrefs().rememberLastMode && !opsPathInitialRedirectDoneRef.current) {
        opsPathInitialRedirectDoneRef.current = true
        nav('/app', { replace: true })
        return
      }
      setMode('workspace')
    }
  }, [opsPath, mode])

  useEffect(() => { opsPathInitialRedirectDoneRef.current = true }, [])

  // P0 UX hardening: prevent outer page scroll from shifting layout.
  // (On some Windows + multi-monitor setups, expanding sidebar sections may cause the browser to scroll the document,
  // making the chat area appear to "move down". We keep scrolling inside panels only.)
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const prevHtmlOverflow = html.style.overflow
    const prevBodyOverflow = body.style.overflow
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    return () => {
      html.style.overflow = prevHtmlOverflow
      body.style.overflow = prevBodyOverflow
    }
  }, [])

  // Close prefs drawer on outside click / ESC
  useEffect(() => {
    if (!prefsOpen) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      // ignore clicks inside drawer
      if (target.closest?.('.prefDrawer')) return
      setPrefsOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPrefsOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [prefsOpen])

  // Dashboard UI state
  const [dashTab, setDashTab] = useState<DashTab>('recent')
  const [dashFullscreen, setDashFullscreen] = useState(() => {
    try {
      return localStorage.getItem(DASH_FULLSCREEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const [dashHostSearch, setDashHostSearch] = useState('')
  const [dashHostProbe, setDashHostProbe] = useState<
    Record<string, { state: 'unknown' | 'ok' | 'bad'; latencyMs?: number; os?: string; checkedAt: number }>
  >({})
  const dashHostProbeRef = useRef(dashHostProbe)
  useEffect(() => {
    dashHostProbeRef.current = dashHostProbe
  }, [dashHostProbe])

  const [dashDrawer, setDashDrawer] = useState<DashDrawerState>({ open: false })
  const [dashHighlight, setDashHighlight] = useState<{ kind: 'host' | 'workspace'; id: string; until: number } | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<null | { title: string; desc?: string; confirmText?: string; onConfirm: () => void }>(null)
  const dashGridRef = useRef<HTMLDivElement | null>(null)

  // Cursor-like: inline confirm panel expansion state (per message).
  const [inlineConfirmExpanded, setInlineConfirmExpanded] = useState<Record<string, boolean>>({})

  // Auto-dismiss toasts created via setToast(...) (some call sites don't use showToast()).
  // Keep "action" toasts visible until user interacts.
  useEffect(() => {
    if (!toast) return
    if (toast.actionLabel && toast.onAction) return
    const id = toast.id
    const t = window.setTimeout(() => {
      setToast((cur) => (cur && cur.id === id ? null : cur))
    }, 3000)
    return () => window.clearTimeout(t)
  }, [toast?.id])

  // Workspace edit modal (replace browser prompt)
  const [workspaceEditOpen, setWorkspaceEditOpen] = useState(false)
  const [workspaceEditDraft, setWorkspaceEditDraft] = useState<{ id: ID; name: string; rootPath: string } | null>(null)
  const [workspaceEditErr, setWorkspaceEditErr] = useState('')

  // User/subscription info for sidebar footer & dashboard
  const [me, setMe] = useState<{ email?: string; role?: string } | null>(null)
  const [meLoading, setMeLoading] = useState(true)
  const [billing, setBilling] = useState<{ plan?: string; expiresAt?: number | null } | null>(null)
  const [billingLoading, setBillingLoading] = useState(true)
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [rulesTab, setRulesTab] = useState<'user' | 'project' | 'commands'>('user')
  const [rulesLoading, setRulesLoading] = useState(false)
  const [rulesErr, setRulesErr] = useState('')
  const [userRulesDraft, setUserRulesDraft] = useState('')
  const [projectRulesDraft, setProjectRulesDraft] = useState('')
  const [commandsDraft, setCommandsDraft] = useState('')

  function openRulesModal(tab: 'user' | 'project' | 'commands') {
    setRulesErr('')
    setRulesTab(tab)
    setRulesOpen(true)
    void (async () => {
      try {
        setRulesLoading(true)
        const sid = (activeSpaceId || '').trim() || 'host_config_v1'
        const r = await apiRulesGet({ spaceId: sid })
        setUserRulesDraft(String(r.userRules || ''))
        setProjectRulesDraft(String(r.projectRules || ''))
        setCommandsDraft(String(r.commands || ''))
      } catch (e) {
        setRulesErr(e instanceof Error ? e.message : String(e))
      } finally {
        setRulesLoading(false)
      }
    })()
  }

  // Admin-only: SSH audit viewer (read-only, paginated)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLoading, setAuditLoading] = useState(false)
  const [auditErr, setAuditErr] = useState('')
  const [auditItems, setAuditItems] = useState<any[]>([])
  const [auditSessionIdFilter, setAuditSessionIdFilter] = useState('')
  const [auditEventTypeFilter, setAuditEventTypeFilter] = useState('')
  const [auditCursor, setAuditCursor] = useState<{ beforeStartedAt?: number; beforeId?: string } | null>(null)

  // Chat screenshot attachments (client-side; optionally sent to backend for vision-capable models)
  const [pendingImages, setPendingImages] = useState<ChatImage[]>([])

  // Workspace split view sizing (left file tree vs right chat)
  const [wsLeftW, setWsLeftW] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_SPLIT_W_KEY)
      const n = Number(raw)
      if (Number.isFinite(n) && n >= 260 && n <= 900) return n
    } catch {
      // ignore
    }
    return 520
  })
  // Workspace tools drawer (files + editor + terminal). Default closed to keep workspace lightweight.
  const [wsToolsOpen, setWsToolsOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACE_TOOLS_OPEN_KEY)
      return String(raw || '').trim() === '1'
    } catch {
      // ignore
    }
    return false
  })
  // #region agent log
  // Confirm whether the "X above 刷新" is Drawer close button, and what it covers.
  useEffect(() => {
    try {
      if (!wsToolsOpen) {
        __dbgPost({
          hypothesisId: 'drawerCloseX',
          location: 'App.tsx:drawerProbe',
          message: 'wsToolsOpen=false',
          data: { hasDrawer: Boolean(document.querySelector('.ui-drawer')) },
        })
        return
      }
      const closeBtn = document.querySelector('.ui-drawerClose') as HTMLElement | null
      const refreshBtn = document.querySelector('.wsRefreshBtn') as HTMLElement | null
      const rc = closeBtn?.getBoundingClientRect?.()
      const rr = refreshBtn?.getBoundingClientRect?.()
      __dbgPost({
        hypothesisId: 'drawerCloseX',
        location: 'App.tsx:drawerProbe',
        message: 'drawer close & refresh rects',
        data: {
          hasClose: Boolean(closeBtn),
          hasRefresh: Boolean(refreshBtn),
          closeRect: rc ? { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.width), h: Math.round(rc.height) } : null,
          refreshRect: rr ? { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) } : null,
        },
      })
    } catch (e) {
      __dbgPost({
        hypothesisId: 'drawerCloseX',
        location: 'App.tsx:drawerProbe',
        message: 'drawer probe failed',
        data: { err: e instanceof Error ? e.message : String(e) },
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsToolsOpen])
  // #endregion
  const wsDragRef = useRef<null | { startX: number; startW: number; pointerId?: number; startedAt?: number }>(null)
  const wsDragElRef = useRef<HTMLElement | null>(null)
  const wsDragRafRef = useRef<number | null>(null)
  const wsDragLastXRef = useRef<number>(0)
  const wsDragForceStopRef = useRef<() => void>(() => {})
  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_SPLIT_W_KEY, String(wsLeftW))
    } catch {
      // ignore
    }
  }, [wsLeftW])
  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACE_TOOLS_OPEN_KEY, wsToolsOpen ? '1' : '0')
    } catch {
      // ignore
    }
  }, [wsToolsOpen])

  // Close user menu on outside click / ESC (sidebar footer dropdown UX)
  useEffect(() => {
    if (!userMenuOpen) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      const root = userMenuRef.current
      const target = e.target as Node | null
      if (!root || !target) return
      if (root.contains(target)) return
      setUserMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('touchstart', onDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('touchstart', onDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [userMenuOpen])

  // Workspace splitter drag handlers
  useEffect(() => {
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(n)))
    const forceStop = () => {
      const st = wsDragRef.current
      if (!st) return
      try {
        const el = wsDragElRef.current
        const pid = st.pointerId
        if (el && typeof pid === 'number' && (el as any).hasPointerCapture?.(pid)) {
          ;(el as any).releasePointerCapture?.(pid)
        }
      } catch {
        // ignore
      }
      wsDragRef.current = null
      wsDragElRef.current = null
      if (wsDragRafRef.current !== null) {
        window.cancelAnimationFrame(wsDragRafRef.current)
        wsDragRafRef.current = null
      }
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    // Expose forceStop to event handlers (panic timer).
    wsDragForceStopRef.current = forceStop
    const schedule = () => {
      if (wsDragRafRef.current !== null) return
      wsDragRafRef.current = window.requestAnimationFrame(() => {
        wsDragRafRef.current = null
        const st = wsDragRef.current
        if (!st) return
        const dx = wsDragLastXRef.current - st.startX
        const next = clamp(st.startW + dx, 260, 900)
        setWsLeftW(next)
      })
    }

    const onMove = (e: MouseEvent | PointerEvent) => {
      const st = wsDragRef.current
      if (!st) return
      wsDragLastXRef.current = e.clientX
      schedule()
    }
    const onUp = () => {
      forceStop()
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // Pointer events: fixes "stuck dragging" when mouseup isn't delivered (e.g. pointer leaves window).
    window.addEventListener('pointermove', onMove as any)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // Window blur / tab hidden: emergency stop (prevents pointer-capture "lock").
    window.addEventListener('blur', onUp)
    const onVis = () => {
      if (document.visibilityState !== 'visible') onUp()
    }
    document.addEventListener('visibilitychange', onVis)
    // ESC: emergency cancel (prevents "frozen" feeling).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (!wsDragRef.current) return
      onUp()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('pointermove', onMove as any)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onUp)
      document.removeEventListener('visibilitychange', onVis)
      document.removeEventListener('keydown', onKeyDown, true)
      // avoid stale closures
      wsDragForceStopRef.current = () => {}
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!r.ok) {
          if (!cancelled) setMe(null)
          return
        }
        const j = (await r.json().catch(() => null)) as any
        const u = j?.user || {}
        if (!cancelled) setMe({ email: u.email, role: u.role })
      } catch {
        if (!cancelled) setMe(null)
      } finally {
        if (!cancelled) setMeLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Logged-in: make backend the source-of-truth for module navigation; remove local mode cache to avoid cross-browser divergence.
  useEffect(() => {
    if (!me?.email) return
    try {
      localStorage.removeItem(MODE_KEY)
      // Avoid stale local prefs causing UI divergence; logged-in state will hydrate from backend prefs_v1.
      localStorage.removeItem('codesprite_prefs_v1')
    } catch {
      // ignore
    }
  }, [me?.email])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch('/api/me/billing', { headers: { Accept: 'application/json' }, credentials: 'include' })
        if (!r.ok) {
          if (!cancelled) setBilling(null)
          return
        }
        const j = (await r.json().catch(() => null)) as any
        // Accept various shapes; prefer { plan, expires_at }.
        const plan = (j?.plan || j?.billing?.plan || '').toString()
        const exp = j?.expires_at ?? j?.billing?.expires_at ?? null
        const expiresAt = typeof exp === 'number' ? exp : null
        if (!cancelled) setBilling({ plan, expiresAt })
      } catch {
        if (!cancelled) setBilling(null)
      } finally {
        if (!cancelled) setBillingLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // UI state sync: hydrate last opened module from backend (cross-browser consistency).
  useEffect(() => {
    if (!me?.email) return
    let cancelled = false
    const modeAtStart = mode
    void (async () => {
      try {
        const r = await apiUiStateGet()
        if (cancelled) return

        const hasLiveConn = (() => {
          try {
            const rawConn = localStorage.getItem(ACTIVE_CONN_KEY)
            if (!rawConn) return false
            const j2 = JSON.parse(rawConn) as any
            const sid2 = String(j2?.sessionId || '').trim()
            const hid2 = String(j2?.hostId || '').trim()
            return Boolean(sid2 && hid2)
          } catch {
            return false
          }
        })()

        if (!r) {
          const seed: UiStateV1 = { version: 2, mode: 'chat', workspaceHostId: null }
          try {
            const wr = await apiUiStatePut({ json: seed, source: 'seed' })
            uiRemoteUpdatedAtRef.current = Number(wr.updatedAt) || Date.now()
          } catch {
            // ignore
          }
          uiRemoteRef.current = seed
          uiStateHydratedRef.current = true
          return
        }

        uiRemoteUpdatedAtRef.current = Number(r.updatedAt) || 0
        const j = (r as any)?.json || {}
        const next: UiStateV1 = {
          version: 2,
          mode: normalizeUiMode((j as any)?.mode),
          workspaceHostId: (typeof (j as any)?.workspaceHostId === 'string' && String((j as any).workspaceHostId).trim()
            ? (String((j as any).workspaceHostId).trim() as any)
            : null) as any,
        }
        uiRemoteRef.current = next
        uiStateHydratedRef.current = true
        if (!hasLiveConn && mode === modeAtStart && loadPrefs().rememberLastMode) setMode(next.mode)
      } catch {
        uiStateHydratedRef.current = true
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.email])

  const meLabel = useMemo(() => {
    const email = (me?.email || '').trim()
    if (!email) return ''
    const at = email.indexOf('@')
    if (at <= 2) return email
    return `${email.slice(0, 2)}***${email.slice(at)}`
  }, [me?.email])

  const isPro = useMemo(() => {
    const p = (billing?.plan || '').toLowerCase()
    if (!p) return false
    return p.includes('pro') || p.includes('paid')
  }, [billing?.plan])

  const proExpireText = useMemo(() => {
    const ts = billing?.expiresAt
    if (!ts) return ''
    try {
      const d = new Date(ts)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day} 到期`
    } catch {
      return ''
    }
  }, [billing?.expiresAt])

  async function logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } finally {
      window.location.href = '/'
    }
  }

  async function loadAuditPage(reset: boolean) {
    if (auditLoading) return
    if ((me?.role || '') !== 'admin') {
      setAuditErr('Admin only')
      return
    }
    setAuditLoading(true)
    setAuditErr('')
    try {
      const sid = (auditSessionIdFilter || '').trim()
      const et = (auditEventTypeFilter || '').trim()
      const c = reset ? null : auditCursor
      const r = await apiAdminSshAuditRecent({
        limit: 60,
        sessionId: sid || undefined,
        eventType: et || undefined,
        beforeStartedAt: typeof c?.beforeStartedAt === 'number' ? c.beforeStartedAt : undefined,
        beforeId: (c?.beforeId || '').trim() || undefined,
      })
      const items = Array.isArray(r.items) ? r.items : []
      setAuditItems((prev) => {
        const next = reset ? [] : [...(prev || [])]
        const seen = new Set(next.map((x: any) => String(x?.id || '')))
        for (const it of items) {
          const id = String((it as any)?.id || '')
          if (!id || seen.has(id)) continue
          seen.add(id)
          next.push(it)
        }
        return next
      })
      setAuditCursor((r as any)?.nextCursor || null)
    } catch (e) {
      setAuditErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAuditLoading(false)
    }
  }

  function openPricing() {
    // In product UI, "upgrade/pro/billing" entry points should open the recharge center.
    openRechargeCenter()
  }

  function openRechargeCenter() {
    // Domestic UX: "充值中心" should land on user billing page (balance + orders + ledger),
    // not the marketing pricing page.
    const url = '/me/billing'
    // Open in a new page (Cursor-like behavior: don't break the current workspace context).
    const w = window.open(url, '_blank', 'noopener,noreferrer')
    if (!w) {
      // Fallback if popup blocked
      window.location.href = url
    }
  }

  function createWorkspaceAndEnter(h: Host) {
    const now = Date.now()
    const wsId = uid('ws') as ID
    const wsName = `${h.name || h.address} 工作区`
    const rootPath = '/srv/www'
    setHostCfg((prev) => {
      const exists = prev.workspaces.find((w) => w.assetId === h.id && w.rootPath === rootPath)
      const newWs = exists
        ? { ...exists, lastOpenedAt: now, updatedAt: now }
        : { id: wsId, assetId: h.id, name: wsName, rootPath, pinned: false, lastOpenedAt: now, createdAt: now, updatedAt: now }
      const workspaces = exists ? prev.workspaces.map((w) => (w.id === newWs.id ? newWs : w)) : [newWs, ...prev.workspaces]
      // IMPORTANT: do NOT mark lastConnectedAt here. Real connection must be verified via /api/ssh/exec.
      return fixHostConfigState({ ...prev, workspaces, activeWorkspaceId: newWs.id, activeHostId: h.id })
    })
    setMode('ssh')
  }
  const [openMenuForId, setOpenMenuForId] = useState<string | null>(null)
  const [menuPos, setMenuPos] = useState<{ id: string; top: number; left: number } | null>(null)
  const [wsChatMenuOpen, setWsChatMenuOpen] = useState(false)
  const [wsChatMenuPos, setWsChatMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [wsFileMenuOpen, setWsFileMenuOpen] = useState(false)
  const [wsFileMenuPos, setWsFileMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [wsTermMenuOpen, setWsTermMenuOpen] = useState(false)
  const [wsTermMenuPos, setWsTermMenuPos] = useState<{ top: number; left: number } | null>(null)
  const [sidebarW, setSidebarW] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(SIDEBAR_W_KEY)
      const n = raw ? Number(raw) : NaN
      if (!Number.isFinite(n)) return 280
      return Math.min(520, Math.max(240, n))
    } catch {
      return 280
    }
  })
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_COLLAPSED_KEY)
      return v === null ? true : v === '1'
    } catch {
      return true
    }
  })

  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [wsNavFlyout, setWsNavFlyout] = useState<null | 'chat' | 'assets' | 'plugins'>(null)
  const wsHeaderRef = useRef<HTMLDivElement | null>(null)
  const [isNarrow, setIsNarrow] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined' ? window.innerWidth < 1100 : false
    } catch {
      return false
    }
  })

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 960) setMobileSidebarOpen(false)
      setIsNarrow(window.innerWidth < 1100)
    }
    onResize()
    window.addEventListener('resize', onResize, { passive: true })
    return () => window.removeEventListener('resize', onResize as any)
  }, [])

  // Workspace tools layout:
  // - narrow/mobile: use Drawer overlay to save space
  // - wide: use pinned tools pane (IDE-like)
  const forcePinnedTools = (() => {
    try {
      const sp = new URL(window.location.href).searchParams
      const v = String(sp.get('pinnedTools') || '').trim()
      return v === '1' || v === 'true'
    } catch {
      return false
    }
  })()
  const useDrawerTools = (isNarrow || mobileSidebarOpen) && !forcePinnedTools
  const showPinnedTools = wsToolsOpen && !useDrawerTools

  // #region agent log
  useEffect(() => {
    try {
      __dbgOverlaySnapshot(
        `state mode=${mode} isNarrow=${isNarrow} useDrawerTools=${useDrawerTools} toolsOpen=${wsToolsOpen} flyout=${wsNavFlyout || ''}`,
      )
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isNarrow, useDrawerTools, wsToolsOpen, wsNavFlyout])

  useEffect(() => {
    try {
      __dbgPost({
        hypothesisId: 'flyoutAutoClose',
        location: 'App.tsx:flyoutState',
        message: 'wsNavFlyout changed',
        data: { mode, wsNavFlyout: wsNavFlyout || null },
      })
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsNavFlyout])
  // #endregion

  // Keep flyout below the workspace header (prevents header z-index from blocking flyout top area).
  useEffect(() => {
    if (mode !== 'workspace') {
      try {
        document.documentElement.style.removeProperty('--wsHeaderH')
      } catch {}
      return
    }
    const el = wsHeaderRef.current
    if (!el) return
    const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(n)))
    const apply = () => {
      try {
        const h = el.getBoundingClientRect ? el.getBoundingClientRect().height : 0
        const v = clamp(Number.isFinite(h) ? h : 56, 44, 220)
        document.documentElement.style.setProperty('--wsHeaderH', `${v}px`)
      } catch {
        // ignore
      }
    }
    apply()
    let ro: ResizeObserver | null = null
    try {
      if (typeof (window as any).ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(() => apply())
        ro.observe(el)
      }
    } catch {
      // ignore
    }
    try {
      window.addEventListener('resize', apply, { passive: true } as any)
    } catch {}
    return () => {
      try {
        ro?.disconnect()
      } catch {}
      try {
        window.removeEventListener('resize', apply as any)
      } catch {}
      try {
        document.documentElement.style.removeProperty('--wsHeaderH')
      } catch {}
    }
  }, [mode])

  const [models, setModels] = useState<string[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_KEY) ?? ''
    } catch {
      return ''
    }
  })

  function apiUrl(path: string) {
    const p = path.startsWith('/') ? path : `/${path}`
    const base = normalizeApiBase(apiBase)
    return base ? `${base}${p}` : p
  }

  async function apiFetch(path: string, init?: RequestInit) {
    // Product endpoints are cookie-based; always include credentials (works for same-origin and CORS-with-credentials).
    return await fetch(apiUrl(path), { credentials: 'include', ...init })
  }

  function apiDetailMessage(detail: any, fallback: string): string {
    if (typeof detail === 'string' && detail.trim()) return detail.trim()
    if (!detail || typeof detail !== 'object') return fallback
    const code = String(detail.code || '').trim()
    if (code === 'Cooldown') {
      const retryAfter = Number(detail.retryAfter)
      return Number.isFinite(retryAfter) && retryAfter > 0 ? `操作过快，请 ${retryAfter} 秒后重试。` : '操作过快，请稍后重试。'
    }
    if (code === 'SshTrialEnded') {
      return 'SSH 试用已结束，请订阅或充值后再试。'
    }
    if (code === 'SshTrialSessionLimit') {
      const used = Number(detail.sessionsUsed)
      const limit = Number(detail.sessionsPerDay)
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
        return `今日连接次数已用完（${used}/${limit}），请明天再试或开通更高权限。`
      }
      return '今日连接次数已用完，请明天再试或开通更高权限。'
    }
    if (code === 'SshTrialOpsLimit') {
      const used = Number(detail.opsUsed)
      const limit = Number(detail.opsPerDay)
      if (Number.isFinite(used) && Number.isFinite(limit) && limit > 0) {
        return `今日终端操作次数已用完（${used}/${limit}），请明天再试或开通更高权限。`
      }
      return '今日终端操作次数已用完，请明天再试或开通更高权限。'
    }
    if (typeof detail.hint === 'string' && detail.hint.trim()) return detail.hint.trim()
    try {
      const raw = JSON.stringify(detail)
      return raw && raw !== '{}' ? raw : fallback
    } catch {
      return fallback
    }
  }

  async function apiInventoryGetState(opts: { spaceId: string }) {
    const sid = String(opts.spaceId || '').trim()
    const res = await apiFetch(`/api/inventory/state?spaceId=${encodeURIComponent(sid)}`, { cache: 'no-store' } as any)
    if (res.status === 404) return null
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; spaceId: string; json: any; updatedAt: number }
  }

  async function apiInventoryPutState(opts: { spaceId: string; json: any; baseUpdatedAt?: number; source?: string }) {
    const sid = String(opts.spaceId || '').trim()
    const res = await apiFetch('/api/inventory/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spaceId: sid,
        json: opts.json,
        baseUpdatedAt: typeof opts.baseUpdatedAt === 'number' ? opts.baseUpdatedAt : undefined,
        source: typeof opts.source === 'string' ? opts.source : undefined,
      }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; spaceId: string; updatedAt: number }
  }

  function normalizeUiMode(v: any): SidebarMode {
    const s = String(v || '').trim()
    if (s === 'chat' || s === 'ssh' || s === 'workspace') return s as SidebarMode
    if (s === 'plugins' && PLUGINS_ENABLED) return s as SidebarMode
    if (s === 'dashboard' && DASHBOARD_ENABLED) return 'dashboard'
    return 'chat'
  }

  async function apiUiStateGet() {
    return await apiInventoryGetState({ spaceId: UI_STATE_SPACE_ID })
  }

  async function apiUiStatePut(opts: { json: UiStateV1; baseUpdatedAt?: number; source?: string }) {
    return await apiInventoryPutState({
      spaceId: UI_STATE_SPACE_ID,
      json: opts.json,
      baseUpdatedAt: opts.baseUpdatedAt,
      source: opts.source,
    })
  }

  async function apiInventorySaveCredential(opts: { kind: 'password' | 'ssh_key'; secret: any; note?: string }) {
    const res = await apiFetch('/api/inventory/credentials/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: opts.kind, secret: opts.secret, note: opts.note }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(apiDetailMessage(j?.detail, `HTTP ${res.status}`))
    if (!j?.ok || !j?.credentialId) throw new Error(apiDetailMessage(j?.detail, 'bad response'))
    return j as { ok: true; credentialId: string; kind: string; updatedAt: number; createdAt: number }
  }

  async function apiAdminSshAuditRecent(opts: {
    limit: number
    sessionId?: string
    eventType?: string
    beforeStartedAt?: number
    beforeId?: string
  }) {
    const sp = new URLSearchParams()
    sp.set('limit', String(Math.max(1, Math.min(200, Number(opts.limit || 50) || 50))))
    if (opts.sessionId) sp.set('sessionId', String(opts.sessionId))
    if (opts.eventType) sp.set('eventType', String(opts.eventType))
    if (typeof opts.beforeStartedAt === 'number' && Number.isFinite(opts.beforeStartedAt)) sp.set('beforeStartedAt', String(opts.beforeStartedAt))
    if (opts.beforeId) sp.set('beforeId', String(opts.beforeId))
    const res = await apiFetch(`/api/admin/ssh/audit/recent?${sp.toString()}`, { cache: 'no-store' } as any)
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; items: any[]; nextCursor?: { beforeStartedAt?: number; beforeId?: string } | null }
  }

  function showToast(next: Omit<ToastState, 'id'>) {
    const id = uid('toast')
    setToast({ id, ...next })
    window.setTimeout(() => {
      setToast((cur) => (cur && cur.id === id ? null : cur))
    }, 3000)
  }

  async function sshTestTcp(input: { address: string; port: number }) {
    try {
      const res = await apiFetch('/api/ssh/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: input.address, port: input.port }),
      })

      const raw = await res.text().catch(() => '')
      const j = (() => {
        try {
          return raw ? (JSON.parse(raw) as any) : null
        } catch {
          return null
        }
      })()

      if (!res.ok) {
        // Best-effort extract a user-friendly message, but keep it short for footer UI.
        let msg = `HTTP ${res.status}`
        const detail = j?.detail
        if (typeof detail === 'string' && detail.trim()) msg = detail.trim()
        else if (detail && typeof detail === 'object') msg = String(detail?.hint || detail?.code || msg)
        else if (j?.error) msg = String(j.error)
        else if (raw) msg = String(raw).slice(0, 160)
        return { success: false, latencyMs: null, os: 'Unknown', error: msg }
      }

      if (!j?.ok) return { success: false, latencyMs: null, os: 'Unknown', error: String(j?.error || 'bad response') }
      return {
        success: Boolean(j?.success),
        latencyMs: typeof j?.latency_ms === 'number' ? (j.latency_ms as number) : null,
        os: (j?.os as string) || 'Unknown',
        error: (j?.error as string) || '',
      }
    } catch (e: any) {
      const msg = typeof e?.message === 'string' && e.message.trim() ? e.message.trim() : '网络错误'
      return { success: false, latencyMs: null, os: 'Unknown', error: msg.slice(0, 160) }
    }
  }

  // --- P0 Remote (exec + files) ---
  type RemoteAuthDraft = { type: HostAuthType; password: string; sshKey: string; passphrase: string; credentialId?: ID | null }
  type RemotePanelState =
    | null
    | {
        kind: 'terminal' | 'files'
        hostId: ID
        rootPath: string
        path: string
        openFile?: string | null
      }

  const [remotePanel, setRemotePanel] = useState<RemotePanelState>(null)
  const [remoteAuth, setRemoteAuth] = useState<RemoteAuthDraft>({
    type: 'password',
    password: '',
    sshKey: '',
    passphrase: '',
    credentialId: null,
  })
  // In-memory (per page lifetime): remember per-host SSH username override for reconnect.
  // - Only used when user overrides username in connect modal without persisting to asset.
  // - Not persisted to localStorage for safety/intent clarity.
  const wsSshUserOverrideByHostRef = useRef<Map<string, string>>(new Map())
  const [remoteBusy, setRemoteBusy] = useState(false)
  const [remoteErr, setRemoteErr] = useState('')
  const [activeConn, setActiveConn] = useState<
    | null
    | {
        hostId: ID
        sessionId?: string | null
        rootPath: string
        path: string
        openFile?: string | null
        ttlSec?: number
        expiresAt?: number
        expired?: boolean
        lastError?: string
      }
  >(() => {
    try {
      const raw = localStorage.getItem(ACTIVE_CONN_KEY)
      if (!raw) return null
      const j = JSON.parse(raw) as any
      const hostId = String(j?.hostId || '').trim()
      const sessionId = String(j?.sessionId || '').trim()
      const rootPath = String(j?.rootPath || '').trim() || '/root'
      const path = String(j?.path || '').trim() || rootPath
      const openFile = typeof j?.openFile === 'string' ? String(j.openFile || '').trim() : ''
      if (!hostId) return null
      const ttlSec = Number(j?.ttlSec)
      const expiresAt = Number(j?.expiresAt)
      const expired = Boolean(j?.expired || false)
      return {
        hostId: hostId as any,
        sessionId: sessionId || null,
        rootPath,
        path,
        openFile: openFile || null,
        ttlSec: Number.isFinite(ttlSec) ? ttlSec : undefined,
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
        expired: expired || !sessionId,
      }
    } catch {
      return null
    }
  })

  const wsPathInputRef = useRef<HTMLInputElement | null>(null)
  const [wsPathDraft, setWsPathDraft] = useState<string>(() => {
    try {
      return (activeConn?.path || '').trim()
    } catch {
      return ''
    }
  })
  // Prevent terminal from stealing focus unless user explicitly clicked the terminal.
  const wsTermUserWantsFocusRef = useRef(false)

  function calcAnchoredMenuPos(input: { rect: DOMRect; approxW: number; approxH: number; margin?: number }) {
    const { rect, approxW, approxH } = input
    const margin = typeof input.margin === 'number' ? input.margin : 10
    const vw = window.innerWidth || 1200
    const vh = window.innerHeight || 800
    // prefer aligning right edge with trigger
    const left = Math.max(margin, Math.min(vw - approxW - margin, rect.right - approxW))
    // flip upward if near bottom
    const spaceBelow = vh - rect.bottom
    const canOpenUp = rect.top > approxH + margin
    const wantUp = spaceBelow < approxH + 12 && canOpenUp
    const rawTop = wantUp ? rect.top - approxH - 8 : rect.bottom + 8
    const top = Math.max(margin, Math.min(vh - approxH - margin, rawTop))
    return { top, left }
  }
  const [connectModal, setConnectModal] = useState<
    | null
    | {
        open: true
        hostId: ID
        rootPath: string
        sshUser: string
        persistSshUser: boolean
        auth: RemoteAuthDraft
        remember: boolean
      }
  >(null)

  const [termCmd, setTermCmd] = useState('')
  const [termCwd, setTermCwd] = useState('')
  const [termLog, setTermLog] = useState<Array<{ ts: number; cmd: string; stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>>(
    [],
  )
  const [sysProbeBusy, setSysProbeBusy] = useState(false)
  const [cmdRunBusyForMsg, setCmdRunBusyForMsg] = useState<string>('')
  type CmdAutoRunMode = 'unset' | 'ask' | 'allowlist' | 'all'
  const CMD_AUTORUN_KEY = 'codesprite_cmd_autorun_v1'
  const CMD_ALLOWLIST_KEY = 'codesprite_cmd_allowlist_v1'
  const [cmdAutoRunMode, setCmdAutoRunMode] = useState<CmdAutoRunMode>(() => {
    try {
      const v = String(localStorage.getItem(CMD_AUTORUN_KEY) || '').trim()
      // Backward compat: older UI stored 'unset' meaning "user hasn't chosen".
      // New default: do NOT force user to choose; default to allowlist.
      if (v === 'unset') return 'allowlist'
      if (v === 'allowlist' || v === 'all' || v === 'ask') return v as any
      // No value means default policy (no extra UI prompt)
      return 'allowlist'
    } catch {
      return 'allowlist'
    }
  })
  const [cmdAllowlist, setCmdAllowlist] = useState<string[]>(() => {
    try {
      const raw = String(localStorage.getItem(CMD_ALLOWLIST_KEY) || '').trim()
      const arr = raw ? (JSON.parse(raw) as any) : []
      if (!Array.isArray(arr)) return []
      return arr.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 200)
    } catch {
      return []
    }
  })
  // Cursor-like: AI tool-call execution policy (Ask / Allowlist / Run Everything)
  type ToolAutoRunMode = 'unset' | 'ask' | 'allowlist' | 'all'
  const TOOL_AUTORUN_KEY = 'codesprite_tool_autorun_v1'
  const TOOL_ALLOWLIST_KEY = 'codesprite_tool_allowlist_v1'
  const [toolAutoRunMode, setToolAutoRunMode] = useState<ToolAutoRunMode>(() => {
    try {
      const v = String(localStorage.getItem(TOOL_AUTORUN_KEY) || '').trim()
      if (v === 'unset') return 'allowlist'
      if (v === 'allowlist' || v === 'all' || v === 'ask') return v as any
      return 'allowlist'
    } catch {
      return 'allowlist'
    }
  })
  const [toolAllowlist, setToolAllowlist] = useState<string[]>(() => {
    try {
      const raw = String(localStorage.getItem(TOOL_ALLOWLIST_KEY) || '').trim()
      const arr = raw ? (JSON.parse(raw) as any) : []
      if (!Array.isArray(arr)) return []
      return arr.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 500)
    } catch {
      return []
    }
  })
  // Workspace interactive terminal (PTY over WS)
  const wsTermElRef = useRef<HTMLDivElement | null>(null)
  const wsTermWsRef = useRef<WebSocket | null>(null)
  const wsTermXRef = useRef<XTerm | null>(null)
  const wsTermFitRef = useRef<FitAddon | null>(null)
  const wsTermVisibleRef = useRef<boolean>(false)
  const [wsTermPtyActive, setWsTermPtyActive] = useState(false)
  const wsTermPtyLeaseIdRef = useRef<string>('')
  // Capture terminal transcript for "Add to context" (Cursor-like behavior).
  // NOTE: PTY is interactive; relying on exec-based termLog misses commands typed in xterm.
  const [wsTermCtxVer, setWsTermCtxVer] = useState(0)
  const wsTermCtxRafRef = useRef<number>(0)
  const wsTermTranscriptRef = useRef<string>('')
  const wsTermInputLineRef = useRef<string>('') // best-effort capture of entered command lines
  const wsTermCwdRef = useRef<string>('.') // cwd used by terminal prompt (Phase 1: command-event terminal)
  const wsTermExecBusyRef = useRef<boolean>(false)
  const wsTermPromptUserRef = useRef<string>('') // whoami
  const wsTermPromptHostRef = useRef<string>('') // hostname

  // Workspace: when tools drawer is closed, dispose xterm/PTY to avoid hidden background sessions.
  useEffect(() => {
    if (mode !== 'workspace') return
    if (wsToolsOpen) return
    if (!wsTermXRef.current && !wsTermWsRef.current) return
    try {
      wsTermDispose()
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, wsToolsOpen])

  type CommandSource = 'user_terminal' | 'ai' | 'ui_button'
  type CommandEventStatus = 'pending' | 'executed' | 'failed'
  type CommandEvent = {
    eventId: string
    source: CommandSource
    // original user/AI input
    originalCommand: string
    // actually executed command after rewrite (may equal originalCommand)
    rewrittenCommand: string
    mode: 'once' | 'snapshot'
    rewriteReason: 'none' | 'interactive_to_snapshot' | 'stream_to_snapshot'
    intent: 'system_monitoring' | 'file_inspection' | 'other'
    cwd: string
    assetId: string
    workspaceId: string
    timestamp: string
    status: CommandEventStatus
    stdout: string
    stderr: string
    exitCode: number | null
    timedOut?: boolean
  }
  type TerminalState = {
    cwd: string
    lastEventId: string
    lastCommand: string
    exitCode: number | null
    stdout: string
    stderr: string
    timestamp: string
  }

  type TerminalStateModel = {
    session_id: string
    os: 'linux' | 'windows' | 'macos'
    shell: 'bash' | 'zsh' | 'powershell' | 'cmd'
    cwd: string
    last_updated: number
    inactive?: boolean
    confidenceLevel?: 'HIGH' | 'MEDIUM' | 'LOW'
    staleReason?: 'mode_switch' | 'timeout' | 'manual_intervention'
    snapshotTime?: number
    command_history: Array<{
      id: string
      raw_command: string
      normalized_command: string
      execution_mode: 'ask' | 'plan' | 'execute' | 'debug'
      timestamp: number
      exit_code: number | null
    }>
    fs_snapshot?: {
      last_ls_path: string
      entries: Array<{ name: string; type: 'file' | 'dir' }>
    }
    resource_snapshot?: {
      memory?: { total?: string; available?: string }
      cpu?: { load_avg?: [number, number, number] }
    }
  }

  const [commandEvents, setCommandEvents] = useState<CommandEvent[]>([])
  const [lastTerminalState, setLastTerminalState] = useState<TerminalState | null>(null)
  const [terminalState, setTerminalState] = useState<TerminalStateModel | null>(null)
  const terminalStateRef = useRef<TerminalStateModel | null>(null)

  const TERMINAL_STATE_KEY = 'codesprite_terminal_state_v1'

  function _aiExecModeFromUiMode(m: AiUiMode): 'ask' | 'plan' | 'execute' | 'debug' {
    if (m === 'debug') return 'debug'
    if (m === 'agent') return 'execute'
    if (m === 'plan') return 'plan'
    return 'ask'
  }

  function aiUiModeStorageKey(input: { spaceId: string; hostId: string }) {
    return `${AI_UI_MODE_KEY}:${(input.spaceId || 'host_config_v1').trim()}:${(input.hostId || '').trim()}`
  }

  const [aiUiMode, setAiUiMode] = useState<AiUiMode>(() => {
    try {
      // Default to Agent in workspace (practical default), but will be overridden per-host if stored.
      return 'agent'
    } catch {
      return 'agent'
    }
  })

  function aiModeForTerminalState(): 'ask' | 'plan' | 'execute' | 'debug' {
    return _aiExecModeFromUiMode(aiUiMode)
  }

  function safeActiveSpaceId(): string {
    try {
      return String(localStorage.getItem(SPACE_ACTIVE_KEY) || '').trim() || 'host_config_v1'
    } catch {
      return 'host_config_v1'
    }
  }

  function terminalStateStorageKey(input: { spaceId: string; hostId: string }) {
    return `${TERMINAL_STATE_KEY}:${(input.spaceId || 'host_config_v1').trim()}:${(input.hostId || '').trim()}`
  }

  function persistTerminalState(next: TerminalStateModel | null) {
    terminalStateRef.current = next
    setTerminalState(next)
    try {
      if (!next) return
      const hostId = (activeConn?.hostId || '').trim()
      const spaceId = safeActiveSpaceId()
      if (!hostId) return
      const key = terminalStateStorageKey({ spaceId, hostId })
      const slim: TerminalStateModel = { ...next, command_history: (next.command_history || []).slice(-80) }
      localStorage.setItem(key, JSON.stringify(slim))
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    try {
      const hostId = (activeConn?.hostId || '').trim()
      const spaceId = safeActiveSpaceId()
      if (!hostId) return

      // Load per-host AI mode (Ask/Plan/Agent/Debug) and keep it independent from terminal state.
      try {
        const mk = aiUiModeStorageKey({ spaceId, hostId })
        const rawM = String(localStorage.getItem(mk) || '').trim().toLowerCase()
        if (rawM === 'ask' || rawM === 'plan' || rawM === 'agent' || rawM === 'debug') {
          setAiUiMode(rawM as AiUiMode)
        }
      } catch {
        // ignore
      }

      const key = terminalStateStorageKey({ spaceId, hostId })
      const raw = String(localStorage.getItem(key) || '').trim()
      const loaded = raw ? (JSON.parse(raw) as any) : null
      const sessionId = String(activeConn?.sessionId || '').trim()
      const cwd = String(activeConn?.path || '').trim() || String(loaded?.cwd || '.')
      const base: TerminalStateModel = {
        session_id: sessionId || String(loaded?.session_id || ''),
        os: (loaded?.os as any) || 'linux',
        shell: (loaded?.shell as any) || 'bash',
        cwd,
        last_updated: Number(loaded?.last_updated || Date.now()) || Date.now(),
        inactive: Boolean(loaded?.inactive) ? Boolean(loaded?.inactive) : false,
        confidenceLevel: (loaded?.confidenceLevel as any) || 'HIGH',
        staleReason: loaded?.staleReason,
        snapshotTime: typeof loaded?.snapshotTime === 'number' ? loaded.snapshotTime : Number(loaded?.last_updated || Date.now()) || Date.now(),
        command_history: Array.isArray(loaded?.command_history) ? loaded.command_history.slice(-80) : [],
        fs_snapshot: loaded?.fs_snapshot,
        resource_snapshot: loaded?.resource_snapshot,
      }
      // Always bind to current active workspace session (when present)
      if (sessionId) base.session_id = sessionId
      base.inactive = false
      // IMPORTANT: when we have a live sessionId, terminal state should be considered fresh.
      // This prevents stale localStorage data (e.g. previous timeout) from blocking execution.
      if (sessionId) {
        const now = Date.now()
        base.last_updated = now
        base.snapshotTime = now
        // Only override trust downgrades caused by timeout; keep manual_intervention semantics.
        if (base.staleReason === 'timeout') base.staleReason = undefined
        if (base.confidenceLevel === 'LOW') base.confidenceLevel = 'HIGH'
      }
      persistTerminalState(base)
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConn?.hostId, activeConn?.sessionId, activeConn?.path])

  function pushCommandEvent(ev: CommandEvent) {
    setCommandEvents((prev) => {
      const next = [...prev, ev]
      return next.slice(Math.max(0, next.length - 80))
    })
    try {
      const now = Date.now()
      const prev = terminalStateRef.current
      const sessionId = String(activeConn?.sessionId || '').trim()
      const base: TerminalStateModel =
        prev || ({ session_id: sessionId, os: 'linux', shell: 'bash', cwd: ev.cwd || '.', last_updated: now, command_history: [] } as any)
      const hist = (base.command_history || []).slice(-79)
      hist.push({
        id: ev.eventId,
        raw_command: ev.originalCommand,
        normalized_command: ev.rewrittenCommand,
        execution_mode: aiModeForTerminalState(),
        timestamp: now,
        exit_code: null,
      })
      const nextState: TerminalStateModel = {
        ...base,
        session_id: sessionId || base.session_id,
        cwd: (ev.cwd || base.cwd || '.').trim() || '.',
        last_updated: now,
        snapshotTime: now,
        inactive: false,
        confidenceLevel: 'HIGH',
        staleReason: undefined,
        command_history: hist,
      }
      if (Array.isArray(fsItems) && fsItems.length) {
        nextState.fs_snapshot = {
          last_ls_path: nextState.cwd,
          entries: fsItems.slice(0, 300).map((x) => ({ name: x.name, type: x.isDir ? 'dir' : 'file' })),
        }
      }
      persistTerminalState(nextState)
    } catch {
      // ignore
    }
  }

  function patchCommandEvent(eventId: string, patch: Partial<CommandEvent>) {
    setCommandEvents((prev) => prev.map((x) => (x.eventId === eventId ? { ...x, ...patch } : x)))
    try {
      const prev = terminalStateRef.current
      if (!prev) return
      const now = Date.now()
      const hist = (prev.command_history || []).map((h) =>
        h.id === eventId ? { ...h, exit_code: typeof patch.exitCode === 'number' ? patch.exitCode : patch.exitCode === null ? null : h.exit_code } : h,
      )
      persistTerminalState({ ...prev, command_history: hist, last_updated: now, snapshotTime: now, confidenceLevel: 'HIGH', staleReason: undefined })
    } catch {
      // ignore
    }
  }

  function wsTermBumpCtxVer() {
    if (wsTermCtxRafRef.current) return
    wsTermCtxRafRef.current = requestAnimationFrame(() => {
      wsTermCtxRafRef.current = 0
      setWsTermCtxVer((v) => v + 1)
    })
  }

  function wsTermAppendTranscript(chunk: string) {
    if (!chunk) return
    try {
      const MAX = 18_000 // keep below backend per-item limit (20k) with some header room
      const prev = wsTermTranscriptRef.current || ''
      let next = prev + chunk
      if (next.length > MAX) next = next.slice(next.length - MAX)
      wsTermTranscriptRef.current = next
      wsTermBumpCtxVer()
    } catch {
      // ignore
    }
  }

  function wsTermDispose() {
    const ws = wsTermWsRef.current
    wsTermWsRef.current = null
    const lid = (wsTermPtyLeaseIdRef.current || '').trim()
    wsTermPtyLeaseIdRef.current = ''
    try {
      if (lid) void apiPtyLeaseEnd({ leaseId: lid }).catch(() => {})
    } catch {
      // ignore
    }
    try {
      if (wsTermPtyActive) setWsTermPtyActive(false)
    } catch {
      // ignore
    }
    try {
      ws?.close()
    } catch {
      // ignore
    }
    const term = wsTermXRef.current
    wsTermXRef.current = null
    wsTermFitRef.current = null
    try {
      term?.dispose()
    } catch {
      // ignore
    }
  }

  function wsTermSafeFitAndResize() {
    const term = wsTermXRef.current
    const fit = wsTermFitRef.current
    const el = wsTermElRef.current
    if (!term || !fit || !el) return
    try {
      if (el.clientWidth <= 0 || el.clientHeight <= 0) return
      // Cursor-like: dynamically tighten terminal by reducing font size when pane becomes narrow.
      // This keeps more columns visible during horizontal split drags without recreating the terminal.
      try {
        const w = el.getBoundingClientRect().width || el.clientWidth
        const wantFont = w < 420 ? 10 : w < 560 ? 11 : w > 980 ? 13 : 12
        const curFont = Number((term as any)?.options?.fontSize) || 12
        if (curFont !== wantFont) {
          const anyTerm = term as any
          if (typeof anyTerm.setOption === 'function') anyTerm.setOption('fontSize', wantFont)
          else if (anyTerm.options) anyTerm.options.fontSize = wantFont
        }
      } catch {
        // ignore
      }
      fit.fit()
      // PTY: notify backend for correct line wrapping.
      try {
        const ws = wsTermWsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
        }
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  }

  const [fsItems, setFsItems] = useState<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>([])
  const [fsContent, setFsContent] = useState<string>('')
  const [fsDirty, setFsDirty] = useState(false)
  const fsAutoKeyRef = useRef<string>('')
  const openFileAutoKeyRef = useRef<string>('')

  type ChatCtxItem = {
    id: string
    kind: string
    title: string
    content: string
    pinned?: boolean
    // "once": used for the next send then auto-removed (unless pinned)
    // "sticky": stays until user removes/clears
    scope?: 'once' | 'sticky'
  }
  const [chatCtxItems, setChatCtxItems] = useState<Array<ChatCtxItem>>([])
  const [ctxHoverId, setCtxHoverId] = useState<string | null>(null)
  const [ctxPreview, setCtxPreview] = useState<null | { title: string; content: string }>(null)

  // P0: @ mention for file context (workspace mode)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionActiveIdx, setMentionActiveIdx] = useState(0)

  // P0: vertical splitter between messages and composer (workspace/chat)
  const CHAT_BOTTOM_H_KEY = 'codesprite_chat_bottom_h_v1'
  const WS_CHAT_BOTTOM_H_KEY = 'codesprite_workspace_chat_bottom_h_v1'
  const WS_TERM_H_KEY = 'codesprite_workspace_term_h_v1'
  const WS_TERM_OPEN_KEY = 'codesprite_workspace_term_open_v1'
  const [chatBottomH, setChatBottomH] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(CHAT_BOTTOM_H_KEY)
      const n = Number(raw || '')
      // Guard against older persisted values (e.g. 1px) that can "hide" the composer.
      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(v)))
      return Number.isFinite(n) ? clamp(n, 140, 520) : 220
    } catch {
      return 220
    }
  })
  const [wsChatBottomH, setWsChatBottomH] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(WS_CHAT_BOTTOM_H_KEY)
      const n = Number(raw || '')
      // In workspace mode we use this value as textarea maxHeight (not a fixed row height).
      // Guard against older persisted values (e.g. 1px) that can "hide" the textarea.
      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(v)))
      return Number.isFinite(n) ? clamp(n, 80, 260) : 120
    } catch {
      return 120
    }
  })
  const [wsTermH, setWsTermH] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(WS_TERM_H_KEY)
      const n = Number(raw || '')
      // Cursor-like: terminal is hidden by default and is revealed by dragging the bottom splitter up.
      // Allow expanding much larger than 420px (up to a safe cap); actual layout will clamp by container height.
      return Number.isFinite(n) && n >= 0 ? Math.min(Math.max(0, n), 1400) : 0
    } catch {
      return 0
    }
  })
  const [wsTermOpen, setWsTermOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(WS_TERM_OPEN_KEY)
      if (raw === null || raw === undefined) return false
      return raw === '1' || raw === 'true'
    } catch {
      return false
    }
  })
  const wsTermRestoreOnceRef = useRef(false)
  const chatVDragRef = useRef<
    null | { startY: number; startH: number; target: 'chat' | 'workspace' | 'ws_term'; pointerId?: number; maxH?: number }
  >(null)

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_BOTTOM_H_KEY, String(chatBottomH))
    } catch {
      // ignore
    }
  }, [chatBottomH])

  useEffect(() => {
    try {
      localStorage.setItem(WS_CHAT_BOTTOM_H_KEY, String(wsChatBottomH))
    } catch {
      // ignore
    }
  }, [wsChatBottomH])

  useEffect(() => {
    try {
      localStorage.setItem(WS_TERM_H_KEY, String(wsTermH))
    } catch {
      // ignore
    }
  }, [wsTermH])

  useEffect(() => {
    try {
      localStorage.setItem(WS_TERM_OPEN_KEY, wsTermOpen ? '1' : '0')
    } catch {
      // ignore
    }
  }, [wsTermOpen])

  // Restore terminal visibility after refresh:
  // - wsTermH is the last height (can be missing/zero due to storage edge cases)
  // - wsTermOpen is the user's intent ("I had terminal open")
  useEffect(() => {
    if (wsTermRestoreOnceRef.current) return
    if (!wsTermOpen) return
    if (wsTermH > 0) return
    wsTermRestoreOnceRef.current = true
    setWsTermH(220)
  }, [wsTermOpen, wsTermH])

  // Keep wsTermOpen in sync with explicit user actions on height.
  useEffect(() => {
    if (wsTermH > 0) {
      if (!wsTermOpen) setWsTermOpen(true)
    } else {
      // Do not auto-close unless we've already attempted restore once (i.e. user dragged/collapsed).
      if (wsTermOpen && wsTermRestoreOnceRef.current) setWsTermOpen(false)
    }
  }, [wsTermH, wsTermOpen])

  useEffect(() => {
    function onMove(e: MouseEvent | PointerEvent) {
      const st = chatVDragRef.current
      if (!st) return
      const dy = e.clientY - st.startY
      // Use integer pixels but avoid over-rounding that makes small drags feel "sticky".
      const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Math.trunc(n)))
      const rawNext = st.startH - dy
      if (st.target === 'chat') setChatBottomH(clamp(rawNext, 140, 520))
      else if (st.target === 'workspace') setWsChatBottomH(clamp(rawNext, 80, 260))
      else {
        const maxH = typeof st.maxH === 'number' && Number.isFinite(st.maxH) ? st.maxH : 1400
        const next = clamp(rawNext, 0, maxH)
        setWsTermH(next)
        setWsTermOpen(next > 0)
        if (next === 0) wsTermRestoreOnceRef.current = true
      }
    }
    function onUp() {
      const st = chatVDragRef.current
      if (!st) return
      chatVDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // Pointer events (better UX across devices; also fixes stuck cursor when using setPointerCapture).
    window.addEventListener('pointermove', onMove as any)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('pointermove', onMove as any)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  function getMentionQuery(v: string): string | null {
    // Match the last token that starts with "@", not containing whitespace.
    // Examples: "帮我看下 @a.txt" -> "a.txt"; "@./foo" -> "./foo"; "@ /bad" -> null
    const m = v.match(/(^|[\s(])@([^\s@]{0,200})$/)
    if (!m) return null
    return m[2] || ''
  }

  function joinPath(base: string, name: string): string {
    const b = (base || '.').replace(/\/+$/, '') || '.'
    const n = (name || '').replace(/^\/+/, '')
    if (!n) return b
    return b === '.' ? `./${n}` : `${b}/${n}`
  }

  function normalizeRefToPath(ref: string): string {
    const r = (ref || '').trim()
    if (!r) return ''
    if (r.startsWith('/')) return r
    // resolve relative to current workspace path
    const base = (activeConn?.path || '.').trim() || '.'
    if (r.startsWith('./') || r.startsWith('../')) return joinPath(base, r)
    return joinPath(base, r)
  }

  const mentionCandidates = useMemo(() => {
    // Only meaningful in workspace mode.
    if (mode !== 'workspace') return []
    if (!activeConn) return []
    const q = (mentionQuery || '').trim().toLowerCase()
    const base = (activeConn.path || '.').trim() || '.'
    // Use fsItems directly to avoid declaration-order / TDZ issues.
    const isAutoBackup = (name: string) => /\.bak_\d{8}_\d{6}$/.test(name)
    const items = fsItems
      .filter((it) => !it.isDir && !isAutoBackup(it.name))
      .map((it) => ({ title: it.name, ref: normalizeRefToPath(it.name), abs: normalizeRefToPath(it.name) }))
    const specials = [
      activeConn.openFile ? { title: '当前文件', ref: activeConn.openFile, abs: normalizeRefToPath(activeConn.openFile) } : null,
    ].filter(Boolean) as Array<{ title: string; ref: string; abs: string }>
    const all = [...specials, ...items]
    const filtered = q ? all.filter((x) => x.title.toLowerCase().includes(q) || x.ref.toLowerCase().includes(q)) : all
    const uniq: Array<{ title: string; ref: string; abs: string }> = []
    const seen = new Set<string>()
    for (const x of filtered) {
      const key = x.abs
      if (seen.has(key)) continue
      seen.add(key)
      uniq.push(x)
      if (uniq.length >= 8) break
    }
    if (uniq.length === 0) uniq.push({ title: `当前目录：${base}`, ref: base, abs: base })
    return uniq
  }, [mode, activeConn?.path, activeConn?.openFile, fsItems, mentionQuery])

  const visibleFsItems = useMemo(() => {
    // Hide auto-generated backup files (created by backend on write) from the workspace file list.
    // Example: "xxx.bak_20260103_211230"
    const isAutoBackup = (name: string) => /\.bak_\d{8}_\d{6}$/.test(name)
    return fsItems.filter((it) => !isAutoBackup(it.name))
  }, [fsItems])

  // Persist active SSH session pointer so refresh can return to workspace (session TTL permitting).
  useEffect(() => {
    try {
      if (activeConn) localStorage.setItem(ACTIVE_CONN_KEY, JSON.stringify(activeConn))
    } catch {
      // ignore
    }
  }, [activeConn])

  function clearPersistedActiveConn() {
    try {
      localStorage.removeItem(ACTIVE_CONN_KEY)
    } catch {
      // ignore
    }
  }

  function markConnExpired(reason: string) {
    setActiveConn((p) => {
      if (!p) return p
      return { ...p, sessionId: null, expired: true, lastError: reason }
    })
    // UX: clear cached workspace file list/editor so user won't mistake stale data as live connection.
    try {
      setFsItems([])
      setFsContent('')
      setFsDirty(false)
      setRemotePanel(null)
      fsAutoKeyRef.current = ''
    } catch {
      // ignore
    }
    try {
      const prev = terminalStateRef.current
      if (!prev) return
      const now = Date.now()
      persistTerminalState({ ...prev, inactive: true, last_updated: now, snapshotTime: now, confidenceLevel: 'LOW', staleReason: 'timeout' })
    } catch {
      // ignore
    }
  }

  function touchConnTtl(ttlSec?: number) {
    const ttl = typeof ttlSec === 'number' && Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec : 20 * 60
    setActiveConn((p) => {
      if (!p) return p
      if (!p.sessionId) return p
      return { ...p, ttlSec: ttl, expiresAt: Date.now() + ttl * 1000, expired: false }
    })
  }

  function authReady(d: RemoteAuthDraft): boolean {
    if (d.type === 'password') return Boolean((d.credentialId || '').trim()) || Boolean(d.password.trim())
    if (d.type === 'ssh_key') return Boolean((d.credentialId || '').trim()) || Boolean(d.sshKey.trim())
    return true
  }

  function ctxAdd(item: { kind: string; title: string; content: string; pinned?: boolean; scope?: 'once' | 'sticky' }) {
    const content = (item.content || '').trim()
    if (!content) return
    setChatCtxItems((prev) => {
      const title = (item.title || '').trim() || item.kind
      const dedupKey = `${item.kind}::${title}`
      const withoutDup = prev.filter((x) => `${x.kind}::${x.title}` !== dedupKey)
      const scope =
        item.scope ||
        (item.kind === 'terminal'
          ? 'once' // default: terminal context is usually "for next question"
          : 'sticky')
      const next = [{ id: uid('ctx'), kind: item.kind, title, content: content.slice(0, 80_000), pinned: item.pinned, scope }, ...withoutDup]
      return next.slice(0, 12)
    })
  }

  function ctxRemove(idx: number) {
    setChatCtxItems((prev) => prev.filter((_, i) => i !== idx))
  }

  function ctxClear() {
    const n = chatCtxItems.length
    setChatCtxItems([])
    setCtxPreview(null)
    setCtxHoverId(null)
    try {
      closeCtxPicker()
    } catch {
      // ignore
    }
    setToast({ id: uid('t'), message: n > 0 ? `已清空上下文（${n} 项）` : '当前无上下文可清空' })
  }

  function ctxRemoveById(id: string) {
    setChatCtxItems((prev) => prev.filter((x) => x.id !== id))
  }

  function ctxTogglePinById(id: string) {
    setChatCtxItems((prev) =>
      prev.map((x) => {
        if (x.id !== id) return x
        const nextPinned = !x.pinned
        // pin implies sticky
        return { ...x, pinned: nextPinned, scope: nextPinned ? 'sticky' : x.scope }
      }),
    )
  }

  function pathBaseName(p: string) {
    const s = (p || '').trim()
    if (!s) return s
    const parts = s.split('/').filter(Boolean)
    return parts[parts.length - 1] || s
  }

  function pathDirName(p: string) {
    const s = (p || '').trim().replace(/\/+$/, '')
    if (!s) return ''
    const i = s.lastIndexOf('/')
    if (i <= 0) return ''
    return s.slice(0, i)
  }

  function displayCtxPath(p: string) {
    const full = (p || '').trim()
    const rp = (activeConn?.rootPath || '').trim().replace(/\/+$/, '')
    if (rp && full.startsWith(rp + '/')) return full.slice(rp.length + 1)
    if (rp && full === rp) return '.'
    return full
  }

  function shortenDirForChip(relPathOrAbs: string) {
    // Input is usually relative-to-rootPath (e.g. yangwen/copilot/deploy/local/deploy.sh)
    // We show ONLY directory part, and keep it short: …/deploy/local
    const rel = (relPathOrAbs || '').trim()
    if (!rel || rel === '.') return ''
    const dir = pathDirName(rel)
    if (!dir) return ''
    const seg = dir.split('/').filter(Boolean)
    if (seg.length <= 2) return seg.join('/')
    return `…/${seg.slice(-2).join('/')}`
  }

  function renderInlineCtxChips() {
    if (mode !== 'workspace') return null
    if (!chatCtxItems.length) return null
    const shown = chatCtxItems.slice(0, 2)
    const more = chatCtxItems.length - shown.length
    return (
      <div style={{ position: 'absolute', top: 8, left: 10, right: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', pointerEvents: 'auto' }}>
        {shown.map((it) => {
          const full = it.title
          const isTerminal = it.kind === 'terminal'
          const mHost = isTerminal ? full.match(/主机名:([^·]+)(?:·|$)/) : null
          const mAsset = isTerminal ? full.match(/资产:([^·]+)(?:·|$)/) : null
          const mCwd = isTerminal ? full.match(/cwd:([^·]+)(?:·|$)/) : null
          const host = (mHost?.[1] || '').trim()
          const asset = (mAsset?.[1] || '').trim()
          const cwd = (mCwd?.[1] || '').trim()
          const cwdBase = cwd ? pathBaseName(cwd) : ''
          const base = isTerminal ? ['终端', host || asset || '', cwdBase || ''].filter(Boolean).join(' · ') : pathBaseName(full)
          const rel = displayCtxPath(full)
          const showPath = ctxHoverId === it.id
          return (
            <div
              key={it.id}
              title={full} // full path on hover (Cursor-like)
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                borderRadius: 999,
                border: '1px solid #e2e8f0',
                background: '#ffffff',
                fontSize: 11,
                lineHeight: 1.2,
                maxWidth: 360,
                cursor: 'default',
                position: 'relative',
              }}
              onMouseEnter={() => setCtxHoverId(it.id)}
              onMouseLeave={() => setCtxHoverId((p) => (p === it.id ? null : p))}
              onMouseDown={(e) => e.preventDefault()}
            >
              {isTerminal ? (
                <button
                  type="button"
                  title={it.pinned ? '已固定（点击取消固定）' : '仅本次使用（点击固定，持续保留）'}
                  onClick={() => ctxTogglePinById(it.id)}
                  style={{
                    width: 24,
                    height: 20,
                    borderRadius: 6,
                    border: it.pinned ? '1px solid rgba(124, 92, 255, 0.16)' : '1px solid #e2e8f0',
                    background: it.pinned ? 'rgba(124, 92, 255, 0.06)' : '#f8fafc',
                    color: it.pinned ? '#4c1d95' : '#64748b',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    marginRight: 2,
                    flexShrink: 0,
                  }}
                >
                  📌
                </button>
              ) : null}
              <button
                type="button"
                title="移除引用"
                onClick={() => ctxRemoveById(it.id)}
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 6,
                  border: '1px solid #e2e8f0',
                  background: '#f8fafc',
                  color: '#64748b',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                ×
              </button>
              <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span style={{ opacity: 0.9 }}>{isTerminal ? '⌨️' : '📄'}</span>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 650 }}>{base}</span>
                  {isTerminal && !it.pinned ? <span style={{ fontSize: 10, opacity: 0.7 }}>（仅本次）</span> : null}
                </div>
              </div>
              {/* Hover-only path popover (no layout shift) */}
              {showPath ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 28,
                    bottom: 'calc(100% + 6px)',
                    zIndex: 20,
                    maxWidth: 560,
                    padding: '6px 10px',
                    borderRadius: 10,
                    border: '1px solid #e2e8f0',
                    background: '#ffffff',
                    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.10)',
                    fontSize: 11,
                    color: '#334155',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    pointerEvents: 'none',
                  }}
                >
                  {rel && rel !== '.' ? rel : full}
                </div>
              ) : null}
            </div>
          )
        })}
        {more > 0 ? (
          <div style={{ fontSize: 11, opacity: 0.75 }}>{`+${more}`}</div>
        ) : null}
      </div>
    )
  }

  const ctxBudgetText = useMemo(() => {
    const totalChars = chatCtxItems.reduce((n, x) => n + (x.content?.length || 0), 0)
    const kb = Math.round((totalChars / 1024) * 10) / 10
    return `${chatCtxItems.length} 项 · ~${kb} KB`
  }, [chatCtxItems])

  const [ctxPickerOpen, setCtxPickerOpen] = useState(false)
  const [ctxPickerTab, setCtxPickerTab] = useState<'files' | 'current' | 'terminal'>('files')
  const [ctxPickerQ, setCtxPickerQ] = useState('')
  const [ctxPickerIdx, setCtxPickerIdx] = useState(0)

  async function ctxAddFileSnapshot(path: string) {
    if (!activeConn?.sessionId) throw new Error('未连接')
    const r = await apiFilesRead({
      hostId: activeConn.hostId,
      rootPath: activeConn.rootPath,
      path,
      sessionId: activeConn.sessionId || undefined,
    })
    ctxAdd({ kind: 'file', title: path, content: r.content || '' })
  }

  async function ctxAddDirSnapshot(path: string) {
    if (!activeConn?.sessionId) throw new Error('未连接')
    const r = await apiFilesList({
      hostId: activeConn.hostId,
      rootPath: activeConn.rootPath,
      path,
      sessionId: activeConn.sessionId || undefined,
    })
    const lines = (r.items || [])
      .slice(0, 200)
      .map((it: any) => `${it.isDir ? 'DIR ' : 'FILE'}\t${it.name}\t${it.size || 0}\t${it.mtime || 0}`)
      .join('\n')
    ctxAdd({ kind: 'dir', title: path, content: `# dir snapshot: ${path}\n# (type\\tname\\tsize\\tmtime)\n${lines}` })
  }

  function closeCtxPicker() {
    setCtxPickerOpen(false)
    setCtxPickerQ('')
    setCtxPickerIdx(0)
  }

  function stripTrailingAtToken() {
    setInput((prev) => prev.replace(/(^|[\\s(])@([^\\s@]{0,200})$/, '$1'))
  }

  // Host config (separate from chat persistence)
  // IMPORTANT: must be declared before any useMemo/useEffect that may read host config,
  // otherwise we can hit TDZ errors ("Cannot access 'X' before initialization") in production bundles.
  function discoverSpacesFromLocalStorage(): Space[] {
    try {
      const out: Space[] = []
      // Recover spaces when SPACE_LIST_KEY was cleared (e.g. panic reset) but host config blobs still exist.
      for (let i = 0; i < localStorage.length; i++) {
        const k = String(localStorage.key(i) || '')
        if (!k) continue
        const pfx = `${HOST_CONFIG_KEY}__`
        if (!k.startsWith(pfx)) continue
        const sid = k.slice(pfx.length).trim()
        if (!sid) continue
        // Best-effort: keep default label for the common space id
        const name = sid === 'host_config_v1' ? '资产管理' : `项目：${sid}`
        out.push({ id: sid, name, lastUsedAt: Date.now() })
      }
      // Always ensure the default space exists.
      if (!out.some((s) => s.id === 'host_config_v1')) out.unshift({ id: 'host_config_v1', name: '资产管理', lastUsedAt: Date.now() })
      // De-dup by id
      const seen = new Set<string>()
      return out.filter((s) => {
        if (!s.id || seen.has(s.id)) return false
        seen.add(s.id)
        return true
      })
    } catch {
      return [{ id: 'host_config_v1', name: '资产管理', lastUsedAt: Date.now() }]
    }
  }

  const [spaces, setSpaces] = useState<Space[]>(() => {
    try {
      const raw = localStorage.getItem(SPACE_LIST_KEY)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          const cleaned = arr
            .filter((x) => x && typeof x === 'object')
            .map((x: any) => ({
              // Guard: never treat HOST_CONFIG_KEY as a space id.
              id: (String(x.id || '').trim() === HOST_CONFIG_KEY ? 'host_config_v1' : String(x.id || '').trim()),
              name: String(x.name || '').trim(),
              lastUsedAt: Number(x.lastUsedAt) || Date.now(),
            }))
            .filter((x: Space) => x.id && x.name)
          if (cleaned.length > 0) return cleaned
        }
      }
    } catch {
      // ignore
    }
    // Recover from host_config blobs if possible (e.g. after reset=1 cleared SPACE_* keys).
    return discoverSpacesFromLocalStorage()
  })

  const [activeSpaceId, setActiveSpaceId] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(SPACE_ACTIVE_KEY)
      const v = (raw || '').trim()
      if (v) return v === HOST_CONFIG_KEY ? 'host_config_v1' : v
      // If active space key is missing, try recover a reasonable default.
      const recovered = discoverSpacesFromLocalStorage()
      return (recovered[0]?.id || '').trim() || 'host_config_v1'
    } catch {
      return 'host_config_v1'
    }
  })

  const activeSpace = useMemo(() => spaces.find((s) => s.id === activeSpaceId) ?? spaces[0], [spaces, activeSpaceId])
  const activeSpaceNameRaw = activeSpace?.name || '资产管理'
  const activeSpaceName = activeSpaceNameRaw === 'host-config v1' ? '资产管理' : activeSpaceNameRaw

  const [hostCfg, setHostCfg] = useState<HostConfigStateV1>(() => loadHostConfigState(activeSpaceId))

  const [selectedBigDataId, setSelectedBigDataId] = useState<string | null>(null)
  const selectedBigData = useMemo(() => {
    const id = (selectedBigDataId || '').trim()
    if (!id) return null
    const arr = Array.isArray((hostCfg as any)?.bigDataAssets) ? ((hostCfg as any).bigDataAssets as any[]) : []
    return (arr.find((x) => x && String(x.id || '').trim() === id) as any) || null
  }, [selectedBigDataId, hostCfg])

  // If backend ui_state_v1 says "workspace" but this browser has no ACTIVE_CONN_KEY,
  // inject a disconnected pointer so the workspace UI is consistent across browsers.
  useEffect(() => {
    if (!me?.email) return
    if (mode !== 'workspace') return
    if (activeConn) return
    const remote = uiRemoteRef.current
    const hidRaw =
      (remote?.workspaceHostId as any) ||
      (hostCfg as any)?.activeHostId ||
      ((hostCfg as any)?.assets?.find?.((a: any) => a && !a.deletedAt)?.id as any) ||
      null
    const hid = typeof hidRaw === 'string' && hidRaw.trim() ? (hidRaw.trim() as any) : null
    if (!hid) return
    setActiveConn({
      hostId: hid,
      sessionId: null,
      rootPath: '/root',
      path: '/root',
      openFile: null,
      // IMPORTANT: do NOT mark expired here. This is the first-entry / not-yet-connected state
      // in this browser. "Reconnect" should only appear after a real disconnect/timeout happened.
      expired: false,
      lastError: '尚未连接：请在右侧点击“连接”，或先在左侧选择主机。',
    })
  }, [me?.email, mode, activeConn, hostCfg.activeHostId, hostCfg.assets])

  const [inventorySyncEnabled, setInventorySyncEnabled] = useState<boolean>(() => {
    try {
      const v = String(localStorage.getItem(INVENTORY_SYNC_ENABLED_KEY) || '').trim()
      if (v === '0') return false
      if (v === '1') return true
      return true
    } catch {
      return true
    }
  })
  const inventoryHydratedBySpaceRef = useRef<Record<string, boolean>>({})
  const inventoryRemoteUpdatedAtBySpaceRef = useRef<Record<string, number>>({})
  const inventoryLastApplyAtBySpaceRef = useRef<Record<string, number>>({})

  // UI state sync (per user, cross-browser). Keep minimal: last module + last workspace host pointer.
  const uiStateHydratedRef = useRef(false)
  const uiRemoteUpdatedAtRef = useRef<number>(0)
  const uiRemoteRef = useRef<UiStateV1 | null>(null)
  const uiStateLastSentSigRef = useRef<string>('')

  type PrefsStateV1 = {
    version: 2
    prefs: Prefs
    layout?: {
      sidebarW?: number
      wsLeftW?: number
      wsToolsOpen?: boolean
      dashFullscreen?: boolean
    }
  }
  const prefsStateHydratedRef = useRef(false)
  const prefsRemoteUpdatedAtRef = useRef<number>(0)
  const prefsStateLastSentSigRef = useRef<string>('')

  function sanitizeHostCfgForSync(input: HostConfigStateV1): HostConfigStateV1 {
    const s = fixHostConfigState(input as any) as any
    const now = Date.now()
    const assets = Array.isArray(s.assets)
      ? s.assets.map((a: any) => ({
          id: String(a.id || '').trim(),
          type: a.type || a.os || 'linux',
          os: a.os || a.type || 'linux',
          name: String(a.name || '').trim().slice(0, 80),
          address: String(a.address || '').trim().slice(0, 253),
          port: Number(a.port) || 22,
          username: String(a.username || a.user || '').trim().slice(0, 64),
          user: String(a.username || a.user || '').trim().slice(0, 64),
          project: typeof a.project === 'string' && a.project.trim() ? a.project.trim().slice(0, 80) : undefined,
          env: a.env,
          tagIds: Array.isArray(a.tagIds) ? a.tagIds.map((x: any) => String(x || '').trim()).filter(Boolean).slice(0, 60) : [],
          credentialId: a.credentialId ? String(a.credentialId) : null,
          status: a.status || 'enabled',
          lastConnectedAt: typeof a.lastConnectedAt === 'number' ? a.lastConnectedAt : null,
          createdAt: typeof a.createdAt === 'number' ? a.createdAt : now,
          updatedAt: typeof a.updatedAt === 'number' ? a.updatedAt : now,
          deletedAt: typeof a.deletedAt === 'number' ? a.deletedAt : null,
          groupId: a.groupId ? String(a.groupId) : null,
          favorite: Boolean(a.favorite),
        }))
      : []
    const workspaces = Array.isArray(s.workspaces)
      ? s.workspaces.map((w: any) => ({
          id: String(w.id || '').trim(),
          assetId: String(w.assetId || '').trim(),
          name: String(w.name || '').trim().slice(0, 120),
          rootPath: String(w.rootPath || '').trim().slice(0, 400),
          pinned: Boolean(w.pinned),
          lastOpenedAt: typeof w.lastOpenedAt === 'number' ? w.lastOpenedAt : null,
          createdAt: typeof w.createdAt === 'number' ? w.createdAt : now,
          updatedAt: typeof w.updatedAt === 'number' ? w.updatedAt : now,
        }))
      : []
    const tags = Array.isArray(s.tags)
      ? s.tags.map((t: any) => ({
          id: String(t.id || '').trim(),
          name: String(t.name || '').trim().slice(0, 60),
          color: typeof t.color === 'string' && t.color.trim() ? t.color.trim().slice(0, 32) : undefined,
          sort: typeof t.sort === 'number' ? t.sort : 0,
          createdAt: typeof t.createdAt === 'number' ? t.createdAt : now,
          updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : now,
        }))
      : []
    const groups = Array.isArray(s.groups)
      ? s.groups.map((g: any) => ({
          id: String(g.id || '').trim(),
          name: String(g.name || '').trim().slice(0, 60),
          parentId: g.parentId ? String(g.parentId) : null,
          sort: typeof g.sort === 'number' ? g.sort : 0,
          createdAt: typeof g.createdAt === 'number' ? g.createdAt : now,
          updatedAt: typeof g.updatedAt === 'number' ? g.updatedAt : now,
        }))
      : []
    const credentials = Array.isArray(s.credentials)
      ? s.credentials.map((c: any) => ({
          id: String(c.id || '').trim(),
          type: (c.type as HostAuthType) || 'none',
          createdAt: typeof c.createdAt === 'number' ? c.createdAt : now,
          updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : now,
        }))
      : []
    const bigDataAssets = Array.isArray((s as any).bigDataAssets) ? (s as any).bigDataAssets : []
    return {
      version: 2,
      activeWorkspaceId: s.activeWorkspaceId || null,
      activeHostId: s.activeHostId || null,
      assets,
      hosts: assets,
      workspaces,
      tags,
      groups,
      credentials,
      bigDataAssets,
    } as any
  }

  const ctxPickerItems = useMemo(() => {
    if (mode !== 'workspace') return []
    const q = (ctxPickerQ || '').trim().toLowerCase()
    const curDir = (activeConn?.path || '.').trim() || '.'
    const openFile = (activeConn?.openFile || '').trim()
    const isAutoBackup = (name: string) => /\\.bak_\\d{8}_\\d{6}$/.test(name)
    if (ctxPickerTab === 'current') {
      const arr: Array<{ kind: 'file' | 'dir' | 'text'; title: string; ref: string }> = []
      if (openFile) arr.push({ kind: 'file', title: `当前文件：${openFile}`, ref: openFile })
      arr.push({ kind: 'dir', title: `当前目录：${curDir}`, ref: curDir })
      const filtered = q ? arr.filter((x) => x.title.toLowerCase().includes(q) || x.ref.toLowerCase().includes(q)) : arr
      return filtered.slice(0, 20)
    }
    if (ctxPickerTab === 'terminal') {
      const last = termLog[0] || null
      const arr: Array<{ kind: 'text'; title: string; ref: string; content: string }> = []
      const transcript = (wsTermTranscriptRef.current || '').trim()
      const h = activeConn?.hostId ? hostById(activeConn.hostId) : null
      const assetName = (h?.name || '').trim()
      const sshUser = ((h?.user || (h as any)?.username || '').trim() || '').trim()
      const sshAddr = (h?.address || '').trim()
      const sshPort = typeof h?.port === 'number' && Number.isFinite(h.port) ? h.port : 22
      const sshTarget = sshAddr ? `${sshUser || 'root'}@${sshAddr}:${sshPort}` : ''

      // Best-effort parse remote hostname from typical bash prompt like:
      //   [root@web deploy]#
      // Prefer the most recent match.
      function parseRemoteHostFromPrompt(s: string): { host: string; prompt: string } | null {
        try {
          const text = (s || '').slice(-6000)
          const re = /\[([^ \]]+)@([^ \]]+)(?: [^\]]*)?\][#$]/g
          let m: RegExpExecArray | null = null
          let lastM: RegExpExecArray | null = null
          while ((m = re.exec(text))) lastM = m
          if (!lastM) return null
          const host = String(lastM[2] || '').trim()
          if (!host) return null
          // capture a short prompt snippet around the match (for evidence)
          const idx = Math.max(0, lastM.index - 40)
          const prompt = text.slice(idx, Math.min(text.length, lastM.index + lastM[0].length + 20)).replace(/\\s+/g, ' ')
          return { host, prompt }
        } catch {
          return null
        }
      }

      const parsed = parseRemoteHostFromPrompt(transcript)
      const remoteHostname = parsed?.host || ''
      if (transcript) {
        const cwd = (activeConn?.path || '').trim() || '.'
        // Make the identity unambiguous for the LLM:
        // - assetName: inventory label (e.g. "test")
        // - sshTarget: address/port/user (e.g. "root@203.0.113.10:22")
        // - remoteHostname: hostname extracted from shell prompt (e.g. "web") if present
        const head =
          `# terminal: session (exec/pty)\\n` +
          (assetName ? `# asset_name: ${assetName}\\n` : '') +
          (sshTarget ? `# ssh_target: ${sshTarget}\\n` : '') +
          (remoteHostname ? `# remote_hostname: ${remoteHostname}  (from shell prompt)\\n` : '') +
          (parsed?.prompt ? `# prompt_evidence: ${parsed.prompt}\\n` : '') +
          `# cwd: ${cwd}\\n\\n`
        const content = head + transcript
        const titleBits = [
          wsTermPtyActive ? '当前终端会话（Shell/PTY）' : '当前终端会话（exec/模拟）',
          assetName ? `资产:${assetName}` : '',
          remoteHostname ? `主机名:${remoteHostname}` : '',
          cwd ? `cwd:${cwd}` : '',
        ].filter(Boolean)
        arr.push({ kind: 'text', title: titleBits.join(' · '), ref: wsTermPtyActive ? 'terminal:pty' : 'terminal:exec', content })
      } else if (last) {
        const content = `# cmd: ${last.cmd}\\n# exitCode: ${last.exitCode}\\n\\nSTDOUT:\\n${last.stdout || ''}\\n\\nSTDERR:\\n${last.stderr || ''}`
        arr.push({ kind: 'text', title: `最近终端输出：${last.cmd.slice(0, 40)}`, ref: 'terminal:last', content })
      } else {
        arr.push({ kind: 'text', title: '暂无终端记录（先打开终端并执行一条命令）', ref: 'terminal:empty', content: '' })
      }
      return arr
    }
    // files
    const arr = (fsItems || [])
      .filter((it) => !isAutoBackup(it.name))
      .map((it) => ({
        kind: it.isDir ? ('dir' as const) : ('file' as const),
        title: it.name,
        ref: normalizeRefToPath(it.name),
      }))
    const filtered = q ? arr.filter((x) => x.title.toLowerCase().includes(q) || x.ref.toLowerCase().includes(q)) : arr
    return filtered.slice(0, 60)
  }, [mode, ctxPickerTab, ctxPickerQ, fsItems, activeConn?.path, activeConn?.openFile, activeConn?.hostId, termLog, wsTermCtxVer])

  function shortenCtxRef(p: string): string {
    const s = (p || '').trim()
    if (!s) return ''
    const parts = s.split('/').filter(Boolean)
    if (parts.length <= 2) return s
    return parts.slice(-2).join('/')
  }

  function renderContextBar() {
    // Always reserve a small row to avoid input area jumping when adding/removing the first context item.
    const shown = chatCtxItems.slice(0, 3)
    const more = chatCtxItems.length - shown.length
    return (
      <div
        style={{
          height: 34,
          marginBottom: 6,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 11, opacity: 0.75, flex: '0 0 auto' }}>{chatCtxItems.length ? `上下文 ${ctxBudgetText}` : '上下文：无（输入 @ 引用文件）'}</span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'nowrap', overflow: 'hidden' }}>
            {shown.map((it, idx) => (
              <span
                key={it.id}
                style={{
                  display: 'inline-flex',
                  gap: 6,
                  alignItems: 'center',
                  border: '1px solid #e2e8f0',
                  background: '#f8fafc',
                  borderRadius: 999,
                  padding: '2px 8px',
                  fontSize: 11,
                  maxWidth: 260,
                  cursor: 'pointer',
                }}
                title="点击预览上下文"
                onClick={() => setCtxPreview({ title: it.title, content: it.content })}
              >
                <span style={{ opacity: 0.9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortenCtxRef(it.title)}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    ctxRemove(idx)
                  }}
                  style={{ border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer' }}
                  aria-label={`移除上下文 ${it.title}`}
                  title="移除"
                >
                  ×
                </button>
              </span>
            ))}
            {more > 0 ? (
              <button className="btn" type="button" onClick={() => setCtxPreview({ title: `上下文（${chatCtxItems.length} 项）`, content: chatCtxItems.map((x) => `--- ${x.title} ---\\n${x.content}`).join('\\n\\n') })}>
                {`+${more}`}
              </button>
            ) : null}
          </div>
        </div>
        {chatCtxItems.length ? (
          <button className="btn" type="button" onClick={ctxClear}>
            清空
          </button>
        ) : (
          <button
            className="btn"
            type="button"
            onClick={() => {
              // If user clicks here, guide them to use @
              setInput((p) => (p && p.trim() ? p : '@'))
              setTimeout(() => inputRef.current?.focus(), 0)
            }}
          >
            @ 引用
          </button>
        )}
      </div>
    )
  }

  function renderUserMenu(extra?: { style?: CSSProperties }) {
    return (
      <div className="userMenu" role="menu" style={extra?.style}>
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            window.location.href = '/me'
          }}
        >
          👤 个人资料
        </button>
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            openRechargeCenter()
          }}
        >
          💳 充值中心
        </button>
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            setPrefsOpen(true)
          }}
        >
          ⚙️ 偏好设置
        </button>
        {me?.email ? (
          <button
            className="userMenuItem"
            type="button"
            onClick={() => {
              setUserMenuOpen(false)
              setInventorySyncEnabled((v) => {
                const next = !v
                showToast({ message: next ? '已开启：资产库云端同步' : '已关闭：资产库云端同步（仅使用本地 localStorage）' })
                return next
              })
            }}
            title="回滚开关：关闭后端同步后，将仅使用本地 localStorage"
          >
            ☁️ 资产库云端同步：{inventorySyncEnabled ? '开启' : '关闭'}
          </button>
        ) : null}
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            openRulesModal('user')
          }}
        >
          📜 规则与命令
        </button>
        {(me?.role || '') === 'admin' ? (
          <button
            className="userMenuItem"
            type="button"
            onClick={() => {
              setUserMenuOpen(false)
              setAuditErr('')
              setAuditItems([])
              setAuditCursor(null)
              setAuditOpen(true)
              void loadAuditPage(true)
            }}
            title="仅管理员可见：查看 SSH/文件/PTY 审计事件"
          >
            🧾 SSH 审计
          </button>
        ) : null}
        <div className="userMenuDivider" />
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            window.location.href = '/'
          }}
        >
          🏠 返回官网首页
        </button>
        <button
          className="userMenuItem userMenuItemDanger"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            void logout()
          }}
        >
          🚪 退出登录
        </button>
      </div>
    )
  }

  function renderUserMenuRail(extra?: { style?: CSSProperties }) {
    return (
      <div className="userMenu userMenuRail" role="menu" style={extra?.style}>
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            window.location.href = '/me'
          }}
        >
          👤 个人资料
        </button>
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            openRechargeCenter()
          }}
        >
          💳 充值中心
        </button>
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            setPrefsOpen(true)
          }}
        >
          ⚙️ 偏好设置
        </button>
        <div className="userMenuDivider" />
        <button
          className="userMenuItem"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            window.location.href = '/'
          }}
        >
          🏠 返回官网首页
        </button>
        <button
          className="userMenuItem userMenuItemDanger"
          type="button"
          onClick={() => {
            setUserMenuOpen(false)
            void logout()
          }}
        >
          🚪 退出登录
        </button>
      </div>
    )
  }

  function remoteClose() {
    setRemotePanel(null)
    setRemoteErr('')
    setRemoteBusy(false)
  }

  async function connectAndEnterWorkspace(input: { hostId: ID; rootPath: string; sshUser?: string; auth: RemoteAuthDraft }): Promise<boolean> {
    const { hostId, rootPath, sshUser, auth } = input
    const h = hostById(hostId)
    if (!h) return false
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      if (!authReady(auth)) throw new Error('请先填写认证信息（密码/私钥仅本次使用）')
      const r = await apiSshConnect({ hostId, auth, username: (sshUser || '').trim() || undefined })
      // Default AI mode for this workspace: Agent (execute). Persist per host+space and sync to backend.
      try {
        const spaceId = safeActiveSpaceId()
        const mk = aiUiModeStorageKey({ spaceId, hostId: String(hostId) })
        localStorage.setItem(mk, 'agent')
        setAiUiMode('agent')
        void apiAiModeSet({ sessionId: r.sessionId, mode: 'execute' }).catch(() => {})
      } catch {
        // ignore
      }
      const rp = (rootPath || '').trim() || defaultRootPathForHost(hostId)
      const prevPath =
        mode === 'workspace' && activeConn && activeConn.hostId === hostId ? (activeConn.path || '').trim() : ''
      const nextPath = prevPath && (prevPath === rp || prevPath.startsWith(rp.replace(/\/+$/, '') + '/')) ? prevPath : rp
      // For security: do not keep password in memory longer than needed.
      // For key/agent: keep in-memory for "one-click reconnect" in the same page lifetime.
      setRemoteAuth((prev) => {
        const next: RemoteAuthDraft = {
          ...prev,
          type: auth.type,
          credentialId: (auth.credentialId as any) ?? null,
          password: '',
          sshKey: auth.sshKey,
          passphrase: auth.passphrase,
        }
        // If bound to a stored credential, never keep secrets in memory.
        if ((auth.credentialId || '').toString().trim()) return { ...next, password: '', sshKey: '', passphrase: '' }
        // Password is one-shot; never keep it.
        if (auth.type === 'password') return { ...next, password: '', sshKey: '', passphrase: '' }
        // Agent: keep nothing.
        if (auth.type === 'agent') return { ...next, password: '', sshKey: '', passphrase: '', credentialId: null }
        // ssh_key: keep key only for this page lifetime (legacy behavior).
        return next
      })
      setActiveConn({
        hostId,
        sessionId: r.sessionId,
        rootPath: rp,
        path: nextPath,
        openFile: null,
        ttlSec: r.ttlSec,
        expiresAt: Date.now() + r.ttlSec * 1000,
        expired: false,
      })
      setChatCtxItems([])
      setMode('workspace')
      // UX: after a successful connect, auto-open the tools drawer (files/editor/terminal)
      // and eagerly load the file list so the workspace looks like a real IDE immediately.
      try {
        setWsToolsOpen(true)
      } catch {
        // ignore
      }
      void (async () => {
        try {
          const r2 = await apiFilesList({ hostId, rootPath: rp, path: nextPath || '.', sessionId: r.sessionId })
          const np = (r2.path || nextPath || '.').trim() || '.'
          setFsItems(r2.items || [])
          setWsPathDraft(np)
          setRemotePanel({ kind: 'files', hostId, rootPath: rp, path: np, openFile: null })
          fsAutoKeyRef.current = `${hostId}|${rp}|${np}`
          setActiveConn((p) => (p ? { ...p, path: np } : p))
        } catch {
          // ignore: user can manually open drawer and refresh
        }
      })()
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const m = raw.toLowerCase()
      const isAuth =
        m.includes('authenticationexception') ||
        m.includes('permission denied') ||
        m.includes('auth failed') ||
        m.includes('bad authentication') ||
        m.includes('authentication failed') ||
        m.includes('http 401') ||
        raw.includes('认证失败')
      const msg = isAuth
        ? auth.type === 'password'
          ? '密码不正确，请重试。'
          : auth.type === 'ssh_key'
            ? '密钥/口令不正确，请重试。'
            : '认证失败，请重试。'
        : raw
      setRemoteErr(msg)
      setToast({ id: uid('t'), message: `连接失败：${msg}` })
      return false
    } finally {
      setRemoteBusy(false)
    }
    return true
  }

  async function disconnectWorkspace(stayInWorkspace: boolean = true) {
    if (!activeConn?.sessionId) {
      if (!stayInWorkspace) {
        clearPersistedActiveConn()
        setActiveConn(null)
      }
      // Also clear stale UI caches even if we were already disconnected.
      try {
        setFsItems([])
        setFsContent('')
        setFsDirty(false)
        setRemotePanel(null)
        fsAutoKeyRef.current = ''
      } catch {
        // ignore
      }
      return
    }
    const sid = String(activeConn.sessionId || '')
    try {
      await apiSshDisconnect({ sessionId: sid })
    } catch {
      // ignore
    } finally {
      if (stayInWorkspace) {
        markConnExpired('连接已断开。你可以点击“重新连接”继续使用工作区。')
      } else {
        clearPersistedActiveConn()
        setActiveConn(null)
      }
    }
  }

  async function remoteRunTerminal() {
    if (!remotePanel) return
    const cmd = termCmd.trim()
    if (!cmd) return
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      const r = await apiSshExec({
        hostId: remotePanel.hostId,
        command: cmd,
        cwd: termCwd.trim() || undefined,
        sessionId: activeConn?.sessionId || undefined,
      })
      setTermLog((prev) => [
        { ts: Date.now(), cmd, stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode ?? null, timedOut: r.timedOut },
        ...prev,
      ])
      const h = hostById(remotePanel.hostId)
      if (h) markConnected(h)
      touchConnTtl(activeConn?.ttlSec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const m = msg.toLowerCase()
      if (m.includes('session expired') || m.includes('http 410')) {
        // Not friendly to show raw expiry errors in the connect modal. Use a short Chinese hint instead.
        setRemoteErr('')
        setToast({ id: uid('t'), message: '连接已断开，请点击“重新连接”继续' })
        markConnExpired('连接已断开（可能是超时或服务重启）。请点击右上角“重新连接”。')
      } else {
        setRemoteErr(msg)
      }
    } finally {
      setRemoteBusy(false)
    }
  }

  async function remoteLoadFs() {
    if (!remotePanel) return
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      const r = await apiFilesList({
        hostId: remotePanel.hostId,
        rootPath: remotePanel.rootPath,
        path: remotePanel.path || '.',
        sessionId: activeConn?.sessionId || undefined,
      })
      setFsItems(r.items || [])
      setRemotePanel((p) => {
        if (!p) return p
        const nextPath = r.path || p.path
        return nextPath && nextPath !== p.path ? { ...p, path: nextPath } : p
      })
      const h = hostById(remotePanel.hostId)
      if (h) markConnected(h)
      touchConnTtl(activeConn?.ttlSec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.toLowerCase().includes('session expired') || msg.toLowerCase().includes('http 410')) {
        setRemoteErr('')
        setToast({ id: uid('t'), message: '连接已断开，请点击“重新连接”继续' })
        markConnExpired('连接已断开（可能是超时或服务重启）。请点击右上角“重新连接”。')
      } else {
        setRemoteErr(msg)
      }
    } finally {
      setRemoteBusy(false)
    }
  }

  async function openWorkspaceDir(absPath: string) {
    if (!activeConn) return
    if (!activeConn.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    const p = (absPath || '').trim()
    if (!p.startsWith('/')) throw new Error('请输入以 / 开头的绝对目录路径')
    // Validate by listing that directory (server will enforce existence + permissions).
    const r = await apiFilesList({
      hostId: activeConn.hostId,
      rootPath: p,
      path: p,
      sessionId: activeConn.sessionId || undefined,
    })
    setFsItems(r.items || [])
    const nextPath = (r.path || p).trim() || p
    setActiveConn({ ...activeConn, rootPath: p, path: nextPath, openFile: null })
    setWsPathDraft(nextPath)
    setFsContent('')
    setFsDirty(false)
    setRemotePanel({ kind: 'files', hostId: activeConn.hostId, rootPath: p, path: nextPath, openFile: null })
  }

  async function workspaceLoadFs(force: boolean = false) {
    if (!activeConn) return
    if (!activeConn.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    const key = `${activeConn.hostId}|${activeConn.rootPath}|${activeConn.path || '.'}`
    if (!force && fsAutoKeyRef.current === key && fsItems.length > 0) return
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      const r = await apiFilesList({
        hostId: activeConn.hostId,
        rootPath: activeConn.rootPath,
        path: activeConn.path || '.',
        sessionId: activeConn.sessionId || undefined,
      })
      setFsItems(r.items || [])
      const nextPath = (r.path || activeConn.path || '.').trim() || '.'
      if (nextPath !== (activeConn.path || '.')) {
        setActiveConn({ ...activeConn, path: nextPath })
      }
      setRemotePanel({ kind: 'files', hostId: activeConn.hostId, rootPath: activeConn.rootPath, path: nextPath, openFile: activeConn.openFile || null })
      fsAutoKeyRef.current = key
      const h = hostById(activeConn.hostId)
      if (h) markConnected(h)
      touchConnTtl(activeConn.ttlSec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRemoteErr(msg)
      const m = msg.toLowerCase()
      if (m.includes('session expired') || m.includes('http 410')) {
        setToast({ id: uid('t'), message: '连接已断开，请点击“重新连接”继续' })
        markConnExpired('连接已断开（可能是超时或服务重启）。请点击右上角“重新连接”。')
      } else {
        setToast({ id: uid('t'), message: `刷新失败：${msg}` })
      }
    } finally {
      setRemoteBusy(false)
    }
  }

  async function openWorkspaceFile(filePath: string) {
    if (!activeConn) return
    if (!activeConn.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    const fp = (filePath || '').trim()
    if (!fp) return
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      const r = await apiFilesRead({
        hostId: activeConn.hostId,
        rootPath: activeConn.rootPath,
        path: fp,
        sessionId: activeConn.sessionId || undefined,
      })
      setFsContent(r.content || '')
      setFsDirty(false)
      setActiveConn({ ...activeConn, openFile: fp })
      touchConnTtl(activeConn.ttlSec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setRemoteErr(msg)
      setToast({ id: uid('t'), message: `打开文件失败：${msg}` })
    } finally {
      setRemoteBusy(false)
    }
  }

  const wsTermBusyRef = useRef(false)
  async function wsTermRun() {
    if (wsTermBusyRef.current) return
    if (!activeConn?.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    const cmd = (termCmd || '').trim()
    if (!cmd) return
    const cwd = (termCwd || '').trim() || (activeConn.path || '').trim() || undefined
    wsTermBusyRef.current = true
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      const r = await apiSshExec({
        hostId: activeConn.hostId,
        command: cmd,
        cwd,
        sessionId: activeConn.sessionId || undefined,
      })
      setTermCmd('')
      setTermCwd(cwd || '')
      setTermLog((prev) => [
        ...prev,
        { ts: Date.now(), cmd: cwd ? `${cwd}$ ${cmd}` : cmd, stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode, timedOut: r.timedOut },
      ])
      touchConnTtl(activeConn.ttlSec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const m = msg.toLowerCase()
      if (m.includes('session expired') || m.includes('http 410')) {
        setToast({ id: uid('t'), message: '连接已断开，请点击“重新连接”继续' })
        markConnExpired('连接已断开（可能是超时或服务重启）。请点击右上角“重新连接”。')
      } else {
        setToast({ id: uid('t'), message: `执行失败：${msg}` })
      }
    } finally {
      setRemoteBusy(false)
      wsTermBusyRef.current = false
    }
  }

  function _normalizeTerminalText(s: string): string {
    return String(s || '').replace(/\r\n/g, '\n')
  }

  function _normalizeSimpleCommand(s: string): string {
    return String(s || '')
      .trim()
      .replace(/\s+/g, ' ')
  }

  function _isCompactProbeCommand(cmd: string): boolean {
    const s = _normalizeSimpleCommand(cmd).toLowerCase()
    // Keep aligned with isSafeAutoRunShellCommand()'s allowlist mental model.
    const allow = new Set([
      'pwd',
      'whoami',
      'hostname',
      'id',
      'uname -a',
      'uptime',
      'df -h',
      'free -m',
      'free -h',
      'date',
    ])
    return allow.has(s)
  }

  function _formatCommandHint(opts: {
    originalCommand: string
    executedCommand: string
    intent: 'system_monitoring' | 'file_inspection' | 'other'
    mode: 'once' | 'snapshot'
    rewriteReason: 'none' | 'interactive_to_snapshot' | 'stream_to_snapshot'
  }): string | null {
    const orig = String(opts.originalCommand || '').trim()
    const exec = String(opts.executedCommand || '').trim()
    if (!orig || !exec) return null

    // Cursor-like: keep it single-line, only when it helps.
    if (opts.intent === 'system_monitoring' && opts.mode === 'snapshot') {
      return orig !== exec ? `# 系统快照（只读）：${orig} → ${exec}` : `# 系统快照（只读）：${exec}`
    }
    if (opts.rewriteReason !== 'none' && orig !== exec) return `# 已自动改写：${orig} → ${exec}`
    return null
  }

  function _formatExecTranscript(opts: {
    cmd: string
    stdout?: string
    stderr?: string
    exitCode: number | null
    timedOut?: boolean
    preferBareOutput?: boolean
  }): string {
    const cmd = String(opts.cmd || '').trim()
    const stdout = _normalizeTerminalText(opts.stdout || '')
    const stderr = _normalizeTerminalText(opts.stderr || '')
    const out = stdout.trimEnd()
    const err = stderr.trimEnd()
    const timedOut = Boolean(opts.timedOut)
    const ok = opts.exitCode === 0 && !timedOut && !err

    // Cursor-like: for very small read-only probes (esp. `pwd`), show just the output when it is safe.
    if (opts.preferBareOutput && ok && _isCompactProbeCommand(cmd) && out) {
      return out.trim()
    }

    const lines: string[] = []
    lines.push(`$ ${cmd}`)
    if (out) lines.push(out)
    if (err) lines.push(err)
    if (!ok) {
      const meta: string[] = [`exitCode: ${opts.exitCode === null ? 'null' : opts.exitCode}`]
      if (timedOut) meta.push('timedOut: true')
      lines.push(`[${meta.join(', ')}]`)
    }
    return lines.join('\n')
  }

  async function runSystemStatusProbe() {
    if (sysProbeBusy) return
    if (mode !== 'workspace') {
      setToast({ id: uid('t'), message: '请先进入工作区再执行系统状态探测' })
      return
    }
    if (!activeConn?.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    if (wsTermPtyActive) {
      setToast({ id: uid('t'), message: '当前处于 Shell（人工）：AI exec 已禁用，请先退出 Shell' })
      return
    }
    if (aiUiMode !== 'agent' && aiUiMode !== 'debug') {
      setToast({ id: uid('t'), message: '当前模式禁止执行命令（请切换到 Agent/Debug）' })
      return
    }
    setSysProbeBusy(true)
    setRemoteErr('')
    try {
      const cwd = (activeConn.path || '').trim() || undefined
      const cmds = [
        'whoami',
        'hostname',
        'pwd',
        'uptime',
        'uname -a',
        'df -h',
        'ps -eo pid,comm,%cpu,%mem --sort=-%cpu | head -n 20',
        'cat /proc/meminfo | head -n 20',
      ]

      let out =
        `# 系统状态探测（只读）\n` +
        `# ts: ${new Date().toISOString()}\n` +
        `# rootPath: ${activeConn.rootPath}\n` +
        `# cwd: ${cwd || '.'}\n\n`

      for (const cmd of cmds) {
        try {
          const r = await apiSshExec({
            hostId: activeConn.hostId,
            command: cmd,
            cwd,
            sessionId: activeConn.sessionId || undefined,
          })
          try {
            const rid = String((r as any)?.runId || '').trim()
            const dur = typeof (r as any)?.durationMs === 'number' ? Math.max(0, Math.round((r as any).durationMs)) : null
            if (rid || dur !== null) out += `# ${[rid ? `runId: ${rid}` : '', dur !== null ? `durationMs: ${dur}` : ''].filter(Boolean).join(', ')}\n`
          } catch {
            // ignore
          }
          out += _formatExecTranscript({
            cmd,
            stdout: r.stdout || '',
            stderr: r.stderr || '',
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            preferBareOutput: false,
          })
          out += '\n\n'
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          out += `$ ${cmd}\n[error: ${msg}]\n\n`
        }
      }

      appendToolResultToActiveSession({
        title: '系统状态探测（只读）',
        meta: [`ts: ${new Date().toISOString()}`, `rootPath: ${activeConn.rootPath}`, `cwd: ${cwd || '.'}`],
        content: out,
      })
      setToast({ id: uid('t'), message: '已写入系统状态到聊天（工具结果）' })
      touchConnTtl(activeConn.ttlSec)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setToast({ id: uid('t'), message: `系统状态探测失败：${msg}` })
    } finally {
      setSysProbeBusy(false)
    }
  }

  async function runShellCommandsDirect(cmds: string[], opts?: { sourceLabel?: string; cwd?: string }) {
    const sourceLabel = (opts?.sourceLabel || '').trim()
    if (mode !== 'workspace') {
      setToast({ id: uid('t'), message: '请先进入工作区再执行命令' })
      return
    }
    if (!activeConn?.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    if (wsTermPtyActive) {
      setToast({ id: uid('t'), message: '当前处于 Shell（人工）：AI exec 已禁用，请先退出 Shell' })
      return
    }
    if (aiUiMode !== 'agent' && aiUiMode !== 'debug') {
      setToast({ id: uid('t'), message: '当前模式禁止执行命令（请切换到 Agent/Debug）' })
      return
    }
    if (terminalConfidenceEffective(terminalStateRef.current) === 'LOW') {
      setToast({ id: uid('t'), message: '终端状态不可信（LOW）：请先重新连接或进入 Shell（人工）' })
      return
    }
    const list = (cmds || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    if (list.length === 0) return
    const cwd = (opts?.cwd || '').trim() || (activeConn.path || '').trim() || '.'

    const results: string[] = []
    for (const cmd of list) {
      const norm = normalizeInteractiveToNonInteractive(cmd)
      const actualCmd = norm.rewrittenCommand
      const evId = uid('ce')
      const ts = new Date().toISOString()
      const ev: CommandEvent = {
        eventId: evId,
        source: 'ai',
        originalCommand: norm.originalCommand,
        rewrittenCommand: actualCmd,
        mode: norm.mode,
        rewriteReason: norm.rewriteReason,
        intent: norm.intent,
        cwd,
        assetId: String(activeConn.hostId || ''),
        workspaceId: String((activeSpaceId || '').trim() || 'host_config_v1'),
        timestamp: ts,
        status: 'pending',
        stdout: '',
        stderr: '',
        exitCode: null,
      }
      pushCommandEvent(ev)
      const why = isDangerousShellCommand(actualCmd)
      if (why) {
        patchCommandEvent(evId, { status: 'failed', stderr: `[blocked] ${why}`, exitCode: 126 })
        setLastTerminalState({
          cwd,
          lastEventId: evId,
          lastCommand: actualCmd,
          exitCode: 126,
          stdout: '',
          stderr: `[blocked] ${why}`,
          timestamp: new Date().toISOString(),
        })
        results.push(`$ ${actualCmd}\n[blocked: ${why}]`)
        continue
      }
      if (/^\s*sudo\b/i.test(actualCmd)) {
        const msg = '[blocked] sudo 可能需要交互输入，已拦截（请在命令前去掉 sudo 或使用 root 执行）'
        patchCommandEvent(evId, { status: 'failed', stderr: msg, exitCode: 126 })
        setLastTerminalState({
          cwd,
          lastEventId: evId,
          lastCommand: actualCmd,
          exitCode: 126,
          stdout: '',
          stderr: msg,
          timestamp: new Date().toISOString(),
        })
        results.push(`$ ${actualCmd}\n[blocked: sudo 可能需要交互输入，已拦截（请在命令前去掉 sudo 或使用 root 执行）]`)
        continue
      }
      try {
        const r = await apiSshExec({
          hostId: activeConn.hostId,
          sessionId: activeConn.sessionId,
          command: actualCmd,
          cwd,
        })
        patchCommandEvent(evId, {
          status: 'executed',
          stdout: String(r.stdout || '').trimEnd(),
          stderr: String(r.stderr || '').trimEnd(),
          exitCode: r.exitCode,
          timedOut: r.timedOut,
        })
        setLastTerminalState({
          cwd,
          lastEventId: evId,
          lastCommand: actualCmd,
          exitCode: r.exitCode,
          stdout: String(r.stdout || '').trimEnd(),
          stderr: String(r.stderr || '').trimEnd(),
          timestamp: new Date().toISOString(),
        })
        const hint = _formatCommandHint({
          originalCommand: norm.originalCommand,
          executedCommand: actualCmd,
          intent: norm.intent,
          mode: norm.mode,
          rewriteReason: norm.rewriteReason,
        })
        if (hint) results.push(hint)
        if (norm.note) results.push(norm.note)
        try {
          const rid = String((r as any)?.runId || '').trim()
          const dur = typeof (r as any)?.durationMs === 'number' ? Math.max(0, Math.round((r as any).durationMs)) : null
          if (rid || dur !== null) results.push(`# ${[rid ? `runId: ${rid}` : '', dur !== null ? `durationMs: ${dur}` : ''].filter(Boolean).join(', ')}`)
        } catch {
          // ignore
        }
        results.push(
          _formatExecTranscript({
            cmd: actualCmd,
            stdout: r.stdout || '',
            stderr: r.stderr || '',
            exitCode: r.exitCode,
            timedOut: r.timedOut,
            preferBareOutput: list.length === 1,
          }),
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        patchCommandEvent(evId, { status: 'failed', stderr: msg, exitCode: 1 })
        setLastTerminalState({
          cwd,
          lastEventId: evId,
          lastCommand: actualCmd,
          exitCode: 1,
          stdout: '',
          stderr: msg,
          timestamp: new Date().toISOString(),
        })
        results.push(`$ ${actualCmd}\n[error: ${msg}]`)
      }
    }

    const combined = results.join('\n\n')
    pushAutoExecCtx(sourceLabel ? `命令执行结果（${sourceLabel}）` : '命令执行结果', combined)
    appendToolResultToActiveSession({
      title: sourceLabel ? `命令执行结果（${sourceLabel}）` : '命令执行结果',
      meta: [`cwd: ${cwd}`, `ts: ${new Date().toISOString()}`],
      content: combined,
    })
    touchConnTtl(activeConn.ttlSec)
  }

  async function runAgentToolCallsDirect(calls: AgentToolCall[], sourceLabel: string) {
    if (mode !== 'workspace') {
      setToast({ id: uid('t'), message: '请先进入工作区再执行操作' })
      return
    }
    if (!activeConn?.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    if (wsTermPtyActive) {
      setToast({ id: uid('t'), message: '当前处于 Shell（人工）：AI exec 已禁用，请先退出 Shell' })
      return
    }
    if (aiUiMode !== 'agent' && aiUiMode !== 'debug') {
      setToast({ id: uid('t'), message: '当前模式禁止执行（请切换到 Agent/Debug）' })
      return
    }
    if (terminalConfidenceEffective(terminalStateRef.current) === 'LOW') {
      setToast({ id: uid('t'), message: '终端状态不可信（LOW）：请先重新连接或进入 Shell（人工）' })
      return
    }
    const list = (calls || []).slice(0, 8)
    if (list.length === 0) return

    setToast({ id: uid('t'), message: `执行中：${list.length} 个操作…` })
    const results: string[] = []
    for (const c of list) {
      try {
        if (c.tool === 'ssh_exec') {
          const cmdRaw = String(c.args.command || '').trim()
          const norm = normalizeInteractiveToNonInteractive(cmdRaw)
          const cmd = norm.rewrittenCommand
          const evId = uid('ce')
          pushCommandEvent({
            eventId: evId,
            source: 'ai',
            originalCommand: norm.originalCommand,
            rewrittenCommand: cmd,
            mode: norm.mode,
            rewriteReason: norm.rewriteReason,
            intent: norm.intent,
            cwd: (c.args.cwd || '').trim() || activeConn.path || '.',
            assetId: String(activeConn.hostId || ''),
            workspaceId: String((activeSpaceId || '').trim() || 'host_config_v1'),
            timestamp: new Date().toISOString(),
            status: 'pending',
            stdout: '',
            stderr: '',
            exitCode: null,
          })
          const why = isDangerousShellCommand(cmd)
          if (why) {
            patchCommandEvent(evId, { status: 'failed', stderr: `已拦截高风险命令：${why}`, exitCode: 126 })
            throw new Error(`已拦截高风险命令：${why}`)
          }
          if (/^\s*sudo\b/i.test(cmd)) {
            patchCommandEvent(evId, { status: 'failed', stderr: 'sudo 可能需要交互输入，已拦截（请去掉 sudo 或使用 root 执行）', exitCode: 126 })
            throw new Error('sudo 可能需要交互输入，已拦截（请去掉 sudo 或使用 root 执行）')
          }
          const r = await apiSshExec({
            hostId: activeConn.hostId,
            sessionId: activeConn.sessionId,
            command: cmd,
            cwd: (c.args.cwd || '').trim() || activeConn.path || '.',
          })
          patchCommandEvent(evId, {
            status: 'executed',
            stdout: String(r.stdout || '').trimEnd(),
            stderr: String(r.stderr || '').trimEnd(),
            exitCode: r.exitCode,
            timedOut: r.timedOut,
          })
          setLastTerminalState({
            cwd: (c.args.cwd || '').trim() || activeConn.path || '.',
            lastEventId: evId,
            lastCommand: cmd,
            exitCode: r.exitCode,
            stdout: String(r.stdout || '').trimEnd(),
            stderr: String(r.stderr || '').trimEnd(),
            timestamp: new Date().toISOString(),
          })
          const hint = _formatCommandHint({
            originalCommand: norm.originalCommand,
            executedCommand: cmd,
            intent: norm.intent,
            mode: norm.mode,
            rewriteReason: norm.rewriteReason,
          })
          if (hint) results.push(hint)
          if (norm.note) results.push(norm.note)
          try {
            const rid = String((r as any)?.runId || '').trim()
            const dur = typeof (r as any)?.durationMs === 'number' ? Math.max(0, Math.round((r as any).durationMs)) : null
            if (rid || dur !== null) results.push(`# ${[rid ? `runId: ${rid}` : '', dur !== null ? `durationMs: ${dur}` : ''].filter(Boolean).join(', ')}`)
          } catch {
            // ignore
          }
          results.push(
            _formatExecTranscript({
              cmd,
              stdout: r.stdout || '',
              stderr: r.stderr || '',
              exitCode: r.exitCode,
              timedOut: r.timedOut,
              preferBareOutput: list.length === 1,
            }),
          )
        } else if (c.tool === 'files_list') {
          const r = await apiFilesList({
            hostId: activeConn.hostId,
            sessionId: activeConn.sessionId,
            rootPath: activeConn.rootPath,
            path: c.args.path,
          })
          const lines = (r.items || []).slice(0, 200).map((it) => `${it.isDir ? 'DIR ' : 'FILE'}\t${it.name}\t${it.size || 0}`)
          results.push(`$ ls ${c.args.path}\n${lines.join('\n')}`)
        } else if (c.tool === 'files_read') {
          const r = await apiFilesRead({
            hostId: activeConn.hostId,
            sessionId: activeConn.sessionId,
            rootPath: activeConn.rootPath,
            path: c.args.path,
          })
          const head = `$ cat ${c.args.path}${r.truncated ? '  (truncated)' : ''}`
          const body = r.isBinary ? '[binary file]' : String(r.content || '').trimEnd()
          results.push(`${head}\n${body}`)
        } else if (c.tool === 'files_write') {
          const content = String(c.args.content ?? '')
          if (content.length > 200_000) throw new Error('写入内容过大（>200k），请分批或改用更小的变更')
          const r = await apiFilesWrite({
            hostId: activeConn.hostId,
            sessionId: activeConn.sessionId,
            rootPath: activeConn.rootPath,
            path: c.args.path,
            content,
          })
          results.push(`写入完成：${c.args.path}${r.backupPath ? `\nbackup: ${r.backupPath}` : ''}`)
          if (activeConn.openFile && activeConn.openFile.trim() === c.args.path.trim()) {
            try {
              const rr = await apiFilesRead({
                hostId: activeConn.hostId,
                sessionId: activeConn.sessionId,
                rootPath: activeConn.rootPath,
                path: c.args.path,
              })
              setFsContent(rr.content || '')
              setFsDirty(false)
            } catch {
              // ignore
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push(`[error] ${c.tool}: ${msg}`)
      }
    }

    const combined = results.join('\n\n')
    pushAutoExecCtx(sourceLabel ? `执行结果（${sourceLabel}）` : '执行结果', combined)
    appendToolResultToActiveSession({
      title: sourceLabel ? `执行结果（${sourceLabel}）` : '执行结果',
      meta: [`cwd: ${(activeConn?.path || '.').trim() || '.'}`, `ts: ${new Date().toISOString()}`],
      content: combined,
    })
    touchConnTtl(activeConn.ttlSec)
  }

  function attachPendingConfirmToActiveSessionMessage(input: { pending: PendingConfirm; targetMessageId?: string }) {
    const sid = String(activeSession?.id || activeId || '').trim()
    if (!sid) return
    const targetId = String(input.targetMessageId || '').trim()
    const pending = input.pending
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s
        const msgs = Array.isArray(s.messages) ? [...s.messages] : []

        // Prefer the explicitly provided message id.
        let idx = targetId ? msgs.findIndex((m) => m.id === targetId) : -1
        // Otherwise, fall back to the latest assistant "chat/system" message (not a tool_result).
        if (idx < 0) {
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i]
            const kind: MessageKind = (m as any)?.kind ? ((m as any).kind as any) : 'chat'
            if (m.role === 'assistant' && kind !== 'tool_result') {
              idx = i
              break
            }
          }
        }

        // If still not found, append a new assistant message for the confirmation panel.
        if (idx < 0) {
          const msg: ChatMessage = {
            id: uid('m'),
            role: 'assistant',
            kind: 'chat',
            content: '需要你确认后再执行：',
            ts: Date.now(),
            pendingConfirm: pending,
          }
          return { ...s, messages: [...msgs, msg] }
        }

        const old = msgs[idx]
        msgs[idx] = { ...old, pendingConfirm: pending }
        return { ...s, messages: msgs }
      }),
    )
  }

  function handleConfirmAction(messageId: string, action: 'reject' | 'approve_once' | 'approve_remember') {
    const mid = String(messageId || '').trim()
    if (!mid) return
    const sid = String(activeSession?.id || activeId || '').trim()
    if (!sid) return

    // Need a live workspace connection to actually execute.
    if (mode !== 'workspace' || !activeConn?.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开或不在工作区，无法执行该操作' })
      // Mark as rejected to avoid a stuck pending panel.
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sid) return s
          return {
            ...s,
            messages: (s.messages || []).map((m) => {
              if (m.id !== mid) return m
              const pc = (m as any)?.pendingConfirm as PendingConfirm | undefined
              if (!pc) return m
              return { ...m, pendingConfirm: { ...pc, status: 'rejected' } }
            }),
          }
        }),
      )
      return
    }

    // Extract payload from current in-memory session (best-effort).
    const msg = activeSession?.messages?.find((m) => m.id === mid)
    const pc = (msg as any)?.pendingConfirm as PendingConfirm | undefined
    if (!pc) return

    const approve = action === 'approve_once' || action === 'approve_remember'
    const nextStatus: PendingConfirmStatus = approve ? 'approved' : 'rejected'

    // Update message UI state first.
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sid) return s
        return {
          ...s,
          messages: (s.messages || []).map((m) => {
            if (m.id !== mid) return m
            const cur = (m as any)?.pendingConfirm as PendingConfirm | undefined
            if (!cur) return m
            return { ...m, pendingConfirm: { ...cur, status: nextStatus } }
          }),
        }
      }),
    )

    if (!approve) return

    // Safety: some commands are always blocked by policy (denylist).
    try {
      const items = Array.isArray(pc.items) ? pc.items : []
      const hardBlocked =
        items.some((it) => (it as any)?.kind === 'command' && Boolean(isDangerousShellCommand(String((it as any)?.command || '').trim()))) ||
        items.some(
          (it) =>
            (it as any)?.kind === 'tool' &&
            String((it as any)?.tool || '').trim() === 'ssh_exec' &&
            Boolean(isDangerousShellCommand(String(((it as any)?.args || {})?.command || '').trim())),
        )
      if (hardBlocked) {
        setToast({ id: uid('t'), message: '该操作被安全策略拦截，无法执行' })
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sid) return s
            return {
              ...s,
              messages: (s.messages || []).map((m) => {
                if (m.id !== mid) return m
                const cur = (m as any)?.pendingConfirm as PendingConfirm | undefined
                if (!cur) return m
                return { ...m, pendingConfirm: { ...cur, status: 'rejected' } }
              }),
            }
          }),
        )
        return
      }
    } catch {
      // ignore
    }

    // Execute + allowlist (optional)
    try {
      const label = String(pc.sourceLabel || '').trim() || (pc.type === 'command' ? '命令' : 'AI 工具调用')

      if (pc.type === 'command') {
        const cmds = (Array.isArray(pc.items) ? pc.items : [])
          .filter((it) => (it as any)?.kind === 'command')
          .map((it) => String((it as any)?.command || '').trim())
          .filter(Boolean)
          .slice(0, 8)

        if (action === 'approve_remember' && pc.allowRemember && cmdAutoRunMode === 'allowlist' && cmds.length > 0) {
          persistCmdAllowlist([...cmdAllowlist, ...cmds])
        }
        if (cmds.length > 0) void runShellCommandsDirect(cmds, { sourceLabel: label })
        return
      }

      if (pc.type === 'tool') {
        const calls: AgentToolCall[] = (Array.isArray(pc.items) ? pc.items : [])
          .filter((it) => (it as any)?.kind === 'tool')
          .map((it) => {
            const tool = String((it as any)?.tool || '').trim()
            const args = (it as any)?.args || {}
            if (tool === 'ssh_exec') return { tool: 'ssh_exec', args: { command: String(args.command || ''), cwd: args.cwd ? String(args.cwd) : undefined } }
            if (tool === 'files_list') return { tool: 'files_list', args: { path: String(args.path || '') } }
            if (tool === 'files_read') return { tool: 'files_read', args: { path: String(args.path || '') } }
            if (tool === 'files_write') return { tool: 'files_write', args: { path: String(args.path || ''), content: String(args.content ?? '') } }
            // Unknown tool: treat as ssh_exec noop to avoid runtime crashes; better to skip.
            return null as any
          })
          .filter(Boolean)
          .slice(0, 8)

        if (action === 'approve_remember' && pc.allowRemember && toolAutoRunMode === 'allowlist' && calls.length > 0) {
          persistToolAllowlist([...toolAllowlist, ...calls.map((c) => toolCallSig(c))])
        }
        if (calls.length > 0) void runAgentToolCallsDirect(calls, label)
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      setToast({ id: uid('t'), message: `执行失败：${err}` })
    }
  }

  function requestRunCommands(cmds: string[], sourceLabel: string, targetMessageId?: string) {
    const list = (cmds || []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    if (list.length === 0) return
    const label = String(sourceLabel || '').trim() || '命令'

    // Intent-first: system monitoring snapshot should NOT be blocked by execution policy UI.
    // If a command will be rewritten into a bounded snapshot, auto-run it (Cursor-like).
    const norms = list.map((c) => normalizeInteractiveToNonInteractive(c))
    const allMonitoringSnapshot = norms.every((n) => n.intent === 'system_monitoring' && n.mode === 'snapshot')
    if (allMonitoringSnapshot) {
      void runShellCommandsDirect(list, { sourceLabel: label ? `${label}（系统快照）` : '系统快照' })
      return
    }

    // Decide by policy
    if (cmdAutoRunMode === 'all') {
      void runShellCommandsDirect(list, { sourceLabel: label })
      return
    }
    if (cmdAutoRunMode === 'allowlist' && allowlistHasAll(list)) {
      void runShellCommandsDirect(list, { sourceLabel: label })
      return
    }
    // default: ask, but auto-run very safe read-only commands to reduce interruptions (Cursor-like)
    if (list.every((c) => isSafeAutoRunShellCommand(c))) {
      void runShellCommandsDirect(list, { sourceLabel: label })
      return
    }
    // Cursor-like: attach confirmation UI to the originating assistant message (inline),
    // rather than showing a global floating bar.
    const pending: PendingConfirm = {
      type: 'command',
      items: list.map((cmd) => {
        const why = isDangerousShellCommand(cmd)
        return { kind: 'command', command: cmd, reason: why || undefined }
      }),
      sourceLabel: label,
      allowRemember: cmdAutoRunMode === 'allowlist',
      status: 'pending',
      createdAt: Date.now(),
    }
    attachPendingConfirmToActiveSessionMessage({ pending, targetMessageId })
  }

  function buildWsUrl(path: string, params: Record<string, string | number | undefined>) {
    const httpBase = normalizeApiBase(apiBase) || window.location.origin
    const u = new URL(httpBase)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    // ensure path joins cleanly
    u.pathname = path
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  function _stripCwdMarkers(chunk: string): { cleaned: string; cwd: string | null } {
    const s = String(chunk || '')
    if (!s) return { cleaned: '', cwd: null }
    let cwd: string | null = null
    const cleaned = s.replace(/__CS_CWD__(.*?)__CS_END__\r?\n/g, (_m, p1) => {
      const v = String(p1 || '').trim()
      if (v) cwd = v
      return ''
    })
    return { cleaned, cwd }
  }

  function _markTerminalManualIntervention() {
    try {
      const prev = terminalStateRef.current
      const now = Date.now()
      const sid = String(activeConn?.sessionId || prev?.session_id || '').trim()
      const cwd = (wsTermCwdRef.current || '').trim() || (activeConn?.path || '').trim() || (prev?.cwd || '').trim() || '.'
      const base: TerminalStateModel =
        prev ||
        ({
          session_id: sid,
          os: 'linux',
          shell: 'bash',
          cwd,
          last_updated: now,
          snapshotTime: now,
          command_history: [],
        } as any)
      persistTerminalState({
        ...base,
        session_id: sid || base.session_id,
        cwd,
        last_updated: now,
        snapshotTime: now,
        confidenceLevel: 'MEDIUM',
        staleReason: 'manual_intervention',
      })
    } catch {
      // ignore
    }
  }

  async function wsTermStartManualShell() {
    if (mode !== 'workspace') {
      setToast({ id: uid('t'), message: '请先进入工作区再打开 Shell（人工）' })
      return
    }
    if (!activeConn?.sessionId) {
      setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
      return
    }
    const term = wsTermXRef.current
    if (!term) {
      setToast({ id: uid('t'), message: '请先展开终端再打开 Shell（人工）' })
      return
    }
    if (wsTermWsRef.current && wsTermWsRef.current.readyState === WebSocket.OPEN) {
      setToast({ id: uid('t'), message: 'Shell（人工）已在运行' })
      return
    }
    try {
      const lease = await apiPtyLeaseCreate({ sessionId: activeConn.sessionId })
      if (!lease?.ok || !lease.leaseId) {
        setToast({ id: uid('t'), message: '当前后端未启用 Shell/PTY（缺少 PTY lease 接口）' })
        return
      }
      wsTermPtyLeaseIdRef.current = lease.leaseId
      const cwd = (wsTermCwdRef.current || '').trim() || (activeConn.path || '').trim() || '.'
      const url = buildWsUrl('/api/ssh/pty/ws', {
        sessionId: activeConn.sessionId,
        leaseId: lease.leaseId,
        cols: term.cols || 120,
        rows: term.rows || 30,
        cwd,
      })
      const ws = new WebSocket(url)
      wsTermWsRef.current = ws
      setWsTermPtyActive(true)
      _markTerminalManualIntervention()

      ws.onopen = () => {
        try {
          term.write('\r\n[Shell] 已进入人工 PTY；AI 将禁止 exec；输入 `exit` 退出。\r\n')
          wsTermAppendTranscript('\n[Shell] entered manual PTY\n')
        } catch {
          // ignore
        }
        wsTermSafeFitAndResize()
      }
      ws.onmessage = (ev) => {
        try {
          const { cleaned, cwd: nextCwd } = _stripCwdMarkers(String((ev as any)?.data || ''))
          if (nextCwd) {
            wsTermCwdRef.current = nextCwd
            setActiveConn((p) => (p ? { ...p, path: nextCwd } : p))
            setWsPathDraft(nextCwd)
          }
          if (cleaned) {
            term.write(cleaned)
            wsTermAppendTranscript(cleaned)
          }
        } catch {
          // ignore
        }
      }
      ws.onerror = () => {
        // best-effort; onclose will handle cleanup
      }
      ws.onclose = () => {
        wsTermWsRef.current = null
        setWsTermPtyActive(false)
        wsTermPtyLeaseIdRef.current = ''
        try {
          term.write('\r\n[Shell] 已退出。\r\n')
          wsTermAppendTranscript('\n[Shell] closed\n')
        } catch {
          // ignore
        }
        _markTerminalManualIntervention()
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setWsTermPtyActive(false)
      wsTermPtyLeaseIdRef.current = ''
      try {
        wsTermWsRef.current?.close()
      } catch {
        // ignore
      }
      wsTermWsRef.current = null
      setToast({ id: uid('t'), message: `打开 Shell 失败：${msg}` })
    }
  }

  async function wsTermStopManualShell() {
    const ws = wsTermWsRef.current
    wsTermWsRef.current = null
    setWsTermPtyActive(false)
    const lid = (wsTermPtyLeaseIdRef.current || '').trim()
    wsTermPtyLeaseIdRef.current = ''
    try {
      ws?.close()
    } catch {
      // ignore
    }
    if (lid) {
      try {
        await apiPtyLeaseEnd({ leaseId: lid })
      } catch {
        // ignore
      }
    }
    _markTerminalManualIntervention()
  }

  // Workspace: terminal (Phase 1: command-event driven, no raw PTY input bypass).
  // - Dragging height must NOT recreate the terminal.
  // - Only init when terminal becomes visible (height>0), and dispose when hidden (height==0).
  useEffect(() => {
    const visible = wsTermH > 0
    const prevVisible = wsTermVisibleRef.current
    wsTermVisibleRef.current = visible

    if (mode !== 'workspace' || !activeConn?.sessionId) {
      if (prevVisible) wsTermDispose()
      return
    }

    if (!visible) {
      if (prevVisible) wsTermDispose()
      return
    }

    const el = wsTermElRef.current
    if (!el) return

    // Already initialized
    if (wsTermXRef.current) return

    // New terminal session: reset transcript & input.
    wsTermTranscriptRef.current = ''
    wsTermInputLineRef.current = ''
    wsTermBumpCtxVer()

    const term = new XTerm({
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
      fontSize: 12,
      theme: { background: 'rgba(0,0,0,0)' },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    el.innerHTML = ''
    term.open(el)

    wsTermXRef.current = term
    wsTermFitRef.current = fit
    wsTermWsRef.current = null
    wsTermCwdRef.current = (activeConn.path || '').trim() || '.'

    // Defer to next paint to avoid xterm internal dimension race.
    requestAnimationFrame(() => {
      wsTermSafeFitAndResize()
      try {
        const active = document.activeElement
        const isInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')
        const isPathInput = Boolean(wsPathInputRef.current && active === wsPathInputRef.current)
        if (!isInput && !isPathInput && wsTermUserWantsFocusRef.current) {
          term.focus()
        }
      } catch {
        // ignore
      }
    })

    function termWrite(s: string) {
      try {
        term.write(String(s || '').replace(/\n/g, '\r\n'))
      } catch {
        // ignore
      }
    }

    function promptPrefix(): string {
      const user = (wsTermPromptUserRef.current || '').trim()
      const host = (wsTermPromptHostRef.current || '').trim()
      if (user && host) return `[${user}@${host} ${((wsTermCwdRef.current || '').trim() || '.').split('/').filter(Boolean).slice(-1)[0] || '.'}]`
      if (host) return `[${host} ${((wsTermCwdRef.current || '').trim() || '.').split('/').filter(Boolean).slice(-1)[0] || '.'}]`
      return `[${((wsTermCwdRef.current || '').trim() || '.').split('/').filter(Boolean).slice(-1)[0] || '.'}]`
    }

    function promptChar(): string {
      const user = (wsTermPromptUserRef.current || '').trim().toLowerCase()
      return user === 'root' ? '#' : '$'
    }

    function printPrompt() {
      const cwd = (wsTermCwdRef.current || '').trim() || '.'
      const base = cwd.split('/').filter(Boolean).slice(-1)[0] || '.'
      // Keep it Cursor-like but bash-ish.
      const head = promptPrefix().replace(/\s+\]$/, ` ${base}]`)
      termWrite(`${head}${promptChar()} `)
      wsTermAppendTranscript(`\n${head}${promptChar()} `)
    }

    // Initial identity probe (best-effort), then prompt.
    void (async () => {
      try {
        const sid = activeConn?.sessionId
        if (!sid) return
        const cwd = (wsTermCwdRef.current || '').trim() || '.'
        const r1 = await apiSshExec({ hostId: activeConn.hostId, sessionId: sid, command: 'whoami', cwd })
        const r2 = await apiSshExec({ hostId: activeConn.hostId, sessionId: sid, command: 'hostname', cwd })
        wsTermPromptUserRef.current = String(r1.stdout || '').trim().split(/\s+/)[0] || ''
        wsTermPromptHostRef.current = String(r2.stdout || '').trim().split(/\s+/)[0] || ''
      } catch {
        // ignore
      } finally {
        printPrompt()
      }
    })()

    async function executeTerminalLine(rawLine: string) {
      const lineRaw = String(rawLine || '').trim()
      const sid = activeConn?.sessionId
      if (!sid) {
        termWrite('连接已断开，请先重新连接。\n')
        printPrompt()
        return
      }
      if (aiUiMode !== 'agent' && aiUiMode !== 'debug') {
        termWrite('[blocked] 当前模式禁止执行（请切换到 Agent/Debug；或进入 Shell（人工））\n')
        printPrompt()
        return
      }
      if (terminalConfidenceEffective(terminalStateRef.current) === 'LOW') {
        termWrite('[blocked] 终端状态不可信（LOW）：请先重新连接或进入 Shell（人工）\n')
        printPrompt()
        return
      }
      if (!lineRaw) {
        printPrompt()
        return
      }
      if (wsTermExecBusyRef.current) {
        termWrite('[busy] 上一条命令仍在执行中…\n')
        printPrompt()
        return
      }
      wsTermExecBusyRef.current = true

      const cwd = (wsTermCwdRef.current || '').trim() || (activeConn.path || '').trim() || '.'
      const norm = normalizeInteractiveToNonInteractive(lineRaw)
      const line = norm.rewrittenCommand
      const eventId = uid('ce')
      const ts = new Date().toISOString()
      const evBase: CommandEvent = {
        eventId,
        source: 'user_terminal',
        originalCommand: norm.originalCommand,
        rewrittenCommand: line,
        mode: norm.mode,
        rewriteReason: norm.rewriteReason,
        intent: norm.intent,
        cwd,
        assetId: String(activeConn.hostId || ''),
        workspaceId: String((activeSpaceId || '').trim() || 'host_config_v1'),
        timestamp: ts,
        status: 'pending',
        stdout: '',
        stderr: '',
        exitCode: null,
      }
      pushCommandEvent(evBase)

      function finalizeTerminalState(p: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }) {
        setLastTerminalState({
          cwd: (wsTermCwdRef.current || '').trim() || cwd,
          lastEventId: eventId,
          lastCommand: line,
          exitCode: p.exitCode,
          stdout: p.stdout,
          stderr: p.stderr,
          timestamp: new Date().toISOString(),
        })
      }

      try {
        // Hard safety: never run denylisted commands even from user terminal.
        const why = isDangerousShellCommand(line)
        if (why) {
          const msg = `[blocked] ${why}`
          patchCommandEvent(eventId, { status: 'failed', stderr: msg, exitCode: 126 })
          finalizeTerminalState({ stdout: '', stderr: msg, exitCode: 126 })
          termWrite(`${msg}\n`)
          printPrompt()
          return
        }
        if (/^\s*sudo\b/i.test(line)) {
          const msg = '[blocked] sudo 可能需要交互输入，已拦截（请去掉 sudo 或使用 root 执行）'
          patchCommandEvent(eventId, { status: 'failed', stderr: msg, exitCode: 126 })
          finalizeTerminalState({ stdout: '', stderr: msg, exitCode: 126 })
          termWrite(`${msg}\n`)
          printPrompt()
          return
        }

        // Built-ins
        if (/^\s*clear\s*$/i.test(line)) {
          try {
            term.clear()
          } catch {
            // ignore
          }
          wsTermTranscriptRef.current = ''
          wsTermBumpCtxVer()
          patchCommandEvent(eventId, { status: 'executed', exitCode: 0 })
          finalizeTerminalState({ stdout: '', stderr: '', exitCode: 0 })
          printPrompt()
          return
        }

        if (norm.note) {
          termWrite(`${norm.note}\n`)
        }

        // cd handling: resolve via `cd ... && pwd`
        const cdM = /^\s*cd(?:\s+(.+))?\s*$/i.exec(line)
        if (cdM) {
          const rawArg = String(cdM[1] || '').trim()
          const arg = rawArg || (activeConn.rootPath || '').trim() || '.'
          const q = (s: string) => "'" + String(s || '').replace(/'/g, "'\\''") + "'"
          const cmd = `cd ${q(arg)} && pwd`
          const r = await apiSshExec({ hostId: activeConn.hostId, sessionId: sid, command: cmd, cwd })
          const out = String(r.stdout || '').trimEnd()
          const err = String(r.stderr || '').trimEnd()
          const exitCode = r.exitCode
          let nextCwd = cwd
          if (exitCode === 0 && out) {
            const parts = out.split('\n').map((x) => x.trim()).filter(Boolean)
            if (parts.length) nextCwd = parts[parts.length - 1]
          }
          wsTermCwdRef.current = nextCwd || cwd
          setActiveConn((p) => (p ? { ...p, path: wsTermCwdRef.current } : p))
          setWsPathDraft(wsTermCwdRef.current)
          // best-effort refresh file tree
          setTimeout(() => {
            try {
              void workspaceLoadFs(true)
            } catch {
              // ignore
            }
          }, 0)

          patchCommandEvent(eventId, { status: 'executed', stdout: out, stderr: err, exitCode, timedOut: r.timedOut })
          finalizeTerminalState({ stdout: out, stderr: err, exitCode, timedOut: r.timedOut })
          if (err) termWrite(`${err}\n`)
          printPrompt()
          return
        }

        const r = await apiSshExec({ hostId: activeConn.hostId, sessionId: sid, command: line, cwd })
        const out = String(r.stdout || '').trimEnd()
        const err = String(r.stderr || '').trimEnd()
        patchCommandEvent(eventId, { status: 'executed', stdout: out, stderr: err, exitCode: r.exitCode, timedOut: r.timedOut })
        finalizeTerminalState({ stdout: out, stderr: err, exitCode: r.exitCode, timedOut: r.timedOut })
        if (out) termWrite(`${out}\n`)
        if (err) termWrite(`${err}\n`)
        printPrompt()
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        patchCommandEvent(eventId, { status: 'failed', stderr: msg, exitCode: 1 })
        finalizeTerminalState({ stdout: '', stderr: msg, exitCode: 1 })
        termWrite(`[error] ${msg}\n`)
        printPrompt()
      } finally {
        wsTermExecBusyRef.current = false
      }
    }

    const sub = term.onData((d) => {
      // PTY mode: raw passthrough (human-controlled Manual/Shell).
      try {
        const ws = wsTermWsRef.current
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(d)
          return
        }
      } catch {
        // ignore
      }
      // Command-event terminal: capture a single input line and execute on Enter.
      if (d.startsWith('\u001b')) return // ignore escape sequences
      for (const ch of d) {
        // Ctrl+C
        if (ch === '\u0003') {
          wsTermInputLineRef.current = ''
          termWrite('^C\n')
          printPrompt()
          continue
        }
        // Enter
        if (ch === '\r' || ch === '\n') {
          const line = wsTermInputLineRef.current || ''
          wsTermInputLineRef.current = ''
          termWrite('\n')
          wsTermAppendTranscript(`\n# user_input: ${String(line || '').trim()}\n`)
          void executeTerminalLine(line)
          continue
        }
        // Backspace
        if (ch === '\u007f') {
          if ((wsTermInputLineRef.current || '').length > 0) {
            wsTermInputLineRef.current = (wsTermInputLineRef.current || '').slice(0, -1)
            // erase one char visually
            termWrite('\b \b')
          }
          continue
        }
        // Printable
        if (ch >= ' ') {
          if ((wsTermInputLineRef.current || '').length < 400) {
            wsTermInputLineRef.current += ch
            termWrite(ch)
          }
        }
      }
    })

    // Fit on window resize (no ResizeObserver; it triggers during drag/layout churn).
    let raf = 0
    const onWinResize = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        wsTermSafeFitAndResize()
      })
    }
    window.addEventListener('resize', onWinResize)

    return () => {
      try {
        window.removeEventListener('resize', onWinResize)
      } catch {
        // ignore
      }
      try {
        if (raf) cancelAnimationFrame(raf)
      } catch {
        // ignore
      }
      try {
        sub.dispose()
      } catch {
        // ignore
      }
      wsTermDispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeConn?.sessionId, activeConn?.hostId, wsTermH > 0, wsToolsOpen])

  // Workspace: keep directory input draft in sync with committed activeConn.path (without breaking typing).
  useEffect(() => {
    if (mode !== 'workspace') return
    const committed = (activeConn?.path || '').trim()
    const el = wsPathInputRef.current
    const focused = Boolean(el && document.activeElement === el)
    if (!focused) setWsPathDraft(committed)
  }, [mode, activeConn?.path])

  // Workspace: refit on splitter changes (safe).
  useEffect(() => {
    if (wsTermH <= 0) return
    let raf = requestAnimationFrame(() => {
      raf = 0
      wsTermSafeFitAndResize()
    })
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [wsTermH])

  // Workspace: refit terminal when left/right split changes (vertical drag).
  useEffect(() => {
    if (wsTermH <= 0) return
    let raf = requestAnimationFrame(() => {
      raf = 0
      wsTermSafeFitAndResize()
    })
    return () => {
      if (raf) cancelAnimationFrame(raf)
    }
  }, [wsLeftW, wsTermH])

  // Auto-load file list when opening/switching to Files, or when path/root changes.
  useEffect(() => {
    if (!remotePanel) return
    if (remotePanel.kind !== 'files') return
    // Do not auto-load until we have either a session or enough one-shot auth info.
    if (!activeConn?.sessionId && !authReady(remoteAuth)) return
    const key = `${remotePanel.hostId}|${remotePanel.rootPath}|${remotePanel.path || '.'}`
    if (fsAutoKeyRef.current === key) return
    fsAutoKeyRef.current = key
    // best-effort: do not block render
    void remoteLoadFs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remotePanel?.kind, remotePanel?.hostId, remotePanel?.rootPath, remotePanel?.path])

  // Keep workspace file tree in sync by reusing the same file listing state.
  useEffect(() => {
    if (mode !== 'workspace') return
    if (!activeConn) return
    setRemotePanel((p) => {
      const want = { kind: 'files' as const, hostId: activeConn.hostId, rootPath: activeConn.rootPath, path: activeConn.path || '.', openFile: activeConn.openFile || null }
      if (!p) return want
      const same = p.kind === want.kind && p.hostId === want.hostId && p.rootPath === want.rootPath && p.path === want.path && (p.openFile || null) === (want.openFile || null)
      return same ? p : want
    })
  }, [mode, activeConn?.hostId, activeConn?.rootPath, activeConn?.path, activeConn?.openFile])

  // Workspace: auto load fs when entering or when restored (fsItems is not persisted).
  useEffect(() => {
    if (mode !== 'workspace') return
    if (!activeConn?.sessionId) return
    if (remoteBusy) return
    if (fsItems.length > 0) return
    void workspaceLoadFs(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeConn?.sessionId, activeConn?.hostId, activeConn?.rootPath, activeConn?.path])

  // Workspace: restore opened file content after refresh (openFile is persisted, fsContent is not).
  useEffect(() => {
    if (mode !== 'workspace') return
    if (!activeConn?.sessionId) return
    const fp = String(activeConn.openFile || '').trim()
    if (!fp) return
    if (remoteBusy) return
    if (fsDirty) return // do not override unsaved edits
    const key = `${activeConn.hostId}|${activeConn.rootPath}|${fp}|${activeConn.sessionId}`
    if (openFileAutoKeyRef.current === key) return
    openFileAutoKeyRef.current = key
    void (async () => {
      try {
        const r = await apiFilesRead({
          hostId: activeConn.hostId,
          rootPath: activeConn.rootPath,
          path: fp,
          sessionId: activeConn.sessionId || undefined,
        })
        setFsContent(r.content || '')
        setFsDirty(false)
        touchConnTtl(activeConn.ttlSec)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const m = msg.toLowerCase()
        if (m.includes('session expired') || m.includes('http 410')) {
          setToast({ id: uid('t'), message: '连接已断开，请点击“重新连接”继续' })
          markConnExpired('连接已断开（可能是超时或服务重启）。请点击右上角“重新连接”。')
          // Avoid persisting unfriendly english errors into the connect modal.
          setRemoteErr('')
        } else {
          setToast({ id: uid('t'), message: `恢复文件失败：${msg}` })
        }
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeConn?.sessionId, activeConn?.hostId, activeConn?.rootPath, activeConn?.openFile, remoteBusy, fsDirty])

  // Local expiry timer: keep page, but prompt reconnect when TTL passes.
  useEffect(() => {
    if (mode !== 'workspace') return
    if (!activeConn?.sessionId) return
    const exp = activeConn.expiresAt || 0
    if (!exp) return
    const t = window.setInterval(() => {
      if (!activeConn?.sessionId) return
      if (activeConn.expiresAt && Date.now() > activeConn.expiresAt) {
        setToast({ id: uid('t'), message: '连接已断开，请点击“重新连接”继续' })
        markConnExpired('连接已断开（空闲超时）。请点击右上角“重新连接”。')
      }
    }, 3000)
    return () => window.clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, activeConn?.sessionId, activeConn?.expiresAt])

  async function remoteOpenFile(filePath: string) {
    if (!remotePanel) return
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      const r = await apiFilesRead({
        hostId: remotePanel.hostId,
        rootPath: remotePanel.rootPath,
        path: filePath,
        sessionId: activeConn?.sessionId || undefined,
      })
      setFsContent(r.content || '')
      setFsDirty(false)
      setRemotePanel((p) => (p ? { ...p, openFile: filePath } : p))
      setActiveConn((p) => (p ? { ...p, openFile: filePath } : p))
      const h = hostById(remotePanel.hostId)
      if (h) markConnected(h)
    } catch (e) {
      setRemoteErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoteBusy(false)
    }
  }

  async function remoteSaveFile() {
    if (!remotePanel) return
    const fp = (remotePanel.openFile || '').trim()
    if (!fp) return
    setRemoteErr('')
    setRemoteBusy(true)
    try {
      await apiFilesWrite({
        hostId: remotePanel.hostId,
        rootPath: remotePanel.rootPath,
        path: fp,
        content: fsContent,
        sessionId: activeConn?.sessionId || undefined,
      })
      setFsDirty(false)
      setToast({ id: uid('t'), message: '已保存（并生成备份）' })
      const h = hostById(remotePanel.hostId)
      if (h) markConnected(h)
      touchConnTtl(activeConn?.ttlSec)
      // Auto-add latest file content to chat context (workspace mode convenience)
      if (mode === 'workspace') {
        const title = fp
        ctxAdd({ kind: 'file', title, content: fsContent })
      }
    } catch (e) {
      setRemoteErr(e instanceof Error ? e.message : String(e))
    } finally {
      setRemoteBusy(false)
    }
  }

  function hostById(id: ID): Host | null {
    return (hostCfg.hosts || []).find((h) => h.id === id && !h.deletedAt) ?? null
  }

  function openConnectModal(hostId: ID) {
    const h = hostById(hostId)
    if (!h) return
    // Clear stale errors (e.g. session expired) before showing the modal.
    setRemoteErr('')
    // UX decision: default always /root (do not follow existing workspace rootPath like /srv/www)
    const rootPath = '/root'
    const sshUser = (h.user || (h as any).username || '').toString().trim()
    const credId = (h as any).credentialId as ID | null
    const cred = credId ? hostCfg.credentials.find((c) => c.id === credId) ?? null : null
    const type = (cred?.type as HostAuthType) || 'password'
    setConnectModal({
      open: true,
      hostId,
      rootPath,
      sshUser,
      persistSshUser: false,
      remember: false,
      auth: { type, password: '', sshKey: '', passphrase: '', credentialId: credId || null },
    })
  }

  async function reconnectWorkspace() {
    if (!activeConn) return
    const hostId = activeConn.hostId
    const rp = (activeConn.rootPath || '/root').trim() || '/root'
    // If we don't have reusable auth (password is intentionally not kept), open modal.
    if (!authReady(remoteAuth)) {
      setRemoteErr('')
      const h = hostById(hostId)
      const sshUser = (h?.user || (h as any)?.username || '').toString().trim()
      setConnectModal({ open: true, hostId, rootPath: rp, sshUser, persistSshUser: false, remember: false, auth: { ...remoteAuth, password: '' } })
      return
    }
    setRemoteBusy(true)
    setRemoteErr('')
    try {
      const u = wsSshUserOverrideByHostRef.current.get(String(hostId) || '') || ''
      const r = await apiSshConnect({ hostId, auth: remoteAuth, username: u.trim() || undefined })
      // Restore per-host AI mode and sync to backend (server-enforced).
      try {
        const spaceId = safeActiveSpaceId()
        const mk = aiUiModeStorageKey({ spaceId, hostId: String(hostId) })
        const rawM = String(localStorage.getItem(mk) || '').trim().toLowerCase()
        const uiM: AiUiMode =
          rawM === 'ask' || rawM === 'plan' || rawM === 'agent' || rawM === 'debug' ? (rawM as any) : 'agent'
        setAiUiMode(uiM)
        void apiAiModeSet({ sessionId: r.sessionId, mode: _aiExecModeFromUiMode(uiM) }).catch(() => {})
      } catch {
        // ignore
      }
      setActiveConn((p) =>
        p
          ? { ...p, sessionId: r.sessionId, ttlSec: r.ttlSec, expiresAt: Date.now() + r.ttlSec * 1000, expired: false, lastError: undefined }
          : p,
      )
      setToast({ id: uid('t'), message: '已重新连接' })
      try {
        setWsToolsOpen(true)
      } catch {
        // ignore
      }
      // Eagerly refresh file list without relying on state timing.
      void (async () => {
        try {
          const rootPath = rp
          const path = (activeConn.path || rp || '.').trim() || '.'
          const r2 = await apiFilesList({ hostId, rootPath, path, sessionId: r.sessionId })
          const np = (r2.path || path || '.').trim() || '.'
          setFsItems(r2.items || [])
          setWsPathDraft(np)
          setRemotePanel({ kind: 'files', hostId, rootPath, path: np, openFile: null })
          fsAutoKeyRef.current = `${hostId}|${rootPath}|${np}`
          setActiveConn((p) => (p ? { ...p, path: np } : p))
        } catch {
          // ignore
        }
      })()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const m = msg.toLowerCase()
      const isAuth =
        m.includes('authenticationexception') ||
        m.includes('permission denied') ||
        m.includes('auth failed') ||
        m.includes('bad authentication') ||
        m.includes('authentication failed')

      if (isAuth) {
        const pretty = '认证失败：请重新输入密码，或更换密钥后重试。'
        setRemoteErr(pretty)
        setToast({ id: uid('t'), message: pretty })
      } else {
        setRemoteErr(msg)
        setToast({ id: uid('t'), message: `重连失败：${msg}` })
      }

      // Always fall back to the connect modal so user can fix auth and retry without leaving workspace.
      setRemoteErr('')
      try {
        const h = hostById(hostId)
        const sshUser = (wsSshUserOverrideByHostRef.current.get(String(hostId) || '') || (h?.user || (h as any)?.username || '') || '').toString().trim()
        setConnectModal({ open: true, hostId, rootPath: rp, sshUser, persistSshUser: false, remember: false, auth: { ...remoteAuth, password: '' } })
      } catch {
        setConnectModal({ open: true, hostId, rootPath: rp, sshUser: '', persistSshUser: false, remember: false, auth: { ...remoteAuth, password: '' } })
      }
    } finally {
      setRemoteBusy(false)
    }
  }

  function defaultRootPathForHost(hostId: ID): string {
    // Keep the default stable and simple.
    // (We intentionally do not infer from past workspaces to avoid confusing defaults.)
    return '/root'
  }

  // NOTE: P0 remote drawer has been removed from UI. We keep remotePanel state only as an internal
  // mechanism to reuse file ops in workspace mode.

  function remotePayload(h: Host) {
    const username = (h.user || (h as any).username || '').trim()
    return { address: h.address, port: h.port, username }
  }

  function remotePayloadWithUser(h: Host, userOverride?: string | null) {
    const u = String(userOverride || '').trim()
    const username = u || (h.user || (h as any).username || '').trim()
    return { address: h.address, port: h.port, username }
  }

  function buildAuthPayload(d: RemoteAuthDraft) {
    const cid = (d.credentialId || '').trim()
    // IMPORTANT: If user provided one-shot secrets, prefer them over a bound credentialId.
    // This allows recovery when the bound credential is missing/corrupted on backend.
    if (d.type === 'password') {
      const pw = String(d.password || '')
      if (pw.trim()) return { type: 'password', password: pw }
      if (cid) return { credentialId: cid }
      return { type: 'password', password: '' }
    }
    if (d.type === 'ssh_key') {
      const key = String(d.sshKey || '')
      if (key.trim()) return { type: 'ssh_key', privateKey: key, passphrase: d.passphrase || undefined }
      if (cid) return { credentialId: cid }
      return { type: 'ssh_key', privateKey: '', passphrase: d.passphrase || undefined }
    }
    return { type: 'agent' }
  }

  async function apiSshConnect(opts: { hostId: ID; auth: RemoteAuthDraft; username?: string }) {
    const h = hostById(opts.hostId)
    if (!h) throw new Error('host not found')
    const res = await apiFetch('/api/ssh/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: remotePayloadWithUser(h, opts.username || null),
        auth: buildAuthPayload(opts.auth),
        timeoutSec: 15,
      }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(apiDetailMessage(j?.detail, `HTTP ${res.status}`))
    if (!j?.ok || !j?.sessionId) throw new Error(apiDetailMessage(j?.detail, 'bad response'))
    return j as { ok: true; sessionId: string; ttlSec: number; host: any }
  }

  async function apiSshDisconnect(opts: { sessionId: string }) {
    const res = await apiFetch('/api/ssh/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: opts.sessionId }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; deleted: boolean }
  }

  async function apiSshExec(opts: { hostId: ID; command: string; cwd?: string; sessionId?: string }) {
    const h = hostById(opts.hostId)
    if (!h) throw new Error('host not found')
    const res = await apiFetch('/api/ssh/exec', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: opts.sessionId || undefined,
        host: remotePayload(h),
        auth: buildAuthPayload(remoteAuth),
        command: opts.command,
        cwd: opts.cwd || undefined,
        timeoutSec: 15,
      }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as {
      ok: true
      timedOut: boolean
      exitCode: number | null
      stdout: string
      stderr: string
      durationMs: number
    }
  }

  async function apiPtyLeaseCreate(opts: { sessionId: string }) {
    const res = await apiFetch('/api/ssh/pty/lease/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: opts.sessionId }),
    })
    const j = (await res.json().catch(() => null)) as any
    // Best-effort: older backend deployments may not have PTY lease endpoints.
    if (!res.ok) return { ok: false, detail: j?.detail || `HTTP ${res.status}` } as any
    if (!j?.ok || !j?.leaseId) return { ok: false, detail: j?.detail || 'bad response' } as any
    return j as { ok: true; sessionId: string; leaseId: string; expiresAt: number }
  }

  async function apiPtyLeaseEnd(opts: { leaseId: string }) {
    const res = await apiFetch('/api/ssh/pty/lease/end', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaseId: opts.leaseId }),
    })
    const j = (await res.json().catch(() => null)) as any
    // Best-effort: ignore if backend doesn't support lease.
    if (!res.ok) return { ok: false, detail: j?.detail || `HTTP ${res.status}` } as any
    if (!j?.ok) return { ok: false, detail: j?.detail || 'bad response' } as any
    return j as { ok: true; leaseId: string }
  }

  async function apiFilesList(opts: { hostId: ID; rootPath: string; path: string; sessionId?: string }) {
    const h = hostById(opts.hostId)
    if (!h) throw new Error('host not found')
    if (!opts.sessionId) throw new Error('missing sessionId')
    const res = await apiFetch('/api/files/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: opts.sessionId,
        host: remotePayload(h),
        auth: buildAuthPayload(remoteAuth),
        rootPath: opts.rootPath,
        path: opts.path,
        limit: 300,
        timeoutSec: 15,
      }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; path: string; rootPath: string; items: Array<{ name: string; isDir: boolean; size: number; mtime: number }> }
  }

  async function apiFilesRead(opts: { hostId: ID; rootPath: string; path: string; sessionId?: string }) {
    const h = hostById(opts.hostId)
    if (!h) throw new Error('host not found')
    if (!opts.sessionId) throw new Error('missing sessionId')
    const res = await apiFetch('/api/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: opts.sessionId,
        host: remotePayload(h),
        auth: buildAuthPayload(remoteAuth),
        rootPath: opts.rootPath,
        path: opts.path,
        offset: 0,
        limit: 262_144,
        timeoutSec: 20,
      }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; path: string; content: string; truncated: boolean; isBinary: boolean }
  }

  async function apiFilesWrite(opts: { hostId: ID; rootPath: string; path: string; content: string; sessionId?: string }) {
    const h = hostById(opts.hostId)
    if (!h) throw new Error('host not found')
    if (!opts.sessionId) throw new Error('missing sessionId')
    const res = await apiFetch('/api/files/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: opts.sessionId,
        host: remotePayload(h),
        auth: buildAuthPayload(remoteAuth),
        rootPath: opts.rootPath,
        path: opts.path,
        content: opts.content,
        confirm: true,
        createBackup: true,
        timeoutSec: 30,
      }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; path: string; backupPath?: string | null }
  }

  async function apiAiModeSet(opts: { sessionId: string; mode: 'ask' | 'plan' | 'execute' | 'debug' }) {
    const res = await apiFetch('/api/ai/mode/set', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: opts.sessionId, mode: opts.mode }),
    })
    const j = (await res.json().catch(() => null)) as any
    // Best-effort: backend may not have this endpoint in older deployments.
    if (!res.ok) return { ok: false, detail: j?.detail || `HTTP ${res.status}` } as any
    if (!j?.ok) return { ok: false, detail: j?.detail || 'bad response' } as any
    return j as { ok: true; sessionId: string; mode: string; updatedAt: number }
  }

  function persistAiUiMode(next: AiUiMode) {
    const m = (next || 'agent') as AiUiMode
    setAiUiMode(m)
    try {
      const hostId = (activeConn?.hostId || '').trim()
      const spaceId = safeActiveSpaceId()
      if (!hostId) return
      const mk = aiUiModeStorageKey({ spaceId, hostId })
      localStorage.setItem(mk, m)
    } catch {
      // ignore
    }
    // Best-effort: sync to backend if connected.
    try {
      const sid = String(activeConn?.sessionId || '').trim()
      if (!sid) return
      void apiAiModeSet({ sessionId: sid, mode: _aiExecModeFromUiMode(m) }).catch(() => {})
    } catch {
      // ignore
    }
  }

  function terminalConfidenceEffective(st: TerminalStateModel | null): 'HIGH' | 'MEDIUM' | 'LOW' {
    try {
      if (!st) return 'LOW'
      const now = Date.now()
      const snap = typeof st.snapshotTime === 'number' ? st.snapshotTime : typeof st.last_updated === 'number' ? st.last_updated : now
      const age = Math.max(0, now - snap)
      if (st.staleReason === 'timeout') return 'LOW'
      if (st.staleReason === 'manual_intervention') {
        // Balanced: keep MEDIUM after manual until refreshed.
        return 'MEDIUM'
      }
      if (age >= 30 * 60_000) return 'LOW'
      if (age >= 10 * 60_000) return 'MEDIUM'
      return (st.confidenceLevel as any) || 'HIGH'
    } catch {
      return 'LOW'
    }
  }

  async function apiRulesGet(opts: { spaceId: string }) {
    const sid = (opts.spaceId || '').trim() || 'host_config_v1'
    const res = await apiFetch(`/api/rules/get?spaceId=${encodeURIComponent(sid)}`, { method: 'GET' })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true; spaceId: string; userRules: string; projectRules: string; commands: string }
  }

  async function apiRulesSave(opts: { spaceId: string; userRules: string; projectRules: string; commands: string }) {
    const res = await apiFetch('/api/rules/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        spaceId: (opts.spaceId || '').trim() || 'host_config_v1',
        userRules: opts.userRules || '',
        projectRules: opts.projectRules || '',
        commands: opts.commands || '',
      }),
    })
    const j = (await res.json().catch(() => null)) as any
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`)
    if (!j?.ok) throw new Error(j?.detail || 'bad response')
    return j as { ok: true }
  }

  function isDangerousShellCommand(cmd: string): string | null {
    const raw = _normalizeSimpleCommand(cmd)
    if (!raw) return null
    const s0 = raw.toLowerCase()

    // Strip a leading sudo wrapper (best-effort) so we can judge the real command.
    // Example: "sudo -n -u root systemctl restart nginx" -> "systemctl restart nginx"
    const tokens0 = s0.split(/\s+/).filter(Boolean)
    if (tokens0.length === 0) return null
    let tokens = tokens0
    if (tokens[0] === 'sudo') {
      if (tokens.length === 1) return '包含 sudo（需要提升权限）'
      let i = 1
      while (i < tokens.length) {
        const t = tokens[i]
        if (t === '--') {
          i++
          break
        }
        if (t === '-u' || t === '--user') {
          i += 2
          continue
        }
        if (t.startsWith('-')) {
          i++
          continue
        }
        break
      }
      tokens = tokens.slice(i)
      if (tokens.length === 0) return '包含 sudo（需要提升权限）'
    }

    const s = tokens.join(' ')
    const first = tokens[0] || ''
    const second = tokens[1] || ''

    // Hard denylist: destructive / mutating / privilege / orchestration / package installs.
    // Keep this list broad because we will auto-run everything else.
    if (first === 'rm') return '包含 rm（删除文件/目录）'
    if (first === 'mv' || first === 'cp' || first === 'touch' || first === 'mkdir' || first === 'rmdir' || first === 'ln') return `包含 ${first}（修改文件系统）`
    if (first === 'chmod' || first === 'chown' || first === 'chgrp') return `包含 ${first}（修改权限/属主）`
    if (first === 'useradd' || first === 'usermod' || first === 'userdel' || first === 'groupadd' || first === 'groupmod' || first === 'groupdel' || first === 'passwd') return `包含 ${first}（修改账号/权限）`
    if (first === 'shutdown' || first === 'reboot' || first === 'poweroff' || first === 'halt') return '包含关机/重启命令'
    if (first === 'kill' || first === 'pkill' || first === 'killall') return `包含 ${first}（终止进程）`
    if (first === 'mount' || first === 'umount' || first === 'fsck' || first === 'parted' || first === 'lvcreate' || first === 'lvremove' || first === 'vgcreate' || first === 'vgremove' || first === 'pvcreate' || first === 'pvremove' || first === 'wipefs') return `包含 ${first}（磁盘/文件系统变更）`
    if (/\bmkfs(\.| )/.test(s) || /\bdd\b.*\bif=/.test(s)) return '包含磁盘格式化/覆写风险命令（mkfs/dd）'

    // Service/system management: allow status/list/show/cat, block start/stop/restart/reload/etc.
    if (first === 'systemctl') {
      const safe = new Set(['status', 'list-units', 'list-unit-files', 'show', 'cat', 'is-active', 'is-enabled'])
      if (!safe.has(second)) return `包含 systemctl ${second || ''}（服务/系统变更）`.trim()
    }
    if (first === 'service') {
      const safe = new Set(['status'])
      if (!safe.has(second)) return `包含 service ${second || ''}（服务变更）`.trim()
    }

    // Package managers / installers
    if (first === 'yum' || first === 'dnf' || first === 'apt' || first === 'apt-get' || first === 'apk' || first === 'pip' || first === 'pip3' || first === 'npm' || first === 'pnpm' || first === 'yarn') {
      return `包含 ${first}（安装/变更软件包）`
    }

    // Scripting/interpreters: semantics are unbounded.
    if (first === 'bash' || first === 'sh' || first === 'zsh' || first === 'python' || first === 'python3' || first === 'node' || first === 'perl' || first === 'ruby') {
      return `包含 ${first}（脚本执行不可控）`
    }

    // Editors / pagers / long-running interactive commands (avoid hanging the UI).
    if (first === 'vi' || first === 'vim' || first === 'nano' || first === 'emacs' || first === 'less' || first === 'more' || first === 'man') {
      return `包含 ${first}（交互命令，可能挂起）`
    }
    if (first === 'watch') return '包含 watch（长时间运行）'
    if (first === 'tail' && tokens.includes('-f')) return '包含 tail -f（长时间跟随输出）'
    if (first === 'journalctl' && tokens.includes('-f')) return '包含 journalctl -f（长时间跟随输出）'
    if (first === 'ping' && !tokens.includes('-c')) return '包含 ping（默认长时间运行）'

    // Write-capable tools that can modify files even without redirection.
    if (first === 'tee') return '包含 tee（可能写入文件）'
    if (first === 'sed' && tokens.includes('-i')) return '包含 sed -i（原地修改文件）'

    // Remote access / transfer
    if (first === 'ssh' || first === 'scp' || first === 'sftp' || first === 'rsync') return `包含 ${first}（远程连接/传输）`

    // Network download/exfil primitives (conservative)
    if (first === 'curl' || first === 'wget') return `包含 ${first}（网络访问/下载）`

    // Git: allow read-only subcommands, block mutating ones.
    if (first === 'git') {
      const mutating = new Set(['add', 'commit', 'push', 'pull', 'fetch', 'reset', 'checkout', 'switch', 'merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'stash', 'clean', 'tag', 'config'])
      if (mutating.has(second)) return `包含 git ${second}（可能修改仓库）`
    }

    // Containers / orchestrators: allow limited read-only, block the rest.
    if (first === 'docker') {
      const safe = new Set(['ps', 'images', 'inspect', 'logs', 'info', 'version'])
      if (!safe.has(second)) return `包含 docker ${second || ''}（容器变更风险）`.trim()
    }
    if (first === 'kubectl') {
      const safe = new Set(['get', 'describe', 'logs', 'top', 'version', 'api-resources', 'api-versions', 'cluster-info', 'config', 'explain'])
      if (!safe.has(second)) return `包含 kubectl ${second || ''}（集群变更风险）`.trim()
    }

    // IP tooling: allow show/list, block add/del/set/etc.
    if (first === 'ip') {
      const dangerousOps = new Set(['add', 'del', 'delete', 'set', 'replace', 'change', 'flush'])
      if (dangerousOps.has(second)) return `包含 ip ${second}（网络配置变更）`
      // e.g. "ip addr show" / "ip -4 addr show" (flags already in tokens; second may be -4)
      if (second.startsWith('-')) {
        const t2 = tokens[2] || ''
        const t3 = tokens[3] || ''
        if (dangerousOps.has(t2) || dangerousOps.has(t3)) return '包含 ip（网络配置变更）'
      }
    }

    // Fork bomb
    if (/\b:\(\)\s*\{/.test(s)) return '疑似 fork bomb'

    return null
  }

  // Cursor-like: translate common interactive commands into one-shot, non-interactive snapshots.
  // This keeps the UX simple while staying compatible with ssh_exec (non-PTY).
  function normalizeInteractiveToNonInteractive(cmd: string): {
    originalCommand: string
    rewrittenCommand: string
    mode: 'once' | 'snapshot'
    rewriteReason: 'none' | 'interactive_to_snapshot' | 'stream_to_snapshot'
    note?: string
    intent: 'system_monitoring' | 'file_inspection' | 'other'
  } {
    const raw = String(cmd || '').trim()
    const first = raw.split(/\s+/)[0]?.toLowerCase() || ''
    // Already in "snapshot" form (should still be treated as system_monitoring snapshot)
    if (first === 'top' && (/\s-(?:b\b|batch\b)/i.test(raw) || /\s--batch\b/i.test(raw))) {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    if (first === 'iftop' && (/\s-(?:t\b|text\b)/i.test(raw) || /\s--text\b/i.test(raw))) {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    if (first === 'iostat' && /\s-([a-zA-Z]*x[a-zA-Z]*)\b/i.test(raw) && /\s1\s+1\s*$/.test(raw)) {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    if (first === 'vmstat' && /\s1\s+2\s*$/.test(raw)) {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    if (first === 'top' && !/\s-(?:b\b|batch\b)|\s--batch\b/i.test(raw)) {
      return {
        originalCommand: raw,
        rewrittenCommand: 'top -b -n 1 | head -n 40',
        mode: 'snapshot',
        rewriteReason: 'interactive_to_snapshot',
        note: '提示：top 为交互命令，已自动改为一次性快照（top -b -n 1）。',
        intent: 'system_monitoring',
      }
    }
    if (first === 'htop') {
      return {
        originalCommand: raw,
        rewrittenCommand: 'top -b -n 1 | head -n 40',
        mode: 'snapshot',
        rewriteReason: 'interactive_to_snapshot',
        note: '提示：htop 为交互命令，已自动改为一次性快照（top -b -n 1）。',
        intent: 'system_monitoring',
      }
    }
    if (first === 'iftop' && !/\s-(?:t\b|text\b)|\s--text\b/i.test(raw)) {
      return {
        originalCommand: raw,
        rewrittenCommand: 'iftop -t -s 2 -L 20',
        mode: 'snapshot',
        rewriteReason: 'interactive_to_snapshot',
        note: '提示：iftop 为交互命令，已自动改为一次性快照（iftop -t -s 2）。',
        intent: 'system_monitoring',
      }
    }
    if (first === 'iostat' && raw === 'iostat') {
      return {
        originalCommand: raw,
        rewrittenCommand: 'iostat -x 1 1',
        mode: 'snapshot',
        rewriteReason: 'stream_to_snapshot',
        note: '提示：iostat 已自动改为一次性快照（iostat -x 1 1）。',
        intent: 'system_monitoring',
      }
    }
    if (first === 'vmstat' && raw === 'vmstat') {
      return {
        originalCommand: raw,
        rewrittenCommand: 'vmstat 1 2',
        mode: 'snapshot',
        rewriteReason: 'stream_to_snapshot',
        note: '提示：vmstat 已自动改为一次性快照（vmstat 1 2）。',
        intent: 'system_monitoring',
      }
    }
    if (first === 'free' && raw === 'free') {
      return {
        originalCommand: raw,
        rewrittenCommand: 'free -m',
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }

    // Common read-only probes (non-interactive) should be treated as monitoring snapshots
    // so they can auto-run without extra approval UI.
    // Keep this list conservative (read-only, bounded output).
    if (first === 'uptime' || first === 'whoami' || first === 'hostname' || first === 'id') {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    if (first === 'uname' && /^uname\s+-a$/i.test(raw)) {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    // Disk/memory snapshots
    if (first === 'df' && (/^df(\s+-h)?$/i.test(raw) || /^df\s+-h\b/i.test(raw))) {
      return {
        originalCommand: raw,
        rewrittenCommand: /^df$/i.test(raw) ? 'df -h' : raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    if (first === 'free' && (/^free(\s+-h|\s+-m)?$/i.test(raw) || /^free\s+-h\b/i.test(raw))) {
      return {
        originalCommand: raw,
        rewrittenCommand: /^free$/i.test(raw) ? 'free -m' : raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    // Process/network snapshots (bounded by caller via head; treat as snapshot anyway)
    if (first === 'ps' || first === 'netstat' || first === 'ss') {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    if (first === 'cat' && raw.toLowerCase().startsWith('cat /proc/')) {
      return {
        originalCommand: raw,
        rewrittenCommand: raw,
        mode: 'snapshot',
        rewriteReason: 'none',
        intent: 'system_monitoring',
      }
    }
    return { originalCommand: raw, rewrittenCommand: raw, mode: 'once', rewriteReason: 'none', intent: 'other' }
  }

  // Cursor-like: In "Ask Every Time" mode, we still auto-run very safe read-only probes
  // to avoid interrupting the user for commands like `pwd`/`ls`.
  function isSafeAutoRunShellCommand(cmd: string): boolean {
    const raw = _normalizeSimpleCommand(cmd)
    if (!raw) return false
    const s = raw.toLowerCase()
    // Never auto-run if it contains shell chaining/redirection/subshell/newlines.
    const bad = [';', '&&', '||', '>', '<', '$(', '`', '\n', '\r']
    if (bad.some((x) => s.includes(x))) return false
    // If already considered dangerous, never auto-run.
    if (isDangerousShellCommand(s)) return false
    // Policy: auto-run everything that is not dangerous and not using chaining/redirection/subshell.
    // (Readonly intent is enforced by denylist, not by a tiny allowlist.)
    return true
  }

  function isSafeAutoRunToolCall(c: AgentToolCall): boolean {
    if (c.tool === 'files_list' || c.tool === 'files_read') return true
    if (c.tool === 'files_write') return false
    if (c.tool === 'ssh_exec') return isSafeAutoRunShellCommand(String(c.args.command || '').trim())
    return false
  }

  function extractRunnableShellCommands(text: string): string[] {
    const s = String(text || '')
    const out: string[] = []
    // Prefer fenced code blocks, e.g. ```bash ... ```
    // IMPORTANT: do NOT treat ```tool blocks (agent tool-call JSON) as runnable shell commands.
    const re = /```([a-zA-Z0-9_-]+)?\s*([\s\S]*?)```/g
    let m: RegExpExecArray | null = null
    while ((m = re.exec(s))) {
      const lang = String(m[1] || '')
        .trim()
        .toLowerCase()
      const body = String(m[2] || '')
      if (lang === 'tool' || lang === 'json') continue
      const isExplicitShell = lang === 'bash' || lang === 'sh' || lang === 'shell'
      const isUnlabeled = !lang
      // If the fence has a non-shell language, ignore.
      if (!isExplicitShell && !isUnlabeled) continue
      // If unlabeled and looks like JSON/tool-call, ignore.
      if (!isExplicitShell) {
        const t = body.trim()
        if (!t) continue
        if (t.startsWith('{') || /"tool"\s*:/.test(t) || /"args"\s*:/.test(t)) continue
      }
      const lines = body.split('\n')
      for (const rawLine of lines) {
        let line = String(rawLine || '').trim()
        if (!line) continue
        // Strip prompt markers
        line = line.replace(/^\$\s+/, '').replace(/^#\s+/, '')
        if (!line) continue
        // Ignore pure comments
        if (line.startsWith('#')) continue
        out.push(line)
        if (out.length >= 8) return out
      }
      if (out.length >= 8) return out
    }
    return out
  }

  function persistCmdAutoRunMode(mode: CmdAutoRunMode) {
    setCmdAutoRunMode(mode)
    try {
      if (mode === 'unset') localStorage.removeItem(CMD_AUTORUN_KEY)
      else localStorage.setItem(CMD_AUTORUN_KEY, mode)
    } catch {
      // ignore
    }
  }

  function persistCmdAllowlist(next: string[]) {
    const uniq = Array.from(new Set((next || []).map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 200)
    setCmdAllowlist(uniq)
    try {
      localStorage.setItem(CMD_ALLOWLIST_KEY, JSON.stringify(uniq))
    } catch {
      // ignore
    }
  }

  function persistToolAutoRunMode(mode: ToolAutoRunMode) {
    setToolAutoRunMode(mode)
    try {
      if (mode === 'unset') localStorage.removeItem(TOOL_AUTORUN_KEY)
      else localStorage.setItem(TOOL_AUTORUN_KEY, mode)
    } catch {
      // ignore
    }
  }

  function persistToolAllowlist(next: string[]) {
    const uniq = Array.from(new Set((next || []).map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 500)
    setToolAllowlist(uniq)
    try {
      localStorage.setItem(TOOL_ALLOWLIST_KEY, JSON.stringify(uniq))
    } catch {
      // ignore
    }
  }

  function toolCallSig(c: AgentToolCall): string {
    if (c.tool === 'ssh_exec') return `ssh_exec:${String(c.args.command || '').trim()}`
    if (c.tool === 'files_list') return `files_list:${String(c.args.path || '').trim()}`
    if (c.tool === 'files_read') return `files_read:${String(c.args.path || '').trim()}`
    if (c.tool === 'files_write') return `files_write:${String(c.args.path || '').trim()}`
    return `${(c as any)?.tool || 'tool'}`
  }

  function allowlistHasAllToolCalls(calls: AgentToolCall[]) {
    const set = new Set(toolAllowlist.map((x) => x.trim()))
    return (calls || []).every((c) => set.has(toolCallSig(c)))
  }

  function requestRunToolCalls(calls: AgentToolCall[], sourceLabel: string, targetMessageId?: string) {
    const list = (calls || []).slice(0, 8)
    if (list.length === 0) return
    const label = String(sourceLabel || '').trim() || 'AI 工具调用'

    // Intent-first: system monitoring snapshot tool calls should auto-run without policy UI.
    try {
      const allMonitoringSnapshot =
        list.length > 0 &&
        list.every((c) => {
          if (c.tool !== 'ssh_exec') return false
          const n = normalizeInteractiveToNonInteractive(String((c as any)?.args?.command || '').trim())
          return n.intent === 'system_monitoring' && n.mode === 'snapshot'
        })
      if (allMonitoringSnapshot) {
        void runAgentToolCallsDirect(list, label ? `${label}（系统快照）` : '系统快照')
        return
      }
    } catch {
      // ignore
    }

    // Safety: always ask when file writes are involved or when an ssh_exec is risky.
    const hasWrite = list.some((c) => c.tool === 'files_write')
    const hasRisky = list.some((c) => c.tool === 'ssh_exec' && Boolean(isDangerousShellCommand((c as any)?.args?.command)))
    if (hasWrite || hasRisky) {
      const pending: PendingConfirm = {
        type: 'tool',
        items: list.map((c) => {
          if (c.tool === 'ssh_exec') {
            const cmd = String((c as any)?.args?.command || '').trim()
            const why = isDangerousShellCommand(cmd)
            return { kind: 'tool', tool: c.tool, args: c.args, reason: why || undefined }
          }
          if (c.tool === 'files_write') return { kind: 'tool', tool: c.tool, args: c.args, reason: '包含文件写入' }
          if (c.tool === 'files_read') return { kind: 'tool', tool: c.tool, args: c.args }
          if (c.tool === 'files_list') return { kind: 'tool', tool: c.tool, args: c.args }
          return { kind: 'tool', tool: (c as any)?.tool || 'tool', args: (c as any)?.args }
        }),
        sourceLabel: label,
        allowRemember: false,
        status: 'pending',
        createdAt: Date.now(),
      }
      attachPendingConfirmToActiveSessionMessage({ pending, targetMessageId })
      return
    }
    if (toolAutoRunMode === 'all') {
      void runAgentToolCallsDirect(list, label)
      return
    }
    if (toolAutoRunMode === 'allowlist' && allowlistHasAllToolCalls(list)) {
      void runAgentToolCallsDirect(list, label)
      return
    }
    // default: ask, but auto-run very safe read-only operations (Cursor-like)
    if (list.every((c) => isSafeAutoRunToolCall(c))) {
      void runAgentToolCallsDirect(list, label)
      return
    }
    const pending: PendingConfirm = {
      type: 'tool',
      items: list.map((c) => {
        if (c.tool === 'ssh_exec') {
          const cmd = String((c as any)?.args?.command || '').trim()
          const why = isDangerousShellCommand(cmd)
          return { kind: 'tool', tool: c.tool, args: c.args, reason: why || undefined }
        }
        if (c.tool === 'files_write') return { kind: 'tool', tool: c.tool, args: c.args, reason: '包含文件写入' }
        if (c.tool === 'files_read') return { kind: 'tool', tool: c.tool, args: c.args }
        if (c.tool === 'files_list') return { kind: 'tool', tool: c.tool, args: c.args }
        return { kind: 'tool', tool: (c as any)?.tool || 'tool', args: (c as any)?.args }
      }),
      sourceLabel: label,
      allowRemember: toolAutoRunMode === 'allowlist',
      status: 'pending',
      createdAt: Date.now(),
    }
    attachPendingConfirmToActiveSessionMessage({ pending, targetMessageId })
  }

  function allowlistHasAll(cmds: string[]) {
    const set = new Set(cmdAllowlist.map((x) => x.trim()))
    return (cmds || []).every((c) => set.has(String(c || '').trim()))
  }

  type AgentToolCall =
    | { tool: 'ssh_exec'; args: { command: string; cwd?: string } }
    | { tool: 'files_list'; args: { path: string } }
    | { tool: 'files_read'; args: { path: string } }
    | { tool: 'files_write'; args: { path: string; content: string } }

  function parseAgentToolCalls(text: string): AgentToolCall[] {
    const out: AgentToolCall[] = []
    const s = String(text || '')
    // Format:
    // ```tool
    // {"tool":"ssh_exec","args":{...}}
    // ```
    const re = /```tool\s*([\s\S]*?)```/g
    let m: RegExpExecArray | null = null
    while ((m = re.exec(s))) {
      const raw = (m[1] || '').trim()
      if (!raw) continue
      try {
        const obj = JSON.parse(raw) as any
        const tool = String(obj?.tool || '').trim()
        const args = obj?.args || {}
        if (!tool) continue
        if (tool === 'ssh_exec') {
          const command = String(args.command || '').trim()
          if (!command) continue
          const cwd = args.cwd ? String(args.cwd).trim() : undefined
          out.push({ tool: 'ssh_exec', args: { command, cwd } })
        } else if (tool === 'files_list') {
          const path = String(args.path || '').trim()
          if (!path) continue
          out.push({ tool: 'files_list', args: { path } })
        } else if (tool === 'files_read') {
          const path = String(args.path || '').trim()
          if (!path) continue
          out.push({ tool: 'files_read', args: { path } })
        } else if (tool === 'files_write') {
          const path = String(args.path || '').trim()
          const content = String(args.content ?? '')
          if (!path) continue
          out.push({ tool: 'files_write', args: { path, content } })
        }
      } catch {
        // ignore malformed blocks
      }
      if (out.length >= 8) break
    }
    return out
  }

  function stripToolBlocksForDisplay(text: string): { text: string; removed: boolean } {
    const s = String(text || '')
    const next = s.replace(/```tool\s*[\s\S]*?```/g, '').trim()
    return { text: next, removed: next !== s.trim() }
  }

  function looksLikeDiskQuestion(q: string): boolean {
    const s = (q || '').toLowerCase()
    return (
      s.includes('磁盘') ||
      s.includes('硬盘') ||
      s.includes('空间') ||
      s.includes('容量') ||
      s.includes('满') ||
      s.includes('df ') ||
      s.includes('df-h') ||
      s.includes('disk') ||
      s.includes('filesystem')
    )
  }

  function buildAutoTerminalCtx(): { kind: string; title: string; content: string } | null {
    try {
      const transcript = (wsTermTranscriptRef.current || '').trim()
      if (!transcript) return null
      const tail = transcript.length > 8000 ? transcript.slice(transcript.length - 8000) : transcript
      const h = activeConn?.hostId ? hostById(activeConn.hostId) : null
      const assetName = (h?.name || '').trim()
      const sshUser = ((h?.user || (h as any)?.username || '').trim() || '').trim()
      const sshAddr = (h?.address || '').trim()
      const sshPort = typeof h?.port === 'number' && Number.isFinite(h.port) ? h.port : 22
      const sshTarget = sshAddr ? `${sshUser || 'root'}@${sshAddr}:${sshPort}` : ''
      const cwd = (activeConn?.path || '').trim() || '.'
      const head =
        `# terminal: pty session (auto-attached)\n` +
        (assetName ? `# asset_name: ${assetName}\n` : '') +
        (sshTarget ? `# ssh_target: ${sshTarget}\n` : '') +
        `# cwd: ${cwd}\n\n`
      const content = head + tail
      const titleBits = ['终端（自动）', assetName ? `资产:${assetName}` : '', cwd ? `cwd:${cwd}` : ''].filter(Boolean)
      return { kind: 'terminal', title: titleBits.join(' · '), content }
    } catch {
      return null
    }
  }

  // NOTE: Tool instructions are injected on the backend as SYSTEM prompt when tool_mode=true.

  function openApiCfg() {
    setApiCfgDraft(apiBase || '')
    setApiCfgTest({ state: 'idle' })
    setApiCfgOpen(true)
  }

  function closeApiCfg() {
    setApiCfgOpen(false)
  }

  function saveApiCfg() {
    const v = normalizeApiBase(apiCfgDraft)
    try {
      localStorage.setItem(API_BASE_KEY, v)
    } catch {
      // ignore
    }
    // empty string means same-origin /api/*
    setApiBase(v)
    setApiCfgOpen(false)
  }

  async function testApiCfg() {
    try {
      setApiCfgTest({ state: 'idle' })
      const base = normalizeApiBase(apiCfgDraft)
      const url = base ? `${base}/api/health` : '/api/health'
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const j = await res.clone().json()
          const d = j?.detail
          const code = typeof d === 'object' ? String(d?.code || '') : ''
          const detailMsg = typeof d === 'object' ? String(d?.message || '') : String(d || '')
          if (code === 'BetaQuotaExceeded') msg = detailMsg || 'Beta 额度已用完，请等待补发或下一轮开放。'
          else if (code === 'InsufficientBalance') msg = 'Beta 额度不足，请等待补发或下一轮开放。'
          else if (code === 'BetaConcurrencyLimit') msg = '当前已有请求在进行中，Beta 阶段同一账号暂时只允许一个并发请求。'
          else if (detailMsg) msg = detailMsg
        } catch {
          // keep the HTTP status fallback
        }
        throw new Error(msg)
      }
      const data = (await res.json()) as { ok?: boolean }
      if (!data.ok) throw new Error('ok != true')
      setApiCfgTest({ state: 'ok' })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setApiCfgTest({ state: 'error', detail })
    }
  }

  const [sshSearch, setSshSearch] = useState('')
const [hostModalOpen, setHostModalOpen] = useState(false)
  const [editingHostId, setEditingHostId] = useState<ID | null>(null)
const [assetCreateTab, setAssetCreateTab] = useState<'host' | 'bigdata'>('host')
  const [copyHintAt, setCopyHintAt] = useState<number>(0)

  // Context switcher (Spec §8.2)
  const [ctxOpen, setCtxOpen] = useState(false)
  const [ctxPos, setCtxPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const [ctxSearch, setCtxSearch] = useState('')
  const ctxBtnRef = useRef<HTMLButtonElement | null>(null)
  const ctxSearchRef = useRef<HTMLInputElement | null>(null)

  const [createOpen, setCreateOpen] = useState(false)
  const [createPos, setCreatePos] = useState<{ top: number; left: number } | null>(null)
  const createBtnRef = useRef<HTMLButtonElement | null>(null)

  // Spec §10.4.4: create workspace drawer (from Inventory +WS)
  const [wsCreateOpen, setWsCreateOpen] = useState(false)
  const [wsCreateDraft, setWsCreateDraft] = useState<{ assetId: ID; name: string; rootPath: string; pinned: boolean } | null>(null)
  const [wsCreateErr, setWsCreateErr] = useState('')

  // SSH "+" action menu
  const [sshMenuOpen, setSshMenuOpen] = useState(false)

  // Managers
  const [groupMgrOpen, setGroupMgrOpen] = useState(false)
  const [tagMgrOpen, setTagMgrOpen] = useState(false)
  const [groupMenuOpenId, setGroupMenuOpenId] = useState<ID | null>(null)
  const [groupMenuPos, setGroupMenuPos] = useState<{ top: number; left: number } | null>(null)

  // Import
  const [importOpen, setImportOpen] = useState(false)
  const [importPreview, setImportPreview] = useState<{
    ok: boolean
    error?: string
    rawText?: string
    state?: HostConfigStateV1
  } | null>(null)

  const visibleSessions = useMemo(() => sessions.filter((s) => !s.closed), [sessions])

  const activeSession = useMemo(() => {
    const fromVisible = visibleSessions.find((s) => s.id === activeId)
    if (fromVisible) return fromVisible
    return visibleSessions[0] ?? sessions[0]
  }, [visibleSessions, sessions, activeId])

  const plugins = useMemo<PluginItem[]>(
    () => [
      { id: 'p1', name: 'SFTP', desc: '\u6587\u4ef6\u4f20\u8f93', installed: true },
      { id: 'p2', name: 'Prometheus', desc: '\u76d1\u63a7\u9762\u677f', installed: true, hasUpdate: true },
      { id: 'p3', name: 'Kube', desc: 'Kubernetes \u7ba1\u7406', installed: false },
    ],
    [],
  )

  const lastMessage = activeSession?.messages?.[activeSession.messages.length - 1]

  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const streamingMsgIdRef = useRef<string | null>(null)
  const resizingRef = useRef(false)

  // Cursor-like: keep auto-captured exec outputs hidden from UI,
  // but available to the LLM for the next question (best-effort).
  const autoExecCtxRef = useRef<Array<{ ts: number; title: string; content: string }>>([])

  function pushAutoExecCtx(title: string, content: string) {
    try {
      const t = (title || '').trim() || '最近执行结果'
      const c = String(content || '').trim()
      if (!c) return
      const next = [{ ts: Date.now(), title: t, content: c }, ...(autoExecCtxRef.current || [])]
      // keep it small
      autoExecCtxRef.current = next.slice(0, 3).map((x) => ({ ...x, content: x.content.slice(0, 18_000) }))
    } catch {
      // ignore
    }
  }

  function buildAutoExecCtxForMessage(msg: string): { kind: string; title: string; content: string } | null {
    try {
      const last = (autoExecCtxRef.current || [])[0]
      if (!last) return null
      const age = Date.now() - (last.ts || 0)
      if (!(age >= 0 && age < 4 * 60_000)) return null
      const q = String(msg || '').trim()
      const wants =
        !q ||
        /刚才|上面|输出|结果|报错|命令|执行|为什么|怎么|是什么|help|error|stderr|stdout/i.test(q)
      if (!wants) return null
      return { kind: 'terminal', title: `终端（自动）· ${last.title}`, content: last.content }
    } catch {
      return null
    }
  }

  // Persist sidebar width
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_W_KEY, String(sidebarW))
    } catch {
      // ignore
    }
  }, [sidebarW])

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0')
    } catch {
      // ignore
    }
  }, [sidebarCollapsed])

  function beginResize(clientX: number) {
    resizingRef.current = true
    const startX = clientX
    const startW = sidebarW
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX
      const next = Math.min(520, Math.max(240, startW + dx))
      setSidebarW(next)
    }
    function onUp() {
      resizingRef.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Ensure activeId always points to a visible session in Chat mode
  useEffect(() => {
    if (mode !== 'chat') return
    if (!activeId) return
    const current = sessions.find((s) => s.id === activeId)
    if (current && !current.closed) return
    if (visibleSessions.length > 0) {
      setActiveId(visibleSessions[0].id)
      return
    }
    const s = createDefaultSession()
    setSessions([s])
    setActiveId(s.id)
  }, [mode, sessions, activeId, visibleSessions])

  // Close session menu on outside click / Escape
  useEffect(() => {
    function onDocDown(e: MouseEvent) {
      const target = e.target as HTMLElement | null
      if (!target) return
      if (target.closest?.('[data-session-menu]')) return
      if (target.closest?.('[data-ssh-menu]')) return
      if (target.closest?.('[data-ssh-menu-trigger]')) return
      if (target.closest?.('[data-group-menu]')) return
      if (target.closest?.('[data-group-menu-trigger]')) return
      if (target.closest?.('[data-ws-chat-menu]')) return
      if (target.closest?.('[data-ws-chat-menu-trigger]')) return
      if (target.closest?.('[data-ws-file-menu]')) return
      if (target.closest?.('[data-ws-file-menu-trigger]')) return
      if (target.closest?.('[data-ws-term-menu]')) return
      if (target.closest?.('[data-ws-term-menu-trigger]')) return
      setOpenMenuForId(null)
      setMenuPos(null)
      setSshMenuOpen(false)
      setGroupMenuOpenId(null)
      setGroupMenuPos(null)
      setWsChatMenuOpen(false)
      setWsChatMenuPos(null)
      setWsFileMenuOpen(false)
      setWsFileMenuPos(null)
      setWsTermMenuOpen(false)
      setWsTermMenuPos(null)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpenMenuForId(null)
        setMenuPos(null)
        setSshMenuOpen(false)
        setGroupMenuOpenId(null)
        setGroupMenuPos(null)
        setWsChatMenuOpen(false)
        setWsChatMenuPos(null)
        setWsFileMenuOpen(false)
        setWsFileMenuPos(null)
        setWsTermMenuOpen(false)
        setWsTermMenuPos(null)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  function hasUserMessages(s?: ChatSession) {
    if (!s) return false
    return s.messages.some((m) => m.role === 'user' && m.content.trim().length > 0)
  }

  // Persist (debounced)
  useEffect(() => {
    const t = window.setTimeout(() => {
      saveState({ version: 1, activeId, sessions })
    }, 200)
    return () => window.clearTimeout(t)
  }, [sessions, activeId])

  // Persist host config (debounced)
  useEffect(() => {
    const t = window.setTimeout(() => {
      saveHostConfigState(fixHostConfigState(hostCfg), activeSpaceId)
    }, 200)
    return () => window.clearTimeout(t)
  }, [hostCfg, activeSpaceId])

  // Persist space selection + list
  useEffect(() => {
    try {
      localStorage.setItem(SPACE_ACTIVE_KEY, activeSpaceId)
      localStorage.setItem(SPACE_LIST_KEY, JSON.stringify(spaces))
    } catch {
      // ignore
    }
  }, [activeSpaceId, spaces])

  useEffect(() => {
    try {
      localStorage.setItem(INVENTORY_SYNC_ENABLED_KEY, inventorySyncEnabled ? '1' : '0')
    } catch {
      // ignore
    }
  }, [inventorySyncEnabled])

  // When switching space: load the corresponding config (assets/workspaces/etc)
  useEffect(() => {
    setHostCfg(loadHostConfigState(activeSpaceId))
  }, [activeSpaceId])

  // Inventory backend sync (per-user). Pull once per space on login; then debounce push.
  useEffect(() => {
    if (!me?.email) return
    if (!inventorySyncEnabled) return
    const spaceId = safeActiveSpaceId()
    if (!spaceId) return
    if (inventoryHydratedBySpaceRef.current[spaceId]) return
    inventoryHydratedBySpaceRef.current[spaceId] = true
    let cancelled = false
    ;(async () => {
      try {
        const r = await apiInventoryGetState({ spaceId })
        if (cancelled) return
        if (r && r.json) {
          inventoryRemoteUpdatedAtBySpaceRef.current[spaceId] = Number(r.updatedAt) || Date.now()
          inventoryLastApplyAtBySpaceRef.current[spaceId] = Date.now()
          setHostCfg(fixHostConfigState(r.json as any))
          return
        }
        // One-time migration: no server state yet -> push local sanitized snapshot.
        const local = sanitizeHostCfgForSync(loadHostConfigState(spaceId))
        const wr = await apiInventoryPutState({ spaceId, json: local, source: 'migration' })
        inventoryRemoteUpdatedAtBySpaceRef.current[spaceId] = Number(wr.updatedAt) || Date.now()
      } catch {
        // allow retry next time
        inventoryHydratedBySpaceRef.current[spaceId] = false
      }
    })()
    return () => {
      cancelled = true
    }
  }, [me?.email, inventorySyncEnabled, activeSpaceId])

  useEffect(() => {
    if (!me?.email) return
    if (!inventorySyncEnabled) return
    const spaceId = safeActiveSpaceId()
    if (!spaceId) return
    if (!inventoryHydratedBySpaceRef.current[spaceId]) return
    const lastApplied = Number(inventoryLastApplyAtBySpaceRef.current[spaceId] || 0)
    if (Date.now() - lastApplied < 900) return
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const payload = sanitizeHostCfgForSync(hostCfg)
          const base = Number(inventoryRemoteUpdatedAtBySpaceRef.current[spaceId] || 0) || 0
          const wr = await apiInventoryPutState({ spaceId, json: payload, baseUpdatedAt: base, source: 'ui' })
          inventoryRemoteUpdatedAtBySpaceRef.current[spaceId] = Number(wr.updatedAt) || Date.now()
        } catch {
          // ignore
        }
      })()
    }, 800)
    return () => window.clearTimeout(t)
  }, [hostCfg, me?.email, inventorySyncEnabled, activeSpaceId])

  // Browser tab title (Spec §8.1)
  useEffect(() => {
    const page =
      mode === 'dashboard'
        ? DASHBOARD_ENABLED
          ? '控制台'
          : '资产管理'
        : mode === 'chat'
          ? '聊天'
          : mode === 'ssh'
            ? '资产管理'
            : mode === 'workspace'
              ? '工作区'
              : mode === 'plugins'
                ? '插件'
                : DASHBOARD_ENABLED
                  ? '控制台'
                  : '资产管理'
    document.title = `${page} · ${activeSpaceName} - CodeSprite`
  }, [mode, activeSpaceName])

  // Persist model selection
  useEffect(() => {
    try {
      if (selectedModel) localStorage.setItem(MODEL_KEY, selectedModel)
    } catch {
      // ignore
    }
  }, [selectedModel])

  // Persist current tab (chat/ssh/plugins) so refresh keeps the same page
  useEffect(() => {
    try {
      // Logged-in: backend ui_state_v1 is the source-of-truth; avoid local cache divergence across browsers.
      if (me?.email) return
      localStorage.setItem(MODE_KEY, mode)
    } catch {
      // ignore
    }
  }, [mode, me?.email])

  // UI state sync: persist last opened module to backend (cross-browser consistency).
  useEffect(() => {
    if (!me?.email) return
    if (!uiStateHydratedRef.current) return
    const t = window.setTimeout(() => {
      const prev = uiRemoteRef.current
      const prevWs = (prev?.workspaceHostId as any) || null
      const nextWs =
        mode === 'workspace'
          ? ((activeConn?.hostId as any) || (hostCfg as any)?.activeHostId || prevWs || null)
          : prevWs
      const payload: UiStateV1 = { version: 2, mode, workspaceHostId: nextWs }
      const sig = JSON.stringify(payload)
      if (sig === uiStateLastSentSigRef.current) return
      uiStateLastSentSigRef.current = sig
      void (async () => {
        try {
          const base = Number(uiRemoteUpdatedAtRef.current || 0) || 0
          const wr = await apiUiStatePut({ json: payload, baseUpdatedAt: base, source: 'ui' })
          uiRemoteUpdatedAtRef.current = Number(wr.updatedAt) || Date.now()
          uiRemoteRef.current = payload
        } catch {
          // ignore
        }
      })()
    }, 650)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, me?.email, activeConn?.hostId, hostCfg.activeHostId])

  // Prefs sync: hydrate from backend (cross-browser consistency). Also carries a small set of layout prefs.
  useEffect(() => {
    if (!me?.email) return
    let cancelled = false
    void (async () => {
      try {
        const r = await apiInventoryGetState({ spaceId: PREFS_SPACE_ID })
        if (cancelled) return
        if (!r) {
          // Baseline should match an incognito / first-time experience.
          const baselineLayout = { sidebarW: 280, wsLeftW: 520, wsToolsOpen: false, dashFullscreen: false }
          const seed: PrefsStateV1 = {
            version: 2,
            prefs: DEFAULT_PREFS,
            layout: baselineLayout,
          }
          // Apply baseline locally as well (prevents one browser keeping stale localStorage UI).
          setPrefs(DEFAULT_PREFS)
          savePrefs(DEFAULT_PREFS)
          setSidebarW(baselineLayout.sidebarW)
          setWsLeftW(baselineLayout.wsLeftW)
          setWsToolsOpen(baselineLayout.wsToolsOpen)
          setDashFullscreen(baselineLayout.dashFullscreen)
          try {
            const wr = await apiInventoryPutState({ spaceId: PREFS_SPACE_ID, json: seed, source: 'seed' })
            prefsRemoteUpdatedAtRef.current = Number(wr.updatedAt) || Date.now()
          } catch {
            // ignore
          }
          prefsStateHydratedRef.current = true
          return
        }

        prefsRemoteUpdatedAtRef.current = Number(r.updatedAt) || 0
        const j = (r as any)?.json || {}
        const nextPrefs = normalizePrefs((j as any)?.prefs || {})
        setPrefs(nextPrefs)
        // Keep local cache aligned (boot theme reads it).
        savePrefs(nextPrefs)

        const layout = ((j as any)?.layout || {}) as any
        const sw = Number(layout.sidebarW)
        if (Number.isFinite(sw) && sw >= 240 && sw <= 520) setSidebarW(Math.trunc(sw))
        const ww = Number(layout.wsLeftW)
        if (Number.isFinite(ww) && ww >= 260 && ww <= 900) setWsLeftW(Math.trunc(ww))
        if (typeof layout.wsToolsOpen === 'boolean') setWsToolsOpen(Boolean(layout.wsToolsOpen))
        if (typeof layout.dashFullscreen === 'boolean') setDashFullscreen(Boolean(layout.dashFullscreen))

        prefsStateHydratedRef.current = true
      } catch {
        prefsStateHydratedRef.current = true
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.email])

  useEffect(() => {
    if (!me?.email) return
    if (!prefsStateHydratedRef.current) return
    const payload: PrefsStateV1 = {
      version: 2,
      prefs,
      layout: { sidebarW, wsLeftW, wsToolsOpen, dashFullscreen },
    }
    const sig = JSON.stringify(payload)
    if (sig === prefsStateLastSentSigRef.current) return
    const t = window.setTimeout(() => {
      if (sig === prefsStateLastSentSigRef.current) return
      prefsStateLastSentSigRef.current = sig
      void (async () => {
        try {
          const base = Number(prefsRemoteUpdatedAtRef.current || 0) || 0
          const wr = await apiInventoryPutState({ spaceId: PREFS_SPACE_ID, json: payload, baseUpdatedAt: base, source: 'ui_prefs' })
          prefsRemoteUpdatedAtRef.current = Number(wr.updatedAt) || Date.now()
        } catch {
          // ignore
        }
      })()
    }, 650)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.email, prefs, sidebarW, wsLeftW, wsToolsOpen, dashFullscreen])

  // Persist dashboard fullscreen preference
  useEffect(() => {
    try {
      localStorage.setItem(DASH_FULLSCREEN_KEY, dashFullscreen ? '1' : '0')
    } catch {
      // ignore
    }
  }, [dashFullscreen])

  // Dashboard fullscreen: ESC exits (spec §3.2)
  useEffect(() => {
    if (mode !== 'dashboard') return
    if (!dashFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDashFullscreen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [mode, dashFullscreen])

  // UX choice: when leaving SSH page, clear the right-side detail selection.
  // This makes "Chat -> SSH" always start from the empty state unless user re-selects a host.
  useEffect(() => {
    if (mode === 'ssh') return
    setHostCfg((prev) => (prev.activeHostId ? { ...prev, activeHostId: null } : prev))
  }, [mode])

  // auto scroll messages
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    // During any splitter drag, do not force-scroll. It feels like the chat panel is "moving"
    // together with the drag (especially when assistant is streaming).
    if (chatVDragRef.current) return
    if (wsDragRef.current) return
    el.scrollTop = el.scrollHeight
  }, [activeId, activeSession?.messages.length, lastMessage?.content])

  async function checkHealthOnce() {
      try {
        setHealth({ state: 'checking' })
        const res = await apiFetch('/api/health', { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { ok?: boolean }
        if (!data.ok) throw new Error('ok != true')
      setHealth({ state: 'ok' })
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
      setHealth({ state: 'error', detail })
    }
  }

  async function loadModelsOnce() {
      try {
        setModelsLoading(true)
        const res = await apiFetch('/api/models', { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { ok?: boolean; models?: string[]; default?: string }
        if (!data.ok || !Array.isArray(data.models)) throw new Error('bad models payload')
        setModels(data.models)
        const fallback = data.default ?? data.models[0] ?? ''
        setSelectedModel((prev) => prev || fallback)
      } catch {
        setModels([])
      } finally {
      setModelsLoading(false)
    }
  }

  // backend health (poll)
  useEffect(() => {
    let mounted = true
    const safe = async () => {
      if (!mounted) return
      await checkHealthOnce()
    }
    void safe()
    const t = window.setInterval(safe, 10_000)
    return () => {
      mounted = false
      window.clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase])

  // models list (one-shot; can be reloaded from dashboard banner)
  useEffect(() => {
    let mounted = true
    const safe = async () => {
      if (!mounted) return
      await loadModelsOnce()
    }
    void safe()
    return () => {
      mounted = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase])

  function newChat() {
    // Prevent creating infinite empty sessions: if current session has no user content, just focus input.
    if (!hasUserMessages(activeSession)) {
      inputRef.current?.focus()
      return
    }
    const s: ChatSession = {
      id: uid('s'),
      title: I18N.newSession,
      messages: [
        {
          id: uid('m'),
          role: 'assistant',
          kind: 'chat',
          content: I18N.newChatHello,
          ts: Date.now(),
        },
      ],
    }
    setSessions((prev) => [s, ...prev])
    setActiveId(s.id)
    setInput('')
    inputRef.current?.focus()
  }

  function appendAssistantToActiveSession(content: string) {
    const text = String(content || '').trim()
    if (!text) return
    const sid = String(activeSession?.id || activeId || '').trim()
    if (!sid) return
    const msg: ChatMessage = { id: uid('m'), role: 'assistant', kind: 'chat', content: text, ts: Date.now() }
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, messages: [...(s.messages || []), msg] } : s)))
  }

  function appendUserToActiveSession(content: string, images?: ChatImage[]) {
    const text = String(content || '').trim()
    if (!text && (!images || images.length === 0)) return
    const sid = String(activeSession?.id || activeId || '').trim()
    if (!sid) return
    const msg: ChatMessage = {
      id: uid('m'),
      role: 'user',
      kind: 'chat',
      content: text || (images?.length ? '（图片）' : ''),
      ts: Date.now(),
      images: images?.length ? images : undefined,
    }
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, messages: [...(s.messages || []), msg] } : s)))
  }

  function appendToolResultToActiveSession(input: { title: string; content: string; meta?: string[] }) {
    const title = String(input.title || '').trim() || '工具输出'
    const text = String(input.content || '').trimEnd()
    if (!text) return
    const sid = String(activeSession?.id || activeId || '').trim()
    if (!sid) return
    const msg: ChatMessage = {
      id: uid('m'),
      role: 'assistant',
      kind: 'tool_result',
      title,
      meta: Array.isArray(input.meta) ? input.meta.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8) : undefined,
      content: text,
      ts: Date.now(),
    }
    setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, messages: [...(s.messages || []), msg] } : s)))
  }

  function onPrimaryAction() {
    // Spec §8.3: top-left "+" is a global create center (must open a menu first).
    const el = createBtnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setCreatePos({ top: r.bottom + 8, left: r.left })
    setCreateOpen(true)
  }

  function closeHostModal() {
    setHostModalOpen(false)
    setEditingHostId(null)
    setAssetCreateTab('host')
  }

  function closeSshMenu() {
    setSshMenuOpen(false)
  }

  function openNewHostModal() {
    setEditingHostId(null)
    setAssetCreateTab('host')
    setHostModalOpen(true)
    closeSshMenu()
  }

  function openNewHostModalWithGroup(groupId: ID) {
    // Reuse host editor by pre-creating a draft host in local state: we just pass editingHostId=null
    // and store a transient preferred groupId in session storage for the editor to read.
    try {
      sessionStorage.setItem('host_config_preselect_group', groupId)
    } catch {
      // ignore
    }
    setEditingHostId(null)
    setAssetCreateTab('host')
    setHostModalOpen(true)
    setGroupMenuOpenId(null)
  }

  function openNewGroupManager() {
    setGroupMgrOpen(true)
    closeSshMenu()
  }

  function openTagManager() {
    setTagMgrOpen(true)
    closeSshMenu()
  }

  function openImport() {
    setImportOpen(true)
    setImportPreview(null)
    closeSshMenu()
  }

  function openWsCreateFromAsset(assetId: ID) {
    const a = hostCfg.assets.find((x) => x.id === assetId) ?? null
    if (!a) return
    // P0: auto-create a default workspace record (so it appears in left list),
    // then open the Remote panel (terminal) for real operations.
    const now = Date.now()
    const rootPath = '/srv/www'
    const wsName = `${a.name || a.address} 工作区`
    setHostCfg((prev) => {
      const existed = (prev.workspaces || []).find((w) => w.assetId === assetId && w.rootPath === rootPath)
      const wsId = existed?.id || (uid('ws') as ID)
      const nextWs = existed
        ? { ...existed, name: existed.name || wsName, lastOpenedAt: now, updatedAt: now }
        : {
            id: wsId,
            assetId,
            name: wsName,
            rootPath,
      pinned: false,
            lastOpenedAt: now,
            createdAt: now,
            updatedAt: now,
          }
      const workspaces = existed ? prev.workspaces.map((w) => (w.id === wsId ? nextWs : w)) : [nextWs, ...prev.workspaces]
      return fixHostConfigState({ ...prev, workspaces, activeWorkspaceId: wsId, activeHostId: assetId })
    })
    openConnectModal(assetId)
  }

  const filteredSpaces = useMemo(() => {
    const q = ctxSearch.trim().toLowerCase()
    const list = spaces.slice().sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))
    if (!q) return { recent: list.slice(0, 5), all: list }
    const all = list.filter((s) => s.name.toLowerCase().includes(q))
    return { recent: all.slice(0, 5), all }
  }, [spaces, ctxSearch])

  function openCtxPopover() {
    const el = ctxBtnRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setCtxPos({ top: r.bottom + 8, left: r.left, width: Math.max(280, Math.min(360, r.width + 180)) })
    setCtxOpen(true)
    window.setTimeout(() => ctxSearchRef.current?.focus(), 0)
  }

  function closeCtxPopover() {
    setCtxOpen(false)
    setCtxSearch('')
    setCtxPos(null)
  }

  function closeCreateMenu() {
    setCreateOpen(false)
    setCreatePos(null)
  }

  function switchSpace(nextId: string) {
    const next = spaces.find((s) => s.id === nextId)
    if (!next) return
    const now = Date.now()
    setSpaces((prev) => prev.map((s) => (s.id === nextId ? { ...s, lastUsedAt: now } : s)))
    setActiveSpaceId(nextId)
    closeCtxPopover()
    setToast({ id: uid('t'), message: `\u5df2\u5207\u6362\u5230\uff1a${next.name}` })
  }

  // Close popovers on outside click / Esc (Spec §8.2 / §8.3)
  useEffect(() => {
    function onDown(e: MouseEvent | TouchEvent) {
      const t = e.target as HTMLElement | null
      if (!t) return
      const inCtx = Boolean(t.closest('[data-ctx-popover]') || t.closest('[data-ctx-btn]'))
      if (ctxOpen && !inCtx) closeCtxPopover()
      const inCreate = Boolean(t.closest('[data-create-menu]') || t.closest('[data-create-btn]'))
      if (createOpen && !inCreate) closeCreateMenu()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (ctxOpen) closeCtxPopover()
        if (createOpen) closeCreateMenu()
      }
    }
    document.addEventListener('mousedown', onDown, { passive: true })
    document.addEventListener('touchstart', onDown, { passive: true })
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown as any)
      document.removeEventListener('touchstart', onDown as any)
      document.removeEventListener('keydown', onKey as any)
    }
  }, [ctxOpen, createOpen, spaces])

  function exportConfig() {
    try {
      const fixed = fixHostConfigState(hostCfg)
      const text = JSON.stringify(fixed, null, 2)
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = I18N.exportFilename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      // ignore
    } finally {
      closeSshMenu()
    }
  }

  function parseImportText(text: string): HostConfigStateV1 | null {
    try {
      const obj = JSON.parse(text) as unknown
      if (!obj || typeof obj !== 'object') return null
      const rec = obj as Record<string, unknown>
      if (rec.version !== 1) return null
      if (!Array.isArray(rec.hosts) || !Array.isArray(rec.groups) || !Array.isArray(rec.tags) || !Array.isArray(rec.credentials))
        return null
      return fixHostConfigState(rec as unknown as HostConfigStateV1)
    } catch {
      return null
    }
  }

  function remapAndMergeImport(imported: HostConfigStateV1) {
    const now = Date.now()
    setHostCfg((prev) => {
      const fixed = fixHostConfigState(imported)
      const mapId = (prefix: string) => uid(prefix) as ID

      const groupMap = new Map<ID, ID>()
      const tagMap = new Map<ID, ID>()
      const credMap = new Map<ID, ID>()
      const hostMap = new Map<ID, ID>()

      const baseGroupSort = prev.groups.reduce((m, g) => Math.max(m, g.sort), 0)
      const baseTagSort = prev.tags.reduce((m, t) => Math.max(m, t.sort), 0)

      const groups: Group[] = fixed.groups.map((g, idx) => {
        const id = mapId('g')
        groupMap.set(g.id, id)
        return {
          ...g,
          id,
          parentId: g.parentId ? null : null, // keep 1-level for now; parent will be remapped below
          sort: baseGroupSort + idx + 1,
          updatedAt: now,
        }
      })
      // remap parentId (two-level)
      for (const g of groups) {
        const old = fixed.groups.find((x) => groupMap.get(x.id) === g.id)
        if (old?.parentId) {
          g.parentId = groupMap.get(old.parentId) ?? null
        }
      }

      const tags: Tag[] = fixed.tags.map((t, idx) => {
        const id = mapId('tag')
        tagMap.set(t.id, id)
        return { ...t, id, sort: baseTagSort + idx + 1, updatedAt: now }
      })

      const credentials: Credential[] = fixed.credentials.map((c) => {
        const id = mapId('cred')
        credMap.set(c.id, id)
        return { ...c, id, updatedAt: now }
      })

      const hosts: Host[] = fixed.hosts.map((h) => {
        const id = mapId('h')
        hostMap.set(h.id, id)
        return {
          ...h,
          id,
          groupId: h.groupId ? groupMap.get(h.groupId) ?? null : null,
          tagIds: (h.tagIds || []).map((tid) => tagMap.get(tid)).filter(Boolean) as ID[],
          credentialId: h.credentialId ? credMap.get(h.credentialId) ?? null : null,
          updatedAt: now,
        }
      })

      const merged: HostConfigStateV1 = {
        version: 2,
        activeWorkspaceId: null,
        activeHostId: hosts[0]?.id ?? prev.activeHostId,
        hosts: [...hosts, ...prev.hosts],
        assets: [...hosts, ...prev.hosts], // sync assets
        workspaces: [],
        groups: [...groups, ...prev.groups],
        tags: [...tags, ...prev.tags],
        credentials: [...credentials, ...prev.credentials],
      }
      return fixHostConfigState(merged)
    })
  }

  async function onPickImportFile(file: File) {
    try {
      const text = await file.text()
      const parsed = parseImportText(text)
      if (!parsed) {
        setImportPreview({ ok: false, error: I18N.importInvalid })
      return
    }
      setImportPreview({ ok: true, rawText: text, state: parsed })
    } catch (e) {
      setImportPreview({ ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  function markConnected(h: Host) {
    const now = Date.now()
    setHostCfg((prev) => {
      // Keep assets/hosts aliases in sync (fixHostConfigState() also syncs, but we update both for clarity).
      const updateOne = (x: any) => (x.id === h.id ? { ...x, lastConnectedAt: now, updatedAt: now } : x)
      const hosts = (prev.hosts || []).map(updateOne)
      const assets = (prev.assets || []).map(updateOne)
      return fixHostConfigState({ ...prev, hosts, assets })
    })
  }

  function upsertGroup(input: { id?: ID; name: string }) {
    const now = Date.now()
    setHostCfg((prev) => {
      const name = input.name.trim()
      if (!name) return prev
      const existed = input.id ? prev.groups.find((g) => g.id === input.id) : null
      if (existed) {
        const groups = prev.groups.map((g) => (g.id === existed.id ? { ...g, name, updatedAt: now } : g))
        return fixHostConfigState({ ...prev, groups })
      }
      const id = uid('g') as ID
      const maxSort = prev.groups.reduce((m, g) => Math.max(m, g.sort), 0)
      const g: Group = { id, name, parentId: null, sort: maxSort + 1, createdAt: now, updatedAt: now }
      return fixHostConfigState({ ...prev, groups: [g, ...prev.groups] })
    })
  }

  function setGroupParent(id: ID, parentId: ID | null) {
    const now = Date.now()
    setHostCfg((prev) => {
      const groups = prev.groups.map((g) => (g.id === id ? { ...g, parentId, updatedAt: now } : g))
      return fixHostConfigState({ ...prev, groups })
    })
  }

  function reorderGroup(id: ID, dir: 'up' | 'down') {
    setHostCfg((prev) => {
      const now = Date.now()
      const groups = prev.groups.slice()
      const target = groups.find((g) => g.id === id)
      if (!target) return prev
      const siblings = groups.filter((g) => (g.parentId ?? null) === (target.parentId ?? null)).sort((a, b) => a.sort - b.sort)
      const idx = siblings.findIndex((g) => g.id === id)
      const swapWith = dir === 'up' ? siblings[idx - 1] : siblings[idx + 1]
      if (!swapWith) return prev
      const aSort = target.sort
      const bSort = swapWith.sort
      const next = groups.map((g) =>
        g.id === target.id ? { ...g, sort: bSort, updatedAt: now } : g.id === swapWith.id ? { ...g, sort: aSort, updatedAt: now } : g,
      )
      return fixHostConfigState({ ...prev, groups: next })
    })
  }

  function moveHostsToGroup(hostIds: ID[], targetGroupId: ID | null) {
    const now = Date.now()
    const setIds = new Set(hostIds)
    setHostCfg((prev) => {
      const hosts = prev.hosts.map((h) => (setIds.has(h.id) ? { ...h, groupId: targetGroupId, updatedAt: now } : h))
      return fixHostConfigState({ ...prev, hosts })
    })
  }

  function deleteGroup(
    id: ID,
    strategy: { type: 'ungroup' } | { type: 'move'; targetGroupId: ID } = { type: 'ungroup' },
  ) {
    const now = Date.now()
    setHostCfg((prev) => {
      const groups = prev.groups
        .filter((g) => g.id !== id)
        .map((g) => (g.parentId === id ? { ...g, parentId: null, updatedAt: now } : g))

      const hosts =
        strategy.type === 'move'
          ? prev.hosts.map((h) => (h.groupId === id ? { ...h, groupId: strategy.targetGroupId, updatedAt: now } : h))
          : prev.hosts.map((h) => (h.groupId === id ? { ...h, groupId: null, updatedAt: now } : h))

      return fixHostConfigState({ ...prev, groups, hosts })
    })
  }

  function upsertTag(input: { id?: ID; name: string }) {
    const now = Date.now()
    setHostCfg((prev) => {
      const name = input.name.trim()
      if (!name) return prev
      const existed = input.id ? prev.tags.find((t) => t.id === input.id) : null
      if (existed) {
        const tags = prev.tags.map((t) => (t.id === existed.id ? { ...t, name, updatedAt: now } : t))
        return fixHostConfigState({ ...prev, tags })
      }
      const id = uid('tag') as ID
      const maxSort = prev.tags.reduce((m, t) => Math.max(m, t.sort), 0)
      const t: Tag = { id, name, sort: maxSort + 1, createdAt: now, updatedAt: now }
      return fixHostConfigState({ ...prev, tags: [t, ...prev.tags] })
    })
  }

  function deleteTag(id: ID) {
    const now = Date.now()
    setHostCfg((prev) => {
      const tags = prev.tags.filter((t) => t.id !== id)
      const hosts = prev.hosts.map((h) =>
        h.tagIds.includes(id) ? { ...h, tagIds: h.tagIds.filter((x) => x !== id), updatedAt: now } : h,
      )
      return fixHostConfigState({ ...prev, tags, hosts })
    })
  }

  function saveHostFromEditor(
    draft: {
      id?: ID
      name: string
      address: string
      port: number
      user: string
      os?: 'linux' | 'windows'
      groupId: ID | null
      tagNames: string[]
      favorite?: boolean
      credentialId?: ID | null
      lastConnectedAt?: number | null
      createdAt?: number
      deletedAt?: number | null
    },
    authType: HostAuthType,
  ): ID {
    const now = Date.now()
    const id = draft.id ?? (uid('h') as ID)
    setHostCfg((prev) => {
      const os = draft.os === 'windows' ? 'windows' : 'linux'
      const groupId: ID | null = draft.groupId
      const groups: Group[] = prev.groups

      // tags: auto-create by name
      const tagsByName = new Map(prev.tags.map((t) => [t.name.trim().toLowerCase(), t]))
      let tags: Tag[] = prev.tags
      const tagIds: ID[] = []
      for (const raw of draft.tagNames) {
        const name = raw.trim()
        if (!name) continue
        const key = name.toLowerCase()
        const existing = tagsByName.get(key)
        if (existing) {
          tagIds.push(existing.id)
          continue
        }
        const id = uid('tag') as ID
        const t: Tag = { id, name, sort: tags.length, createdAt: now, updatedAt: now }
        tags = [t, ...tags]
        tagsByName.set(key, t)
        tagIds.push(id)
      }

      const existed = prev.assets.find((h) => h.id === id)
      const createdAt = existed?.createdAt ?? draft.createdAt ?? now

      // credential
      let credentials: Credential[] = prev.credentials
      let credentialId: ID | null = draft.credentialId ?? existed?.credentialId ?? null
      if (authType === 'none') {
        credentialId = null
      } else {
        const cId = credentialId ?? (uid('cred') as ID)
        const cEx = prev.credentials.find((c) => c.id === cId)
        if (cEx) {
          credentials = prev.credentials.map((c) => (c.id === cId ? { ...c, type: authType, updatedAt: now } : c))
        } else {
          credentials = [{ id: cId, type: authType, createdAt: now, updatedAt: now }, ...prev.credentials]
        }
        credentialId = cId
      }

      const h: Host = {
        id,
        type: os, // host-config v2
        os: os, // legacy field used by some UI
        name: draft.name,
        address: draft.address,
        port: draft.port,
        user: draft.user,
        username: draft.user ?? '', // Required by Asset
        groupId,
        tagIds,
        favorite: Boolean(draft.favorite ?? existed?.favorite ?? false),
        credentialId,
        lastConnectedAt: draft.lastConnectedAt ?? existed?.lastConnectedAt ?? null,
        createdAt,
        updatedAt: now,
        deletedAt: draft.deletedAt ?? existed?.deletedAt ?? null,
        status: 'enabled', // Required by Asset
      }

      const assets = existed ? prev.assets.map((x) => (x.id === id ? h : x)) : [h, ...prev.assets]
      return fixHostConfigState({ ...prev, assets, tags, groups, credentials, activeHostId: id })
    })
    return id
  }

  async function copyHostAddress(h: Host) {
    const text = h.user ? `${h.user}@${h.address}:${h.port}` : `${h.address}:${h.port}`
    try {
      await navigator.clipboard.writeText(text)
      setCopyHintAt(Date.now())
      window.setTimeout(() => setCopyHintAt(0), 1200)
    } catch {
      window.prompt(I18N.sshCopyAddr, text)
    }
  }

  function toggleFavorite(h: Host) {
    setHostCfg((prev) => {
      const now = Date.now()
      const hosts = prev.hosts.map((x) => (x.id === h.id ? { ...x, favorite: !x.favorite, updatedAt: now } : x))
      return { ...prev, hosts }
    })
  }

  function deleteHost(h: Host) {
    const addr = `${h.user ? h.user + '@' : h.username ? h.username + '@' : ''}${h.address}:${h.port}`
    setConfirmDialog({
      title: '删除主机资产',
      desc: `将删除：${h.name}（${addr}）。该操作仅影响本地配置，不会影响真实主机。`,
      confirmText: '删除',
      onConfirm: () => {
        const now = Date.now()
        setHostCfg((prev) => {
          const hosts = prev.hosts.map((x) => (x.id === h.id ? { ...x, deletedAt: now, updatedAt: now } : x))
          return fixHostConfigState({ ...prev, hosts })
        })
        setConfirmDialog(null)
      },
    })
  }

  function closeSession(sessionId: string) {
    setOpenMenuForId(null)
    setMenuPos(null)
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, closed: true } : s)))
  }

  function deleteSession(sessionId: string) {
    setOpenMenuForId(null)
    setMenuPos(null)
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== sessionId)
      if (next.length === 0) return [createDefaultSession()]
      return next
    })
  }

  function stopGeneration() {
    const ctrl = abortRef.current
    const assistantId = streamingMsgIdRef.current
    const sessionId = activeSession?.id

    if (ctrl) {
      try {
        ctrl.abort()
      } catch {
        // ignore
      }
    }

    if (assistantId && sessionId) {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantId ? { ...m, streaming: false, content: appendStoppedTag(m.content) } : m,
            ),
          }
        }),
      )
    }

    abortRef.current = null
    streamingMsgIdRef.current = null
    setSending(false)
  }

  function doClearActiveChatMessages() {
    const sessionId = activeSession?.id
    if (!sessionId) {
      setToast({ id: uid('t'), message: '没有可清空的会话' })
      return
    }
    const msgCount = activeSession?.messages?.length || 0
    if (msgCount <= 0) {
      setToast({ id: uid('t'), message: '当前聊天已为空' })
      return
    }

    // Stop streaming first (if any) to avoid re-adding messages after clear.
    if (sending) {
      try {
        stopGeneration()
      } catch {
        // ignore
      }
    }
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, messages: [] } : s)))
    setPendingImages([])
    setToast({ id: uid('t'), message: '已清空聊天记录' })
  }

  const [wsChatConfirm, setWsChatConfirm] = useState<null | { type: 'clear_chat' }>(null)

  function modelSupportsImages(model: string) {
    const m = (model || '').toLowerCase()
    // Heuristic: only enable vision send for models that look multimodal.
    // (deepseek-chat / deepseek-reasoner are text-only; vision models usually include vl/vision.)
    return m.includes('vl') || m.includes('vision') || m.includes('multimodal') || m.includes('image')
  }

  async function addScreenshotFile(file: File) {
    const maxBytes = 1_500_000 // ~1.5MB, keep request safe
    if (!file.type.startsWith('image/')) {
      setToast({ id: uid('t'), message: '仅支持图片格式的截图' })
      return
    }
    if (file.size > maxBytes) {
      setToast({ id: uid('t'), message: '截图过大（>1.5MB），请裁剪后再上传' })
      return
    }
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result || ''))
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
    if (!dataUrl.startsWith('data:image/')) {
      setToast({ id: uid('t'), message: '截图解析失败' })
      return
    }
    const img: ChatImage = { id: uid('img'), name: file.name || 'screenshot.png', dataUrl, size: file.size }
    setPendingImages((prev) => [img, ...prev].slice(0, 3))
  }

  async function onChatPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    try {
      const items = e.clipboardData?.items
      if (!items) return
      for (const it of Array.from(items)) {
        if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f && f.type.startsWith('image/')) {
            e.preventDefault()
            await addScreenshotFile(f)
            return
          }
        }
      }
    } catch {
      // ignore
    }
  }

  async function send() {
    const raw = input
    const text = raw.trim()
    const sessionId = activeSession?.id
    const imgs = pendingImages
    if ((!text && imgs.length === 0) || !sessionId || sending) return

    // Shortcut: direct shell command runner (no LLM).
    // - /run <cmd>
    // - !<cmd>
    const t0 = text.replace(/\s+/g, ' ').trim()
    const isRun = mode === 'workspace' && imgs.length === 0 && (t0.toLowerCase().startsWith('/run ') || t0.startsWith('!'))
    if (isRun) {
      if (aiUiMode !== 'agent' && aiUiMode !== 'debug') {
        setToast({ id: uid('t'), message: '当前模式禁止执行命令（请切换到 Agent/Debug）' })
        return
      }
      if (terminalConfidenceEffective(terminalStateRef.current) === 'LOW') {
        setToast({ id: uid('t'), message: '终端状态不可信（LOW）：请先重新连接或进入 Shell（人工）' })
        return
      }
      const cmd = t0.toLowerCase().startsWith('/run ') ? t0.slice(5).trim() : t0.slice(1).trim()
      if (!cmd) return
      if (!activeConn?.sessionId) {
        setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
        return
      }
      setInput('')
      setPendingImages([])
      appendUserToActiveSession(`/run ${cmd}`)
      requestRunCommands([cmd], '/run')
      return
    }

    // Shortcut: local system status probe (do NOT call LLM).
    // This avoids the "model suggests commands" behavior and directly verifies terminal/session wiring.
    const t = text.replace(/\s+/g, ' ').trim()
    const isSysProbe =
      mode === 'workspace' &&
      imgs.length === 0 &&
      (t === '查看当前系统状态' || t === '查看系统状态' || t === '系统状态' || t.toLowerCase() === '/sys')
    if (isSysProbe) {
      if (!activeConn?.sessionId) {
        setToast({ id: uid('t'), message: '连接已断开，请先重新连接' })
        return
      }
      if (aiUiMode !== 'agent' && aiUiMode !== 'debug') {
        setToast({ id: uid('t'), message: '当前模式禁止执行命令（请切换到 Agent/Debug）' })
        return
      }
      setInput('')
      setPendingImages([])
      appendUserToActiveSession('查看当前系统状态')
      void runSystemStatusProbe()
      return
    }

    setSending(true)

    setPendingImages([])

    const shownText = text || (imgs.length ? '（图片）' : '')
    const userMsg: ChatMessage = {
      id: uid('m'),
      role: 'user',
      content: shownText,
      ts: Date.now(),
      images: imgs.length ? imgs : undefined,
    }

    const assistantId = uid('m')
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      ts: Date.now() + 1,
      streaming: true,
    }

    // optimistic update
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== sessionId) return s
        const nextMessages = [...s.messages, userMsg, assistantMsg]
        const nextTitle = s.title === I18N.newSession ? text.slice(0, 18) : s.title
        return { ...s, title: nextTitle, messages: nextMessages }
      }),
    )

    setInput('')
    setMentionOpen(false)
    setMentionQuery('')
    setMentionActiveIdx(0)

    const ctrl = new AbortController()
    abortRef.current = ctrl
    streamingMsgIdRef.current = assistantId

    try {
      const wantImages = imgs.length > 0 && modelSupportsImages(selectedModel)
      if (imgs.length > 0 && !wantImages) {
        setToast({ id: uid('t'), message: '图片已发出，但当前模型不支持看图；请补充文字描述' })
      }

      // Note: Cursor-like behavior: context attachments are added explicitly via the @ Context Picker.

      const agentEnabled = mode === 'workspace' && Boolean(activeConn?.sessionId) && (aiUiMode === 'agent' || aiUiMode === 'debug')
      // Cursor-like: do NOT inject tool instructions into the visible user message.
      // Instead, send tool_mode/tool_env as hidden metadata; backend injects it into system prompt.
      const msgToModel = text || (imgs.length ? '（我发了一张图片，请根据我后续的文字描述来回答）' : '')
      // Workspace Snapshot: structured "world state" the AI can trust (Cursor-like).
      // IMPORTANT: do NOT feed raw terminal transcript as primary truth; provide structured Command Events + snapshot.
      const autoCtx: Array<{ kind: string; title: string; content: string }> = []
      if (agentEnabled && activeConn) {
        const cwd = (activeConn.path || '').trim() || '.'
        const selectedFile = String(activeConn.openFile || '').trim()
        const fileTree = (fsItems || []).slice(0, 260).map((x) => x.name)
        const selectedFileContent = selectedFile ? String(fsContent || '').slice(0, 220_000) : ''
        const snapshot = {
          os_type: 'linux',
          shell_type: 'bash',
          path_style: 'unix',
          asset_id: String(activeConn.hostId || ''),
          workspace_id: String((activeSpaceId || '').trim() || 'host_config_v1'),
          cwd,
          file_tree: fileTree,
          selected_file: selectedFile || null,
          selected_file_content: selectedFileContent || null,
          last_terminal_state: lastTerminalState,
          recent_command_events: (commandEvents || []).slice(Math.max(0, commandEvents.length - 12)),
          assistant_guidelines: [
            // Keep UX clean: don't talk about internal conventions/prompts.
            '不要向用户解释内部“命令约定/工具约定/系统提示词”等实现细节，直接给出结论与可执行步骤。',
            // Safety: avoid destructive suggestions unless explicitly asked.
            '除非用户明确要求删除/破坏性操作，否则不要建议使用 rm 等破坏性命令；优先建议只读验证（ls/stat/cat/head）。',
          ],
        }
        autoCtx.push({ kind: 'workspace_snapshot', title: 'workspace_snapshot', content: JSON.stringify(snapshot) })
      }

      const toolEnv =
        agentEnabled && activeConn
          ? `os: linux\nasset_name: ${hostById(activeConn.hostId)?.name || ''}\nrootPath: ${activeConn.rootPath}\ncwd: ${activeConn.path || '.'}`
          : ''

      const termState = terminalStateRef.current
      const aiMode = _aiExecModeFromUiMode(aiUiMode)

      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          message: msgToModel,
          model: selectedModel,
          context_items: [...chatCtxItems.map((x) => ({ kind: x.kind, title: x.title, content: x.content })), ...autoCtx],
          images: wantImages ? imgs.map((x) => x.dataUrl) : [],
          tool_mode: agentEnabled,
          tool_env: toolEnv,
          ai_mode: aiMode,
          terminal_state: termState,
          // For server-side project rules injection
          spaceId: (activeSpaceId || '').trim() || 'host_config_v1',
        }),
        signal: ctrl.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('no body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let acc = ''

      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        acc += decoder.decode(value, { stream: true })

        const next = acc
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              messages: s.messages.map((m) => (m.id === assistantId ? { ...m, content: next } : m)),
            }
          }),
        )
      }

      // finalize
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s
          return {
            ...s,
            messages: s.messages.map((m) => (m.id === assistantId ? { ...m, streaming: false } : m)),
          }
        }),
      )

      // Cursor-like: terminal context is usually "for the next question".
      // Auto-remove terminal ctx items that are scope=once and not pinned after a successful send.
      const removedOnceIds: string[] = []
      setChatCtxItems((prev) => {
        const next = prev.filter((x) => {
          const drop = x.kind === 'terminal' && x.scope === 'once' && !x.pinned
          if (drop) removedOnceIds.push(x.id)
          return !drop
        })
        return next
      })
      if (removedOnceIds.length > 0) {
        setToast({ id: uid('t'), message: `已使用终端上下文（${removedOnceIds.length} 项），默认仅本次；可点📌固定` })
      }

      // Agent mode: parse tool calls and execute against the connected workspace.
      if (agentEnabled && activeConn?.sessionId) {
        const calls = parseAgentToolCalls(acc)
        if (calls.length > 0) {
          // Cursor-like: don't auto-run blindly; route through the tool execution policy (Ask/Allowlist/All).
          requestRunToolCalls(calls, 'AI 工具调用', assistantId)
        }
      }
    } catch (e) {
      const isAbort =
        (e instanceof DOMException && e.name === 'AbortError') ||
        (e instanceof Error && e.name === 'AbortError') ||
        String(e).toLowerCase().includes('abort')

      if (isAbort) {
        // stopGeneration() already updated UI; ensure message is finalized anyway.
        setSessions((prev) =>
          prev.map((s) => {
            if (s.id !== sessionId) return s
            return {
              ...s,
              messages: s.messages.map((m) =>
                m.id === assistantId ? { ...m, streaming: false, content: appendStoppedTag(m.content) } : m,
              ),
            }
          }),
        )
        return
      }

      const err = e instanceof Error ? e.message : String(e)
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === assistantId
                ? { ...m, streaming: false, error: err, content: `${I18N.requestFailed}${err}` }
                : m,
            ),
          }
        }),
      )
    } finally {
      abortRef.current = null
      streamingMsgIdRef.current = null
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Cursor-like @ context picker
    if (ctxPickerOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCtxPickerIdx((p) => Math.min(p + 1, Math.max(0, ctxPickerItems.length - 1)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCtxPickerIdx((p) => Math.max(0, p - 1))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        closeCtxPicker()
        stripTrailingAtToken()
        return
      }
      if (e.key === 'Enter' && !e.shiftKey && ctxPickerItems.length > 0) {
        e.preventDefault()
        const pick = ctxPickerItems[Math.min(ctxPickerIdx, ctxPickerItems.length - 1)] as any
        void (async () => {
          try {
            if (pick.kind === 'file') await ctxAddFileSnapshot(pick.ref)
            else if (pick.kind === 'dir') await ctxAddDirSnapshot(pick.ref)
            else if (pick.kind === 'text' && pick.content) ctxAdd({ kind: 'terminal', title: pick.title, content: pick.content, scope: 'once' })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            setToast({ id: uid('t'), message: `加入上下文失败：${msg}` })
          } finally {
            closeCtxPicker()
            stripTrailingAtToken()
            setTimeout(() => inputRef.current?.focus(), 0)
          }
        })()
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const statusText =
    health.state === 'checking'
      ? I18N.backendChecking
      : health.state === 'ok'
        ? I18N.backendOk
        : `${I18N.backendErr}${health.detail ? `\uff08${health.detail}\uff09` : ''}`

  const dotClass = health.state === 'ok' ? 'dot dotOk' : health.state === 'error' ? 'dot dotErr' : 'dot'

  const modelSelectValue = modelsLoading || models.length === 0 ? '' : selectedModel

  const tagById = useMemo(() => new Map(hostCfg.tags.map((t) => [t.id, t])), [hostCfg.tags])
  const groupById = useMemo(() => new Map(hostCfg.groups.map((g) => [g.id, g])), [hostCfg.groups])
  const credById = useMemo(() => new Map(hostCfg.credentials.map((c) => [c.id, c])), [hostCfg.credentials])
  const openGroup = useMemo(() => (groupMenuOpenId ? groupById.get(groupMenuOpenId) ?? null : null), [groupMenuOpenId, groupById])

  function normalizeTokens(q: string) {
    return q
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
  }

  const visibleHosts = useMemo(() => {
    const tokens = normalizeTokens(sshSearch)
    const hosts = hostCfg.hosts.filter((h) => !h.deletedAt)
    if (tokens.length === 0) return hosts

    return hosts.filter((h) => {
      const groupName = h.groupId ? groupById.get(h.groupId)?.name ?? '' : ''
      const tagNames = (h.tagIds || []).map((id) => tagById.get(id)?.name ?? '').join(' ')
      const hay = `${h.name} ${h.address} ${h.user} ${groupName} ${tagNames}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
  }, [hostCfg.hosts, sshSearch, groupById, tagById])

  const isSshSearching = sshSearch.trim().length > 0

  const favoriteHosts = useMemo(() => visibleHosts.filter((h) => h.favorite), [visibleHosts])
  const recentHosts = useMemo(
    () =>
      [...visibleHosts]
        .filter((h) => typeof h.lastConnectedAt === 'number')
        .sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0))
        .slice(0, 10),
    [visibleHosts],
  )

  const dashHostCount = useMemo(() => hostCfg.hosts.filter((h) => !h.deletedAt).length, [hostCfg.hosts])
  const dashWorkspaceCount = useMemo(() => hostCfg.workspaces.length, [hostCfg.workspaces])

  const dashHostsFiltered = useMemo(() => {
    const tokens = normalizeTokens(dashHostSearch)
    const hosts = hostCfg.hosts.filter((h) => !h.deletedAt)
    if (tokens.length === 0) return hosts
    return hosts.filter((h) => {
      const groupName = h.groupId ? groupById.get(h.groupId)?.name ?? '' : ''
      const tagNames = (h.tagIds || []).map((id) => tagById.get(id)?.name ?? '').join(' ')
      const hay = `${h.name} ${h.address} ${h.user} ${groupName} ${tagNames}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
  }, [dashHostSearch, hostCfg.hosts, groupById, tagById])

  const dashWorkspacesSorted = useMemo(
    () =>
      hostCfg.workspaces
        .slice()
        .sort((a, b) => (b.lastOpenedAt || b.updatedAt || 0) - (a.lastOpenedAt || a.updatedAt || 0)),
    [hostCfg.workspaces],
  )

  const dashRecentMixed = useMemo(() => {
    const items: Array<
      | { kind: 'host'; ts: number; host: Host }
      | { kind: 'ws'; ts: number; ws: any; host: Host | null }
    > = []
    for (const h of hostCfg.hosts) {
      if (h.deletedAt) continue
      const ts = typeof h.lastConnectedAt === 'number' ? (h.lastConnectedAt as number) : 0
      if (ts > 0) items.push({ kind: 'host', ts, host: h })
    }
    for (const w of hostCfg.workspaces) {
      const ts = typeof (w as any).lastOpenedAt === 'number' ? ((w as any).lastOpenedAt as number) : (w.updatedAt as number) || 0
      if (ts <= 0) continue
      const host = hostCfg.hosts.find((h) => h.id === w.assetId) ?? null
      items.push({ kind: 'ws', ts, ws: w, host })
    }
    return items
      .slice()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5)
  }, [hostCfg.hosts, hostCfg.workspaces])

  // Dashboard: lightweight host reachability probe (TCP) for status dots.
  useEffect(() => {
    if (mode !== 'dashboard') return
    let cancelled = false
    const intervalMs = 60_000

    const pickTargets = () =>
      hostCfg.hosts
        .filter((h) => !h.deletedAt)
        .slice()
        .sort((a, b) => (b.lastConnectedAt || 0) - (a.lastConnectedAt || 0))
        .slice(0, 8)

    async function run() {
      const now = Date.now()
      const targets = pickTargets()
      for (const h of targets) {
        if (cancelled) return
        const prev = dashHostProbeRef.current[h.id]
        if (prev && now - prev.checkedAt < intervalMs - 5_000) continue
        setDashHostProbe((m) => ({ ...m, [h.id]: { state: 'unknown', checkedAt: now } }))
        try {
          const r = await sshTestTcp({ address: h.address, port: h.port })
          if (cancelled) return
          setDashHostProbe((m) => ({
            ...m,
            [h.id]: {
              state: r.success ? 'ok' : 'bad',
              latencyMs: r.latencyMs ?? undefined,
              os: r.os,
              checkedAt: Date.now(),
            },
          }))
        } catch {
          if (cancelled) return
          setDashHostProbe((m) => ({ ...m, [h.id]: { state: 'bad', checkedAt: Date.now() } }))
        }
      }
    }

    void run()
    const t = window.setInterval(() => void run(), intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, apiBase, hostCfg.hosts])

  const topGroups = useMemo(
    () => hostCfg.groups.filter((g) => !g.parentId).sort((a, b) => a.sort - b.sort),
    [hostCfg.groups],
  )
  const childGroupsByParent = useMemo(() => {
    const m = new Map<ID, Group[]>()
    for (const g of hostCfg.groups) {
      if (!g.parentId) continue
      const arr = m.get(g.parentId) || []
      arr.push(g)
      m.set(g.parentId, arr)
    }
    for (const [, arr] of m.entries()) arr.sort((a, b) => a.sort - b.sort)
    return m
  }, [hostCfg.groups])

  function hostsInGroup(groupId: ID | null) {
    return visibleHosts.filter((h) => (groupId ? h.groupId === groupId : !h.groupId))
  }

  const activeHost = useMemo(() => {
    const id = hostCfg.activeHostId
    if (!id) return null
    return visibleHosts.find((h) => h.id === id) ?? null
  }, [hostCfg.activeHostId, visibleHosts])

  const activeWorkspace = useMemo(() => {
    const id = hostCfg.activeWorkspaceId
    if (!id) return null
    return hostCfg.workspaces.find((w) => w.id === id) ?? null
  }, [hostCfg.activeWorkspaceId, hostCfg.workspaces])

  const activeWorkspaceAsset = useMemo(() => {
    if (!activeWorkspace) return null
    return hostCfg.assets.find((a) => a.id === activeWorkspace.assetId) ?? null
  }, [activeWorkspace, hostCfg.assets])

  // Ensure activeHostId is visible & valid in SSH mode
  // NOTE: allow "no selection" (activeHostId=null) so user can close the detail panel.
  useEffect(() => {
    if (mode !== 'ssh') return
    const active = hostCfg.activeHostId
    if (!active) return
    if (visibleHosts.some((h) => h.id === active)) return
    const nextId = visibleHosts[0]?.id ?? null
    if (nextId !== hostCfg.activeHostId) {
      setHostCfg((prev) => ({ ...prev, activeHostId: nextId }))
    }
  }, [mode, hostCfg.activeHostId, visibleHosts])

  const installedPlugins = useMemo(() => plugins.filter((p) => p.installed), [plugins])
  const updatePlugins = useMemo(() => plugins.filter((p) => p.installed && p.hasUpdate), [plugins])
  const marketPlugins = useMemo(() => plugins.filter((p) => !p.installed), [plugins])

  function renderWorkspaceToolsCard(extra?: { style?: CSSProperties }) {
  if (!activeConn?.sessionId) {
    return (
      <div
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: 0,
          ...(extra?.style || {}),
        }}
      >
        <div
          style={{
            padding: 12,
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div style={{ fontWeight: 800 }}>{'文件'}</div>
        </div>
        <div style={{ padding: 12, flex: 1, minHeight: 0, overflow: 'auto' }}>
          <div className="workCardText" style={{ opacity: 0.86 }}>
            {activeConn?.expired ? '连接已断开。' : '尚未连接。'}
          </div>
          <div style={{ marginTop: 10, fontSize: 12, opacity: 0.7 }}>
            {activeConn?.expired ? '请点击上方右侧“重新连接”继续使用工作区。' : '请点击上方右侧“连接”进入工作区。'}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div
        style={{
          border: '1px solid #e2e8f0',
          borderRadius: 12,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: 0,
          ...(extra?.style || {}),
        }}
      >
        <div style={{ padding: 12, borderBottom: '1px solid #e2e8f0', display: 'flex', gap: 8 }}>
          <input
            className="fieldInput"
            style={{ flex: 1 }}
            ref={wsPathInputRef}
            value={wsPathDraft}
            onChange={(e) => setWsPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              if (!activeConn || remoteBusy) return
              const p = (wsPathDraft || '').trim()
              if (!p) return
              void (async () => {
                try {
                  setRemoteErr('')
                  setRemoteBusy(true)
                  await openWorkspaceDir(p)
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err)
                  const m = msg.toLowerCase()
                  const pretty = m.includes('filenotfound') || m.includes('no such file') || m.includes('not found') ? '目录不存在' : msg
                  setToast({ id: uid('t'), message: pretty })
                } finally {
                  setRemoteBusy(false)
                }
              })()
            }}
            placeholder="当前目录路径"
          />
          <button
            className="btn btnPrimary"
            type="button"
            disabled={!activeConn || remoteBusy}
            title="打开任意目录（需在服务器上真实存在且有权限访问）"
            onClick={() => {
              if (!activeConn) return
              const p = (wsPathDraft || '').trim()
              if (!p) return
              void (async () => {
                try {
                  setRemoteErr('')
                  setRemoteBusy(true)
                  await openWorkspaceDir(p)
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e)
                  const m = msg.toLowerCase()
                  const pretty = m.includes('filenotfound') || m.includes('no such file') || m.includes('not found') ? '目录不存在' : msg
                  setToast({ id: uid('t'), message: pretty })
                } finally {
                  setRemoteBusy(false)
                }
              })()
            }}
          >
            打开
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              if (!activeConn) return
              const cur = (activeConn.path || '.').trim() || '.'
              const parent = cur === '/' ? '/' : cur.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'
              const root = (activeConn.rootPath || '/root').replace(/\/+$/, '') || '/'
              const next = root !== '/' && (parent === '/' || (!parent.startsWith(root + '/') && parent !== root)) ? root : parent
              setActiveConn({ ...activeConn, path: next, openFile: null })
              setWsPathDraft(next)
              setFsContent('')
              setFsDirty(false)
            }}
            disabled={!activeConn || remoteBusy}
          >
            上级
          </button>
          <button
            className="btn btnPrimary wsRefreshBtn"
            type="button"
            onClick={() => {
              if (!activeConn) return
              void workspaceLoadFs(true)
            }}
            disabled={!activeConn}
            title="刷新目录（在当前版本复用文件面板逻辑）"
          >
            刷新
          </button>
        </div>

        <div
          className="wsLeftPane"
          style={{
            padding: 12,
            flex: 1,
            minHeight: 0,
            display: 'grid',
            overflow: 'hidden',
            // IMPORTANT: keep row count aligned with rendered children, otherwise the editor/terminal will be squashed/hidden.
            // Keep the splitter visually slim, but with enough hit-area to drag.
            // Allow terminal to expand up to the top (Cursor-like): make upper rows shrinkable to 0.
            gridTemplateRows: activeConn?.openFile ? `minmax(0, 1fr) minmax(0, 1fr) 6px ${wsTermH}px` : `minmax(0, 1fr) 6px ${wsTermH}px`,
            gap: 0,
          }}
        >
          {/* File list */}
          <div style={{ overflow: 'auto', minHeight: 0, paddingBottom: 10 }}>
            {visibleFsItems.length === 0 ? (
              <div className="wsEmpty">
                <div className="workCardText" style={{ opacity: 0.85 }}>
                  {!activeConn ? '未连接工作区。请先连接主机。' : '暂无文件列表（可能是目录为空或尚未加载）。'}
                </div>
                <div className="wsEmptyActions">
                  <button
                    className="btn btnPrimary wsRefreshBtn"
                    type="button"
                    disabled={!activeConn}
                    onClick={() => {
                      if (!activeConn) return
                      void workspaceLoadFs(true)
                    }}
                  >
                    刷新
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={!activeConn || remoteBusy}
                    onClick={() => {
                      if (!activeConn) return
                      const p = (activeConn.rootPath || '/root').trim() || '/root'
                      setWsPathDraft(p)
                      void (async () => {
                        try {
                          setRemoteErr('')
                          setRemoteBusy(true)
                          await openWorkspaceDir(p)
                        } catch (e) {
                          const msg = e instanceof Error ? e.message : String(e)
                          setToast({ id: uid('t'), message: msg })
                        } finally {
                          setRemoteBusy(false)
                        }
                      })()
                    }}
                    title="打开 rootPath（主机侧根目录）"
                  >
                    打开 rootPath
                  </button>
                  <button
                    className="btn"
                    type="button"
                    disabled={!activeConn || remoteBusy}
                    onClick={() => {
                      if (!activeConn) return
                      const p = '/'
                      setWsPathDraft(p)
                      void (async () => {
                        try {
                          setRemoteErr('')
                          setRemoteBusy(true)
                          await openWorkspaceDir(p)
                        } catch (e) {
                          const msg = e instanceof Error ? e.message : String(e)
                          setToast({ id: uid('t'), message: msg })
                        } finally {
                          setRemoteBusy(false)
                        }
                      })()
                    }}
                    title="打开 /（可能受权限限制）"
                  >
                    打开 /
                  </button>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setDashDrawer({ open: true, type: 'create_workspace' })
                      setMode('dashboard')
                    }}
                    title="跳转到控制台创建工作区"
                  >
                    创建工作区
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {visibleFsItems.map((it) => {
                  const iconType = (() => {
                    if (it.isDir) return 'folder'
                    const ext = it.name.split('.').pop()?.toLowerCase() || ''
                    const name = it.name.toLowerCase()
                    if (['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java'].includes(ext)) return 'code'
                    if (['json', 'yaml', 'yml', 'toml', 'env'].includes(ext) || name.includes('config')) return 'config'
                    if (['md', 'txt'].includes(ext)) return 'doc'
                    if (['sh', 'bash', 'ps1'].includes(ext)) return 'script'
                    return 'other'
                  })()
                  const icon =
                    iconType === 'folder'
                      ? '📁'
                      : iconType === 'code'
                        ? '📝'
                        : iconType === 'config'
                          ? '⚙️'
                          : iconType === 'doc'
                            ? '📄'
                            : iconType === 'script'
                              ? '🔧'
                              : '📄'

                  const isSelected = activeConn?.openFile?.endsWith(`/${it.name}`) || false
                  return (
                    <button
                      key={it.name}
                      className="btn button-hover"
                      type="button"
                      title={(activeConn?.path || '.').trim() ? `${(activeConn?.path || '.').trim().replace(/\/+$/, '')}/${it.name}` : it.name}
                      style={{
                        textAlign: 'left',
                        justifyContent: 'space-between',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        paddingRight: 12,
                        border: isSelected ? '1px solid rgba(124, 92, 255, 0.16)' : '1px solid #e2e8f0',
                        background: isSelected ? 'rgba(124, 92, 255, 0.05)' : '#ffffff',
                        transition: 'all 0.15s ease',
                      }}
                      onClick={() => {
                        if (!activeConn) return
                        if (it.isDir) {
                          const next = `${(activeConn.path || '.').replace(/\/+$/, '')}/${it.name}`
                          setActiveConn({ ...activeConn, path: next, openFile: null })
                          setFsContent('')
                          setFsDirty(false)
                        } else {
                          const fp = `${activeConn.path || '.'}/${it.name}`
                          void openWorkspaceFile(fp)
                        }
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                        <span style={{ flex: '0 0 auto', fontSize: 16, filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.3))' }} title={iconType}>
                          {icon}
                        </span>
                        <span style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: it.isDir ? 600 : 500 }}>
                          {it.name}
                        </span>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', fontSize: 11, opacity: 0.6 }}>
                        {!it.isDir && it.size > 0 ? (
                          <span>
                            {it.size < 1024 ? `${it.size}B` : it.size < 1024 * 1024 ? `${(it.size / 1024).toFixed(1)}K` : `${(it.size / (1024 * 1024)).toFixed(1)}M`}
                          </span>
                        ) : null}
                        {it.isDir ? <span style={{ opacity: 0.55 }}>›</span> : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {activeConn?.openFile ? (
            /* Editor */
            <div
              style={{
                border: '1px solid #e2e8f0',
                // When terminal is visible, visually merge editor+terminal into one card.
                borderBottom: wsTermH > 0 ? 'none' : '1px solid #e2e8f0',
                borderRadius: wsTermH > 0 ? '12px 12px 0 0' : 12,
                overflow: 'hidden',
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              <div
                style={{
                  padding: 10,
                  borderBottom: '1px solid #e2e8f0',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 10,
                }}
              >
                <div
                  title={activeConn.openFile} // hover to show full path
                  style={{
                    fontSize: 12,
                    opacity: 0.9,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    maxWidth: 320,
                    flex: '0 1 auto',
                  }}
                >
                  {pathBaseName(activeConn.openFile)}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button
                    className="btn"
                    type="button"
                    data-ws-file-menu-trigger
                    onClick={(e) => {
                      const el = e.currentTarget as HTMLButtonElement
                      const r = el.getBoundingClientRect()
                      setWsFileMenuPos(calcAnchoredMenuPos({ rect: r, approxW: 210, approxH: 180 }))
                      setWsFileMenuOpen((p) => !p)
                    }}
                    title="更多"
                  >
                    ⋯
                  </button>
                </div>
              </div>
              <div style={{ flex: 1, minHeight: 0, padding: 10 }}>
                <textarea
                  value={fsContent}
                  onChange={(e) => {
                    setFsContent(e.target.value)
                    setFsDirty(true)
                  }}
                  spellCheck={false}
                  style={{
                    width: '100%',
                    height: '100%',
                    resize: 'none',
                    borderRadius: 10,
                    border: '1px solid #e2e8f0',
                    background: '#ffffff',
                    color: '#0f172a',
                    padding: 10,
                    fontSize: 12,
                    lineHeight: 1.55,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, \"Liberation Mono\", \"Courier New\", monospace',
                    outline: 'none',
                  }}
                />
              </div>
            </div>
          ) : null}

          {/* Terminal splitter */}
          <button
            type="button"
            role="separator"
            aria-orientation="horizontal"
            aria-label={wsTermH <= 0 ? '拖拽向上打开终端' : '拖拽调整编辑器/终端高度'}
            style={{ height: 6, position: 'relative', zIndex: 5, pointerEvents: 'auto', background: 'transparent', border: 0, padding: 0 }}
            title={wsTermH <= 0 ? '拖拽向上打开终端' : '拖拽调整编辑器/终端高度'}
          >
            <div
              onPointerDown={(e) => {
                try {
                  ;(e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId)
                } catch {}
                e.preventDefault()
                let maxH = 1400
                try {
                  const container = (e.currentTarget as HTMLDivElement).closest('.wsLeftPane') as HTMLElement | null
                  if (container) {
                    maxH = Math.max(120, Math.round(container.clientHeight - 24))
                  }
                } catch {}
                chatVDragRef.current = { startY: e.clientY, startH: wsTermH, target: 'ws_term', pointerId: e.pointerId, maxH }
                document.body.style.cursor = 'row-resize'
                document.body.style.userSelect = 'none'
              }}
              onPointerUp={(e) => {
                try {
                  ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
                } catch {}
                chatVDragRef.current = null
                document.body.style.cursor = ''
                document.body.style.userSelect = ''
              }}
              onPointerCancel={(e) => {
                try {
                  ;(e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId)
                } catch {}
                chatVDragRef.current = null
                document.body.style.cursor = ''
                document.body.style.userSelect = ''
              }}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: -10,
                bottom: -10,
                cursor: 'row-resize',
                touchAction: 'none',
                background:
                  'linear-gradient(to bottom, transparent 0, transparent 12px, rgba(255,255,255,0.18) 12px, rgba(255,255,255,0.18) 13px, transparent 13px, transparent 100%)',
              }}
            />
          </button>

          {/* Terminal panel */}
          <div
            style={{
              border: '1px solid #e2e8f0',
              borderTop: activeConn?.openFile ? 'none' : '1px solid #e2e8f0',
              borderRadius: activeConn?.openFile ? '0 0 12px 12px' : 12,
              overflow: 'hidden',
              minHeight: 0,
              display: wsTermH <= 0 ? 'none' : 'flex',
              flexDirection: 'column',
              position: 'relative',
            }}
            className="wsTermPanel"
          >
            <div className="wsTermChrome" aria-label="终端工具栏">
              <button
                className="btn"
                type="button"
                data-ws-term-menu-trigger
                onClick={(e) => {
                  const el = e.currentTarget as HTMLButtonElement
                  const r = el.getBoundingClientRect()
                  setWsTermMenuPos(calcAnchoredMenuPos({ rect: r, approxW: 220, approxH: 190 }))
                  setWsTermMenuOpen((p) => !p)
                }}
                title="更多"
              >
                ⋯
              </button>
              {wsTermPtyActive ? (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 12,
                    opacity: 0.9,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid #e2e8f0',
                    background: '#f8fafc',
                  }}
                  title="Shell（人工）模式：PTY 交互；AI exec 已在后端禁用"
                >
                  Shell（人工）
                </span>
              ) : null}
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 10 }}>
              <div
                ref={wsTermElRef}
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: 10,
                  border: '1px solid #e2e8f0',
                  background: '#ffffff',
                }}
                onMouseDown={() => {
                  try {
                    wsTermUserWantsFocusRef.current = true
                    wsTermXRef.current?.focus()
                  } catch {}
                }}
              />
            </div>
          </div>
        </div>
      </div>
    )
  }

  const showSidebarCollapseControls = mode === 'ssh' && !isNarrow
  // In workspace mode, we never use the SSH sidebar collapse mechanism because it has its own icon rail.
  const sidebarCollapseActive = showSidebarCollapseControls && sidebarCollapsed
  const effectiveSidebarW = sidebarCollapseActive ? 0 : sidebarW
  // When collapsed, give the resizer column enough room (28px) to show the expand button.
  // When workspace mode the resizer is hidden entirely.
  const effectiveResizerW = mode === 'workspace' ? 0 : sidebarCollapseActive ? 28 : 6

  return (
    <div
      className={`${mobileSidebarOpen ? 'app mobileSidebarOpen' : 'app'}${mode === 'workspace' ? ' wsMode' : ''}${dashFullscreen ? ' appFullscreen' : ''}${sidebarCollapseActive ? ' sidebarCollapsed' : ''}`}
      style={{ ['--sidebar-w' as never]: `${effectiveSidebarW}px`, ['--sidebar-resizer-w' as never]: `${effectiveResizerW}px` }}
    >
      {prefsOpen ? (
        <>
          <div className="prefDrawerOverlay" aria-hidden="true" onClick={() => setPrefsOpen(false)} />
          <div className="prefDrawer" role="dialog" aria-modal="true" aria-label="偏好设置">
            <div className="prefDrawerHeader">
              <div className="prefDrawerTitle">偏好设置</div>
              <button className="prefDrawerClose" type="button" onClick={() => setPrefsOpen(false)} aria-label="关闭">
                ✕
              </button>
            </div>
            <div className="prefDrawerBody">
              <div className="modalSection">
                <div className="modalSectionTitle">启动与导航</div>
                <div className="field">
                  <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={prefs.rememberLastMode}
                      onChange={(e) => {
                        const next = { ...prefs, rememberLastMode: e.target.checked }
                        setPrefs(next)
                        savePrefs(next)
                        // If user disables remember, optionally jump to default module now.
                        if (!next.rememberLastMode) setMode(next.defaultMode)
                      }}
                      style={{ marginTop: 3 }}
                    />
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 850 }}>记住上次打开的模块</div>
                      <div style={{ marginTop: 6, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                        开启后：刷新页面/下次打开仍停留在你上次使用的“聊天 / 资产管理 / 插件”。
                      </div>
                    </div>
                  </label>
                </div>

                {!prefs.rememberLastMode ? (
                  <div className="field" style={{ marginTop: 12 }}>
                    <div className="fieldLabel">默认进入模块</div>
                    <select
                      className="fieldSelect"
                      value={prefs.defaultMode}
                      onChange={(e) => {
                        const v = String(e.target.value || 'chat')
                        const dm = v === 'ssh' || v === 'plugins' || v === 'chat' ? (v as any) : 'chat'
                        const next = { ...prefs, defaultMode: dm }
                        setPrefs(next)
                        savePrefs(next)
                        setMode(dm)
                      }}
                    >
                      <option value="chat">聊天</option>
                      <option value="ssh">资产管理</option>
                      {PLUGINS_ENABLED ? <option value="plugins">插件</option> : null}
                    </select>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                      关闭“记住上次模块”后，每次进入 /app 会从这里选择的模块开始。
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="modalSection" style={{ marginTop: 12 }}>
                <div className="modalSectionTitle">外观</div>
                <div className="field">
                  <div className="fieldLabel">背景主题</div>
                  <select
                    className="fieldSelect"
                    value={prefs.themeMode}
                    onChange={(e) => {
                      const v = String(e.target.value || DEFAULT_PREFS.themeMode)
                      const tm: ThemeMode = v === 'neutral' || v === 'light' || v === 'dark' ? (v as ThemeMode) : DEFAULT_PREFS.themeMode
                      const next = { ...prefs, themeMode: tm }
                      setPrefs(next)
                      savePrefs(next)
                      try {
                        document.documentElement.dataset.theme = tm
                      } catch {
                        // ignore
                      }
                    }}
                  >
                    <option value="dark">深夜蓝</option>
                    <option value="neutral">石墨灰</option>
                    <option value="light">海雾蓝</option>
                  </select>
                  <div style={{ marginTop: 8, fontSize: 12, color: '#64748b', lineHeight: 1.6 }}>
                    仅调整全局背景与装饰渐变（3 个预设），不影响业务数据与权限。
                  </div>
                </div>
              </div>

              <div className="modalSection" style={{ marginTop: 12 }}>
                <div className="modalSectionTitle">提示</div>
                <div className="workCardText">
                  模型选择在聊天区直接选择即可；偏好设置主要放 UI/交互/隐私等全局行为。
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
      {ctxPreview ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 23, 42, 0.16)',
            zIndex: 60,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 16,
          }}
          onClick={() => setCtxPreview(null)}
        >
          <div
            style={{
              width: 'min(980px, 96vw)',
              maxHeight: '88vh',
              borderRadius: 16,
              border: '1px solid #e2e8f0',
              background: '#ffffff',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                padding: 12,
                borderBottom: '1px solid #e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ctxPreview.title}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    try {
                      void navigator.clipboard.writeText(ctxPreview.content || '')
                      setToast({ id: uid('t'), message: '已复制上下文内容' })
                    } catch {
                      setToast({ id: uid('t'), message: '复制失败' })
                    }
                  }}
                >
                  复制
                </button>
                <button className="btn btnPrimary" type="button" onClick={() => setCtxPreview(null)}>
                  关闭
                </button>
              </div>
            </div>
            <div style={{ padding: 12, minHeight: 0, overflow: 'auto' }}>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word',
                  fontSize: 12,
                  lineHeight: 1.55,
                  color: '#334155',
                  fontFamily:
                    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                }}
              >
                {ctxPreview.content}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
      {mobileSidebarOpen ? (
        <div className="mobileSidebarOverlay" onClick={() => setMobileSidebarOpen(false)} aria-hidden="true" />
      ) : null}

      {mode === 'workspace' ? (
        /* ── Workspace icon rail: collapses sidebar to 48px, flyout on demand ── */
        <aside className="sidebar sidebarIconRail" aria-label="Sidebar">
          <div className="iconRailBrand" title="CodeSprite">CS</div>
          {activeConn?.sessionId ? (
            <div className="iconRailConnDot" title={`已连接：${activeConn.hostId ? (hostById(activeConn.hostId)?.name || activeConn.hostId) : ''}`} />
          ) : (
            <div className="iconRailConnDot iconRailConnDotOff" title="未连接" />
          )}
          <button
            type="button"
            className={`iconRailBtn${wsNavFlyout === 'chat' ? ' iconRailBtnActive' : ''}`}
            title="AI 聊天"
            aria-label="AI 聊天"
            onClick={() => {
              setUserMenuOpen(false)
              __dbgPost({ hypothesisId: 'flyoutAutoClose', location: 'App.tsx:iconRail.chat', message: 'rail click', data: { prev: wsNavFlyout || null } })
              setWsNavFlyout('chat')
            }}
          >
            💬
          </button>
          <button
            type="button"
            className={`iconRailBtn${wsNavFlyout === 'assets' ? ' iconRailBtnActive' : ''}`}
            title="资产管理"
            aria-label="资产管理"
            onClick={() => {
              setUserMenuOpen(false)
              __dbgPost({ hypothesisId: 'flyoutAutoClose', location: 'App.tsx:iconRail.assets', message: 'rail click', data: { prev: wsNavFlyout || null } })
              setWsNavFlyout('assets')
            }}
          >
            🖥
          </button>
          {PLUGINS_ENABLED ? (
            <button
              type="button"
              className={`iconRailBtn${wsNavFlyout === 'plugins' ? ' iconRailBtnActive' : ''}`}
              title="插件"
              aria-label="插件"
              onClick={() => {
                setUserMenuOpen(false)
                __dbgPost({ hypothesisId: 'flyoutAutoClose', location: 'App.tsx:iconRail.plugins', message: 'rail click', data: { prev: wsNavFlyout || null } })
                setWsNavFlyout('plugins')
              }}
            >
              🔌
            </button>
          ) : null}

          {/* 弹性间距，把用户头像顶到底部 */}
          <div style={{ flex: 1 }} />

          {/* 用户头像按钮（底部，与 VS Code 账号图标位置对齐） */}
          <div style={{ position: 'relative' }} ref={userMenuRef}>
            <button
              type="button"
              className="iconRailUserBtn"
              title={me?.email || '未登录'}
              aria-label="用户菜单"
              onClick={() => {
                setWsNavFlyout(null)
                setUserMenuOpen((v) => !v)
              }}
            >
              <span className="iconRailUserAvatar">{(meLabel || 'U').slice(0, 1).toUpperCase()}</span>
              {isPro ? <span className="iconRailUserDot iconRailUserDotOnline" /> : <span className="iconRailUserDot" />}
            </button>

            {/* 用户菜单：fixed 定位到图标轨道右侧 */}
            {userMenuOpen
              ? renderUserMenuRail({ style: { position: 'fixed', left: 54, bottom: 12, top: 'auto', zIndex: 260 } })
              : null}
          </div>

          {/* Flyout overlay + panel */}
          {wsNavFlyout ? (
            <>
              <div
                className="wsNavFlyoutOverlay"
                aria-hidden="true"
                onClick={() => {
                  __dbgPost({
                    hypothesisId: 'flyoutAutoClose',
                    location: 'App.tsx:wsNavFlyoutOverlay',
                    message: 'overlay click -> close flyout',
                    data: { mode, wsNavFlyout: wsNavFlyout || null },
                  })
                  setWsNavFlyout(null)
                }}
              />
              <div className="wsNavFlyout" role="dialog" aria-label={wsNavFlyout === 'chat' ? 'AI 聊天' : wsNavFlyout === 'assets' ? '资产管理' : '插件'}>
                <div className="wsNavFlyoutHeader">
                  <span className="wsNavFlyoutTitle">
                    {wsNavFlyout === 'chat' ? 'AI 聊天' : wsNavFlyout === 'assets' ? '资产管理' : '插件'}
                  </span>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      __dbgPost({
                        hypothesisId: 'flyoutAutoClose',
                        location: 'App.tsx:wsNavFlyoutHeader',
                        message: 'header collapse click -> close flyout',
                        data: { mode, wsNavFlyout: wsNavFlyout || null },
                      })
                      setWsNavFlyout(null)
                    }}
                    aria-label="折叠"
                    title="折叠"
                  >
                    {'>>>'}
                  </button>
                </div>
                <div className="wsNavFlyoutBody">
                  {wsNavFlyout === 'chat' ? (
                    <div className="sidebarBody">
                      <div className="sessionList">
                        {visibleSessions.map((s) => {
                          const active = s.id === activeId
                          const last = s.messages[s.messages.length - 1]
                          return (
                            <div key={s.id} className={active ? 'sessionRow sessionRowActive' : 'sessionRow'}>
                              <button
                                className={active ? 'sessionItem sessionItemActive sessionMainBtn' : 'sessionItem sessionMainBtn'}
                                type="button"
                                onClick={() => {
                                  __dbgPost({
                                    hypothesisId: 'flyoutAutoClose',
                                    location: 'App.tsx:wsNavFlyout.chatSessionClick',
                                    message: 'select session (keep flyout open)',
                                    data: { mode, wsNavFlyout: wsNavFlyout || null, sessionId: String(s.id || '') },
                                  })
                                  setActiveId(s.id)
                                }}
                              >
                                <div className="sessionTitle">{s.title || I18N.untitled}</div>
                                <div className="sessionMeta">
                                  {last ? `${formatTime(last.ts)} · ${last.role}` : I18N.noMessages}
                                </div>
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : wsNavFlyout === 'assets' ? (
                    <div className="sidebarBodyAssets" style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                      <HostSidebar
                        state={hostCfg}
                        onStateChange={setHostCfg}
                        disableDemoSeed={Boolean(me?.email)}
                        onSelectAsset={(id) => {
                          __dbgPost({
                            hypothesisId: 'flyoutAutoClose',
                            location: 'App.tsx:HostSidebar.onSelectAsset',
                            message: 'select asset',
                            data: { mode, wsNavFlyout: wsNavFlyout || null, id: String(id || '') },
                          })
                          setSelectedBigDataId(null)
                          setHostCfg((prev) => ({ ...prev, activeHostId: id, activeWorkspaceId: null }))
                          if (mode === 'workspace') {
                            const hid = (String(id || '').trim() as any) || null
                            if (hid) {
                              setActiveConn({
                                hostId: hid,
                                sessionId: null,
                                rootPath: '/root',
                                path: '/root',
                                openFile: null,
                                expired: false,
                                lastError: '尚未连接：请在右侧点击"连接"，或先在左侧选择主机。',
                              })
                            }
                          }
                        }}
                        onRequestConfirm={(opts) => setConfirmDialog(opts)}
                        onConnectAsset={(assetId) => {
                          __dbgPost({
                            hypothesisId: 'flyoutAutoClose',
                            location: 'App.tsx:HostSidebar.onConnectAsset',
                            message: 'connect click',
                            data: { mode, wsNavFlyout: wsNavFlyout || null, assetId: String(assetId || '') },
                          })
                          openConnectModal(assetId)
                        }}
                        onDeleteAsset={(assetId) => {
                          const h = hostById(assetId)
                          if (h) deleteHost(h)
                        }}
                        onNewHost={() => openNewHostModal()}
                        onImport={() => openImport()}
                        onToast={(msg) => setToast({ id: uid('t'), message: msg })}
                        onSelectBigData={(id) => {
                          const bdId = String(id || '').trim()
                          if (!bdId) return
                          setSelectedBigDataId(bdId)
                          nav('/app/assets')
                        }}
                        onEditAsset={(id) => {
                          __dbgPost({
                            hypothesisId: 'flyoutAutoClose',
                            location: 'App.tsx:HostSidebar.onEditAsset',
                            message: 'edit click',
                            data: { mode, wsNavFlyout: wsNavFlyout || null, id: String(id || '') },
                          })
                          if (id) {
                            const h = hostCfg.assets.find((a) => a.id === id) ?? null
                            if (h) {
                              setEditingHostId(h.id)
                              setHostModalOpen(true)
                            }
                          } else {
                            openNewHostModal()
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <div className="sidebarBody">
                      <div className="sideList">
                        <div className="sideTitleRow">
                          <div className="sideSectionTitle">{I18N.pluginsTitle}</div>
                        </div>
                        <div className="sideEmpty" style={{ marginTop: 12 }}>插件功能即将推出</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </aside>
      ) : (
        /* ── Normal sidebar (non-workspace mode) ── */
      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebarHeader">
          <div className="brand">
            <div className="brandTitle">{'CodeSprite'}</div>
            <div className="brandSub">{'AI \u5de5\u4f5c\u53f0'}</div>
            {/* Hide "当前空间" switcher: not relevant to end users in current product stage */}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="mobileSidebarCloseBtn"
              type="button"
              onClick={() => setMobileSidebarOpen(false)}
              aria-label="关闭侧边栏"
              title="关闭"
            >
              ✕
            </button>
            <button
              ref={createBtnRef}
              data-create-btn
              className="newChatBtn"
              onClick={onPrimaryAction}
              title={'\u65b0\u5efa\u2026'}
              aria-label={'\u65b0\u5efa\u2026'}
              type="button"
            >
            +
          </button>
          </div>
        </div>

        <div className="sidebarTabs" role="tablist" aria-label="Primary navigation">
          {DASHBOARD_ENABLED ? (
          <button
            className={mode === 'dashboard' ? 'tabBtn tabBtnActive' : 'tabBtn'}
            onClick={() => setMode('dashboard')}
            type="button"
          >
            {I18N.navDashboard}
          </button>
          ) : null}
          <button
            className={mode === 'chat' ? 'tabBtn tabBtnActive' : 'tabBtn'}
            onClick={() => setMode('chat')}
            type="button"
          >
            {I18N.navChat}
          </button>
          <button
            className={mode === 'ssh' ? 'tabBtn tabBtnActive' : 'tabBtn'}
              onClick={() => {
              if (me?.email) {
                setMode('workspace')
                return
              }
                setMode(activeConn ? 'workspace' : 'ssh')
              }}
            type="button"
          >
            {I18N.navSsh}
          </button>
          {PLUGINS_ENABLED ? (
            <button
              className={mode === 'plugins' ? 'tabBtn tabBtnActive' : 'tabBtn'}
              onClick={() => setMode('plugins')}
              type="button"
            >
              {I18N.navPlugins}
            </button>
          ) : null}
        </div>

        <div className={mode === 'ssh' ? 'sidebarBody sidebarBodyAssets' : 'sidebarBody'}>
          {mode === 'chat' ? (
            <div className="sessionList">
              {visibleSessions.map((s) => {
                const active = s.id === activeId
                const last = s.messages[s.messages.length - 1]
                const lastKind = (last as any)?.kind ? String((last as any).kind) : 'chat'
                const lastLabel = last ? (lastKind === 'tool_result' ? 'tool' : last.role) : ''
                return (
                  <div key={s.id} className={active ? 'sessionRow sessionRowActive' : 'sessionRow'}>
                    <button
                      className={active ? 'sessionItem sessionItemActive sessionMainBtn' : 'sessionItem sessionMainBtn'}
                      onClick={() => setActiveId(s.id)}
                      type="button"
                    >
                      <div className="sessionTitle">{s.title || I18N.untitled}</div>
                      <div className="sessionMeta">
                        {last ? `${formatTime(last.ts)} \u00b7 ${lastLabel}` : I18N.noMessages}
                      </div>
                    </button>

                    <div className="sessionActions" data-session-menu>
                      <button
                        className="sessionKebabBtn"
                        type="button"
                        title={I18N.more}
                        onClick={(e) => {
                          e.stopPropagation()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setOpenMenuForId((prev) => {
                            const nextId = prev === s.id ? null : s.id
                            if (!nextId) {
                              setMenuPos(null)
                              return null
                            }
                            const menuW = 180
                            const menuH = 96
                            const left = Math.min(window.innerWidth - menuW - 8, Math.max(8, rect.right - menuW))
                            const top = Math.min(window.innerHeight - menuH - 8, Math.max(8, rect.bottom + 6))
                            setMenuPos({ id: s.id, top, left })
                            return nextId
                          })
                        }}
                      >
                        {String.fromCharCode(0x22ef)}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : mode === 'ssh' ? (
            <HostSidebar
              state={hostCfg}
              onStateChange={setHostCfg}
              disableDemoSeed={Boolean(me?.email)}
              onSelectAsset={(id) => {
                setSelectedBigDataId(null)
                setHostCfg((prev) => ({ ...prev, activeHostId: id, activeWorkspaceId: null }))
                if (opsPath) {
                  // Don't change mode here, just navigate back to /app where the current mode is valid
                  nav('/app')
                }
              }}
              onRequestConfirm={(opts) => setConfirmDialog(opts)}
              onConnectAsset={(assetId) => {
                openConnectModal(assetId)
              }}
              onDeleteAsset={(assetId) => {
                const h = hostById(assetId)
                if (h) deleteHost(h)
              }}
              onNewHost={() => openNewHostModal()}
              onImport={() => openImport()}
              onToast={(msg) => setToast({ id: uid('t'), message: msg })}
              onSelectBigData={(id) => {
                const bdId = String(id || '').trim()
                if (!bdId) return
                setSelectedBigDataId(bdId)
                nav('/app/assets')
              }}
              onEditAsset={(id) => {
                if (id) {
                  const h = hostCfg.assets.find((a) => a.id === id) ?? null
                  if (h) {
                    setEditingHostId(h.id)
                    setHostModalOpen(true)
                  }
                } else {
                  // create new
                  openNewHostModal()
                }
              }}
            />
          ) : (
            <div className="sideList">
              <div className="sideTitleRow">
              <div className="sideSectionTitle">{I18N.pluginsTitle}</div>
              </div>

              <div className="sideGroupLabel">{I18N.pluginsUpdates}</div>
              {updatePlugins.length === 0 ? (
                <div className="sideEmpty">{I18N.pluginsNoUpdates}</div>
              ) : (
                updatePlugins.map((p) => (
                  <button key={p.id} className="sideItem" type="button">
                    <div className="sideItemTitle">{p.name}</div>
                    <div className="sideItemMeta">{p.desc || ''}</div>
                  </button>
                ))
              )}

              <div className="sideGroupLabel">{I18N.pluginsInstalled}</div>
              {installedPlugins.map((p) => (
                <button key={p.id} className="sideItem" type="button">
                  <div className="sideItemTitle">{p.name}</div>
                  <div className="sideItemMeta">{p.desc || ''}</div>
                </button>
              ))}

              <div className="sideGroupLabel">{I18N.pluginsMarket}</div>
              {marketPlugins.map((p) => (
                <button key={p.id} className="sideItem" type="button">
                  <div className="sideItemTitle">{p.name}</div>
                  <div className="sideItemMeta">{p.desc || ''}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="sidebarFooter">
          {showSidebarCollapseControls ? (
            <button
              className="miniBtn sidebarCollapseBtn"
              type="button"
              onClick={() => setSidebarCollapsed(true)}
              aria-label="收起侧边栏"
              title="收起侧边栏"
            >
              « 收起侧栏
            </button>
          ) : null}
          <div className="userCardWrap" ref={userMenuRef}>
              <button
                className="userCard"
                type="button"
                onClick={() => setUserMenuOpen((v) => !v)}
                title={me?.email || ''}
              >
                <div className="userAvatar">{(meLabel || 'U').slice(0, 1).toUpperCase()}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="userName">{meLabel || '未登录'}</div>
                  <div className="userMeta">{isPro ? '🟢 在线' : 'Free 计划'}</div>
                </div>
              </button>
              {userMenuOpen ? renderUserMenu() : null}
          </div>
        </div>
      </aside>
      )}

      {/* Resizer / expand-button — always a grid child so column layout stays stable */}
      {mode !== 'workspace' ? (
        sidebarCollapseActive ? (
          <button
            type="button"
            className="sidebarExpandBtn"
            onClick={() => setSidebarCollapsed(false)}
            aria-label="展开侧边栏"
            title="展开侧边栏"
          >
            »
          </button>
        ) : (
          <div
            className="resizer"
            role="separator"
            aria-orientation="vertical"
            title="\u62d6\u62fd\u8c03\u6574\u5bbd\u5ea6"
            onMouseDown={(e) => beginResize(e.clientX)}
            onDoubleClick={() => setSidebarW(280)}
          />
        )
      ) : null}

      <main className="main">
        <button
          type="button"
          className="mobileSidebarOpenBtn"
          onClick={() => setMobileSidebarOpen(true)}
          aria-label="打开侧边栏"
          title="菜单"
        >
          ☰
        </button>
        {mode === 'dashboard' ? (
          <div className="dash">
            <div className="dashTopbar">
              <div>
                <div className="dashTitle">
                  <button
                    type="button"
                    className="dashCrumbBtn"
                    onClick={() => {
                      // Spec §3.1: clicking "控制台" resets within page
                      setDashTab('recent')
                      setDashDrawer({ open: false })
                      setDashHostSearch('')
                      setDashHighlight(null)
                      // scroll to top
                      window.setTimeout(() => {
                        const el = dashGridRef.current
                        if (el) el.scrollTop = 0
                      }, 0)
                    }}
                    title="回到概览顶部"
                  >
                    控制台
                  </button>
                  <span style={{ opacity: 0.7, margin: '0 6px' }}>&gt;</span>
                  <span style={{ opacity: 0.95 }}>概览</span>
                </div>
                <div className="dashSub">资产、工作区与快捷入口</div>
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  className="dashFsBtn"
                  type="button"
                  onClick={() => setDashFullscreen((v) => !v)}
                  title={dashFullscreen ? '退出全屏' : '全屏模式'}
                >
                  {dashFullscreen ? '退出全屏' : '全屏模式'}
                </button>
              </div>
            </div>

            <div className="dashGrid" ref={dashGridRef}>
              {/* B. Dynamic overview */}
              <div className="dashCard">
                <div className="dashCardHeader">
                  <div className="dashCardTitle">智能概览</div>
                </div>
                {dashHostCount === 0 ? (
                  <div className="dashGuide">
                    <div className="dashGuideTitle">🚀 欢迎使用 CodeSprite，只需 3 步即可起飞</div>
                    <div className="dashGuideStep dashGuideStepHot">
                      <div className="dashGuideStepTitle">
                        <span>1) 添加第一台主机</span>
                        <button className="dashGuideBtn" type="button" onClick={openNewHostModal}>
                          去添加
                        </button>
                      </div>
                      <div className="dashGuideStepDesc">连接你的开发机/服务器，支持 SSH/Local</div>
                    </div>
                    <div className="dashGuideStep dashGuideStepLocked">
                      <div className="dashGuideStepTitle">
                        <span>2) 创建工作区</span>
                        <span className="dashGuideLock">待解锁</span>
                      </div>
                      <div className="dashGuideStepDesc">为项目配置独立的上下文与环境</div>
                    </div>
                    <div className="dashGuideStep dashGuideStepLocked">
                      <div className="dashGuideStepTitle">
                        <span>3) 开启 AI 对话</span>
                        <span className="dashGuideLock">待解锁</span>
                      </div>
                      <div className="dashGuideStepDesc">享受代码解释、补全与重构能力</div>
                    </div>
                  </div>
                ) : (
                  <div className="statGrid">
                    <button className="statItem statItemClickable" type="button" onClick={() => setMode(activeConn ? 'workspace' : 'ssh')}>
                      <div className="statNum">{dashHostCount}</div>
                      <div className="statLabel">资产主机</div>
                      <div className="statHint">[ + ]</div>
                    </button>
                    <button className="statItem statItemClickable" type="button" onClick={() => setMode(activeConn ? 'workspace' : 'ssh')}>
                      <div className="statNum">{dashWorkspaceCount}</div>
                      <div className="statLabel">活跃工作区</div>
                      <div className="statHint">[ + ]</div>
                    </button>
                    {PLUGINS_ENABLED ? (
                      <button className="statItem statItemClickable" type="button" onClick={() => setMode('plugins')}>
                        <div className="statNum">{plugins.filter((p) => p.installed).length}</div>
                        <div className="statLabel">已装插件</div>
                        <div className="statHint">[ 管理 ]</div>
                      </button>
                    ) : null}
                    <div className="statItem">
                      <div className="statNum">—</div>
                      <div className="statLabel">本月对话</div>
                      <div className="statHint">[ ↗ 12% ]</div>
                    </div>
                  </div>
                )}
              </div>

              {/* C. Quick actions */}
              <div className="dashCard">
                <div className="dashCardHeader">
                  <div className="dashCardTitle">快捷操作</div>
                </div>
                <div className="quickGrid">
                  <button className="quickCard quickCardPrimary" type="button" onClick={openNewHostModal}>
                    <div className="quickIcon quickIconPrimary">+</div>
                    <div className="quickTitle">+ 新建主机</div>
                    <div className="quickDesc">弹窗添加资产，不跳转页面</div>
                  </button>
                  <button className="quickCard" type="button" onClick={() => setImportOpen(true)}>
                    <div className="quickIcon">📂</div>
                    <div className="quickTitle">导入资产</div>
                    <div className="quickDesc">批量导入主机/分组/标签</div>
                  </button>
                  {PLUGINS_ENABLED ? (
                    <button className="quickCard" type="button" onClick={() => setMode('plugins')}>
                      <div className="quickIcon">🧩</div>
                      <div className="quickTitle">安装插件</div>
                      <div className="quickDesc">增强终端与运维能力</div>
                    </button>
                  ) : null}
                  <button className="quickCard" type="button" onClick={() => setMode('chat')}>
                    <div className="quickIcon">💬</div>
                    <div className="quickTitle">发起对话</div>
                    <div className="quickDesc">进入聊天，开始提问</div>
                  </button>
                </div>
              </div>

              {/* D. Recent & inventory tabs */}
              <div className="dashCard dashCardSpan2">
                <div className="dashCardHeader" style={{ gap: 12, flexWrap: 'wrap' }}>
                  <div className="dashCardTitle">最近访问 & 资源清单</div>
                  <div className="dashTabs" role="tablist" aria-label="Dashboard tabs">
                    <button
                      className={dashTab === 'recent' ? 'dashTabBtn dashTabBtnActive' : 'dashTabBtn'}
                      type="button"
                      onClick={() => setDashTab('recent')}
                    >
                      最近访问
                    </button>
                    <button
                      className={dashTab === 'hosts' ? 'dashTabBtn dashTabBtnActive' : 'dashTabBtn'}
                      type="button"
                      onClick={() => setDashTab('hosts')}
                    >
                      我的主机
                    </button>
                    <button
                      className={dashTab === 'workspaces' ? 'dashTabBtn dashTabBtnActive' : 'dashTabBtn'}
                      type="button"
                      onClick={() => setDashTab('workspaces')}
                    >
                      活跃工作区
                    </button>
                  </div>
                </div>

                {dashTab === 'hosts' ? (
                  <div className="dashSearchRow">
                    <input
                      className="fieldInput"
                      value={dashHostSearch}
                      onChange={(e) => setDashHostSearch(e.target.value)}
                      placeholder="搜索主机名/IP/用户/标签/分组…"
                    />
                    <button className="btn btnPrimary" type="button" onClick={openNewHostModal}>
                      + 新建主机
                    </button>
                  </div>
                ) : null}

                <div className="dashList">
                  {dashTab === 'recent' ? (
                    dashRecentMixed.length === 0 ? (
                      <div className="recentEmpty">暂无最近访问。你可以先“新建主机”，再打开“⚡ 终端”或“📂 文件”。</div>
                    ) : (
                      dashRecentMixed.map((it) => {
                        if (it.kind === 'ws') {
                          const ws = it.ws as any
                          const host = it.host
                          const probe = host ? dashHostProbe[host.id] : null
                          const dot = probe?.state === 'ok' ? 'dashDot dashDotOk' : probe?.state === 'bad' ? 'dashDot dashDotBad' : 'dashDot'
                          return (
                            <div
                              key={`ws_${ws.id}`}
                              className="dashRow"
                              role="button"
                              tabIndex={0}
                              onClick={() => {
                                setHostCfg((prev) => ({ ...prev, activeWorkspaceId: ws.id, activeHostId: ws.assetId }))
                                setMode('ssh')
                              }}
                            >
                              <div className="dashRowLeft">
                                <span className={dot} aria-hidden="true" />
                                <div className="dashRowIcon">📂</div>
                                <div className="dashRowText">
                                  <div className="dashRowTitle">{ws.name}</div>
                                  <div className="dashRowMeta">
                                    {host ? `工作区 · ${host.name} · ${host.address}:${host.port}` : '工作区'}
                                    {ws.lastOpenedAt ? ` · ${formatTime(ws.lastOpenedAt)}` : ''}
                                  </div>
                                </div>
                              </div>
                              <div className="dashRowActions">
                                <button
                                  className="miniBtn"
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    setMode('ssh')
                                  }}
                                >
                                  打开
                                </button>
                                <button
                                  className="miniBtn"
                                  type="button"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    setWorkspaceEditErr('')
                                    setWorkspaceEditDraft({ id: ws.id, name: ws.name, rootPath: ws.rootPath })
                                    setWorkspaceEditOpen(true)
                                  }}
                                >
                                  配置
                                </button>
                              </div>
                            </div>
                          )
                        }
                        const h = it.host
                        const probe = dashHostProbe[h.id]
                        const dot = probe?.state === 'ok' ? 'dashDot dashDotOk' : probe?.state === 'bad' ? 'dashDot dashDotBad' : 'dashDot'
                        return (
                          <div
                            key={`h_${h.id}`}
                            className="dashRow"
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              openConnectModal(h.id)
                            }}
                          >
                            <div className="dashRowLeft">
                              <span className={dot} aria-hidden="true" />
                              <div className="dashRowIcon">🖥️</div>
                              <div className="dashRowText">
                                <div className="dashRowTitle">{h.name}</div>
                                <div className="dashRowMeta">{`${h.user ? h.user + '@' : ''}${h.address}:${h.port}`}</div>
                              </div>
                            </div>
                            <div className="dashRowActions">
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  openConnectModal(h.id)
                                }}
                              >
                                🔌 连接
                              </button>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  openConnectModal(h.id)
                                }}
                              >
                                📂 文件
                              </button>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  setEditingHostId(h.id)
                                  setHostModalOpen(true)
                                }}
                              >
                                ⚙️
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )
                  ) : dashTab === 'hosts' ? (
                    dashHostsFiltered.length === 0 ? (
                      <div className="recentEmpty">暂无主机。点击右侧“+ 新建主机”。</div>
                    ) : (
                      dashHostsFiltered.map((h) => {
                        const probe = dashHostProbe[h.id]
                        const dot = probe?.state === 'ok' ? 'dashDot dashDotOk' : probe?.state === 'bad' ? 'dashDot dashDotBad' : 'dashDot'
                        const groupName = h.groupId ? groupById.get(h.groupId)?.name ?? '' : ''
                        const tagsText = (h.tagIds || []).map((id) => tagById.get(id)?.name ?? '').filter(Boolean)
                        return (
                          <div
                            key={h.id}
                            className="dashRow"
                            role="button"
                            tabIndex={0}
                            onClick={() => openConnectModal(h.id)}
                          >
                            <div className="dashRowLeft">
                              <span className={dot} aria-hidden="true" />
                              <div className="dashRowIcon">🖥️</div>
                              <div className="dashRowText">
                                <div className="dashRowTitle">
                                  {h.name}
                                  {tagsText.length ? (
                                    <span className="dashRowTags">{tagsText.slice(0, 3).map((t) => `#${t}`).join(' ')}</span>
                                  ) : null}
                                </div>
                                <div className="dashRowMeta">
                                  {`${h.user ? h.user + '@' : ''}${h.address}:${h.port}`}
                                  {groupName ? ` · ${groupName}` : ''}
                                  {typeof h.lastConnectedAt === 'number' ? ` · 上次连接 ${formatTime(h.lastConnectedAt)}` : ''}
                                </div>
                              </div>
                            </div>
                            <div className="dashRowActions">
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  openConnectModal(h.id)
                                }}
                              >
                                🔌 连接
                              </button>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  openConnectModal(h.id)
                                }}
                              >
                                📂 文件
                              </button>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  setEditingHostId(h.id)
                                  setHostModalOpen(true)
                                }}
                              >
                                ⚙️
                              </button>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  deleteHost(h)
                                }}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                        )
                      })
                    )
                  ) : dashWorkspacesSorted.length === 0 ? (
                  <div className="recentEmpty">暂无工作区。你可以在主机上点击“⚡ 终端”开始操作（会自动生成默认工作区）。</div>
                  ) : (
                    dashWorkspacesSorted.slice(0, 30).map((w) => {
                      const host = hostCfg.hosts.find((h) => h.id === w.assetId) ?? null
                      const probe = host ? dashHostProbe[host.id] : null
                      const dot = probe?.state === 'ok' ? 'dashDot dashDotOk' : probe?.state === 'bad' ? 'dashDot dashDotBad' : 'dashDot'
                      return (
                        <div
                          key={w.id}
                          className="dashRow"
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setHostCfg((prev) => ({ ...prev, activeWorkspaceId: w.id, activeHostId: w.assetId }))
                            setMode('ssh')
                          }}
                        >
                          <div className="dashRowLeft">
                            <span className={dot} aria-hidden="true" />
                            <div className="dashRowIcon">📂</div>
                            <div className="dashRowText">
                              <div className="dashRowTitle">
                                {w.name}
                                {w.pinned ? <span className="dashRowTags">📌 置顶</span> : null}
                              </div>
                              <div className="dashRowMeta">
                                {host ? `资产：${host.name} · ${host.address}:${host.port}` : `assetId=${w.assetId}`}
                                {w.lastOpenedAt ? ` · 最近打开 ${formatTime(w.lastOpenedAt)}` : ''}
                              </div>
                            </div>
                          </div>
                          <div className="dashRowActions">
                            <button
                              className="miniBtn"
                              type="button"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                setMode('ssh')
                              }}
                            >
                              打开
                            </button>
                            <button
                              className="miniBtn"
                              type="button"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                const now = Date.now()
                                setHostCfg((prev) => ({
                                  ...prev,
                                  workspaces: prev.workspaces.map((x) => (x.id === w.id ? { ...x, pinned: !x.pinned, updatedAt: now } : x)),
                                }))
                              }}
                            >
                              {w.pinned ? '取消置顶' : '置顶'}
                            </button>
                            <button
                              className="miniBtn"
                              type="button"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                if (!window.confirm('确定删除该工作区吗？')) return
                                setHostCfg((prev) => ({ ...prev, workspaces: prev.workspaces.filter((x) => x.id !== w.id) }))
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : mode === 'chat' ? (
          <>
            <div className="topbar">
              <div className="topbarTitle">
                <p className="h1">{activeSession?.title ?? I18N.chat}</p>
                <p className="h2">{I18N.hintKeys}</p>
              </div>

              <button className="statusPill" type="button" title={I18N.proxyTip} onClick={openApiCfg}>
                <span className={dotClass} />
                <span>{statusText}</span>
              </button>
            </div>

            <div style={{ minHeight: 0, flex: 1, display: 'grid', gridTemplateRows: `minmax(0, 1fr) 10px ${chatBottomH}px` }}>
            <div className="messages" ref={listRef}>
              {activeSession?.messages.map((m) => (
                <div key={m.id} className={m.role === 'user' ? 'msgRow msgUser' : 'msgRow msgAssistant'}>
                    <div className={m.role === 'user' ? 'bubble bubbleUser' : 'bubble bubbleAssistant'}>
                      {(() => {
                        if (m.role !== 'assistant') return <div>{m.content}</div>
                        const stripped = stripToolBlocksForDisplay(m.content)
                        return (
                          <div>
                            <div>{stripped.text || (m.streaming ? '…' : '')}</div>
                          </div>
                        )
                      })()}
                      {m.images?.length ? (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                          {m.images.map((im) => (
                            <img
                              key={im.id}
                              src={im.dataUrl}
                              alt={im.name}
                              style={{
                                width: 120,
                                height: 90,
                                objectFit: 'cover',
                                borderRadius: 12,
                                border: '1px solid #e2e8f0',
                              }}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                </div>
              ))}
            </div>

              <div
                role="separator"
                aria-orientation="horizontal"
                onMouseDown={(e) => {
                  e.preventDefault()
                  chatVDragRef.current = { startY: e.clientY, startH: chatBottomH, target: 'chat' }
                  document.body.style.cursor = 'row-resize'
                  document.body.style.userSelect = 'none'
                }}
                style={{
                  height: 10,
                  cursor: 'row-resize',
                  background:
                    'linear-gradient(to bottom, transparent 0, transparent 4px, rgba(255,255,255,0.18) 4px, rgba(255,255,255,0.18) 5px, transparent 5px, transparent 100%)',
                }}
                title="拖拽调整消息区/输入区高度"
              />

              <div className="composerWrap" style={{ borderTop: 'none', height: '100%', overflow: 'visible' }}>
              <div className="composer">
                  {/* Workspace: keep input clean; context is represented via @path in the textarea + top-right "清空上下文". */}
                  <div className="composerInput" style={{ position: 'relative' }}>
                    {pendingImages.length ? (
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                        {pendingImages.map((im) => (
                          <div
                            key={im.id}
                            style={{
                              border: '1px solid #e2e8f0',
                              borderRadius: 12,
                              padding: 6,
                              background: '#ffffff',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            <img src={im.dataUrl} alt={im.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10 }} />
                            <button
                              type="button"
                              className="btn"
                              style={{ padding: '6px 10px', borderRadius: 10 }}
                              onClick={() => setPendingImages((prev) => prev.filter((x) => x.id !== im.id))}
                              title="移除截图"
                            >
                              移除
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  <textarea
                    className="textarea"
                    placeholder={I18N.inputPlaceholder}
                    value={input}
                      onChange={(e) => {
                        const v = e.target.value
                        setInput(v)
                        // Chat mode: do not enable @ mention (no workspace file list).
                        setMentionOpen(false)
                        setMentionQuery('')
                        setMentionActiveIdx(0)
                      }}
                    onKeyDown={onKeyDown}
                      onPaste={onChatPaste}
                    ref={inputRef}
                  />
                  <button
                    className={sending ? 'actionBtn actionBtnStop' : 'actionBtn actionBtnSend'}
                    type="button"
                    onClick={sending ? stopGeneration : () => void send()}
                    title={sending ? I18N.stopTitle : I18N.send}
                      disabled={!sending && !input.trim() && pendingImages.length === 0}
                  >
                    {sending ? I18N.stop : I18N.send}
                  </button>
                </div>

                <select
                  className="modelSelect"
                  value={modelSelectValue}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={modelsLoading || models.length === 0}
                    title={modelsLoading ? I18N.modelLoading : models.length === 0 ? I18N.modelUnavailable : I18N.modelLabel}
                >
                    {(modelsLoading ? [I18N.modelLoading] : models.length === 0 ? [I18N.modelUnavailable] : models).map((name) => (
                      <option key={name} value={modelsLoading || models.length === 0 ? '' : name}>
                        {name}
                      </option>
                    ))}
                </select>
              </div>

              <div className="hint">{I18N.hintFooter}</div>
              </div>
            </div>
          </>
        ) : mode === 'workspace' && !opsPath ? (
          <div className="workArea" style={{ gridRow: '1 / -1' }}>
            <div className="workHeader" ref={wsHeaderRef}>
              <div className="workHeaderRow">
                <div className="workHeaderLeft">
                  <div className="workHeaderTitleRow">
                    <p className="h1" style={{ margin: 0 }}>
                      {'工作区'}
                    </p>
                    <div className="workHeaderCrumb">
                      {activeConn ? `${hostById(activeConn.hostId)?.name || ''}` : '未连接主机'}
                    </div>
                  </div>
                  <div className="workHeaderSub">
                    {activeConn?.sessionId
                      ? `当前目录：${(activeConn.path || '.').trim() || '.'}`
                      : activeConn?.expired
                        ? '连接已断开：点击右侧“重连”继续使用工作区。'
                        : activeConn
                          ? '尚未连接：请点击右侧“连接”进入工作区。'
                          : '请先连接主机后再使用工作区（文件/终端/AI 执行）'}
                  </div>
                </div>

                <div className="workHeaderActions">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => openRulesModal('user')}
                    title="像 Cursor 的 User Rules：对你所有项目生效"
                  >
                    用户规则
                  </button>

                  <select
                    className="modelSelect modelSelectCompact"
                    value={aiUiMode}
                    onChange={(e) => {
                      const next = e.target.value as AiUiMode
                      persistAiUiMode(next)
                      const msg =
                        next === 'ask'
                          ? '已切换：Ask（只读）— 不执行命令'
                          : next === 'plan'
                            ? '已切换：Plan（规划）— 不执行命令'
                            : next === 'agent'
                              ? '已切换：Agent（执行）— 允许 exec'
                              : '已切换：Debug（执行+回溯）— 允许 exec'
                      setToast({ id: uid('t'), message: msg })
                    }}
                    title="AI 行为模式：Ask/Plan 禁止执行；Agent/Debug 允许 exec（PTY 需单独进入 Shell）"
                    disabled={!activeConn?.sessionId}
                  >
                    <option value="ask">Ask（只读）</option>
                    <option value="plan">Plan（规划）</option>
                    <option value="agent">Agent（执行）</option>
                    <option value="debug">Debug（执行+回溯）</option>
                  </select>

                  <select
                    className="modelSelect modelSelectCompact"
                    value={modelSelectValue}
                    onChange={(e) => setSelectedModel(e.target.value)}
                    disabled={!activeConn?.sessionId || modelsLoading || models.length === 0}
                    title={modelsLoading ? I18N.modelLoading : models.length === 0 ? I18N.modelUnavailable : I18N.modelLabel}
                  >
                    {(modelsLoading ? [I18N.modelLoading] : models.length === 0 ? [I18N.modelUnavailable] : models).map((name) => (
                      <option key={name} value={modelsLoading || models.length === 0 ? '' : name}>
                        {name}
                      </option>
                    ))}
                  </select>

                  <button
                    className="btn"
                    type="button"
                    disabled={sysProbeBusy || !activeConn?.sessionId || (aiUiMode !== 'agent' && aiUiMode !== 'debug')}
                    onClick={() => void runSystemStatusProbe()}
                    title={
                      !activeConn?.sessionId
                        ? '请先连接/重新连接工作区'
                        : aiUiMode !== 'agent' && aiUiMode !== 'debug'
                          ? 'Ask/Plan 禁止执行命令'
                          : '执行 uptime/df 等只读命令'
                    }
                  >
                    {sysProbeBusy ? '系统状态获取中…' : '系统状态'}
                  </button>

                  <button
                    className="btn"
                    type="button"
                    onClick={() => setWsToolsOpen((p) => !p)}
                    title={wsToolsOpen ? '关闭文件/终端抽屉' : '打开文件/终端抽屉（文件列表/编辑器/终端）'}
                  >
                    文件/终端
                  </button>

                  <button
                    className="btn"
                    type="button"
                    data-ws-chat-menu-trigger
                    onClick={(e) => {
                      const el = e.currentTarget as HTMLButtonElement
                      const r = el.getBoundingClientRect()
                      setWsChatMenuPos(calcAnchoredMenuPos({ rect: r, approxW: 210, approxH: 160 }))
                      setWsChatMenuOpen((p) => !p)
                    }}
                    title="更多"
                  >
                    ⋯
                  </button>

                  {activeConn?.sessionId ? (
                    <>
                      <span className="workHeaderDivider" aria-hidden="true" />
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          void disconnectWorkspace(true)
                        }}
                      >
                        {'断开'}
                      </button>
                      <button
                        className="btn btnPrimary"
                        type="button"
                        disabled={remoteBusy}
                        onClick={() => {
                          void reconnectWorkspace()
                        }}
                        title="重新连接（切换 session）"
                      >
                        {'重连'}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

            </div>
            <div
              className="workBody"
              style={{
                padding: 12,
                overflow: 'hidden',
                minHeight: 0,
                display: 'grid',
                gridTemplateRows: 'auto minmax(0, 1fr)',
                gap: 10,
              }}
            >
              <div style={{ gridRow: '1 / 2', minHeight: 0 }}>
                {activeConn && !activeConn.sessionId ? (
                  <div
                    style={{
                      marginTop: 0,
                      display: 'flex',
                      gap: 12,
                      alignItems: 'flex-start',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ flex: '1 1 520px', minWidth: 260 }}>
                      <div className="workCardText" style={{ marginTop: 0, color: 'rgba(255,180,120,0.95)' }}>
                        {activeConn.expired
                          ? activeConn.lastError ||
                            '连接已断开，点击右侧“重连”继续使用工作区。'
                          : activeConn.lastError || '尚未连接。点击右侧“连接”后输入认证信息即可进入工作区。'}
                      </div>

                      {(() => {
                        const h = activeConn?.hostId ? hostById(activeConn.hostId) : null
                        if (!h) return null
                        const grp = h.groupId ? groupById.get(h.groupId)?.name ?? '未分组' : '未分组'
                        const tags = (h.tagIds || []).map((id) => tagById.get(id)?.name ?? '').filter(Boolean).slice(0, 10)
                        const metaHint = '连接信息已隐藏'
                        return (
                          <div
                            style={{
                              marginTop: 10,
                              borderRadius: 12,
                              border: '1px solid #e2e8f0',
                              background: '#ffffff',
                              padding: '10px 12px',
                            }}
                          >
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                              <div style={{ fontWeight: 900, letterSpacing: 0.2 }}>{h.name || h.address}</div>
                              <span className="badge">{grp}</span>
                              {(h.status || 'enabled') !== 'enabled' ? <span className="badge">{String(h.status)}</span> : null}
                              {typeof h.lastConnectedAt === 'number' ? <span className="badge">{`上次连接 ${formatTime(h.lastConnectedAt)}`}</span> : null}
                            </div>
                            <div style={{ marginTop: 6, opacity: 0.62, fontSize: 12 }}>{metaHint}</div>
                            {tags.length ? (
                              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {tags.map((t) => (
                                  <span key={t} className="badge">
                                    #{t}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                          </div>
                        )
                      })()}
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
                      {activeConn.expired ? (
                        <button className="btn btnPrimary" type="button" disabled={remoteBusy} onClick={() => void reconnectWorkspace()}>
                          重新连接
                        </button>
                      ) : (
                        <button
                          className="btn btnPrimary"
                          type="button"
                          disabled={remoteBusy || !activeConn.hostId}
                          onClick={() => {
                            if (!activeConn.hostId) return
                            openConnectModal(activeConn.hostId)
                          }}
                        >
                          连接
                        </button>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>

                    <div
                      style={{
                display: 'grid',
                // Tools (file/editor/terminal) on LEFT, AI chat on RIGHT.
                gridTemplateColumns: showPinnedTools ? `${wsLeftW}px 18px minmax(0, 1fr)` : 'minmax(0, 1fr)',
                gap: 0,
                padding: 0,
                height: '100%',
                overflow: 'hidden',
                        minHeight: 0,
                alignItems: 'stretch',
                gridRow: '2 / 3',
              }}
                      onMouseMove={(e) => {
                        // Cursor-like: allow dragging anywhere near the boundary (not only the exact handle).
                        try {
                          if (useDrawerTools || !showPinnedTools) return
                          const root = e.currentTarget as HTMLDivElement
                          const r = root.getBoundingClientRect()
                          const gutterW = 18
                          const leftEdge = r.left + wsLeftW
                          const rightEdge = leftEdge + gutterW
                          const x = e.clientX
                          const near = x >= leftEdge - 10 && x <= rightEdge + 10
                          root.style.cursor = near ? 'col-resize' : ''
                        } catch {
                          // ignore
                        }
                      }}
                      onMouseLeave={(e) => {
                        try {
                          ;(e.currentTarget as HTMLDivElement).style.cursor = ''
                        } catch {
                          // ignore
                        }
                      }}
                      onMouseDown={(e) => {
                        // Mouse fallback: start drag when clicking near the boundary, even if not on the handle element.
                        try {
                          if (useDrawerTools || !showPinnedTools) return
                          const root = e.currentTarget as HTMLDivElement
                          const r = root.getBoundingClientRect()
                          const gutterW = 18
                          const leftEdge = r.left + wsLeftW
                          const rightEdge = leftEdge + gutterW
                          const x = e.clientX
                          const near = x >= leftEdge - 10 && x <= rightEdge + 10
                          if (!near) return
                          e.preventDefault()
                          e.stopPropagation()
                          wsDragRef.current = { startX: e.clientX, startW: wsLeftW, startedAt: Date.now() }
                          wsDragElRef.current = null
                          wsDragLastXRef.current = e.clientX
                          document.body.style.cursor = 'col-resize'
                          document.body.style.userSelect = 'none'
                        } catch {
                          // ignore
                        }
                      }}
            >
              {useDrawerTools ? (
                <Drawer
                  open={wsToolsOpen}
                  title="文件/终端"
                  ariaLabel="工作区文件与终端"
                  width={'min(520px, calc(100vw - 48px))'}
                  onClose={() => setWsToolsOpen(false)}
                  hideClose
                  overlayClassName="ui-drawerOverlayNoRailCover"
                >
                  {renderWorkspaceToolsCard()}
                </Drawer>
              ) : showPinnedTools ? (
                <>
                  {/* Resize handle */}
                  <button
                    className="wsResizeHandle"
                    type="button"
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="拖拽调整文件/终端面板宽度"
                    title="拖拽调整文件/终端面板宽度"
                    style={{
                      gridColumn: '2 / 3',
                      cursor: 'col-resize',
                      touchAction: 'none',
                      position: 'relative',
                      zIndex: 50,
                      pointerEvents: 'auto',
                      width: '100%',
                      height: '100%',
                    }}
                      onPointerDown={(e) => {
                        try {
                          ;(e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId)
                        } catch {}
                        e.preventDefault()
                      wsDragRef.current = { startX: e.clientX, startW: wsLeftW, pointerId: e.pointerId, startedAt: Date.now() }
                      wsDragElRef.current = e.currentTarget as any
                      wsDragLastXRef.current = e.clientX
                      document.body.style.cursor = 'col-resize'
                        document.body.style.userSelect = 'none'
                      }}
                    onMouseDown={(e) => {
                      // Fallback: some environments deliver mouse events but flaky pointer events.
                      e.preventDefault()
                      e.stopPropagation()
                      wsDragRef.current = { startX: e.clientX, startW: wsLeftW, startedAt: Date.now() }
                      wsDragElRef.current = e.currentTarget as any
                      wsDragLastXRef.current = e.clientX
                      document.body.style.cursor = 'col-resize'
                      document.body.style.userSelect = 'none'
                    }}
                      onPointerUp={(e) => {
                        try {
                          ;(e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId)
                        } catch {}
                      wsDragForceStopRef.current?.()
                      }}
                      onPointerCancel={(e) => {
                        try {
                          ;(e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId)
                        } catch {}
                      wsDragForceStopRef.current?.()
                    }}
                  />

                  <div style={{ gridColumn: '1 / 2', minHeight: 0, minWidth: 0, height: '100%', overflow: 'hidden' }}>
                    {renderWorkspaceToolsCard({ style: { height: '100%' } })}
                    </div>
                </>
              ) : null}

              {/* Right: chat (reuse chat UI, but in workspace mode) */}
              <div
                className="wsChatPanel"
                style={{
                  minHeight: 0,
                  minWidth: 0,
                  gridColumn: showPinnedTools ? '3 / 4' : '1 / -1',
                }}
              >
                <div
                  className="wsChatPanelHeader"
                >
                  <div style={{ fontWeight: 800 }}>{'AI 聊天'}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      className="miniBtn"
                      onClick={() => {
                        // Safety: if the composer area was accidentally dragged/collapsed by browser quirks,
                        // always provide a visible recovery action.
                        setWsChatBottomH(160)
                        try {
                          localStorage.setItem(WS_CHAT_BOTTOM_H_KEY, '160')
                        } catch {
                          // ignore
                        }
                        setTimeout(() => inputRef.current?.focus(), 0)
                      }}
                      title="恢复输入框可见（重置输入框高度）"
                    >
                      显示输入框
                    </button>
                    <div className="wsChatHeaderMeta">{aiUiMode === 'ask' ? 'Ask' : aiUiMode === 'plan' ? 'Plan' : aiUiMode === 'agent' ? 'Agent' : 'Debug'}</div>
                  </div>
                </div>
                <div
                  className="wsChatGrid"
                  style={{
                    // Critical: use minmax(0, 1fr) so the message list can shrink and become scrollable
                    // instead of expanding and pushing the composer out of viewport.
                    // Small-screen safety: ensure composer row stays visible.
                    gridTemplateRows: `minmax(0, 1fr) 8px minmax(84px, auto)`,
                  }}
                >
                  <div className="messages" ref={listRef} style={{ minHeight: 0 }}>
                    {activeSession?.messages.map((m) => {
                      const kind: MessageKind = (m as any)?.kind ? ((m as any).kind as any) : 'chat'
                      const isTool = kind === 'tool_result'
                      const isUser = m.role === 'user' && !isTool
                      const rowCls = isUser ? 'msgRow msgUser' : isTool ? 'msgRow msgTool' : 'msgRow msgAssistant'
                      const bubbleCls = isUser ? 'bubble bubbleUser' : isTool ? 'bubble bubbleTool' : 'bubble bubbleAssistant'
                      return (
                        <div key={m.id} className={rowCls}>
                          <div className={bubbleCls}>
                            {isTool ? (
                              <div className="toolResult">
                                <div className="toolHeader">
                                  <div className="toolTitle">{m.title || '工具结果'}</div>
                                  <div className="toolMeta">
                                    {(Array.isArray(m.meta) ? m.meta : [])
                                      .map((x) => String(x || '').trim())
                                      .filter(Boolean)
                                      .slice(0, 8)
                                      .join(' · ')}
                                  </div>
                                </div>
                                <div className="toolBody">{m.content || ''}</div>
                              </div>
                            ) : m.role !== 'assistant' ? (
                              <div>{m.content}</div>
                            ) : (
                              (() => {
                                const stripped = stripToolBlocksForDisplay(m.content)
                                const pc = (m as any)?.pendingConfirm as PendingConfirm | undefined
                                const status: PendingConfirmStatus = pc?.status || 'pending'
                                const fmtItem = (it: PendingConfirmItem): { text: string; reason?: string } => {
                                  if (it.kind === 'command') return { text: `$ ${String(it.command || '').trim()}`, reason: it.reason }
                                  const tool = String((it as any)?.tool || '').trim()
                                  const args = (it as any)?.args || {}
                                  if (tool === 'ssh_exec') {
                                    const cmd = String(args?.command || '').trim()
                                    const cwd = String(args?.cwd || '').trim()
                                    return { text: `$ ${cmd}${cwd ? `  (cwd: ${cwd})` : ''}`, reason: it.reason }
                                  }
                                  if (tool === 'files_list') return { text: `列目录  ${String(args?.path || '').trim()}`, reason: it.reason }
                                  if (tool === 'files_read') return { text: `读文件  ${String(args?.path || '').trim()}`, reason: it.reason }
                                  if (tool === 'files_write') return { text: `写文件  ${String(args?.path || '').trim()}`, reason: it.reason }
                                  return { text: `${tool || 'tool'}  ${String(args?.path || '').trim()}`, reason: it.reason }
                                }
                                return (
                                  <div>
                                    <div>{stripped.text || (m.streaming ? '…' : '')}</div>
                                    {pc ? (
                                      <div
                                        className={[
                                          'inlineConfirmPanel',
                                          status === 'approved' ? 'approved' : '',
                                          status === 'rejected' ? 'rejected' : '',
                                        ]
                                          .filter(Boolean)
                                          .join(' ')}
                                      >
                                        {(() => {
                                          const items = Array.isArray(pc.items) ? pc.items : []
                                          const hardBlocked =
                                            items.some((it) => it.kind === 'command' && Boolean(isDangerousShellCommand(String(it.command || '').trim()))) ||
                                            items.some(
                                              (it) =>
                                                it.kind === 'tool' &&
                                                String((it as any)?.tool || '').trim() === 'ssh_exec' &&
                                                Boolean(isDangerousShellCommand(String(((it as any)?.args || {})?.command || '').trim())),
                                            )
                                          const hasWrite = items.some((it) => it.kind === 'tool' && String((it as any)?.tool || '').trim() === 'files_write')
                                          const hasRiskHint = items.some((it) => Boolean((it as any)?.reason))
                                          const hint = hardBlocked
                                            ? '该操作已被安全策略拦截，无法执行。'
                                            : hasWrite
                                              ? '将写入文件：请确认路径与内容无误。'
                                              : hasRiskHint
                                                ? '高风险操作：确认后才会执行。'
                                                : ''
                                          return hint ? <div className="confirmHint">{hint}</div> : null
                                        })()}
                                        <div className="confirmHeader">
                                          <div className="confirmHeaderLeft">
                                            <span className="confirmIcon">
                                              {(pc.items || []).some((x) => Boolean((x as any)?.reason)) ? '⚠️' : '•'}
                                            </span>
                                            <span className="confirmTitle">需要确认以下操作</span>
                                          </div>
                                          {(() => {
                                            const n = Array.isArray(pc.items) ? pc.items.length : 0
                                            if (n <= 1) return null
                                            const expanded = Boolean(inlineConfirmExpanded[m.id])
                                            return (
                                              <button
                                                type="button"
                                                className="miniBtn confirmMiniBtn"
                                                onClick={() => setInlineConfirmExpanded((prev) => ({ ...prev, [m.id]: !expanded }))}
                                                title={expanded ? '收起明细' : '展开明细'}
                                              >
                                                {expanded ? '收起' : `展开（${n}）`}
                                              </button>
                                            )
                                          })()}
                                        </div>
                                        <div className="confirmList">
                                          {(() => {
                                            const all = Array.isArray(pc.items) ? pc.items : []
                                            const expanded = Boolean(inlineConfirmExpanded[m.id])
                                            const shown = expanded ? all.slice(0, 8) : all.slice(0, 1)
                                            return shown.map((it, idx) => {
                                              const v = fmtItem(it)
                                              return (
                                                <div key={idx} className="confirmItem">
                                                  <span className="confirmBullet">•</span>
                                                  <span className="confirmCommand" title={v.text}>
                                                    {v.text}
                                                  </span>
                                                  {v.reason ? <span className="confirmReason">({v.reason})</span> : null}
                                                </div>
                                              )
                                            })
                                          })()}
                                        </div>
                                        {status === 'pending' ? (
                                          <div className="confirmActions">
                                            {(() => {
                                              const items = Array.isArray(pc.items) ? pc.items : []
                                              const hardBlocked =
                                                items.some((it) => it.kind === 'command' && Boolean(isDangerousShellCommand(String(it.command || '').trim()))) ||
                                                items.some(
                                                  (it) =>
                                                    it.kind === 'tool' &&
                                                    String((it as any)?.tool || '').trim() === 'ssh_exec' &&
                                                    Boolean(isDangerousShellCommand(String(((it as any)?.args || {})?.command || '').trim())),
                                                )
                                              if (hardBlocked) return null
                                              return (
                                                <>
                                                  <button
                                                    className="miniBtn btnPrimary confirmPrimaryBtn"
                                                    type="button"
                                                    onClick={() => handleConfirmAction(m.id, 'approve_once')}
                                                    disabled={status !== 'pending'}
                                                    title="仅执行一次，下次仍需确认"
                                                  >
                                                    允许一次
                                                  </button>
                                                  {pc.allowRemember ? (
                                                    <button
                                                      className="miniBtn btnPrimary confirmPrimaryBtn"
                                                      type="button"
                                                      onClick={() => handleConfirmAction(m.id, 'approve_remember')}
                                                      disabled={status !== 'pending'}
                                                      title="加入信任列表：下次遇到同类操作可自动执行"
                                                    >
                                                      总是允许
                                                    </button>
                                                  ) : null}
                                                </>
                                              )
                                            })()}
                                            <button
                                              className="miniBtn confirmSkipBtn"
                                              type="button"
                                              onClick={() => handleConfirmAction(m.id, 'reject')}
                                              disabled={status !== 'pending'}
                                              title="不执行该操作"
                                            >
                                              跳过
                                            </button>
                                          </div>
                                        ) : (
                                          <div style={{ fontSize: 12, opacity: 0.75 }}>
                                            {status === 'approved' ? '已确认，本次操作已提交执行。' : '已跳过，本次操作未执行。'}
                                          </div>
                                        )}
                                      </div>
                                    ) : null}
                                  </div>
                                )
                              })()
                            )}

                          {mode === 'workspace' && !isTool && m.role === 'assistant' && activeConn?.sessionId && (aiUiMode === 'agent' || aiUiMode === 'debug') ? (
                              (() => {
                                const cmds = extractRunnableShellCommands(m.content)
                                if (cmds.length === 0) return null
                                return (
                                  <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <button
                                      type="button"
                                      className="miniBtn"
                                      disabled={cmdRunBusyForMsg === m.id}
                                      onClick={() => {
                                        if (cmdRunBusyForMsg) return
                                        setCmdRunBusyForMsg(m.id)
                                        try {
                                          requestRunCommands(cmds, 'AI 代码块', m.id)
                                        } finally {
                                          setCmdRunBusyForMsg('')
                                        }
                                      }}
                                      title={cmdRunBusyForMsg === m.id ? '执行中…' : `一键执行代码块中的命令（${cmds.length} 条）`}
                                    >
                                      {cmdRunBusyForMsg === m.id ? '执行中…' : `运行命令（${cmds.length}）`}
                                    </button>
                                  </div>
                                )
                              })()
                            ) : null}
                            {m.images?.length ? (
                              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                                {m.images.map((im) => (
                                  <img
                                    key={im.id}
                                    src={im.dataUrl}
                                    alt={im.name}
                                    style={{
                                      width: 120,
                                      height: 90,
                                      objectFit: 'cover',
                                      borderRadius: 12,
                                      border: '1px solid #e2e8f0',
                                    }}
                                  />
                                ))}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  <div
                    role="separator"
                    aria-orientation="horizontal"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      chatVDragRef.current = { startY: e.clientY, startH: wsChatBottomH, target: 'workspace' }
                      document.body.style.cursor = 'row-resize'
                      document.body.style.userSelect = 'none'
                    }}
                    style={{
                      height: 10,
                      cursor: 'row-resize',
                    }}
                    className="wsChatVResizeHandle"
                    title="拖拽调整消息区/输入区高度"
                  />

                  <div className="composerWrap" style={{ borderTop: 'none', overflow: 'visible' }}>
                    <div className="composer">
                    {/* Workspace: keep input clean; context is represented via @path in the textarea + top-right "清空上下文". */}
                    <div className="composerInput" style={{ position: 'relative' }}>
                      {renderInlineCtxChips()}
                      {pendingImages.length ? (
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
                          {pendingImages.map((im) => (
                            <div
                              key={im.id}
                              className="wsImagePreviewChip"
                            >
                              <img src={im.dataUrl} alt={im.name} style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 10 }} />
                              <button
                                type="button"
                                className="btn"
                                style={{ padding: '6px 10px', borderRadius: 10 }}
                                onClick={() => setPendingImages((prev) => prev.filter((x) => x.id !== im.id))}
                                title="移除截图"
                              >
                                移除
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <textarea
                        className="textarea"
                        placeholder={I18N.inputPlaceholder}
                        value={input}
                        spellCheck={false}
                        style={{
                          paddingTop: chatCtxItems.length ? 42 : undefined,
                          // Workspace: control textarea height via draggable splitter (no blank fixed-height row).
                          maxHeight: wsChatBottomH,
                        }}
                        onChange={(e) => {
                          const v = e.target.value
                          setInput(v)
                      const q = getMentionQuery(v)
                      if (q !== null && mode === 'workspace' && activeConn) {
                        setCtxPickerQ(q)
                        setCtxPickerOpen(true)
                        setCtxPickerTab('files')
                        setCtxPickerIdx(0)
                      } else {
                        closeCtxPicker()
                      }
                        }}
                        onKeyDown={onKeyDown}
                        onPaste={onChatPaste}
                        ref={inputRef}
                      />
                      {ctxPickerOpen ? (
                        <div
                          className="wsCtxPicker"
                          style={{
                            position: 'absolute',
                            left: 10,
                            right: 10,
                            bottom: 64,
                            zIndex: 30,
                          }}
                          onMouseDown={(ev) => ev.preventDefault()}
                        >
                          <div className="wsCtxPickerSidebar">
                            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 10 }}>@ 上下文</div>
                            <button
                              type="button"
                              className={`btn wsCtxPickerTab ${ctxPickerTab === 'files' ? 'wsCtxPickerTabActive' : ''}`}
                              onClick={() => {
                                setCtxPickerTab('files')
                                setCtxPickerIdx(0)
                              }}
                            >
                              Files & Folders
                            </button>
                            <button
                              type="button"
                              className={`btn wsCtxPickerTab ${ctxPickerTab === 'current' ? 'wsCtxPickerTabActive' : ''}`}
                              onClick={() => {
                                setCtxPickerTab('current')
                                setCtxPickerIdx(0)
                              }}
                            >
                              Current
                            </button>
                            <button
                              type="button"
                              className={`btn wsCtxPickerTab ${ctxPickerTab === 'terminal' ? 'wsCtxPickerTabActive' : ''}`}
                              onClick={() => {
                                setCtxPickerTab('terminal')
                                setCtxPickerIdx(0)
                              }}
                            >
                              Terminal
                            </button>
                            <div style={{ marginTop: 14, fontSize: 11, opacity: 0.65, lineHeight: 1.45 }}>
                              ↑↓ 选择 · Enter 添加 · Esc 关闭
                            </div>
                          </div>
                          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                              <input
                                className="fieldInput"
                                value={ctxPickerQ}
                                onChange={(e) => {
                                  setCtxPickerQ(e.target.value)
                                  setCtxPickerIdx(0)
                                }}
                                placeholder="搜索…"
                                style={{ flex: 1 }}
                              />
                              <button
                                className="btn"
                                type="button"
                                onClick={() => {
                                  closeCtxPicker()
                                  stripTrailingAtToken()
                                }}
                              >
                                关闭
                              </button>
                            </div>
                            <div style={{ flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 12 }}>
                              {ctxPickerItems.length === 0 ? (
                                <div style={{ padding: 12, fontSize: 12, opacity: 0.7 }}>暂无可用项（先刷新目录或打开文件）</div>
                              ) : (
                                <div style={{ display: 'grid', gap: 6 }}>
                                  {ctxPickerItems.map((it: any, i: number) => (
                                    <button
                                      key={`${it.ref}_${i}`}
                                      type="button"
                                      className={`btn wsCtxPickerItem ${i === ctxPickerIdx ? 'wsCtxPickerItemActive' : ''}`}
                                      onClick={() => {
                                        setCtxPickerIdx(i)
                                        void (async () => {
                                          try {
                                            if (it.kind === 'file') await ctxAddFileSnapshot(it.ref)
                                            else if (it.kind === 'dir') await ctxAddDirSnapshot(it.ref)
                                            else if (it.kind === 'text' && it.content) ctxAdd({ kind: 'terminal', title: it.title, content: it.content, scope: 'once' })
                                          } catch (err) {
                                            const msg = err instanceof Error ? err.message : String(err)
                                            setToast({ id: uid('t'), message: `加入上下文失败：${msg}` })
                                          } finally {
                                            closeCtxPicker()
                                            stripTrailingAtToken()
                                            setTimeout(() => inputRef.current?.focus(), 0)
                                          }
                                        })()
                                      }}
                                    >
                                      <span style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {it.kind === 'dir' ? '📁 ' : it.kind === 'file' ? '📄 ' : '⌘ '}
                                        {it.title}
                                      </span>
                                      <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.ref}</span>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : null}
                      <button
                        className={sending ? 'actionBtn actionBtnStop' : 'actionBtn actionBtnSend'}
                        type="button"
                        onClick={sending ? stopGeneration : () => void send()}
                        title={sending ? I18N.stopTitle : I18N.send}
                        disabled={!sending && !input.trim() && pendingImages.length === 0}
                      >
                        {sending ? I18N.stop : I18N.send}
                      </button>
                    </div>
                    {/* Workspace: model selection moved to the top toolbar (more Cursor-like, keeps composer compact). */}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        ) : (
          <div className="workArea" style={{ gridRow: '1 / -1' }}>
            <div className="workHeader">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <p className="h1" style={{ margin: 0 }}>
                  {mode === 'ssh' || (mode === 'workspace' && opsPath) ? I18N.sshTitle : I18N.pluginsTitle}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  <a
                    href="/"
                    style={{
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '8px 10px',
                      borderRadius: 12,
                      border: '1px solid #e2e8f0',
                      background: '#ffffff',
                      color: '#0f172a',
                      fontWeight: 850,
                      whiteSpace: 'nowrap',
                    }}
                    title="返回官网主页"
                  >
                    {'返回主页'}
                  </a>
                </div>
              </div>
              {mode !== 'ssh' && !(mode === 'workspace' && opsPath) ? (
                <p className="h2">{'\u63d2\u4ef6\u4e0e\u7ec4\u4ef6\u80fd\u529b\u4f1a\u653e\u5728\u8fd9\u91cc\u3002'}</p>
              ) : null}
            </div>
            <div className="workBody">
              {mode !== 'ssh' && !(mode === 'workspace' && opsPath) ? (
              <div className="workCard">
                  <div className="workCardTitle">{I18N.placeholderTitle}</div>
                  <div className="workCardText">{I18N.placeholderPlugins}</div>
                </div>
              ) : opsPath ? (
                <div style={{ padding: '8px 6px' }}>
                  {selectedBigData ? (
                    <div className="workCard" style={{ marginBottom: 10 }}>
                      <div className="workCardTitle">{`大数据资产：${String(selectedBigData.name || selectedBigData.id || '').trim() || '未命名'}`}</div>
                      <div className="workCardText" style={{ marginTop: 8 }}>
                        {[
                          selectedBigData.component_key ? `类型=${String(selectedBigData.component_key)}` : '',
                          selectedBigData.env ? `env=${String(selectedBigData.env)}` : '',
                          selectedBigData.region ? `region=${String(selectedBigData.region)}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ') || '已选中大数据资产。'}
                      </div>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                        <button
                          className="btn btnPrimary"
                          type="button"
                          onClick={() => {
                            const id = String(selectedBigData.id || '').trim()
                            if (!id) return
                            nav(`/app/assets/console/${encodeURIComponent(id)}`)
                          }}
                          title="打开控制台"
                        >
                          连接
                        </button>
                        <button
                          className="btn"
                          type="button"
                          onClick={() => {
                            nav('/app/assets')
                          }}
                          title="返回资产列表"
                        >
                          详情
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <OpsWorkspace embedded />
                </div>
              ) : (
                <div className="detailCard">
                  {activeHost ? (
                    <>
                      <div className="sshDetailHeader">
                        <div className="sshDetailHeaderLeft">
                          <div className="sshDetailTitleRow">
                            <div className="sshDetailTitle">{activeHost.name}</div>
                            <span className="badge">{activeHost.groupId ? groupById.get(activeHost.groupId)?.name ?? '未分组' : '未分组'}</span>
                            {(activeHost.status || 'enabled') !== 'enabled' ? <span className="badge">{String(activeHost.status)}</span> : null}
                          </div>
                          <div className="sshDetailSub">{`${activeHost.user ? activeHost.user + '@' : activeHost.username ? activeHost.username + '@' : ''}${activeHost.address}:${activeHost.port}`}</div>
                          {(activeHost.tagIds || []).length ? (
                            <div className="sshTagRow" style={{ marginTop: 8 }}>
                              {(activeHost.tagIds || [])
                                .map((id) => tagById.get(id)?.name ?? '')
                                .filter(Boolean)
                                .slice(0, 12)
                                .map((t) => (
                                  <span key={t} className="badge">
                                    #{t}
                                  </span>
                                ))}
                            </div>
                          ) : null}
                        </div>

                        <div className="sshDetailActions">
                          <button className="btn btnPrimary" type="button" onClick={() => openConnectModal(activeHost.id)}>
                            连接
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={async () => {
                              const r = await sshTestTcp({ address: activeHost.address, port: activeHost.port })
                              if (r.success) {
                                showToast({ message: `连通性 OK${typeof r.latencyMs === 'number' ? ` · ${r.latencyMs}ms` : ''}` })
                              } else {
                                showToast({ message: `连通性失败 · ${r.error || 'unknown error'}` })
                              }
                            }}
                          >
                            测试连通性
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={() => {
                              setEditingHostId(activeHost.id)
                              setHostModalOpen(true)
                            }}
                          >
                            编辑
                          </button>
                          <button
                            className="btn"
                            type="button"
                            onClick={async () => {
                              const label = activeHost.name
                              try {
                                await navigator.clipboard.writeText(label)
                                showToast({ message: `已复制：${label}` })
                              } catch {
                                window.prompt('复制到剪贴板（浏览器限制，手动复制）', label)
                              }
                            }}
                          >
                            复制名称
                          </button>
                          <button
                            className="btn btnIcon"
                            type="button"
                            title="删除"
                            aria-label="删除"
                            onClick={() => deleteHost(activeHost)}
                          >
                            🗑
                          </button>
                        </div>
                      </div>

                      <div className="detailRow">
                        <div className="detailLabel">地址</div>
                        <div className="detailValue">{activeHost.address}</div>
                      </div>
                      <div className="detailRow">
                        <div className="detailLabel">端口</div>
                        <div className="detailValue">{String(activeHost.port)}</div>
                      </div>
                      <div className="detailRow">
                        <div className="detailLabel">用户</div>
                        <div className="detailValue">{activeHost.user || activeHost.username || '-'}</div>
                      </div>
                      <div className="detailRow">
                        <div className="detailLabel">认证</div>
                        <div className="detailValue">
                          {(() => {
                            const cid = (activeHost as any).credentialId as ID | null | undefined
                            const c = cid ? credById.get(cid) ?? null : null
                            const t = (c?.type as any) || 'none'
                            if (t === 'ssh_key') return 'SSH Key'
                            if (t === 'password') return '密码'
                            if (t === 'agent') return 'Agent'
                            if (t === 'none') return '无'
                            return String(t)
                          })()}
                        </div>
                      </div>
                      <div className="detailRow">
                        <div className="detailLabel">最近连接</div>
                        <div className="detailValue">
                          {typeof activeHost.lastConnectedAt === 'number' ? formatTime(activeHost.lastConnectedAt) : '-'}
                        </div>
                      </div>
                      <div className="detailRow">
                        <div className="detailLabel">创建时间</div>
                        <div className="detailValue">{formatTime(activeHost.createdAt)}</div>
                      </div>
                      <div className="detailRow">
                        <div className="detailLabel">更新时间</div>
                        <div className="detailValue">{formatTime(activeHost.updatedAt)}</div>
                      </div>
                    </>
                  ) : (
                    <div className="sshEmptyState">
                      <div className="workCardTitle">{'平台资产台账'}</div>
                      <div className="workCardText">{'请在左侧选择一个主机资产以查看详情。'}</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <ConfirmDialog
        open={Boolean(confirmDialog)}
        title={confirmDialog?.title || '确认删除'}
        description={confirmDialog?.desc || ''}
        confirmText={confirmDialog?.confirmText || '删除'}
        cancelText="取消"
        tone="danger"
        onCancel={() => setConfirmDialog(null)}
        onConfirm={() => {
          const fn = confirmDialog?.onConfirm
          if (fn) fn()
          else setConfirmDialog(null)
        }}
      />

      {hostModalOpen
        ? createPortal(
            <>
              {/* Host modal: do NOT close on outside click (prevents accidental dismiss + click-through) */}
              <div
                className="modalOverlay"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              />
              <div className="modal" role="dialog" aria-modal="true">
                {assetCreateTab === 'bigdata' && !editingHostId ? (
                  <BigDataEditor
                    activeTab={assetCreateTab}
                    onSwitchTab={setAssetCreateTab}
                    onCancel={closeHostModal}
                    onSave={({ name, kind, env, region, bucket }) => {
                      const now = Date.now()
                      const nextItem = {
                        id: uid('bd'),
                        component_key: kind,
                        name,
                        bucket,
                        env: env || 'prod',
                        region: region || 'cn-shenzhen',
                        createdAt: now,
                        updatedAt: now,
                      }
                      setHostCfg((prev) => {
                        const arr = Array.isArray((prev as any).bigDataAssets) ? ((prev as any).bigDataAssets as any[]) : []
                        return { ...(prev as any), bigDataAssets: [nextItem, ...arr] }
                      })
                      setToast({ id: uid('t'), message: `已新增大数据资产：${name}` })
                      closeHostModal()
                    }}
                  />
                ) : (
                  <HostEditor
                    title={
                      editingHostId ? (
                        I18N.sshEditHost
                      ) : (
                        <div className="assetCreateTabs" role="tablist" aria-label="新增资产类型">
                          <button
                            type="button"
                            className={assetCreateTab === 'host' ? 'assetCreateTab assetCreateTabActive' : 'assetCreateTab'}
                            onClick={() => setAssetCreateTab('host')}
                            role="tab"
                            aria-selected={assetCreateTab === 'host'}
                          >
                            新增主机
                          </button>
                          <button
                            type="button"
                            className={assetCreateTab === 'bigdata' ? 'assetCreateTab assetCreateTabActive' : 'assetCreateTab'}
                            onClick={() => setAssetCreateTab('bigdata')}
                            role="tab"
                            aria-selected={assetCreateTab === 'bigdata'}
                          >
                            新增大数据资产
                          </button>
                        </div>
                      )
                    }
                    host={editingHostId ? hostCfg.hosts.find((h) => h.id === editingHostId) ?? null : null}
                    groups={hostCfg.groups}
                    tags={hostCfg.tags}
                    credential={editingHostId
                      ? hostCfg.hosts.find((h) => h.id === editingHostId)?.credentialId
                        ? hostCfg.credentials.find(
                            (c) => c.id === hostCfg.hosts.find((h) => h.id === editingHostId)?.credentialId,
                          ) ?? null
                        : null
                      : null}
                    onTestConnection={(input) => sshTestTcp(input)}
                    onCancel={closeHostModal}
                    onSave={(draft, authType) => {
                      saveHostFromEditor(draft, authType)
                      closeHostModal()
                    }}
                    onSaveAndConnect={(draft, authType, secrets) => {
                      const id = saveHostFromEditor(draft, authType)
                      closeHostModal()
                      const rp = defaultRootPathForHost(id)
                      void connectAndEnterWorkspace({
                        hostId: id,
                        rootPath: rp,
                        auth: {
                          type: authType,
                          password: secrets?.password || '',
                          sshKey: secrets?.privateKey || '',
                          passphrase: secrets?.passphrase || '',
                        },
                      })
                    }}
                  />
                )}
              </div>
            </>,
            document.body,
          )
        : null}

      {apiCfgOpen
        ? createPortal(
            <>
              <div className="modalOverlay" onMouseDown={(e) => e.preventDefault()} onClick={closeApiCfg} />
              <div className="modal" role="dialog" aria-modal="true">
                <div className="modalHeader">
                  <div className="modalTitle">{I18N.apiBaseTitle}</div>
                  <div className="modalCloseRow">
                    <button className="modalClose" type="button" onClick={closeApiCfg} aria-label={I18N.apiBaseCancel}>
                      \u00d7
                    </button>
                  </div>
                </div>
                <div className="modalBody">
                  <div className="formRow">
                    <div className="formLabel">{I18N.apiBaseLabel}</div>
                    <div className="formControl">
                      <input
                        className="input"
                        value={apiCfgDraft}
                        onChange={(e) => setApiCfgDraft(e.target.value)}
                        placeholder={I18N.apiBaseHint}
                      />
                      <div className="formHelp">
                        {I18N.apiBaseCurrent}
                        <code style={{ marginLeft: 6 }}>{apiCfgDraft.trim() ? apiCfgDraft.trim() : '(same-origin /api)'}</code>
                        {apiCfgTest.state !== 'idle' ? (
                          <span style={{ marginLeft: 10 }}>
                            {apiCfgTest.state === 'ok'
                              ? I18N.apiBaseOk
                              : `${I18N.apiBaseBad}${apiCfgTest.detail ? ` (${apiCfgTest.detail})` : ''}`}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="modalFooter">
                  <button className="btn" type="button" onClick={() => void testApiCfg()}>
                    {I18N.apiBaseTest}
                  </button>
                  <div style={{ flex: 1 }} />
                  <button className="btn" type="button" onClick={closeApiCfg}>
                    {I18N.apiBaseCancel}
                  </button>
                  <button className="btn btnPrimary" type="button" onClick={saveApiCfg}>
                    {I18N.apiBaseSave}
                  </button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* Connect modal: click "连接主机" -> collect rootPath + one-shot auth -> enter workspace split-view */}
      {connectModal?.open
        ? createPortal(
            <>
              <div
                className="modalOverlay"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  // Do NOT close on overlay click (avoid accidental dismissal while pasting secrets).
                  e.preventDefault()
                  e.stopPropagation()
                }}
              />
              <div
                className="modal"
                role="dialog"
                aria-modal="true"
                onMouseDown={(e) => {
                  // Prevent backdrop handlers from triggering when interacting inside modal.
                  e.stopPropagation()
                }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="modalHeader">
                  <div className="modalTitle">{`连接主机 · ${hostById(connectModal.hostId)?.name || connectModal.hostId}`}</div>
                  <div className="modalCloseRow">
                    <button className="modalClose" type="button" onClick={() => setConnectModal(null)} aria-label="关闭">
                      ×
                    </button>
                  </div>
                </div>
                <div className="modalBody">
                  <div className="formGrid">
                    <div className="field fieldSpan2">
                      <div className="fieldLabel">rootPath（工作区根目录，Windows 也支持如 C:/Users）</div>
                      <Input
                        value={connectModal.rootPath}
                        onChange={(e) => setConnectModal((p) => (p ? { ...p, rootPath: (e.target as HTMLInputElement).value } : p))}
                        placeholder="例如：/root 或 C:/Users"
                      />
                      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <div style={{ fontSize: 12, opacity: 0.75, marginRight: 4 }}>{'常用：'}</div>
                        <button type="button" className="btn" onClick={() => setConnectModal((p) => (p ? { ...p, rootPath: '/root' } : p))}>
                          /root
                        </button>
                        <button type="button" className="btn" onClick={() => setConnectModal((p) => (p ? { ...p, rootPath: 'C:/Users' } : p))}>
                          C:/Users
                        </button>
                        <button type="button" className="btn" onClick={() => setConnectModal((p) => (p ? { ...p, rootPath: 'C:/' } : p))}>
                          C:/
                        </button>
                      </div>
                    </div>

                    <div className="field fieldSpan2">
                      <div className="fieldLabel">账号/用户名（SSH）</div>
                      <Input
                        value={connectModal.sshUser}
                        onChange={(e) => setConnectModal((p) => (p ? { ...p, sshUser: (e.target as HTMLInputElement).value } : p))}
                        placeholder="例如：root / ubuntu / ecs-user"
                      />
                      <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.9 }}>
                        <input
                          type="checkbox"
                          checked={Boolean(connectModal.persistSshUser)}
                          onChange={(e) => setConnectModal((p) => (p ? { ...p, persistSshUser: (e.target as HTMLInputElement).checked } : p))}
                        />
                        同时更新为该主机的默认账号（会更新资产配置）
                      </label>
                    </div>

                    <div className="field fieldSpan2">
                      <div className="fieldLabel">认证方式</div>
                      <div className="auth-tabs" role="tablist" aria-label="认证方式">
                        <button
                          type="button"
                          className={connectModal.auth.type === 'password' ? 'tab active' : 'tab'}
                          onClick={() => setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, type: 'password' } } : p))}
                          role="tab"
                          aria-selected={connectModal.auth.type === 'password'}
                        >
                          🔑 密码
                        </button>
                        <button
                          type="button"
                          className={connectModal.auth.type === 'ssh_key' ? 'tab active' : 'tab'}
                          onClick={() => setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, type: 'ssh_key' } } : p))}
                          role="tab"
                          aria-selected={connectModal.auth.type === 'ssh_key'}
                        >
                          📄 私钥
                        </button>
                        <button
                          type="button"
                          className={connectModal.auth.type === 'agent' ? 'tab active' : 'tab'}
                          onClick={() => setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, type: 'agent' } } : p))}
                          role="tab"
                          aria-selected={connectModal.auth.type === 'agent'}
                        >
                          🛰 Agent
                        </button>
                      </div>

                      {connectModal.auth.type === 'password' ? (
                        <Input
                          type="password"
                          value={connectModal.auth.password}
                          onChange={(e) =>
                            setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, password: (e.target as HTMLInputElement).value } } : p))
                          }
                          placeholder="密码（仅本次使用，不保存）"
                        />
                      ) : connectModal.auth.type === 'ssh_key' ? (
                        <>
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                            <label className="btn" style={{ cursor: 'pointer' }}>
                              {'上传密钥文件'}
                              <input
                                type="file"
                                accept=".pem,.key,.ppk,.txt,*/*"
                                style={{ display: 'none' }}
                                onChange={(e) => {
                                  const f = (e.target as HTMLInputElement).files?.[0]
                                  if (!f) return
                                  const reader = new FileReader()
                                  reader.onload = () => {
                                    const txt = String(reader.result || '')
                                    setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, sshKey: txt } } : p))
                                    setToast({ id: uid('t'), message: `已读取密钥文件：${f.name}` })
                                  }
                                  reader.onerror = () => {
                                    setToast({ id: uid('t'), message: '读取密钥文件失败，请重试或直接粘贴' })
                                  }
                                  reader.readAsText(f)
                                }}
                              />
                            </label>
                            <div style={{ fontSize: 12, opacity: 0.7 }}>{'不会落盘保存；仅用于本次连接。'}</div>
                          </div>
                          <textarea
                            className="fieldTextarea"
                            style={{ minHeight: 120 }}
                            value={connectModal.auth.sshKey}
                            onChange={(e) =>
                              setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, sshKey: (e.target as HTMLTextAreaElement).value } } : p))
                            }
                            placeholder="粘贴 SSH 私钥内容（仅本次使用，不保存）"
                          />
                          <Input
                            type="password"
                            value={connectModal.auth.passphrase}
                            onChange={(e) =>
                              setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, passphrase: (e.target as HTMLInputElement).value } } : p))
                            }
                            placeholder="Passphrase（可选）"
                          />
                        </>
                      ) : (
                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          代理模式：将尝试使用服务器侧 SSH Agent/本机已有密钥（如启用 allow_agent / look_for_keys）。
                        </div>
                      )}
                      {connectModal.auth.credentialId ? (
                        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                          已绑定云端凭据：<span style={{ fontFamily: 'monospace' }}>{String(connectModal.auth.credentialId).slice(0, 10)}…</span>
                          <button
                            type="button"
                            className="btn"
                            style={{ marginLeft: 10, padding: '4px 8px', borderRadius: 10 }}
                            onClick={() => {
                              setConnectModal((p) => (p ? { ...p, auth: { ...p.auth, credentialId: null }, remember: false } : p))
                              setRemoteErr('')
                              setToast({ id: uid('t'), message: '已解除绑定：将使用本次输入的密码/私钥连接' })
                            }}
                            title="若提示 Credential not found，可先解除绑定再用本次输入连接"
                          >
                            解除绑定
                          </button>
                        </div>
                      ) : null}
                      {me?.email && inventorySyncEnabled && (connectModal.auth.type === 'password' || connectModal.auth.type === 'ssh_key') ? (
                        <label style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, opacity: 0.9 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(connectModal.remember)}
                            onChange={(e) => setConnectModal((p) => (p ? { ...p, remember: (e.target as HTMLInputElement).checked } : p))}
                          />
                          保存凭据到云端（加密，仅本人可用；默认不保存）
                        </label>
                      ) : null}
                      {remoteErr ? <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,120,120,0.95)' }}>{remoteErr}</div> : null}
                    </div>
                  </div>
                </div>
                <div className="modalFooter">
                  <Button type="button" onClick={() => setConnectModal(null)}>
                    取消
                  </Button>
                  <Button
                    variant="primary"
                    type="button"
                    disabled={remoteBusy}
                    onClick={() => {
                      const cm = connectModal
                      if (!cm) return
                      void (async () => {
                        const sshUser = String((cm as any).sshUser || '').trim()
                        if (!sshUser) {
                          setRemoteErr('请填写账号/用户名（SSH）。')
                          return
                        }
                        if ((cm as any).persistSshUser) {
                          const now = Date.now()
                          setHostCfg((prev) => {
                            const assets = (prev.assets || []).map((a: any) =>
                              a.id === cm.hostId ? { ...a, user: sshUser, username: sshUser, updatedAt: now } : a,
                            )
                            return { ...(prev as any), assets, hosts: assets } as any
                          })
                        }
                        let auth = cm.auth
                        const wantSave = Boolean(cm.remember) && Boolean(me?.email) && inventorySyncEnabled
                        if (wantSave && !String(auth.credentialId || '').trim() && (auth.type === 'password' || auth.type === 'ssh_key')) {
                          try {
                            const kind = auth.type === 'password' ? 'password' : 'ssh_key'
                            const secret =
                              kind === 'password'
                                ? { password: auth.password }
                                : { privateKey: auth.sshKey, passphrase: auth.passphrase || undefined }
                            const saved = await apiInventorySaveCredential({ kind, secret })
                            const cid = String(saved.credentialId || '').trim()
                            if (cid) {
                              const now = Date.now()
                              setHostCfg((prev) => {
                                const assets = (prev.assets || []).map((a) => (a.id === cm.hostId ? { ...a, credentialId: cid } : a))
                                const creds = Array.isArray(prev.credentials) ? prev.credentials : []
                                const has = creds.some((c) => c && String((c as any).id || '') === cid)
                                const nextCreds = has ? creds : [...creds, { id: cid, type: auth.type, createdAt: now, updatedAt: now } as any]
                                return { ...prev, assets, hosts: assets, credentials: nextCreds } as any
                              })
                              auth = { ...auth, credentialId: cid, password: '', sshKey: '', passphrase: '' }
                            }
                          } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e)
                            showToast({ message: `保存云端凭据失败（继续一次性连接）：${msg}` })
                          }
                        }

                        // Remember override for reconnect (page lifetime) unless user chose to persist to asset.
                        try {
                          if (!Boolean((cm as any).persistSshUser)) wsSshUserOverrideByHostRef.current.set(String(cm.hostId), sshUser)
                          else wsSshUserOverrideByHostRef.current.delete(String(cm.hostId))
                        } catch {
                          // ignore
                        }
                        const ok = await connectAndEnterWorkspace({ hostId: cm.hostId, rootPath: cm.rootPath, sshUser, auth })
                        // Only close on success; keep modal open on auth error.
                        if (ok) setConnectModal(null)
                      })()
                    }}
                  >
                    {remoteBusy ? '连接中…' : '连接并进入工作区'}
                  </Button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* Workspace open-directory popup removed: validation happens inline via "打开" button */}

      {/* Workspace edit modal: replace browser prompt (spec prefers in-app UI) */}
      {workspaceEditOpen && workspaceEditDraft
        ? createPortal(
            <>
              <div
                className="modalOverlay"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              />
              <div className="modal" role="dialog" aria-modal="true" aria-label="编辑工作区">
                <div className="modalHeader">
                  <div className="modalTitle">{'编辑工作区'}</div>
                  <IconButton
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setWorkspaceEditOpen(false)
                      setWorkspaceEditDraft(null)
                      setWorkspaceEditErr('')
                    }}
                    title={'关闭'}
                    aria-label={'关闭'}
                  >
                    ×
                  </IconButton>
                </div>
                <div className="modalBody">
                  <div className="modalSection">
                    <div className="modalSectionTitle">{'基础信息'}</div>
                    <div className="formGrid">
                      <div className="field fieldSpan2">
                        <div className="fieldLabel">{'工作区名称 *'}</div>
                        <Input
                          value={workspaceEditDraft.name}
                          onChange={(e) => setWorkspaceEditDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                          placeholder="例如：Project-Backend-Dev"
                        />
                      </div>
                      <div className="field fieldSpan2">
                        <div className="fieldLabel">{'目录（rootPath）'}</div>
                        <Input
                          value={workspaceEditDraft.rootPath}
                          onChange={(e) => setWorkspaceEditDraft((d) => (d ? { ...d, rootPath: e.target.value } : d))}
                          placeholder="/srv/www"
                        />
                      </div>
                    </div>
                    {workspaceEditErr ? (
                      <div style={{ color: 'rgba(255,120,120,0.95)', fontSize: 12, marginTop: 10 }}>{workspaceEditErr}</div>
                    ) : null}
                  </div>
                </div>
                <div className="modalFooter">
                  <Button
                    type="button"
                    onClick={() => {
                      setWorkspaceEditOpen(false)
                      setWorkspaceEditDraft(null)
                      setWorkspaceEditErr('')
                    }}
                  >
                    {'取消'}
                  </Button>
                  <Button
                    variant="primary"
                    type="button"
                    onClick={() => {
                      const name = (workspaceEditDraft.name || '').trim()
                      const rootPath = (workspaceEditDraft.rootPath || '').trim()
                      if (!name) return setWorkspaceEditErr('请填写工作区名称')
                      if (name.length > 64) return setWorkspaceEditErr('工作区名称过长（最多 64）')
                      if (rootPath && rootPath.length > 180) return setWorkspaceEditErr('目录过长（最多 180）')
                      const now = Date.now()
                      setHostCfg((prev) => ({
                        ...prev,
                        workspaces: prev.workspaces.map((w) =>
                          w.id === workspaceEditDraft.id ? { ...w, name, rootPath: rootPath || w.rootPath, updatedAt: now } : w,
                        ),
                      }))
                      setWorkspaceEditOpen(false)
                      setWorkspaceEditDraft(null)
                      setWorkspaceEditErr('')
                      showToast({ message: `已更新工作区：${name}` })
                    }}
                  >
                    {'保存'}
                  </Button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* SSH "+" action menu is rendered under the sidebar "+" button for reliable positioning */}

      {groupMgrOpen
        ? createPortal(
            <>
              <div className="modalOverlay" onMouseDown={(e) => e.preventDefault()} onClick={() => setGroupMgrOpen(false)} />
              <div className="modal" role="dialog" aria-modal="true">
                <GroupManager
                  groups={hostCfg.groups}
                  hosts={hostCfg.hosts.filter((h) => !h.deletedAt)}
                  onClose={() => setGroupMgrOpen(false)}
                  onUpsert={(g) => upsertGroup(g)}
                  onDelete={(id, strategy) => deleteGroup(id, strategy)}
                  onMoveHosts={(hostIds, targetGroupId) => moveHostsToGroup(hostIds, targetGroupId)}
                  onReorder={(id, dir) => reorderGroup(id, dir)}
                  onSetParent={(id, parentId) => setGroupParent(id, parentId)}
                />
              </div>
            </>,
            document.body,
          )
        : null}

      {tagMgrOpen
        ? createPortal(
            <>
              <div className="modalOverlay" onMouseDown={(e) => e.preventDefault()} onClick={() => setTagMgrOpen(false)} />
              <div className="modal" role="dialog" aria-modal="true">
                <TagManager
                  tags={hostCfg.tags}
                  onClose={() => setTagMgrOpen(false)}
                  onUpsert={(t) => upsertTag(t)}
                  onDelete={(id) => deleteTag(id)}
                />
              </div>
            </>,
            document.body,
          )
        : null}

      {groupMenuOpenId && openGroup && groupMenuPos
        ? createPortal(
            <Menu
              className="groupMenu"
              data-group-menu
              style={{
                position: 'fixed',
                top: groupMenuPos.top,
                left: groupMenuPos.left,
                right: 'auto',
                zIndex: 9999,
              }}
            >
              <MenuItem
                type="button"
                onClick={() => {
                  openNewHostModalWithGroup(openGroup.id)
                  setGroupMenuOpenId(null)
                  setGroupMenuPos(null)
                }}
              >
                {I18N.groupMenuNewHost}
              </MenuItem>
              <MenuItem
                type="button"
                onClick={() => {
                  const next = window.prompt(I18N.groupMenuRename, openGroup.name)
                  if (next && next.trim()) upsertGroup({ id: openGroup.id, name: next.trim() })
                  setGroupMenuOpenId(null)
                  setGroupMenuPos(null)
                }}
              >
                {I18N.groupMenuRename}
              </MenuItem>
              <MenuItem
                danger
                type="button"
                onClick={() => {
                  if (window.confirm(I18N.groupDeleteConfirm)) {
                    deleteGroup(openGroup.id, { type: 'ungroup' })
                  }
                  setGroupMenuOpenId(null)
                  setGroupMenuPos(null)
                }}
              >
                {I18N.groupMenuDelete}
              </MenuItem>
              <div className="actionMenuDivider" />
              <MenuItem
                type="button"
                onClick={() => {
                  setGroupMgrOpen(true)
                  setGroupMenuOpenId(null)
                  setGroupMenuPos(null)
                }}
              >
                {I18N.groupMenuOpenManager}
              </MenuItem>
            </Menu>,
            document.body,
          )
        : null}

      {/* Spec §8.2: context switcher popover */}
      {ctxOpen && ctxPos
        ? createPortal(
            <div
              className="ctxPopover"
              data-ctx-popover
              style={{ position: 'fixed', top: ctxPos.top, left: ctxPos.left, width: ctxPos.width, zIndex: 9999 }}
              role="dialog"
              aria-modal="false"
            >
              <div className="ctxPopoverHeader">
                <Input
                  ref={ctxSearchRef}
                  value={ctxSearch}
                  onChange={(e) => setCtxSearch(e.target.value)}
                  className="ctxSearchInput"
                  placeholder={'\u641c\u7d22\u7a7a\u95f4\u2026'}
                />
              </div>

              <div className="ctxPopoverBody">
                <div className="ctxSectionTitle">{'\u6700\u8fd1\u7a7a\u95f4'}</div>
                {filteredSpaces.recent.length === 0 ? (
                  <div className="ctxEmpty">
                    {'\u672a\u627e\u5230\u7a7a\u95f4'}
                    <button className="ctxLinkBtn" type="button" onClick={() => setCtxSearch('')}>
                      {'\u6e05\u7a7a\u641c\u7d22'}
                    </button>
                  </div>
                ) : (
                  <Menu className="ctxMenu">
                    {filteredSpaces.recent.map((s) => (
                      <MenuItem
                        key={s.id}
                        type="button"
                        className={s.id === activeSpaceId ? 'ctxMenuItem ctxMenuItemActive' : 'ctxMenuItem'}
                        onClick={() => switchSpace(s.id)}
                      >
                        <span className="ctxMenuItemName">{s.name}</span>
                        {s.id === activeSpaceId ? <span className="ctxTag">{'\u5f53\u524d'}</span> : null}
                      </MenuItem>
                    ))}
                  </Menu>
                )}

                <div className="ctxSectionTitle" style={{ marginTop: 10 }}>
                  {'\u5168\u90e8\u7a7a\u95f4'}
                </div>
                <div className="ctxAllList">
                  <Menu className="ctxMenu">
                    {filteredSpaces.all.map((s) => (
                      <MenuItem
                        key={s.id}
                        type="button"
                        className={s.id === activeSpaceId ? 'ctxMenuItem ctxMenuItemActive' : 'ctxMenuItem'}
                        onClick={() => switchSpace(s.id)}
                      >
                        <span className="ctxMenuItemName">{s.name}</span>
                        {s.id === activeSpaceId ? <span className="ctxTag">{'\u5f53\u524d'}</span> : null}
                      </MenuItem>
                    ))}
                  </Menu>
                </div>

                <div className="ctxActionsRow">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      const name = (window.prompt('\u65b0\u5efa\u7a7a\u95f4\u540d\u79f0', '\u65b0\u7a7a\u95f4') || '').trim()
                      if (!name) return
                      const id = `space_${Math.random().toString(16).slice(2)}_${Date.now()}`
                      const now = Date.now()
                      setSpaces((prev) => [{ id, name, lastUsedAt: now }, ...prev])
                      setActiveSpaceId(id)
                      closeCtxPopover()
                      setToast({ id: uid('t'), message: `\u5df2\u521b\u5efa\u7a7a\u95f4\uff1a${name}` })
                    }}
                    title={'\u65b0\u5efa\u7a7a\u95f4\uff08\u5360\u4f4d\uff09'}
                  >
                    {'+ \u65b0\u5efa\u7a7a\u95f4'}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* Spec §8.3: global create menu */}
      {createOpen && createPos
        ? createPortal(
            <Menu
              data-create-menu
              className="createMenu"
              style={{ position: 'fixed', top: createPos.top, left: createPos.left, zIndex: 9999 }}
            >
              <div className="createMenuHeader">{'\u65b0\u5efa\u2026'}</div>
              <MenuItem
                type="button"
                autoFocus
                onClick={() => {
                  closeCreateMenu()
                  openNewHostModal()
                }}
              >
                {'1) \u65b0\u5efa\u4e3b\u673a\uff08\u63a8\u8350\uff09'}
              </MenuItem>
              <MenuItem
                type="button"
                onClick={() => {
                  closeCreateMenu()
                  setMode('dashboard')
                  setDashDrawer({ open: true, type: 'create_workspace' })
                }}
              >
                {'2) \u521b\u5efa\u5de5\u4f5c\u533a'}
              </MenuItem>
              <MenuItem
                type="button"
                onClick={() => {
                  closeCreateMenu()
                  setMode('chat')
                  newChat()
                }}
              >
                {'3) \u53d1\u8d77\u5bf9\u8bdd'}
              </MenuItem>
              {PLUGINS_ENABLED ? (
                <MenuItem
                  type="button"
                  onClick={() => {
                    closeCreateMenu()
                    setMode('plugins')
                  }}
                >
                  {'4) \u5b89\u88c5\u63d2\u4ef6'}
                </MenuItem>
              ) : null}
              <MenuItem
                type="button"
                onClick={() => {
                  closeCreateMenu()
                  setMode('ssh')
                  openImport()
                }}
              >
                {'5) \u5bfc\u5165\u8d44\u4ea7'}
              </MenuItem>
            </Menu>,
            document.body,
          )
        : null}

      {/* Spec §10.4.4: create workspace drawer */}
      {wsCreateOpen && wsCreateDraft
        ? createPortal(
            <>
              <div className="dashDrawerOverlay" onClick={() => setWsCreateOpen(false)} aria-hidden="true" />
              <div className="dashDrawer" role="dialog" aria-modal="true">
                <div className="dashDrawerHeader">
                  <div className="dashDrawerTitle">{'创建工作区'}</div>
                  <button className="dashDrawerClose" type="button" onClick={() => setWsCreateOpen(false)} aria-label="关闭">
                    ✕
                  </button>
                </div>
                <div className="dashDrawerBody">
                  <div className="field">
                    <div className="fieldLabel">{'工作区名称 *'}</div>
                    <input
                      className="fieldInput"
                      value={wsCreateDraft.name}
                      onChange={(e) => setWsCreateDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                      placeholder="例如：Web-Server-01 工作区"
                    />
                  </div>

                  <div className="field">
                    <div className="fieldLabel">{'目录（rootPath）*'}</div>
                    <input
                      className="fieldInput"
                      value={wsCreateDraft.rootPath}
                      onChange={(e) => setWsCreateDraft((d) => (d ? { ...d, rootPath: e.target.value } : d))}
                      placeholder="/srv/www"
                    />
                  </div>

                  <div className="field">
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#475569' }}>
                      <input
                        type="checkbox"
                        checked={wsCreateDraft.pinned}
                        onChange={(e) => setWsCreateDraft((d) => (d ? { ...d, pinned: e.target.checked } : d))}
                      />
                      {'创建后置顶'}
                    </label>
                  </div>

                  {wsCreateErr ? <div className="fieldError">{wsCreateErr}</div> : null}

                  <div className="modalFooter" style={{ justifyContent: 'space-between' }}>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => {
                        setWsCreateOpen(false)
                      }}
                    >
                      取消
                    </button>
                    <button
                      className="btn btnPrimary"
                      type="button"
                      onClick={() => {
                        if (!wsCreateDraft) return
                        const name = (wsCreateDraft.name || '').trim()
                        const rootPath = (wsCreateDraft.rootPath || '').trim()
                        if (!name) return setWsCreateErr('请填写名称（1-60）')
                        if (name.length > 60) return setWsCreateErr('名称过长（最多 60）')
                        if (!rootPath) return setWsCreateErr('请填写根目录')
                        if (rootPath.length > 180) return setWsCreateErr('目录过长（最多 180）')
                        setWsCreateErr('')
                        const now = Date.now()
                        const id = uid('ws') as ID
                        const newW = {
                          id,
                          assetId: wsCreateDraft.assetId,
                          name,
                          rootPath,
                          pinned: wsCreateDraft.pinned,
                          lastOpenedAt: now,
                          createdAt: now,
                          updatedAt: now,
                        }
                        setHostCfg((prev) =>
                          fixHostConfigState({
                            ...prev,
                            workspaces: [newW, ...prev.workspaces],
                            activeWorkspaceId: id,
                          }),
                        )
                        setWsCreateOpen(false)
                        setToast({
                          id: uid('t'),
                          message: `已创建工作区：${name}`,
                          actionLabel: '打开',
                          onAction: () => setHostCfg((prev) => ({ ...prev, activeWorkspaceId: id })),
                        })
                      }}
                    >
                      创建并打开
                    </button>
                  </div>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {importOpen
        ? createPortal(
            <>
              <div
                className="modalOverlay"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setImportOpen(false)
                  setImportPreview(null)
                }}
              />
              <div className="modal" role="dialog" aria-modal="true">
                <div className="modalHeader">
                  <div className="modalTitle">{I18N.importTitle}</div>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setImportOpen(false)
                      setImportPreview(null)
                    }}
                    title={'\u5173\u95ed'}
                  >
                    X
                  </button>
                </div>
                <div className="modalBody">
                  <div className="field">
                    <div className="fieldLabel">{I18N.importPickFile}</div>
                    <input
                      className="fieldInput"
                      type="file"
                      accept="application/json,.json"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) void onPickImportFile(f)
                      }}
                    />
                  </div>

                  <div className="detailCard" style={{ maxWidth: 'none' }}>
                    <div className="workCardText" style={{ marginBottom: 8 }}>
                      {I18N.importPreview}
                    </div>
                    {!importPreview ? (
                      <div className="workCardText">{'\u8bf7\u9009\u62e9\u4e00\u4e2a\u5bfc\u5165\u6587\u4ef6\u3002'}</div>
                    ) : importPreview.ok && importPreview.state ? (
                      <div className="workCardText">
                        {`hosts=${importPreview.state.hosts.length}, groups=${importPreview.state.groups.length}, tags=${importPreview.state.tags.length}, credentials=${importPreview.state.credentials.length}`}
                      </div>
                    ) : (
                      <div style={{ color: 'rgba(255,120,120,0.95)', fontSize: 12 }}>
                        {importPreview.error || I18N.importInvalid}
                      </div>
                    )}
                  </div>
                </div>
                <div className="modalFooter">
                  <button
                    className="btn"
                    type="button"
                    onClick={() => {
                      setImportOpen(false)
                      setImportPreview(null)
                    }}
                  >
                    {I18N.importCancel}
                  </button>
                  <button
                    className="btn btnPrimary"
                    type="button"
                    disabled={!importPreview?.ok || !importPreview.state}
                    onClick={() => {
                      if (importPreview?.ok && importPreview.state) {
                        remapAndMergeImport(importPreview.state)
                        setImportOpen(false)
                        setImportPreview(null)
                      }
                    }}
                  >
                    {I18N.importConfirm}
                  </button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {openMenuForId && menuPos
        ? createPortal(
            <div className="sessionMenu sessionMenuPortal" data-session-menu style={{ top: menuPos.top, left: menuPos.left }}>
              <button className="sessionMenuItem" type="button" role="menuitem" onClick={() => closeSession(menuPos.id)}>
                {I18N.closeSession}
              </button>
              <button
                className="sessionMenuItem sessionMenuItemDanger"
                type="button"
                role="menuitem"
                onClick={() => deleteSession(menuPos.id)}
              >
                {I18N.deleteSession}
              </button>
            </div>,
            document.body,
          )
        : null}

      {/* Workspace chat menu (Cursor-like: keep toolbar clean; move "new/clear chat" into a ... menu). */}
      {wsChatMenuOpen && wsChatMenuPos
        ? createPortal(
            <div
              data-ws-chat-menu
              style={{
                position: 'fixed',
                top: wsChatMenuPos.top,
                left: wsChatMenuPos.left,
                zIndex: 1400,
              }}
            >
              <Menu>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsChatMenuOpen(false)
                    setWsChatMenuPos(null)
                    ctxClear()
                    newChat()
                  }}
                >
                  新会话
                </MenuItem>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsChatMenuOpen(false)
                    setWsChatMenuPos(null)
                    // Safety: recover from older persisted values that could collapse the textarea height.
                    setWsChatBottomH(160)
                    try {
                      localStorage.setItem(WS_CHAT_BOTTOM_H_KEY, '160')
                    } catch {
                      // ignore
                    }
                    setTimeout(() => inputRef.current?.focus(), 0)
                  }}
                >
                  重置输入框高度
                </MenuItem>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsChatMenuOpen(false)
                    setWsChatMenuPos(null)
                    ctxClear()
                  }}
                >
                  {chatCtxItems.length ? `清空上下文（${chatCtxItems.length}）` : '清空上下文'}
                </MenuItem>
                <MenuItem
                  type="button"
                  danger
                  onClick={() => {
                    setWsChatMenuOpen(false)
                    setWsChatMenuPos(null)
                    setWsChatConfirm({ type: 'clear_chat' })
                  }}
                >
                  清空聊天
                </MenuItem>
              </Menu>
            </div>,
            document.body,
          )
        : null}

      {/* Workspace file editor menu */}
      {wsFileMenuOpen && wsFileMenuPos
        ? createPortal(
            <div
              data-ws-file-menu
              style={{
                position: 'fixed',
                top: wsFileMenuPos.top,
                left: wsFileMenuPos.left,
                zIndex: 1400,
              }}
            >
              <Menu>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsFileMenuOpen(false)
                    setWsFileMenuPos(null)
                    if (!activeConn?.openFile) return
                    const content = String(fsContent || '').trim()
                    if (!content) return setToast({ id: uid('t'), message: '文件内容为空，无法加入上下文' })
                    const fp = activeConn.openFile || 'file'
                    ctxAdd({ kind: 'file', title: fp, content: fsContent })
                    setTimeout(() => inputRef.current?.focus(), 0)
                  }}
                >
                  加入上下文
                </MenuItem>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsFileMenuOpen(false)
                    setWsFileMenuPos(null)
                    if (remoteBusy || !fsDirty) return
                    void remoteSaveFile()
                  }}
                >
                  {remoteBusy ? '保存中…' : fsDirty ? '保存' : '已保存'}
                </MenuItem>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsFileMenuOpen(false)
                    setWsFileMenuPos(null)
                    setActiveConn((p) => (p ? { ...p, openFile: null } : p))
                    setFsContent('')
                    setFsDirty(false)
                    setRemotePanel((p) => (p ? { ...p, openFile: null } : p))
                  }}
                >
                  关闭
                </MenuItem>
              </Menu>
            </div>,
            document.body,
          )
        : null}

      {/* Workspace terminal menu */}
      {wsTermMenuOpen && wsTermMenuPos
        ? createPortal(
            <div
              data-ws-term-menu
              style={{
                position: 'fixed',
                top: wsTermMenuPos.top,
                left: wsTermMenuPos.left,
                zIndex: 1400,
              }}
            >
              <Menu>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsTermMenuOpen(false)
                    setWsTermMenuPos(null)
                    wsTermXRef.current?.clear()
                    wsTermTranscriptRef.current = ''
                    wsTermInputLineRef.current = ''
                    wsTermBumpCtxVer()
                    try {
                      wsTermWsRef.current?.send('clear\n')
                    } catch {
                      // ignore
                    }
                  }}
                >
                  清空终端
                </MenuItem>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsTermMenuOpen(false)
                    setWsTermMenuPos(null)
                    if (wsTermPtyActive) {
                      void wsTermStopManualShell()
                    } else {
                      void wsTermStartManualShell()
                    }
                  }}
                >
                  {wsTermPtyActive ? '退出 Shell（人工）' : '进入 Shell（人工，PTY）'}
                </MenuItem>
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsTermMenuOpen(false)
                    setWsTermMenuPos(null)
                    wsTermRestoreOnceRef.current = true
                    setWsTermOpen(false)
                    setWsTermH(0)
                  }}
                >
                  收起终端
                </MenuItem>
                <div className="actionMenuDivider" />
                <MenuItem
                  type="button"
                  onClick={() => {
                    setWsTermMenuOpen(false)
                    setWsTermMenuPos(null)
                    // Open @ context picker on Terminal tab for quick "add terminal output to context"
                    setCtxPickerOpen(true)
                    setCtxPickerTab('terminal')
                    setCtxPickerIdx(0)
                    setCtxPickerQ('')
                    setTimeout(() => inputRef.current?.focus(), 0)
                  }}
                >
                  加入上下文…
                </MenuItem>
              </Menu>
            </div>,
            document.body,
          )
        : null}

      {/* Rules & Commands modal (Cursor-like) */}
      <Modal
        open={rulesOpen}
        title="规则与命令"
        ariaLabel="规则与命令"
        onClose={() => setRulesOpen(false)}
        footer={
          <>
            <Button type="button" onClick={() => setRulesOpen(false)}>
              关闭
            </Button>
            <Button
              variant="primary"
              type="button"
              disabled={rulesLoading}
              onClick={() => {
                void (async () => {
                  try {
                    setRulesErr('')
                    setRulesLoading(true)
                    const sid = (activeSpaceId || '').trim() || 'host_config_v1'
                    await apiRulesSave({
                      spaceId: sid,
                      userRules: userRulesDraft,
                      projectRules: projectRulesDraft,
                      commands: commandsDraft,
                    })
                    setToast({ id: uid('t'), message: '已保存规则与命令' })
                    setRulesOpen(false)
                  } catch (e) {
                    setRulesErr(e instanceof Error ? e.message : String(e))
                  } finally {
                    setRulesLoading(false)
                  }
                })()
              }}
            >
              {rulesLoading ? '保存中…' : '保存'}
            </Button>
          </>
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className={rulesTab === 'user' ? 'tab active' : 'tab'} onClick={() => setRulesTab('user')}>
              用户规则
            </button>
            <button
              type="button"
              className={rulesTab === 'project' ? 'tab active' : 'tab'}
              onClick={() => setRulesTab('project')}
            >
              项目规则
            </button>
            <button
              type="button"
              className={rulesTab === 'commands' ? 'tab active' : 'tab'}
              onClick={() => setRulesTab('commands')}
            >
              命令
            </button>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            当前项目：{activeSpaceName || '资产管理'}（spaceId: {(activeSpaceId || '').trim() || 'host_config_v1'}）
          </div>
        </div>

        {rulesErr ? <div style={{ marginTop: 10, color: 'rgba(255,120,120,0.95)', fontSize: 12 }}>{rulesErr}</div> : null}
        {rulesLoading ? <div style={{ marginTop: 10, opacity: 0.75, fontSize: 12 }}>加载中…</div> : null}

        <div style={{ marginTop: 12 }}>
          {rulesTab === 'user' ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>对你所有项目生效（像 Cursor User Rules）。</div>
              <textarea
                className="fieldTextarea"
                style={{ minHeight: 220 }}
                value={userRulesDraft}
                onChange={(e) => setUserRulesDraft((e.target as HTMLTextAreaElement).value)}
                placeholder="例如：\n- 你是资深SRE，回答必须给出可执行命令\n- 不要编造命令输出，缺信息先请求执行命令\n"
              />
            </>
          ) : rulesTab === 'project' ? (
            <>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>仅对当前项目生效（像 Cursor Project Rules）。</div>
              <textarea
                className="fieldTextarea"
                style={{ minHeight: 220 }}
                value={projectRulesDraft}
                onChange={(e) => setProjectRulesDraft((e.target as HTMLTextAreaElement).value)}
                placeholder="例如：\n- 本项目默认目录为 /srv/www/codesprite\n- 发布走 /srv/www/codesprite/web，后端容器 codesprite-api\n"
              />
            </>
          ) : (
            <>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>便捷命令（MVP：纯文本，每行一条，AI 会作为快捷指令参考）。</div>
              <textarea
                className="fieldTextarea"
                style={{ minHeight: 220 }}
                value={commandsDraft}
                onChange={(e) => setCommandsDraft((e.target as HTMLTextAreaElement).value)}
                placeholder="例如：\ncheck_disk: df -h\ncheck_docker: docker ps -a\n"
              />
            </>
          )}
        </div>
      </Modal>

      {/* Admin: SSH audit modal (read-only) */}
      {auditOpen
        ? createPortal(
            <>
              <div className="modalOverlay" onClick={() => setAuditOpen(false)} aria-hidden="true" />
              <div className="modal" role="dialog" aria-modal="true" aria-label="SSH 审计">
                <div className="modalHeader">
                  <div className="modalTitle">SSH 审计（管理员）</div>
                  <button className="modalClose" type="button" onClick={() => setAuditOpen(false)} aria-label="关闭">
                    ✕
                  </button>
                </div>
                <div className="modalBody">
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <div className="field" style={{ margin: 0 }}>
                      <div className="fieldLabel">sessionId（可选）</div>
                      <input
                        className="fieldInput"
                        value={auditSessionIdFilter}
                        onChange={(e) => setAuditSessionIdFilter((e.target as HTMLInputElement).value)}
                        placeholder="ssh_..."
                      />
                    </div>
                    <div className="field" style={{ margin: 0 }}>
                      <div className="fieldLabel">eventType（可选）</div>
                      <select
                        className="fieldInput"
                        value={auditEventTypeFilter}
                        onChange={(e) => setAuditEventTypeFilter((e.target as HTMLSelectElement).value)}
                      >
                        <option value="">（全部）</option>
                        <option value="ssh_exec">ssh_exec</option>
                        <option value="files_list">files_list</option>
                        <option value="files_read">files_read</option>
                        <option value="files_write">files_write</option>
                        <option value="pty_lease_create">pty_lease_create</option>
                        <option value="pty_lease_end">pty_lease_end</option>
                        <option value="pty_open">pty_open</option>
                        <option value="pty_close">pty_close</option>
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Button
                        type="button"
                        onClick={() => {
                          const sid = String(activeConn?.sessionId || '').trim()
                          if (!sid) {
                            setToast({ id: uid('t'), message: '当前工作区未连接（无 sessionId）' })
                            return
                          }
                          setAuditSessionIdFilter(sid)
                          setAuditItems([])
                          setAuditCursor(null)
                          void loadAuditPage(true)
                        }}
                        disabled={!activeConn?.sessionId || auditLoading}
                        title="一键锁定当前工作区 sessionId"
                      >
                        当前工作区
                      </Button>
                      <Button
                        type="button"
                        onClick={() => {
                          setAuditItems([])
                          setAuditCursor(null)
                          void loadAuditPage(true)
                        }}
                        disabled={auditLoading}
                      >
                        {auditLoading ? '加载中…' : '刷新'}
                      </Button>
                      <Button type="button" onClick={() => void loadAuditPage(false)} disabled={auditLoading || !auditCursor}>
                        加载更多
                      </Button>
                      <Button
                        type="button"
                        onClick={() => {
                          try {
                            const txt = JSON.stringify(auditCursor || {}, null, 2)
                            void navigator.clipboard.writeText(txt)
                            setToast({ id: uid('t'), message: '已复制 nextCursor' })
                          } catch {
                            // ignore
                          }
                        }}
                        disabled={!auditCursor}
                      >
                        复制 nextCursor
                      </Button>
                    </div>
                  </div>

                  {auditErr ? <div style={{ marginTop: 10, color: 'rgba(255,120,120,0.95)', fontSize: 12 }}>{auditErr}</div> : null}
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                    items: {auditItems.length}
                    {auditCursor ? ` · nextCursor: ${String(auditCursor.beforeStartedAt || '')}/${String(auditCursor.beforeId || '').slice(0, 16)}` : ' · nextCursor: null'}
                  </div>

                  <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                    {(auditItems || []).slice(0, 200).map((it: any, idx: number) => {
                      const id = String(it?.id || '')
                      const et = String(it?.eventType || '')
                      const startedAt = it?.startedAt
                      const ok = it?.ok
                      const summary =
                        `${et}` +
                        (typeof startedAt === 'number' ? ` · ${new Date(startedAt).toISOString()}` : '') +
                        (ok === true ? ' · ok' : ok === false ? ' · fail' : '') +
                        (it?.durationMs ? ` · ${it.durationMs}ms` : '') +
                        (it?.exitCode !== null && it?.exitCode !== undefined ? ` · exit=${it.exitCode}` : '')
                      const body = JSON.stringify(it, null, 2)
                      return (
                        <div
                          key={id || `audit_${idx}`}
                          style={{
                            border: '1px solid #e2e8f0',
                            borderRadius: 10,
                            padding: 10,
                            background: '#f8fafc',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                            <div style={{ fontWeight: 700, fontSize: 12, opacity: 0.95 }}>{summary}</div>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={() => {
                                  try {
                                    void navigator.clipboard.writeText(id)
                                    setToast({ id: uid('t'), message: '已复制 id/runId' })
                                  } catch {
                                    // ignore
                                  }
                                }}
                                title="复制 id/runId"
                                disabled={!id}
                              >
                                复制ID
                              </button>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={() => {
                                  try {
                                    const hashes = [it?.cmdHash, it?.pathHash, it?.cwdHash].filter(Boolean).join('\n')
                                    if (!hashes) return
                                    void navigator.clipboard.writeText(String(hashes))
                                    setToast({ id: uid('t'), message: '已复制 hashes' })
                                  } catch {
                                    // ignore
                                  }
                                }}
                                title="复制 cmdHash/pathHash/cwdHash（便于日志/DB 关联检索）"
                                disabled={!(it?.cmdHash || it?.pathHash || it?.cwdHash)}
                              >
                                复制hash
                              </button>
                              <button
                                className="miniBtn"
                                type="button"
                                onClick={() => {
                                  try {
                                    void navigator.clipboard.writeText(body)
                                    setToast({ id: uid('t'), message: '已复制 JSON' })
                                  } catch {
                                    // ignore
                                  }
                                }}
                                title="复制整条 JSON"
                              >
                                复制JSON
                              </button>
                            </div>
                          </div>
                          <div style={{ marginTop: 6, fontSize: 12, whiteSpace: 'pre-wrap', opacity: 0.9 }}>{body}</div>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="modalFooter">
                  <Button type="button" onClick={() => setAuditOpen(false)}>
                    关闭
                  </Button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* Workspace: confirm modal for destructive chat operations (avoid browser confirm). */}
      {wsChatConfirm?.type === 'clear_chat'
        ? createPortal(
            <>
              <div
                className="modalOverlay"
                onMouseDown={(e) => e.preventDefault()}
                // Do NOT close on overlay click (Cursor-like): avoid accidental dismiss.
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                aria-hidden="true"
              />
              <div className="modal modalCompact" role="dialog" aria-modal="true" aria-label="清空聊天确认">
                <div className="modalHeader">
                  <div className="modalTitle">清空当前聊天记录</div>
                  <button className="btn" type="button" onClick={() => setWsChatConfirm(null)} title="关闭">
                    X
                  </button>
                </div>
                <div className="modalBody">
                  <div className="workCardText modalHintText">
                    这会清空当前会话的聊天消息记录，且无法撤销。
                  </div>
                </div>
                <div className="modalFooter modalFooterCompact">
                  <button className="btn" type="button" onClick={() => setWsChatConfirm(null)}>
                    取消
                  </button>
                  <button
                    className="btn btnDanger"
                    type="button"
                    onClick={() => {
                      setWsChatConfirm(null)
                      doClearActiveChatMessages()
                    }}
                  >
                    清空聊天
                  </button>
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* Dashboard drawer (right side) */}
      {dashDrawer.open
        ? createPortal(
            <>
              <div
                className="dashDrawerOverlay"
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={() => setDashDrawer({ open: false })}
                aria-hidden="true"
              />
              <div className="dashDrawer" role="dialog" aria-modal="true">
                <div className="dashDrawerHeader">
                  <div className="dashDrawerTitle">
                    {dashDrawer.type === 'create_workspace'
                      ? '创建工作区'
                      : dashDrawer.type === 'host_detail'
                        ? '主机详情'
                        : '工作区详情'}
                  </div>
                  <button className="dashDrawerClose" type="button" onClick={() => setDashDrawer({ open: false })} aria-label="关闭">
                    ✕
                  </button>
                </div>
                <div className="dashDrawerBody">
                  {dashDrawer.type === 'create_workspace' ? (
                    <div className="workCardText">
                      {'（待按文档 §3.3.6 落地：选择主机/名称/rootPath，创建并打开，成功后 Toast + 列表高亮）'}
                    </div>
                  ) : dashDrawer.type === 'host_detail' ? (
                    <div className="workCardText">{`hostId=${dashDrawer.hostId}`}</div>
                  ) : (
                    <div className="workCardText">{`workspaceId=${dashDrawer.workspaceId}`}</div>
                  )}
                </div>
              </div>
            </>,
            document.body,
          )
        : null}

      {/* P0 remote drawer removed: connect goes straight to workspace split-view */}

      {/* Toast (bottom-right) */}
      {toast
        ? createPortal(
            <div className="toastWrap" role="status" aria-live="polite">
              <div className="toast">
                <div className="toastMsg">{toast.message}</div>
                {toast.actionLabel && toast.onAction ? (
                  <button
                    className="toastAction"
                    type="button"
                    onClick={() => {
                      const cb = toast.onAction as (() => void)
                      setToast(null)
                      cb()
                    }}
                  >
                    {toast.actionLabel}
                  </button>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

function HostEditor(props: {
  title: ReactNode
  host: Host | null
  groups: Group[]
  tags: Tag[]
  credential: Credential | null
  onTestConnection: (input: { address: string; port: number }) => Promise<{ success: boolean; latencyMs: number | null; os: string; error: string }>
  onCancel: () => void
  onSave: (
    draft: {
      id?: ID
      name: string
      address: string
      port: number
      user: string
      os?: 'linux' | 'windows'
      description?: string
      groupId: ID | null
      tagNames: string[]
      favorite?: boolean
      credentialId?: ID | null
      lastConnectedAt?: number | null
      createdAt?: number
      deletedAt?: number | null
    },
    authType: HostAuthType,
  ) => void
  onSaveAndConnect: (
    draft: {
      id?: ID
      name: string
      address: string
      port: number
      user: string
      os?: 'linux' | 'windows'
      description?: string
      groupId: ID | null
      tagNames: string[]
      favorite?: boolean
      credentialId?: ID | null
      lastConnectedAt?: number | null
      createdAt?: number
      deletedAt?: number | null
    },
    authType: HostAuthType,
    secrets: { password?: string; privateKey?: string; passphrase?: string },
  ) => void
}) {
  const { title, host, groups, tags, credential, onCancel, onSave, onSaveAndConnect, onTestConnection } = props

  const DRAFT_KEY_PREFIX = 'codesprite_host_editor_draft_v2'
  const LAST_OS_KEY = 'codesprite_host_editor_draft_v2_last_os'
  const lastUserKey = (os: 'linux' | 'windows') => `${DRAFT_KEY_PREFIX}:last_user:${os}`
  const draftKey = (os: 'linux' | 'windows', user: string) => `${DRAFT_KEY_PREFIX}:${os}:${user || '_'}`

  const [address, setAddress] = useState(host?.address ?? '')
  const [name, setName] = useState(host?.name ?? '')
  const initialOs = ((host as any)?.os === 'windows' ? 'windows' : 'linux') as 'linux' | 'windows'
  const [os, setOs] = useState<'linux' | 'windows'>(() => {
    if (host?.id) return initialOs
    try {
      const v = String(localStorage.getItem(LAST_OS_KEY) || '').trim()
      if (v === 'linux' || v === 'windows') return v as any
    } catch {
      // ignore
    }
    return initialOs
  })
  const [port, setPort] = useState<number>(() => {
    const hp = (host as any)?.port
    const p = typeof hp === 'number' && Number.isFinite(hp) ? hp : undefined
    if (p && p >= 1 && p <= 65535) return p
    // NOTE: "资产管理" 的远程能力（命令/文件/终端）目前走 SSH/SFTP。
    // Windows 若要支持同样能力，推荐启用 OpenSSH Server（默认 22）。
    return 22
  })
  const portTouchedRef = useRef(false)
  const [user, setUser] = useState((host?.user ?? (host as any)?.username ?? '') as string)
  const [groupId, setGroupId] = useState<ID | ''>(() => {
    const existing = (host?.groupId as ID) ?? ''
    if (existing) return existing
    try {
      const pre = sessionStorage.getItem('host_config_preselect_group') as ID | null
      if (pre) return pre
    } catch {
      // ignore
    }
    return ''
  })
  const [tagNames, setTagNames] = useState<string[]>(() => {
    if (!host) return []
    const byId = new Map(tags.map((t) => [t.id, t]))
    return (host.tagIds || []).map((id) => byId.get(id)?.name ?? '').filter(Boolean)
  })
  const [tagInput, setTagInput] = useState('')
  const [description, setDescription] = useState<string>(() => ((host as any)?.description as string) || '')
  const [auth, setAuth] = useState<HostAuthType>((credential?.type as HostAuthType) ?? 'none')
  const [showPassword, setShowPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [sshKeyText, setSshKeyText] = useState('')
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs?: number; os?: string; error?: string } | null>(null)
  const [testDetailsOpen, setTestDetailsOpen] = useState(false)
  const [err, setErr] = useState<string>('')
  const [copiedHint, setCopiedHint] = useState<string>('')
  const windowsGuideEnabled = WINDOWS_SSH_GUIDE_ENABLED
  const [winProbeBusy, setWinProbeBusy] = useState(false)
  const [winProbeResult, setWinProbeResult] = useState<{ ok: boolean; latencyMs?: number; os?: string; error?: string } | null>(null)
  const [winProbeDetailOpen, setWinProbeDetailOpen] = useState(false)

  // Windows: allow SSH auth types too (OpenSSH Server on Windows).

  const groupsSorted = useMemo(() => groups.slice().sort((a, b) => a.sort - b.sort), [groups])

  const addrTrim = address.trim()
  const isAddrValid = useMemo(() => {
    // Rule (as user expects): if it looks like an IP (only digits + '.'), it MUST be a valid IPv4.
    // Hostname is allowed only when it contains letters or '-'.
    if (!addrTrim) return false
    const looksLikeIpv4 = /^[0-9.]+$/.test(addrTrim)
    if (looksLikeIpv4) return isValidIPv4(addrTrim)
    return isValidHostname(addrTrim)
  }, [addrTrim])

  const canSubmit = useMemo(() => {
    const a = addrTrim
    const u = user.trim()
    const p = Number(port)
    if (!a) return false
    if (!isAddrValid) return false
    if (!Number.isInteger(p) || p < 1 || p > 65535) return false
    if (!u) return false
    if (u.length > 32) return false
    const n = name.trim()
    if (n && n.length > 60) return false
    return true
  }, [addrTrim, isAddrValid, port, user, name])

  const canTest = useMemo(() => {
    const a = addrTrim
    const p = Number(port)
    if (!a) return false
    if (!isAddrValid) return false
    if (!Number.isInteger(p) || p < 1 || p > 65535) return false
    if (p !== 22) return false
    return true
  }, [addrTrim, isAddrValid, port])

  // Draft caching (new hosts only). Keyed by OS + username (no secrets).
  useEffect(() => {
    if (host?.id) return
    try {
      const lastU = String(localStorage.getItem(lastUserKey(os)) || '').trim()
      const raw = String(localStorage.getItem(draftKey(os, lastU)) || '') || String(localStorage.getItem(draftKey(os, '_')) || '')
      if (!raw) return
      const j = JSON.parse(raw) as any
      if (!address && j?.address) setAddress(String(j.address || ''))
      if (!name && j?.name) setName(String(j.name || ''))
      if (!user && j?.user) setUser(String(j.user || ''))
      if (!portTouchedRef.current) {
        const p = Number(j?.port)
        if (Number.isFinite(p) && p >= 1 && p <= 65535) setPort(p)
      }
    } catch {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (host?.id) return
    try {
      localStorage.setItem(LAST_OS_KEY, os)
    } catch {
      // ignore
    }
    const u = user.trim()
    try {
      if (u) localStorage.setItem(lastUserKey(os), u)
    } catch {
      // ignore
    }
    try {
      localStorage.setItem(draftKey(os, u || '_'), JSON.stringify({ address, name, user, os, port }))
    } catch {
      // ignore
    }
  }, [host?.id, address, name, user, os, port])

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedHint(`已复制：${label}`)
      window.setTimeout(() => setCopiedHint(''), 1200)
    } catch {
      window.prompt(label, text)
    }
  }

  const windowsOpenSshScript = useMemo(() => {
    return [
      '# 以管理员身份运行 PowerShell',
      '$ErrorActionPreference = "Stop"',
      '',
      '# 安装 OpenSSH Server（如已安装则跳过）',
      'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
      '',
      '# 启动并设为开机自启',
      'Start-Service sshd',
      'Set-Service -Name sshd -StartupType Automatic',
      '',
      '# 放行 22 端口（Windows 防火墙）',
      'if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {',
      '  New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22',
      '}',
      '',
      '# 查看状态',
      'Get-Service sshd',
      'Get-NetTCPConnection -LocalPort 22 -State Listen | Select-Object -First 5',
      '',
      '# 提示：云主机还需要在安全组/防火墙放行 TCP 22（公网/内网按需）',
    ].join('\n')
  }, [])

  async function probeWindowsOpenSsh22() {
    const a = address.trim()
    if (!a) return setErr('请先填写主机地址')
    if (!isAddrValid) return setErr('主机地址不合法：请输入正确的 IPv4（如 192.168.1.100）')
    if (!user.trim()) return setErr('请先填写用户名')
    setErr('')
    setWinProbeResult(null)
    setWinProbeDetailOpen(false)
    setWinProbeBusy(true)
    try {
      const r = await onTestConnection({ address: a, port: 22 })
      setWinProbeResult(r.success ? { ok: true, latencyMs: r.latencyMs ?? undefined, os: r.os } : { ok: false, error: r.error || '未检测到 SSH' })
    } catch (e: any) {
      const msg = typeof e?.message === 'string' && e.message.trim() ? e.message.trim() : '未检测到 SSH'
      setWinProbeResult({ ok: false, error: msg.slice(0, 160) })
    } finally {
      setWinProbeBusy(false)
    }
  }

  function submitSave() {
    const n = name.trim()
    const a = address.trim()
    const u = user.trim()
    const p = Number(port)

    if (!a) return setErr('主机地址不能为空')
    if (!isAddrValid) return setErr('主机地址不合法：请输入正确的 IPv4（如 192.168.1.100）')
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setErr('端口不合法（1~65535）')
    if (!u) return setErr('用户名不能为空')
    if (u.length > 32) return setErr('用户名过长（最多 32）')
    if (n && n.length > 60) return setErr('显示名称过长（最多 60）')

    const tagsFinal = tagNames.map((x) => x.trim()).filter(Boolean).slice(0, 40)

    onSave(
      {
        id: host?.id,
        name: n || a,
        address: a,
        port: p,
        user: u,
        os,
        description: description.trim(),
        groupId: groupId || null,
        tagNames: tagsFinal,
        favorite: host?.favorite ?? false,
        credentialId: host?.credentialId ?? null,
        lastConnectedAt: host?.lastConnectedAt ?? null,
        createdAt: host?.createdAt,
        deletedAt: host?.deletedAt ?? null,
      },
      auth,
    )
  }

  function submitSaveAndConnect() {
    const n = name.trim()
    const a = address.trim()
    const u = user.trim()
    const p = Number(port)

    if (!a) return setErr('主机地址不能为空')
    if (!isAddrValid) return setErr('主机地址不合法：请输入正确的 IPv4（如 192.168.1.100）')
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setErr('端口不合法（1~65535）')
    if (!u) return setErr('用户名不能为空')
    if (u.length > 32) return setErr('用户名过长（最多 32）')
    if (n && n.length > 60) return setErr('显示名称过长（最多 60）')

    const tagsFinal = tagNames.map((x) => x.trim()).filter(Boolean).slice(0, 40)

    onSaveAndConnect(
      {
        id: host?.id,
        name: n || a,
        address: a,
        port: p,
        user: u,
        os,
        description: description.trim(),
        groupId: groupId || null,
        tagNames: tagsFinal,
        favorite: host?.favorite ?? false,
        credentialId: host?.credentialId ?? null,
        lastConnectedAt: host?.lastConnectedAt ?? null,
        createdAt: host?.createdAt,
        deletedAt: host?.deletedAt ?? null,
      },
      auth,
      {
        password: auth === 'password' ? password : undefined,
        privateKey: auth === 'ssh_key' ? sshKeyText : undefined,
        passphrase: auth === 'ssh_key' ? sshKeyPassphrase : undefined,
      },
    )
  }

  async function testConnection() {
    const a = address.trim()
    const p = Number(port)
    if (!a) return setErr('请先填写主机地址')
    if (!isAddrValid) return setErr('主机地址不合法：请输入正确的 IPv4（如 192.168.1.100）')
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setErr('请先填写正确端口')
    if (p !== 22) return setErr('测试连接目前仅支持端口 22（OpenSSH）')
    setErr('')
    setTestResult(null)
    setTesting(true)
    try {
      const r = await onTestConnection({ address: a, port: p })
      setTestResult(r.success ? { ok: true, latencyMs: r.latencyMs ?? undefined, os: r.os } : { ok: false, error: r.error || '连接失败' })
      setTestDetailsOpen(false)
    } catch (e: any) {
      const msg = typeof e?.message === 'string' && e.message.trim() ? e.message.trim() : '连接失败'
      setTestResult({ ok: false, error: msg.slice(0, 160) })
      setTestDetailsOpen(false)
    } finally {
      setTesting(false)
    }
  }

  function addTagFromInput() {
    const v = tagInput.trim()
    if (!v) return
    if (tagNames.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setTagInput('')
      return
    }
    setTagNames((arr) => [...arr, v].slice(0, 40))
    setTagInput('')
  }

  // clear one-shot preselect after first render
  useEffect(() => {
    try {
      sessionStorage.removeItem('host_config_preselect_group')
    } catch {
      // ignore
    }
  }, [])

  return (
    <>
      <div className="modalHeader">
        <div className="modalTitle">{title}</div>
        <IconButton type="button" variant="ghost" onClick={onCancel} title={'\u5173\u95ed'} aria-label={'\u5173\u95ed'}>
          ×
        </IconButton>
      </div>
      <div className="modalBody">
        <div style={{ display: 'grid', gap: 14 }}>
          {/* 基础信息 */}
          <div className="modalSection">
            <div className="modalSectionTitle">{'基础信息'}</div>
        <div className="formGrid">
          <div className="field">
                <div className="fieldLabel">{'主机地址（Host/IP） *'}</div>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.100" />
                {addrTrim && !isAddrValid ? (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,120,120,0.95)' }}>
                    主机 IP 不合法（示例：192.168.1.100）
                  </div>
                ) : null}
          </div>
          <div className="field">
                <div className="fieldLabel">{'端口（Port）'}</div>
                <Input
                  value={String(port)}
                  onChange={(e) => {
                    portTouchedRef.current = true
                    setPort(Number(e.target.value))
                  }}
                  inputMode="numeric"
                  placeholder="22"
                />
                {os === 'windows' && (Number(port) === 5985 || Number(port) === 5986) ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,210,120,0.95)', lineHeight: 1.5 }}>
                    {'看起来是历史 WinRM 端口（5985/5986）。资产管理的命令/文件能力走 SSH/SFTP，建议改为 22（OpenSSH）。 '}
                    <button
                      type="button"
                      onClick={() => {
                        portTouchedRef.current = true
                        setPort(22)
                      }}
                      style={{
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'rgba(180,220,255,0.95)',
                        fontWeight: 800,
                        padding: 0,
                      }}
                    >
                      {'改成 22'}
                    </button>
                  </div>
                ) : null}
          </div>
          <div className="field">
                <div className="fieldLabel">{'显示名称（Display Name）'}</div>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Web-Server-01" />
          </div>
          <div className="field">
                <div className="fieldLabel">{'操作系统（OS）'}</div>
                <Select
                  value={os}
                  onChange={(e) => {
                    const next = e.target.value as 'linux' | 'windows'
                    setOs(next)
                    // UX: switch default ports for common protocols, but don't overwrite user edits / existing hosts.
                    if (!host?.id && !portTouchedRef.current) {
                      setPort(22)
                    }
                  }}
                >
                  <option value="linux">{'Linux'}</option>
                  <option value="windows">{'Windows'}</option>
                </Select>
          </div>
            </div>
          </div>

          {windowsGuideEnabled && os === 'windows' && (Number(port) === 22 || !portTouchedRef.current) ? (
            <div className="modalSection">
              <div className="modalSectionTitle">{'Windows：启用 OpenSSH（仅需一次）'}</div>
              <div style={{ fontSize: 12, opacity: 0.82, lineHeight: 1.65 }}>
                要像 Linux 一样支持<strong>命令执行 / 文件浏览 / 终端</strong>，Windows 需要启用 OpenSSH Server（端口 22）。
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                <Button type="button" size="sm" variant="ghost" onClick={() => void copyText('一键启用脚本（PowerShell）', windowsOpenSshScript)}>
                  {'复制一键启用脚本（PowerShell）'}
                </Button>
                <Button type="button" size="sm" variant="primary" onClick={() => void probeWindowsOpenSsh22()} disabled={winProbeBusy || !isAddrValid || !user.trim()}>
                  {winProbeBusy ? '检测中…' : '测试 22 端口（OpenSSH）'}
                </Button>
                <a
                  href="/docs/windows-openssh-onboarding.md"
                  target="_blank"
                  rel="noreferrer"
                  style={{ alignSelf: 'center', fontSize: 12, opacity: 0.8, textDecoration: 'underline' }}
                >
                  查看完整指引
                </a>
                {copiedHint ? <div style={{ alignSelf: 'center', fontSize: 12, color: 'rgba(180,255,210,0.95)' }}>{copiedHint}</div> : null}
              </div>
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', fontWeight: 800, fontSize: 13 }}>{'展开脚本内容（PowerShell 管理员）'}</summary>
                <pre
                  style={{
                    marginTop: 10,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    borderRadius: 12,
                    border: '1px solid #e2e8f0',
                    background: '#f8fafc',
                    padding: 12,
                    fontSize: 12,
                    lineHeight: 1.55,
                  }}
                >
                  {windowsOpenSshScript}
                </pre>
              </details>

              {winProbeResult ? (
                <div style={{ marginTop: 10, fontSize: 12, color: winProbeResult.ok ? 'rgba(180,255,210,0.95)' : 'rgba(255,170,120,0.95)' }}>
                  {winProbeResult.ok
                    ? `✅ 已检测到 SSH${typeof winProbeResult.latencyMs === 'number' ? `（${winProbeResult.latencyMs}ms）` : ''}${winProbeResult.os ? ` · ${winProbeResult.os}` : ''}`
                    : '⚠️ 未检测到 SSH（请确认已启用 OpenSSH 且放行 22）'}
                  {!winProbeResult.ok && winProbeResult.error ? (
                    <button
                      type="button"
                      className="miniBtn"
                      style={{ marginLeft: 10 }}
                      onClick={() => setWinProbeDetailOpen((v) => !v)}
                      title="展开/收起详情"
                    >
                      {winProbeDetailOpen ? '收起详情' : '展开详情'}
                    </button>
                  ) : null}
                  {winProbeDetailOpen && winProbeResult.error ? (
                    <div style={{ marginTop: 8, opacity: 0.9, whiteSpace: 'pre-wrap' }}>{String(winProbeResult.error)}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 认证配置 */}
          <div className="modalSection">
            <div className="modalSectionTitle">{'认证配置'}</div>
            <div className="formGrid">
          <div className="field fieldSpan2">
                <div className="fieldLabel">{'用户名（Username） *'}</div>
                <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder={os === 'windows' ? 'Administrator' : 'root'} />
              </div>
              <div className="field fieldSpan2">
                <div className="fieldLabel">{'认证方式'}</div>
                <div className="auth-section">
                  <div className="auth-tabs" role="tablist" aria-label="认证方式">
                    <button
                      type="button"
                      className={auth === 'password' ? 'tab active' : 'tab'}
                      onClick={() => setAuth('password')}
                      role="tab"
                      aria-selected={auth === 'password'}
                    >
                      {'🔑 密码'}
                    </button>
                    <button
                      type="button"
                      className={auth === 'ssh_key' ? 'tab active' : 'tab'}
                      onClick={() => setAuth('ssh_key')}
                      role="tab"
                      aria-selected={auth === 'ssh_key'}
                    >
                      {'📄 SSH 私钥'}
                    </button>
                    <button
                      type="button"
                      className={auth === 'agent' ? 'tab active' : 'tab'}
                      onClick={() => setAuth('agent')}
                      role="tab"
                      aria-selected={auth === 'agent'}
                    >
                      {'🛰 跳板机/Agent'}
                    </button>
                  </div>

                  <div className="auth-content-box">
                    {auth === 'password' ? (
                      <div>
                        <div className="fieldLabel" style={{ marginBottom: 6 }}>
                          {'🔒 密码（Password）'}
                        </div>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                          <Input
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            type={showPassword ? 'text' : 'password'}
                            placeholder="请输入密码"
                          />
                          <Button type="button" variant="ghost" onClick={() => setShowPassword((v) => !v)} title="显示/隐藏">
                            {showPassword ? '🙈' : '👁️'}
                          </Button>
                        </div>
                        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                          {'注：当前版本仅保存认证方式，密码内容暂不持久化（后续可接入加密存储）。'}
                        </div>
                      </div>
                    ) : auth === 'ssh_key' ? (
                      <div className="key-input-group">
                        <div className="file-drop"
                          onDragOver={(e) => {
                            e.preventDefault()
                          }}
                          onDrop={async (e) => {
                            e.preventDefault()
                            const f = e.dataTransfer.files?.[0]
                            if (!f) return
                            const t = await f.text().catch(() => '')
                            if (t) setSshKeyText(t)
                          }}
                        >
                          <div style={{ fontWeight: 800 }}>{'📄 拖拽私钥文件到这里'}</div>
                          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                            {'支持 PEM / OpenSSH 格式'}
                          </div>
                          <label className="fileUploadBtn">
                            {'点击上传'}
                            <input
                              type="file"
                              accept=".pem,.key,text/plain"
                              onChange={async (e) => {
                                const f = e.target.files?.[0]
                                if (!f) return
                                const t = await f.text().catch(() => '')
                                if (t) setSshKeyText(t)
                              }}
                            />
                          </label>
                        </div>

                        <div style={{ marginTop: 10 }}>
                          <div className="fieldLabel" style={{ marginBottom: 6 }}>
                            {'或者粘贴内容…'}
                          </div>
                          <textarea
                            className="fieldTextarea"
                            style={{ minHeight: 120 }}
                            value={sshKeyText}
                            onChange={(e) => setSshKeyText(e.target.value)}
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                          />
                          <div style={{ marginTop: 8 }} className="formGrid">
                            <div className="field fieldSpan2">
                              <div className="fieldLabel">{'密码短语（Passphrase，可选）'}</div>
                              <Input
                                placeholder="选填…"
                                type="password"
                                value={sshKeyPassphrase}
                                onChange={(e) => setSshKeyPassphrase((e.target as HTMLInputElement).value)}
                              />
                            </div>
                          </div>
                          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
                            {'注：当前版本仅保存认证方式，私钥内容暂不持久化（后续可接入加密存储）。'}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize: 13, opacity: 0.8, lineHeight: 1.7 }}>
                        {'跳板机/Agent（占位）：后续可在此配置跳板机链路、ProxyCommand、SSH Agent 等。'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 管理属性 */}
          <div className="modalSection">
            <div className="modalSectionTitle">{'管理属性'}</div>
            <div className="formGrid">
              <div className="field">
                <div className="fieldLabel">{'分组（Group）'}</div>
                <Select value={groupId} onChange={(e) => setGroupId(e.target.value as ID | '')}>
              <option value="">{I18N.sshUntitledGroup}</option>
                  {groupsSorted.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </Select>
          </div>
              <div className="field">
                <div className="fieldLabel">{'标签（Tags）'}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  {tagNames.map((t) => (
                    <span
                      key={t}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 8px',
                        borderRadius: 999,
                        border: '1px solid #e2e8f0',
                        background: '#f8fafc',
                        fontSize: 12,
                      }}
                    >
                      {t}
                      <button
                        type="button"
                        onClick={() => setTagNames((arr) => arr.filter((x) => x !== t))}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          color: '#64748b',
                          fontWeight: 900,
                        }}
                        aria-label={`移除标签 ${t}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    className="fieldInput"
                    style={{ width: 140 }}
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    placeholder="+ 输入标签"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addTagFromInput()
                      }
                    }}
                  />
                  <Button type="button" size="sm" variant="ghost" onClick={addTagFromInput} disabled={!tagInput.trim()}>
                    {'添加'}
                  </Button>
                </div>
          </div>
          <div className="field fieldSpan2">
                <div className="fieldLabel">{'备注（Description）'}</div>
                <textarea
                  className="fieldTextarea"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="这是一个用于测试的节点..."
                />
              </div>
            </div>
          </div>
        </div>

        {/* Test connection detail (kept out of footer to avoid layout squeeze) */}
        {!testing && testResult && !testResult.ok && testResult.error ? (
          <div style={{ marginTop: 8 }}>
            <button type="button" className="miniBtn" onClick={() => setTestDetailsOpen((v) => !v)} title="展开/收起测试连接详情">
              {testDetailsOpen ? '收起测试连接详情' : '展开测试连接详情'}
            </button>
            {testDetailsOpen ? (
              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.9, whiteSpace: 'pre-wrap' }}>{String(testResult.error)}</div>
            ) : null}
          </div>
        ) : null}

        {err ? (
          <div style={{ color: 'rgba(255,120,120,0.95)', fontSize: 12, marginTop: 10 }}>{err}</div>
        ) : null}
      </div>
      <div className="modalFooter">
        <Button type="button" variant="ghost" onClick={() => void testConnection()} disabled={testing || !canTest}>
          {testing ? '测试中…' : '⚡ 测试连接'}
        </Button>
        {testResult ? (
          <div style={{ fontSize: 12, color: testResult.ok ? 'rgba(180,255,210,0.95)' : 'rgba(255,170,120,0.95)' }}>
            {testResult.ok
              ? `✅ 连接成功${typeof testResult.latencyMs === 'number' ? `（${testResult.latencyMs}ms）` : ''}${testResult.os ? ` · ${testResult.os}` : ''}`
              : '⚠️ 连接失败'}
          </div>
        ) : null}
        <div style={{ flex: 1 }} />
        <Button type="button" onClick={onCancel}>
          {'取消'}
        </Button>
        <Button type="button" onClick={submitSave} disabled={!canSubmit}>
          {'仅保存'}
        </Button>
        <Button variant="primary" type="button" onClick={submitSaveAndConnect} disabled={!canSubmit}>
          {'保存并连接主机'}
        </Button>
      </div>
    </>
  )
}

function BigDataEditor(props: {
  activeTab: 'host' | 'bigdata'
  onSwitchTab: (t: 'host' | 'bigdata') => void
  onCancel: () => void
  onSave: (v: { name: string; kind: BigDataKind; env: string; region: string; bucket: string }) => void
}) {
  const { activeTab, onSwitchTab, onCancel, onSave } = props
  const [name, setName] = useState('')
  const [kind, setKind] = useState<BigDataKind>('starrocks')
  const [env, setEnv] = useState('prod')
  const [region, setRegion] = useState('cn-shenzhen')
  const [bucket, setBucket] = useState<'emapreduce' | 'flinkCluster' | 'ungrouped'>(() => {
    if (kind === 'flink') return 'flinkCluster'
    if (kind === 'starrocks') return 'emapreduce'
    if (kind === 'dataworks') return 'emapreduce'
    return 'ungrouped'
  })

  useEffect(() => {
    // Keep a reasonable default grouping aligned with type.
    // Users can still override manually.
    setBucket((prev) => {
      if (kind === 'flink') return 'flinkCluster'
      if (kind === 'starrocks') return 'emapreduce'
      if (kind === 'dataworks') return 'emapreduce'
      // Keep user selection if they already changed it away from defaults.
      return prev === 'flinkCluster' || prev === 'emapreduce' ? 'ungrouped' : prev
    })
  }, [kind])

  const canSave = Boolean(name.trim())
  return (
    <>
      <div className="modalHeader">
        <div className="modalTitle">
          <div className="assetCreateTabs" role="tablist" aria-label="新增资产类型">
            <button
              type="button"
              className={activeTab === 'host' ? 'assetCreateTab assetCreateTabActive' : 'assetCreateTab'}
              onClick={() => onSwitchTab('host')}
              role="tab"
              aria-selected={activeTab === 'host'}
            >
              新增主机
            </button>
            <button
              type="button"
              className={activeTab === 'bigdata' ? 'assetCreateTab assetCreateTabActive' : 'assetCreateTab'}
              onClick={() => onSwitchTab('bigdata')}
              role="tab"
              aria-selected={activeTab === 'bigdata'}
            >
              新增大数据资产
            </button>
          </div>
        </div>
        <IconButton type="button" variant="ghost" onClick={onCancel} title={'关闭'} aria-label={'关闭'}>
          ×
        </IconButton>
      </div>

      <div className="modalBody">
        <div className="modalSection">
          <div className="modalSectionTitle">{'基础信息'}</div>
          <div className="formGrid">
            <div className="field">
              <div className="fieldLabel">{'名称（Name） *'}</div>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="flink-prod-01" />
            </div>
            <div className="field">
              <div className="fieldLabel">{'类型（Type）'}</div>
              <Select value={kind} onChange={(e) => setKind(e.target.value as BigDataKind)}>
                <option value="starrocks">StarRocks</option>
                <option value="flink">Flink</option>
                <option value="dataworks">DataWorks</option>
                <option value="other">其它</option>
              </Select>
            </div>

            <div className="field">
              <div className="fieldLabel">{'环境（Env）'}</div>
              <Input value={env} onChange={(e) => setEnv(e.target.value)} placeholder="prod / test / dev" />
            </div>
            <div className="field">
              <div className="fieldLabel">{'区域（Region）'}</div>
              <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="cn-shenzhen / us-west-1" />
            </div>

            <div className="field fieldSpan2">
              <div className="fieldLabel">{'归类（Bucket）'}</div>
              <Select value={bucket} onChange={(e) => setBucket(e.target.value as any)}>
                <option value="emapreduce">E-mapreduce（StarRocks / DataWorks）</option>
                <option value="flinkCluster">Flink 集群</option>
                <option value="ungrouped">未分组</option>
              </Select>
            </div>
          </div>
          <div className="modalHintText" style={{ marginTop: 10 }}>
            保存后会出现在左侧“大数据”列表中。默认会按类型归类（可手动调整），并建议补齐 env/region 便于筛选与排障。
          </div>
        </div>
      </div>

      <div className="modalFooter modalFooterCompact">
        <button className="btn" type="button" onClick={onCancel}>
          取消
        </button>
        <button
          className="btn btnPrimary"
          type="button"
          disabled={!canSave}
          onClick={() => {
            const n = name.trim()
            if (!n) return
            onSave({
              name: n,
              kind,
              env: (env || '').trim(),
              region: (region || '').trim(),
              bucket: String(bucket),
            })
          }}
        >
          保存
        </button>
      </div>
    </>
  )
}

function GroupManager(props: {
  groups: Group[]
  hosts: Host[]
  onClose: () => void
  onUpsert: (g: { id?: ID; name: string }) => void
  onDelete: (id: ID, strategy: { type: 'ungroup' } | { type: 'move'; targetGroupId: ID }) => void
  onMoveHosts: (hostIds: ID[], targetGroupId: ID | null) => void
  onReorder: (id: ID, dir: 'up' | 'down') => void
  onSetParent: (id: ID, parentId: ID | null) => void
}) {
  const { groups, hosts, onClose, onUpsert, onDelete, onMoveHosts, onReorder, onSetParent } = props

  const [q, setQ] = useState('')
  const [selectedId, setSelectedId] = useState<ID | null>(null)
  const [newName, setNewName] = useState('')
  const [rename, setRename] = useState<{ id: ID; name: string } | null>(null)
  const [deleteAsk, setDeleteAsk] = useState<{ id: ID; strategy: 'ungroup' | 'move'; targetId: ID | '' } | null>(
    null,
  )

  const groupsSorted = useMemo(() => groups.slice().sort((a, b) => a.sort - b.sort), [groups])
  const groupById = useMemo(() => new Map(groups.map((g) => [g.id, g])), [groups])

  const childrenByParent = useMemo(() => {
    const m = new Map<ID | null, Group[]>()
    for (const g of groups) {
      const p = (g.parentId ?? null) as ID | null
      const arr = m.get(p) || []
      arr.push(g)
      m.set(p, arr)
    }
    for (const [, arr] of m.entries()) arr.sort((a, b) => a.sort - b.sort)
    return m
  }, [groups])

  const hostCountByGroup = useMemo(() => {
    const c = new Map<ID, number>()
    for (const h of hosts) {
      if (!h.groupId) continue
      c.set(h.groupId, (c.get(h.groupId) || 0) + 1)
    }
    return c
  }, [hosts])

  const selected = selectedId ? groupById.get(selectedId) ?? null : null
  const selectedHosts = useMemo(() => (selectedId ? hosts.filter((h) => h.groupId === selectedId) : []), [hosts, selectedId])
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const checkedIds = useMemo(() => Object.entries(checked).filter(([, v]) => v).map(([k]) => k as ID), [checked])

  // selection is cleared explicitly when selecting another group

  const qLower = q.trim().toLowerCase()
  function matchGroup(g: Group) {
    if (!qLower) return true
    return g.name.toLowerCase().includes(qLower)
  }

  function renderTree(parentId: ID | null, indent = 0) {
    const arr = childrenByParent.get(parentId) || []
    return arr
      .filter(matchGroup)
      .map((g) => (
        <div key={g.id} style={{ marginLeft: indent ? 12 : 0 }}>
          <div
            className={g.id === selectedId ? 'treeItem treeItemActive' : 'treeItem'}
            onClick={() => {
              setSelectedId(g.id)
              setChecked({})
            }}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div>{g.name}</div>
            </div>
            <div className="badge">{hostCountByGroup.get(g.id) || 0}</div>
          </div>
          {renderTree(g.id, indent + 1)}
        </div>
      ))
  }

  return (
    <>
      <div className="modalHeader">
        <div className="modalTitle">{I18N.groupsTitle}</div>
        <button className="btn" type="button" onClick={onClose} title={'\u5173\u95ed'}>
          X
        </button>
      </div>

      <div className="modalBody">
        <div className="mgrGrid">
          <div className="mgrPane">
            <div className="mgrPaneTitle">{'\u5206\u7ec4\u6811'}</div>
            <div className="mgrToolbar">
              <input
                className="fieldInput"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={'\u641c\u7d22\u5206\u7ec4\u540d\u79f0\u2026'}
              />
            </div>
            <div className="mgrHint">{'\u70b9\u51fb\u5206\u7ec4\u67e5\u770b\u8be6\u60c5\u4e0e\u4e3b\u673a\u5f52\u5c5e'}</div>
            <div style={{ marginTop: 8 }}>{renderTree(null, 0)}</div>
          </div>

          <div className="mgrPane">
          <div className="mgrPaneTitle">{'\u5206\u7ec4\u8be6\u60c5'}</div>

            <div className="mgrRow">
              <input
                className="fieldInput"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={'\u65b0\u5efa\u9876\u7ea7\u5206\u7ec4\u540d\u79f0'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    const n = newName.trim()
                    if (!n) return
                    onUpsert({ name: n })
                    setNewName('')
                  }
                }}
              />
              <button
                className="btn btnPrimary"
                type="button"
                disabled={newName.trim().length === 0}
                onClick={() => {
                  const n = newName.trim()
                  if (!n) return
                  onUpsert({ name: n })
                  setNewName('')
                }}
              >
                {'\u65b0\u5efa'}
              </button>
            </div>

          {!selected ? (
              <div style={{ marginTop: 12 }} className="mgrHint">
                {'\u8bf7\u4ece\u5de6\u4fa7\u9009\u62e9\u4e00\u4e2a\u5206\u7ec4\u3002'}
              </div>
            ) : (
              <>
                <div style={{ marginTop: 12 }} className="mgrRowBetween">
                  <div style={{ fontWeight: 700 }}>{selected.name}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="miniBtn" type="button" onClick={() => onReorder(selected.id, 'up')}>
                      {'\u4e0a\u79fb'}
                    </button>
                    <button className="miniBtn" type="button" onClick={() => onReorder(selected.id, 'down')}>
                      {'\u4e0b\u79fb'}
                    </button>
                    <button
                      className="miniBtn"
                      type="button"
                      onClick={() => setRename({ id: selected.id, name: selected.name })}
                    >
                      {I18N.rename}
                    </button>
                    <button
                      className="miniBtn mgrDanger"
                      type="button"
                      onClick={() => setDeleteAsk({ id: selected.id, strategy: 'ungroup', targetId: '' })}
                    >
                      {I18N.remove}
                    </button>
                  </div>
                </div>

                <div style={{ marginTop: 10 }} className="mgrRow">
                  <div style={{ width: 110, fontSize: 12, color: 'var(--muted)' }}>{'\u7236\u7ea7'}</div>
                  <select
                    className="fieldSelect"
                    value={selected.parentId ?? ''}
                    onChange={(e) => onSetParent(selected.id, (e.target.value as ID) || null)}
                  >
                    <option value="">{'\u65e0\uff08\u9876\u7ea7\uff09'}</option>
                    {groupsSorted
                      .filter((g) => g.id !== selected.id && !g.parentId)
                      .map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                  </select>
                </div>

                {rename ? (
                  <div style={{ marginTop: 10 }} className="mgrRow">
                    <input
                      className="fieldInput"
                      value={rename.name}
                      onChange={(e) => setRename((p) => (p ? { ...p, name: e.target.value } : p))}
                    />
                    <button className="btn" type="button" onClick={() => setRename(null)}>
                      {I18N.sshCancel}
                    </button>
                    <button
                      className="btn btnPrimary"
                      type="button"
                      disabled={rename.name.trim().length === 0}
                      onClick={() => {
                        const n = rename.name.trim()
                        if (!n) return
                        onUpsert({ id: rename.id, name: n })
                        setRename(null)
                      }}
                    >
                      {I18N.sshSave}
                    </button>
                  </div>
                ) : null}

                <div style={{ marginTop: 14 }} className="mgrPaneTitle">
                  {'\u4e3b\u673a\u5f52\u5c5e'}
                </div>
                {selectedHosts.length === 0 ? (
                  <div className="mgrHint">{'\u8be5\u5206\u7ec4\u4e0b\u6682\u65e0\u4e3b\u673a\u3002'}</div>
                ) : (
                  <div className="mgrList">
                    {selectedHosts.map((h) => (
                      <div key={h.id} className="mgrHostItem">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <input
                            type="checkbox"
                            checked={Boolean(checked[h.id])}
                            onChange={(e) => setChecked((p) => ({ ...p, [h.id]: e.target.checked }))}
                          />
                          <div>
                            <div style={{ fontSize: 12, fontWeight: 650 }}>{h.name}</div>
                            <div className="mgrHostMeta">{`${h.user ? h.user + '@' : ''}${h.address}:${h.port}`}</div>
                          </div>
                        </div>
                        <button className="miniBtn" type="button" onClick={() => onMoveHosts([h.id], null)}>
                          {'\u79fb\u51fa\u5206\u7ec4'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {checkedIds.length > 0 ? (
                  <div className="mgrActionsRow">
                    <button className="btn" type="button" onClick={() => setChecked({})}>
                      {` \u5df2\u9009 ${checkedIds.length} \u4e2a \u00b7 \u6e05\u7a7a\u9009\u4e2d`}
                    </button>
                    <button className="btn" type="button" onClick={() => onMoveHosts(checkedIds, null)}>
                      {'\u6279\u91cf\u79fb\u51fa\u5206\u7ec4'}
                    </button>
                    <select
                      className="fieldSelect"
                      value=""
                      onChange={(e) => {
                        const v = e.target.value as ID
                        if (v) onMoveHosts(checkedIds, v)
                      }}
                      title={'\u6279\u91cf\u79fb\u52a8\u5230\u5176\u5b83\u5206\u7ec4'}
                    >
                      <option value="">{'\u6279\u91cf\u79fb\u52a8\u5230\u2026'}</option>
                      {groupsSorted.filter((g) => g.id !== selected.id).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {deleteAsk && deleteAsk.id === selected.id ? (
                  <div style={{ marginTop: 14, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
                    <div className="mgrPaneTitle mgrDanger">{'\u5220\u9664\u5206\u7ec4\u786e\u8ba4'}</div>
                    <div className="mgrHint">
                      {'\u5220\u9664\u5206\u7ec4\u4e0d\u4f1a\u5220\u9664\u4e3b\u673a\uff0c\u4f46\u9700\u8981\u9009\u62e9\u4e3b\u673a\u5f52\u5c5e\u5904\u7406\u65b9\u5f0f\u3002'}
                    </div>
                    <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="radio"
                          checked={deleteAsk.strategy === 'ungroup'}
                          onChange={() => setDeleteAsk((p) => (p ? { ...p, strategy: 'ungroup' } : p))}
                        />
                        {'\u79fb\u51fa\u5206\u7ec4\uff08\u9ed8\u8ba4\uff09'}
                      </label>
                      <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                          type="radio"
                          checked={deleteAsk.strategy === 'move'}
                          onChange={() => setDeleteAsk((p) => (p ? { ...p, strategy: 'move' } : p))}
                        />
                        {'\u79fb\u52a8\u5230\u6307\u5b9a\u5206\u7ec4'}
                      </label>
                      {deleteAsk.strategy === 'move' ? (
                        <select
                          className="fieldSelect"
                          value={deleteAsk.targetId}
                          onChange={(e) =>
                            setDeleteAsk((p) => (p ? { ...p, targetId: e.target.value as ID | '' } : p))
                          }
                        >
                          <option value="">{'\u9009\u62e9\u76ee\u6807\u5206\u7ec4\u2026'}</option>
                          {groupsSorted
                            .filter((g) => g.id !== selected.id)
                            .map((g) => (
                              <option key={g.id} value={g.id}>
                                {g.name}
                              </option>
                            ))}
                        </select>
                      ) : null}
                    </div>
                    <div className="mgrActionsRow">
                      <button className="btn" type="button" onClick={() => setDeleteAsk(null)}>
                        {I18N.sshCancel}
                      </button>
                      <button
                        className="btn btnDanger"
                        type="button"
                        disabled={deleteAsk.strategy === 'move' && !deleteAsk.targetId}
                        onClick={() => {
                          if (deleteAsk.strategy === 'move') {
                            onDelete(selected.id, { type: 'move', targetGroupId: deleteAsk.targetId as ID })
                          } else {
                            onDelete(selected.id, { type: 'ungroup' })
                          }
                          setDeleteAsk(null)
                          setSelectedId(null)
                        }}
                      >
                        {'\u786e\u8ba4\u5220\u9664'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="modalFooter">
        <button className="btn btnPrimary" type="button" onClick={onClose}>
          {'\u5b8c\u6210'}
        </button>
      </div>
    </>
  )
}

function TagManager(props: {
  tags: Tag[]
  onClose: () => void
  onUpsert: (t: { id?: ID; name: string }) => void
  onDelete: (id: ID) => void
}) {
  const { tags, onClose, onUpsert, onDelete } = props
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ id: ID; name: string } | null>(null)
  const [addErr, setAddErr] = useState<string>('')
  const sorted = useMemo(() => tags.slice().sort((a, b) => a.sort - b.sort), [tags])
  const canAdd = name.trim().length > 0

  function doAdd(opts?: { closeAfter?: boolean }) {
    const n = name.trim()
    if (!n) {
      setAddErr(I18N.nameRequired)
      return
    }
    setAddErr('')
    onUpsert({ name: n })
    setName('')
    if (opts?.closeAfter) onClose()
  }

  return (
    <>
      <div className="modalHeader">
        <div className="modalTitle">{I18N.tagsTitle}</div>
        <button className="btn" type="button" onClick={onClose} title={'\u5173\u95ed'}>
          X
        </button>
      </div>
      <div className="modalBody">
        <div className="field">
          <div className="fieldLabel">{'\u65b0\u5efa\u6807\u7b7e'}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <input
              className="fieldInput"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (addErr) setAddErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  doAdd({ closeAfter: false })
                }
              }}
              placeholder={'\u8bf7\u8f93\u5165\u6807\u7b7e\u540d\u79f0'}
            />
            <button
              className="btn"
              type="button"
              disabled={!canAdd}
              onClick={() => doAdd({ closeAfter: false })}
            >
              {'\u7ee7\u7eed\u6dfb\u52a0'}
            </button>
            <button
              className="btn btnPrimary"
              type="button"
              disabled={!canAdd}
              onClick={() => doAdd({ closeAfter: true })}
            >
              {'\u6dfb\u52a0\u5e76\u5173\u95ed'}
            </button>
          </div>
          {addErr ? <div style={{ marginTop: 6, color: 'rgba(255,120,120,0.95)', fontSize: 12 }}>{addErr}</div> : null}
        </div>

        <div className="detailCard" style={{ maxWidth: 'none', margin: 0, width: '100%' }}>
          {sorted.length === 0 ? (
            <div className="workCardText">{'\u6682\u65e0\u6807\u7b7e'}</div>
          ) : (
            sorted.map((t) => (
              <div key={t.id} className="detailRow" style={{ gridTemplateColumns: '1fr auto', alignItems: 'center' }}>
                <div className="detailValue">{t.name}</div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    className="miniBtn"
                    type="button"
                    onClick={() => setEditing({ id: t.id, name: t.name })}
                  >
                    {I18N.rename}
                  </button>
                  <button className="miniBtn" type="button" onClick={() => onDelete(t.id)}>
                    {I18N.remove}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {editing ? (
        <div className="modalFooter">
          <div style={{ flex: 1 }}>
            <input
              className="fieldInput"
              value={editing.name}
              onChange={(e) => setEditing((p) => (p ? { ...p, name: e.target.value } : p))}
            />
          </div>
          <button className="btn" type="button" onClick={() => setEditing(null)}>
            {I18N.sshCancel}
          </button>
          <button
            className="btn btnPrimary"
            type="button"
            onClick={() => {
              const n = editing.name.trim()
              if (!n) return
              onUpsert({ id: editing.id, name: n })
              setEditing(null)
            }}
          >
            {I18N.sshSave}
          </button>
        </div>
      ) : (
        <div className="modalFooter">
          <button className="btn btnPrimary" type="button" onClick={onClose}>
            {'\u5b8c\u6210'}
          </button>
        </div>
      )}
    </>
  )
}


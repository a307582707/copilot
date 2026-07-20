import type { ClientStateV2, ID, Asset } from './types'

export const HOST_CONFIG_KEY = 'host_config_v2'
const LEGACY_KEY_V1 = 'host_config_v1'

export function hostConfigKey(spaceId?: string): string {
  const s = (spaceId || '').trim()
  if (!s) return HOST_CONFIG_KEY
  // Backward/bug-compat: some UI code may accidentally use the storage key as a space id.
  // In that case, read/write the canonical root key instead of creating "host_config_v2__host_config_v2".
  if (s === HOST_CONFIG_KEY) return HOST_CONFIG_KEY
  return `${HOST_CONFIG_KEY}__${s}`
}

function emptyState(): ClientStateV2 {
  return { 
    version: 2, 
    activeWorkspaceId: null, 
    assets: [], 
    workspaces: [], 
    tags: [], 
    credentials: [],
    groups: [],
    hosts: [],
    activeHostId: null,
    // Extra fields (kept via index signature); important for asset sidebar demo.
    bigDataAssets: [],
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function asStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asBool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}

export function fixHostConfigState(state: ClientStateV2): ClientStateV2 {
  const assetIds = new Set(state.assets.map((a) => a.id))
  const tagIds = new Set(state.tags.map((t) => t.id))
  const credIds = new Set(state.credentials.map((c) => c.id))

  const assets = state.assets.map((a) => {
    const tagIdsFixed = uniq((a.tagIds || []).filter((id) => tagIds.has(id)))
    const credentialId = a.credentialId && credIds.has(a.credentialId) ? a.credentialId : null
    return { ...a, tagIds: tagIdsFixed, credentialId }
  })

  // Filter workspaces that point to non-existent assets
  const workspaces = state.workspaces.filter(w => assetIds.has(w.assetId))

  const wsIds = new Set(workspaces.map(w => w.id))
  const activeWorkspaceId = state.activeWorkspaceId && wsIds.has(state.activeWorkspaceId) 
    ? state.activeWorkspaceId 
    : null

  // Ensure legacy aliases are preserved/synced
  const hosts = assets
  const activeHostId = state.activeHostId ?? null

  return { ...state, assets, workspaces, activeWorkspaceId, hosts, activeHostId }
}

function parseV2(raw: unknown): ClientStateV2 | null {
  if (!isObj(raw)) return null
  if (raw.version !== 2) return null

  const activeWorkspaceId = (asStr(raw.activeWorkspaceId) as ID | null) ?? null
  const activeHostId = (asStr(raw.activeHostId) as ID | null) ?? null

  const assets = Array.isArray(raw.assets) ? raw.assets : []
  const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : []
  const tags = Array.isArray(raw.tags) ? raw.tags : []
  const credentials = Array.isArray(raw.credentials) ? raw.credentials : []
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  const bigDataAssetsRaw = Array.isArray((raw as any).bigDataAssets) ? ((raw as any).bigDataAssets as any[]) : []
  // Support loading from legacy 'hosts' field if 'assets' is missing
  const legacyHosts = Array.isArray(raw.hosts) ? raw.hosts : []
  const finalAssetsRaw = assets.length > 0 ? assets : legacyHosts

  const finalAssets = finalAssetsRaw.filter(isObj).map((h: any) => {
    const username = asStr(h.username) ?? asStr(h.user) ?? ''
    return {
      id: asStr(h.id) ?? '',
      name: asStr(h.name) ?? '',
      address: asStr(h.address) ?? '',
      port: asNum(h.port) ?? 22,
      username: username,
      user: username, // Alias
      project: asStr(h.project) ?? undefined,
      env: (asStr(h.env) as any) ?? undefined,
      tagIds: Array.isArray(h.tagIds) ? h.tagIds.map(asStr).filter(Boolean) : [],
      credentialId: (asStr(h.credentialId) as ID | null) ?? null,
      status: (asStr(h.status) as any) ?? 'enabled',
      lastConnectedAt: asNum(h.lastConnectedAt),
      createdAt: asNum(h.createdAt) ?? Date.now(),
      updatedAt: asNum(h.updatedAt) ?? Date.now(),
      deletedAt: asNum(h.deletedAt),
      groupId: (asStr(h.groupId) as ID | null) ?? null // Legacy
    }
  })

  return {
    version: 2,
    activeWorkspaceId,
    activeHostId,
    assets: finalAssets,
    // Alias hosts to assets
    hosts: finalAssets,
    workspaces: workspaces.filter(isObj).map((w: any) => ({
      id: asStr(w.id) ?? '',
      assetId: asStr(w.assetId) ?? '',
      name: asStr(w.name) ?? '',
      rootPath: asStr(w.rootPath) ?? '',
      pinned: asBool(w.pinned) ?? false,
      lastOpenedAt: asNum(w.lastOpenedAt),
      createdAt: asNum(w.createdAt) ?? Date.now(),
      updatedAt: asNum(w.updatedAt) ?? Date.now(),
    })),
    tags: tags.filter(isObj).map((t: any) => ({
      id: asStr(t.id) ?? '',
      name: asStr(t.name) ?? '',
      color: asStr(t.color) ?? undefined,
      sort: asNum(t.sort) ?? 0,
      createdAt: asNum(t.createdAt) ?? Date.now(),
      updatedAt: asNum(t.updatedAt) ?? Date.now(),
    })),
    credentials: credentials.filter(isObj).map((c: any) => ({
      id: asStr(c.id) ?? '',
      type: (asStr(c.type) as any) ?? 'none',
      encryptedPayload: asStr(c.encryptedPayload) ?? undefined,
      createdAt: asNum(c.createdAt) ?? Date.now(),
      updatedAt: asNum(c.updatedAt) ?? Date.now(),
    })),
    groups: groups.filter(isObj).map((g: any) => ({
      id: asStr(g.id) ?? '',
      name: asStr(g.name) ?? '',
      parentId: asStr(g.parentId),
      sort: asNum(g.sort) ?? 0,
      createdAt: asNum(g.createdAt) ?? Date.now(),
      updatedAt: asNum(g.updatedAt) ?? Date.now(),
    })),
    bigDataAssets: bigDataAssetsRaw
      .filter(isObj)
      .map((it: any) => {
        const component_key = asStr(it.component_key) ?? ''
        const bucketRaw = asStr(it.bucket)
        const bucket =
          bucketRaw === 'emapreduce' || bucketRaw === 'flinkCluster' || bucketRaw === 'ungrouped'
            ? bucketRaw
            : component_key.toLowerCase().includes('flink')
              ? 'flinkCluster'
              : component_key.toLowerCase().includes('starrocks')
                ? 'emapreduce'
                : 'ungrouped'
        return {
          id: asStr(it.id) ?? '',
          component_key,
          name: asStr(it.name) ?? '',
          bucket,
          env: asStr(it.env) ?? undefined,
          region: asStr(it.region) ?? undefined,
          createdAt: asNum(it.createdAt) ?? Date.now(),
          updatedAt: asNum(it.updatedAt) ?? Date.now(),
        }
      })
      .filter((it: any) => it.id && it.name),
  }
}

// Simple V1 -> V2 migration
function migrateV1(raw: any): ClientStateV2 | null {
  if (!isObj(raw) || raw.version !== 1) return null
  
  const v1Hosts = Array.isArray(raw.hosts) ? raw.hosts : []
  const v1Groups = Array.isArray(raw.groups) ? raw.groups : []
  const groupMap = new Map(v1Groups.map((g: any) => [g.id, g.name]))

  const assets: Asset[] = v1Hosts.filter(isObj).map((h: any) => {
    const project = h.groupId ? groupMap.get(h.groupId) : undefined
    const username = asStr(h.user) ?? ''
    return {
      id: asStr(h.id) ?? '',
      name: asStr(h.name) ?? '',
      address: asStr(h.address) ?? '',
      port: asNum(h.port) ?? 22,
      username: username,
      user: username, // Alias
      project: project, // Map group name to project
      env: undefined, // Default
      tagIds: Array.isArray(h.tagIds) ? h.tagIds.map(asStr).filter(Boolean) : [],
      credentialId: asStr(h.credentialId) ?? null,
      status: 'enabled',
      lastConnectedAt: asNum(h.lastConnectedAt),
      createdAt: asNum(h.createdAt) ?? Date.now(),
      updatedAt: asNum(h.updatedAt) ?? Date.now(),
      deletedAt: asNum(h.deletedAt),
      groupId: asStr(h.groupId) ?? null // Legacy
    }
  })

  // We don't automatically create workspaces from hosts in migration 
  // unless we want to "default" to something. 
  // Let's leave workspaces empty for now, user can create them.
  
  return {
    version: 2,
    activeWorkspaceId: null,
    activeHostId: null,
    assets,
    hosts: assets, // Alias
    workspaces: [],
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isObj).map((t: any) => ({
      id: t.id, name: t.name, color: t.color, sort: t.sort, createdAt: t.createdAt, updatedAt: t.updatedAt
    })) : [],
    credentials: Array.isArray(raw.credentials) ? raw.credentials.filter(isObj).map((c: any) => ({
      id: c.id, type: c.type, encryptedPayload: c.encryptedPayload, createdAt: c.createdAt, updatedAt: c.updatedAt
    })) : [],
    groups: v1Groups.filter(isObj).map((g: any) => ({
      id: g.id, name: g.name, parentId: g.parentId, sort: g.sort, createdAt: g.createdAt, updatedAt: g.updatedAt
    })),
  }
}

export function loadHostConfigState(spaceId?: string): ClientStateV2 {
  try {
    const rawV2 = localStorage.getItem(hostConfigKey(spaceId))
    if (rawV2) {
      const parsed = parseV2(JSON.parse(rawV2))
      if (parsed) return fixHostConfigState(parsed)
    }

    // Try V1
    const rawV1 = localStorage.getItem(LEGACY_KEY_V1)
    if (rawV1) {
      const migrated = migrateV1(JSON.parse(rawV1))
      if (migrated) {
        // Save immediately to V2 so we don't migrate every time
        saveHostConfigState(migrated, spaceId)
        return migrated
      }
    }

    return emptyState()
  } catch {
    return emptyState()
  }
}

export function saveHostConfigState(state: ClientStateV2, spaceId?: string) {
  try {
    localStorage.setItem(hostConfigKey(spaceId), JSON.stringify(state))
  } catch {
    // ignore
  }
}

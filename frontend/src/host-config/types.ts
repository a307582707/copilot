export type ID = string

export type HostAuthType = 'password' | 'ssh_key' | 'agent' | 'none'

export type AssetStatus = 'enabled' | 'disabled'

export type EnvType = 'dev' | 'test' | 'stage' | 'prod'

export type AssetType = 'linux' | 'windows'

export type WinrmConfig = {
  host: string
  port: number // 5985/5986
  transport?: 'http' | 'https'
  auth?: 'password' | 'ntlm' | 'kerberos'
  username?: string
}

export type Group = {
  id: ID
  name: string
  parentId?: ID | null
  sort: number
  createdAt: number
  updatedAt: number
}

export type Asset = {
  id: ID
  // owner_user_id (backend field, optional for local)
  type?: AssetType // default: linux (for backward compat)
  os?: 'linux' | 'windows' // legacy UI compatibility
  name: string // 1..60
  address: string // IP/hostname
  port: number // 1..65535
  username: string // ssh user
  user?: string // Legacy alias for username (used in App.tsx)
  
  winrm?: WinrmConfig

  project?: string // e.g. "crm-backend"
  env?: EnvType // e.g. "prod"
  
  tagIds: ID[]
  // tags (migrated from Tag object to just using IDs, or keeping Tag definition for metadata)
  
  credentialId?: ID | null

  status: AssetStatus
  
  lastConnectedAt?: number | null // ms
  createdAt: number
  updatedAt: number
  deletedAt?: number | null
  
  groupId?: ID | null // Legacy alias used in App.tsx logic?
  favorite?: boolean // Legacy alias for favorite (pinned in V2)
}

export type Workspace = {
  id: ID
  assetId: ID
  name: string
  rootPath: string // /srv/www/...
  pinned: boolean
  lastOpenedAt?: number | null
  createdAt: number
  updatedAt: number
}

// Keeping Tag for UI color/metadata management
export type Tag = {
  id: ID
  name: string
  color?: string
  sort: number
  createdAt: number
  updatedAt: number
}

export type Credential = {
  id: ID
  type: HostAuthType
  encryptedPayload?: string
  createdAt: number
  updatedAt: number
}

// Legacy Group support is removed in favor of Project/Env dimensions, 
// but we keep the type if we want to migrate gracefully or map it. 
// For this MVP redesign, we'll assume we can drop strict Group objects 
// and just use 'project' string on Asset.

export type ClientStateV2 = {
  version: 2
  activeWorkspaceId: ID | null
  assets: Asset[]
  workspaces: Workspace[]
  tags: Tag[]
  credentials: Credential[]
  // Legacy fields for backward compatibility - MUST be required to satisfy App.tsx strict usage
  groups: Group[]
  hosts: Asset[] // Legacy alias for assets
  activeHostId: ID | null // Legacy alias for active host selection in App.tsx
  
  // Index signature to allow loose typing for legacy fields during migration
  [key: string]: any
}

// Alias for backward compat if needed, or we just switch to V2
export type HostConfigState = ClientStateV2

-- MySQL 8.0 schema for saas_api (migrated from sqlite schema in saas_api/app/db.py)
-- Charset/Collation: utf8mb4 / utf8mb4_unicode_ci (matches docker-compose dev default)
-- Time fields: BIGINT epoch ms (keep behavior stable)

-- IMPORTANT
-- - Run this on an EMPTY database first.
-- - For existing DBs, prefer using a migration tool; this file is idempotent but not a full alter-migration system.

SET NAMES utf8mb4;
SET time_zone = '+08:00';

-- --- users / auth ---
CREATE TABLE IF NOT EXISTS users (
  id                BIGINT NOT NULL AUTO_INCREMENT,
  email             VARCHAR(190) NOT NULL,
  password_hash     VARCHAR(512) NOT NULL,
  password_salt     VARCHAR(128) NOT NULL,
  role              VARCHAR(20) NOT NULL DEFAULT 'user',
  phone             VARCHAR(32) NULL,
  phone_verified_at BIGINT NULL,
  display_name      VARCHAR(120) NULL,
  avatar_url        VARCHAR(500) NULL,
  wechat_openid     VARCHAR(128) NULL,
  wechat_unionid    VARCHAR(128) NULL,
  wechat_bound_at   BIGINT NULL,
  last_login_at     BIGINT NULL,
  last_login_ip     VARCHAR(64) NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_email (email),
  UNIQUE KEY uk_users_phone (phone),
  UNIQUE KEY uk_users_wechat_unionid (wechat_unionid),
  UNIQUE KEY uk_users_wechat_openid (wechat_openid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- login_challenges (for wechat qr / state management) ---
CREATE TABLE IF NOT EXISTS login_challenges (
  id           VARCHAR(80) NOT NULL,
  purpose      VARCHAR(32) NOT NULL DEFAULT 'login',
  channel      VARCHAR(20) NOT NULL,
  state_token  VARCHAR(120) NOT NULL,
  scene_token  VARCHAR(120) NULL,
  status       VARCHAR(20) NOT NULL,
  user_id      BIGINT NULL,
  redirect_uri VARCHAR(500) NULL,
  client_ip    VARCHAR(64) NULL,
  ua           TEXT NULL,
  meta_json    LONGTEXT NULL,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  consumed_at  BIGINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_challenges_state (state_token),
  KEY idx_challenges_status_created (status, created_at DESC),
  KEY idx_challenges_user_created (user_id, created_at DESC),
  CONSTRAINT fk_login_challenges_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- auth_audit (lightweight login logs) ---
CREATE TABLE IF NOT EXISTS auth_audit (
  id          VARCHAR(80) NOT NULL,
  user_id     BIGINT NULL,
  action_type VARCHAR(40) NOT NULL,
  result      VARCHAR(40) NOT NULL,
  identifier  VARCHAR(190) NULL,
  ip          VARCHAR(64) NULL,
  ua          TEXT NULL,
  created_at  BIGINT NOT NULL,
  detail_json LONGTEXT NULL,
  PRIMARY KEY (id),
  KEY idx_auth_audit_user_created (user_id, created_at DESC),
  KEY idx_auth_audit_action_created (action_type, created_at DESC),
  CONSTRAINT fk_auth_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- subscriptions ---
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id            BIGINT NOT NULL,
  status             VARCHAR(32) NOT NULL,
  trial_ends_at      BIGINT NULL,
  current_period_end BIGINT NULL,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_subscriptions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- recharge_orders ---
CREATE TABLE IF NOT EXISTS recharge_orders (
  id           VARCHAR(80) NOT NULL,
  user_id      BIGINT NOT NULL,
  channel      VARCHAR(32) NOT NULL,
  amount_cents BIGINT NOT NULL,
  status       VARCHAR(32) NOT NULL,
  note         TEXT NULL,
  proof_path   TEXT NULL,
  submitted_at BIGINT NULL,
  paid_at      BIGINT NULL,
  credited_at  BIGINT NULL,
  credited_by  BIGINT NULL,
  created_at   BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_recharge_user_created (user_id, created_at DESC),
  CONSTRAINT fk_recharge_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- ledger ---
CREATE TABLE IF NOT EXISTS ledger (
  id           VARCHAR(80) NOT NULL,
  user_id      BIGINT NOT NULL,
  entry_type   VARCHAR(40) NOT NULL,
  amount_cents BIGINT NOT NULL,
  period       VARCHAR(40) NULL,
  ref_id       VARCHAR(80) NULL,
  created_at   BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ledger_user_created (user_id, created_at DESC),
  UNIQUE KEY uk_ledger_user_type_ref (user_id, entry_type, ref_id),
  CONSTRAINT fk_ledger_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- sms_codes ---
CREATE TABLE IF NOT EXISTS sms_codes (
  id          BIGINT NOT NULL AUTO_INCREMENT,
  purpose     VARCHAR(40) NOT NULL,
  phone       VARCHAR(32) NOT NULL,
  user_id     BIGINT NULL,
  code_hash   VARCHAR(512) NOT NULL,
  code_salt   VARCHAR(128) NOT NULL,
  ip          VARCHAR(64) NULL,
  ua          TEXT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  consumed_at BIGINT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_sms_codes_phone_purpose_created (phone, purpose, created_at DESC),
  CONSTRAINT fk_sms_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- llm_usage ---
CREATE TABLE IF NOT EXISTS llm_usage (
  id                VARCHAR(80) NOT NULL,
  user_id           BIGINT NOT NULL,
  model             VARCHAR(80) NULL,
  upstream          VARCHAR(120) NULL,
  status            VARCHAR(32) NOT NULL,
  prompt_chars      INT NULL,
  completion_chars  INT NULL,
  prompt_tokens     INT NULL,
  completion_tokens INT NULL,
  cost_cents        BIGINT NULL,
  started_at        BIGINT NOT NULL,
  finished_at       BIGINT NULL,
  error             TEXT NULL,
  PRIMARY KEY (id),
  KEY idx_llm_usage_user_started (user_id, started_at DESC),
  CONSTRAINT fk_llm_usage_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- ssh_usage_daily ---
CREATE TABLE IF NOT EXISTS ssh_usage_daily (
  user_id          BIGINT NOT NULL,
  day              INT NOT NULL, -- YYYYMMDD
  sessions_created INT NOT NULL DEFAULT 0,
  ops              INT NOT NULL DEFAULT 0,
  updated_at       BIGINT NOT NULL,
  PRIMARY KEY (user_id, day),
  CONSTRAINT fk_ssh_usage_daily_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- ssh_audit ---
CREATE TABLE IF NOT EXISTS ssh_audit (
  id          VARCHAR(80) NOT NULL,
  user_id     BIGINT NOT NULL,
  session_id  VARCHAR(80) NULL,
  event_type  VARCHAR(40) NOT NULL,
  asset_name  VARCHAR(160) NULL,
  ssh_target  VARCHAR(240) NULL,
  cwd         VARCHAR(800) NULL,
  path        VARCHAR(1600) NULL,
  cmd         VARCHAR(4000) NULL,
  ok          TINYINT NULL,
  exit_code   INT NULL,
  timed_out   TINYINT NULL,
  stdout_len  INT NULL,
  stderr_len  INT NULL,
  started_at  BIGINT NOT NULL,
  finished_at BIGINT NULL,
  duration_ms INT NULL,
  error       VARCHAR(800) NULL,
  meta_json   LONGTEXT NULL,
  PRIMARY KEY (id),
  KEY idx_ssh_audit_user_started (user_id, started_at DESC),
  KEY idx_ssh_audit_session_started (session_id, started_at DESC),
  KEY idx_ssh_audit_type_started (event_type, started_at DESC),
  CONSTRAINT fk_ssh_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- inventory_state (host/asset inventory without secrets) ---
CREATE TABLE IF NOT EXISTS inventory_state (
  user_id    BIGINT NOT NULL,
  space_id   VARCHAR(80) NOT NULL,
  json       LONGTEXT NOT NULL,
  version    INT NOT NULL DEFAULT 2,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, space_id),
  KEY idx_inventory_state_user_updated (user_id, updated_at DESC),
  CONSTRAINT fk_inventory_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- inventory_credentials (encrypted payload, per-user) ---
CREATE TABLE IF NOT EXISTS inventory_credentials (
  id          VARCHAR(120) NOT NULL,
  user_id     BIGINT NOT NULL,
  kind        VARCHAR(20) NOT NULL, -- password | ssh_key
  enc_payload LONGTEXT NOT NULL,
  meta_json   LONGTEXT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_inventory_credentials_user_updated (user_id, updated_at DESC),
  CONSTRAINT fk_inventory_credentials_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- rules_state (per-user, per-space) ---
CREATE TABLE IF NOT EXISTS rules_state (
  user_id       BIGINT NOT NULL,
  space_id      VARCHAR(80) NOT NULL,
  user_rules    LONGTEXT NOT NULL,
  project_rules LONGTEXT NOT NULL,
  commands      LONGTEXT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (user_id, space_id),
  KEY idx_rules_state_user_updated (user_id, updated_at DESC),
  CONSTRAINT fk_rules_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- aiops_settings ---
CREATE TABLE IF NOT EXISTS aiops_settings (
  `key`       VARCHAR(190) NOT NULL,
  value       LONGTEXT NULL,
  updated_at  BIGINT NOT NULL,
  updated_by  BIGINT NULL,
  PRIMARY KEY (`key`),
  KEY idx_aiops_settings_updated (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- aiops asset sync runs / schedules ---
CREATE TABLE IF NOT EXISTS aiops_asset_sync_runs (
  id                VARCHAR(120) NOT NULL,
  cloud_account_key VARCHAR(80) NOT NULL,
  cli_account_id    VARCHAR(120) NOT NULL,
  region            VARCHAR(80) NOT NULL DEFAULT 'all',
  trigger_mode      VARCHAR(40) NOT NULL DEFAULT 'manual',
  status            VARCHAR(40) NOT NULL DEFAULT 'queued',
  started_at        BIGINT NULL,
  finished_at       BIGINT NULL,
  summary           TEXT NULL,
  error             LONGTEXT NULL,
  triggered_by      BIGINT NULL,
  created_at        BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_aiops_sync_runs_status (status, created_at DESC),
  KEY idx_aiops_sync_runs_account (cloud_account_key, created_at DESC),
  KEY idx_aiops_sync_runs_created (created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS aiops_asset_sync_schedules (
  id                VARCHAR(120) NOT NULL,
  cloud_account_key VARCHAR(80) NOT NULL,
  cli_account_id    VARCHAR(120) NOT NULL,
  region            VARCHAR(80) NOT NULL DEFAULT 'all',
  cron_expr         VARCHAR(120) NOT NULL DEFAULT '0 18 * * *',
  enabled           TINYINT NOT NULL DEFAULT 1,
  last_run_id       VARCHAR(120) NULL,
  last_run_at       BIGINT NULL,
  next_run_at       BIGINT NULL,
  updated_by        BIGINT NULL,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_aiops_sync_schedules_enabled (enabled, next_run_at ASC),
  KEY idx_aiops_sync_schedules_updated (updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --- overseas subscription operations ---
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id               VARCHAR(120) NOT NULL,
  provider         VARCHAR(40) NOT NULL,
  event_id         VARCHAR(160) NOT NULL,
  event_type       VARCHAR(80) NULL,
  order_id         VARCHAR(120) NULL,
  signature_valid  TINYINT NOT NULL DEFAULT 0,
  handled          TINYINT NOT NULL DEFAULT 0,
  payload_json     LONGTEXT NULL,
  received_at      BIGINT NOT NULL,
  handled_at       BIGINT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_payment_webhook_provider_event (provider, event_id),
  KEY idx_payment_webhook_received (received_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_refunds (
  id                VARCHAR(120) NOT NULL,
  order_id          VARCHAR(120) NOT NULL,
  provider          VARCHAR(40) NOT NULL,
  amount_cents      BIGINT NOT NULL,
  currency          VARCHAR(16) NULL,
  status            VARCHAR(40) NOT NULL,
  reason_code       VARCHAR(80) NULL,
  provider_ref      VARCHAR(160) NULL,
  created_by        BIGINT NULL,
  created_at        BIGINT NOT NULL,
  updated_at        BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_payment_refunds_provider_ref (provider, provider_ref),
  KEY idx_payment_refunds_order_created (order_id, created_at DESC),
  CONSTRAINT fk_payment_refunds_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_records (
  id                      VARCHAR(120) NOT NULL,
  user_id                 BIGINT NOT NULL,
  subscription_period_key VARCHAR(120) NULL,
  delivery_type           VARCHAR(80) NOT NULL,
  status                  VARCHAR(40) NOT NULL,
  region                  VARCHAR(80) NULL,
  device_limit            INT NULL,
  region_limit            INT NULL,
  config_version          INT NOT NULL DEFAULT 1,
  issued_at               BIGINT NULL,
  expires_at              BIGINT NULL,
  revoked_at              BIGINT NULL,
  updated_at              BIGINT NOT NULL,
  meta_json               LONGTEXT NULL,
  PRIMARY KEY (id),
  KEY idx_delivery_records_user_updated (user_id, updated_at DESC),
  KEY idx_delivery_records_status_updated (status, updated_at DESC),
  CONSTRAINT fk_delivery_records_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS device_registrations (
  id                 VARCHAR(120) NOT NULL,
  user_id            BIGINT NOT NULL,
  device_fingerprint VARCHAR(240) NOT NULL,
  first_seen_at      BIGINT NOT NULL,
  last_seen_at       BIGINT NOT NULL,
  status             VARCHAR(40) NOT NULL DEFAULT 'active',
  notes              TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_registrations_user_fp (user_id, device_fingerprint),
  KEY idx_device_registrations_user_seen (user_id, last_seen_at DESC),
  CONSTRAINT fk_device_registrations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS abuse_events (
  id            VARCHAR(120) NOT NULL,
  user_id       BIGINT NULL,
  category      VARCHAR(80) NOT NULL,
  severity      VARCHAR(40) NOT NULL,
  status        VARCHAR(40) NOT NULL,
  action_taken  VARCHAR(80) NULL,
  evidence_json LONGTEXT NULL,
  created_by    BIGINT NULL,
  created_at    BIGINT NOT NULL,
  resolved_at   BIGINT NULL,
  PRIMARY KEY (id),
  KEY idx_abuse_events_status_created (status, created_at DESC),
  KEY idx_abuse_events_user_created (user_id, created_at DESC),
  CONSTRAINT fk_abuse_events_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_abuse_events_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS node_inventory (
  id                 VARCHAR(120) NOT NULL,
  region             VARCHAR(80) NOT NULL,
  provider           VARCHAR(80) NOT NULL,
  status             VARCHAR(40) NOT NULL,
  capacity_limit     INT NOT NULL DEFAULT 0,
  active_users       INT NOT NULL DEFAULT 0,
  cost_monthly_cents BIGINT NOT NULL DEFAULT 0,
  latency_p50_ms     INT NOT NULL DEFAULT 0,
  online_rate        DECIMAL(6,4) NOT NULL DEFAULT 0,
  updated_at         BIGINT NOT NULL,
  meta_json          LONGTEXT NULL,
  PRIMARY KEY (id),
  KEY idx_node_inventory_region_updated (region, updated_at DESC),
  KEY idx_node_inventory_status_updated (status, updated_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS status_incidents (
  id          VARCHAR(120) NOT NULL,
  status      VARCHAR(40) NOT NULL,
  title       VARCHAR(255) NOT NULL,
  severity    VARCHAR(40) NOT NULL,
  scope_json  LONGTEXT NULL,
  message_md  LONGTEXT NULL,
  created_by  BIGINT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  resolved_at BIGINT NULL,
  PRIMARY KEY (id),
  KEY idx_status_incidents_updated (updated_at DESC, created_at DESC),
  CONSTRAINT fk_status_incidents_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id            VARCHAR(120) NOT NULL,
  actor_user_id BIGINT NULL,
  target_type   VARCHAR(80) NOT NULL,
  target_id     VARCHAR(120) NULL,
  action        VARCHAR(80) NOT NULL,
  before_json   LONGTEXT NULL,
  after_json    LONGTEXT NULL,
  reason        TEXT NULL,
  created_at    BIGINT NOT NULL,
  PRIMARY KEY (id),
  KEY idx_admin_audit_actor_created (actor_user_id, created_at DESC),
  KEY idx_admin_audit_target_created (target_type, target_id, created_at DESC),
  CONSTRAINT fk_admin_audit_actor FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_tickets (
  id          VARCHAR(120) NOT NULL,
  user_id     BIGINT NOT NULL,
  category    VARCHAR(80) NOT NULL,
  subject     VARCHAR(255) NOT NULL,
  content     LONGTEXT NOT NULL,
  status      VARCHAR(40) NOT NULL DEFAULT 'open',
  admin_note  LONGTEXT NULL,
  assigned_to BIGINT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  resolved_at BIGINT NULL,
  PRIMARY KEY (id),
  KEY idx_support_tickets_user_updated (user_id, updated_at DESC),
  KEY idx_support_tickets_status_updated (status, updated_at DESC),
  CONSTRAINT fk_support_tickets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_support_tickets_assigned_to FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- init_asset_domain_v2.sql
-- 幂等初始化 v2 资产域模型
-- 执行方式：
--   docker exec -i codesprite-mysql mysql -uroot -p < cicd/scripts/init_asset_domain_v2.sql

CREATE DATABASE IF NOT EXISTS codesprite_assets
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE codesprite_assets;

-- 主资产表：稳定身份 + 基础定位信息
CREATE TABLE IF NOT EXISTS asset_master (
  asset_id           VARCHAR(128) NOT NULL COMMENT '内部主键，建议由 cloud/resource_type/region/resource_id 组合生成',
  cloud_vendor       VARCHAR(32)  NOT NULL DEFAULT 'aliyun',
  account_name       VARCHAR(64)  DEFAULT NULL,
  resource_type      VARCHAR(64)  NOT NULL,
  resource_id        VARCHAR(128) NOT NULL,
  resource_name      VARCHAR(255) NOT NULL DEFAULT '',
  region             VARCHAR(32)  DEFAULT NULL,
  zone_id            VARCHAR(64)  DEFAULT NULL,
  env                VARCHAR(32)  DEFAULT NULL,
  resource_group     VARCHAR(128) DEFAULT NULL,
  parent_resource_id VARCHAR(128) DEFAULT NULL,
  lifecycle_status   ENUM('active','missing','retiring','retired') NOT NULL DEFAULT 'active',
  first_seen_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  missing_since      DATETIME     DEFAULT NULL,
  retired_at         DATETIME     DEFAULT NULL,
  source_of_truth    VARCHAR(32)  NOT NULL DEFAULT 'aliyun_cli',
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (asset_id),
  UNIQUE KEY uk_asset_identity (cloud_vendor, resource_type, region, resource_id),
  KEY idx_master_region_env (region, env),
  KEY idx_master_type (resource_type),
  KEY idx_master_lifecycle (lifecycle_status),
  KEY idx_master_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='资产主表（统一身份与当前定位）';

-- 人工维护元数据：owner、用途、业务归属等，不由自动发现覆盖
CREATE TABLE IF NOT EXISTS asset_metadata_curated (
  asset_id        VARCHAR(128) NOT NULL,
  owner_user      VARCHAR(128) DEFAULT NULL,
  owner_team      VARCHAR(128) DEFAULT NULL,
  service_name    VARCHAR(128) DEFAULT NULL,
  system_name     VARCHAR(128) DEFAULT NULL,
  purpose         TEXT         DEFAULT NULL,
  criticality     VARCHAR(32)  DEFAULT NULL,
  cost_center     VARCHAR(128) DEFAULT NULL,
  manual_tags     VARCHAR(512) DEFAULT NULL,
  verified_by     VARCHAR(128) DEFAULT NULL,
  verified_at     DATETIME     DEFAULT NULL,
  notes           TEXT         DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (asset_id),
  CONSTRAINT fk_curated_master FOREIGN KEY (asset_id) REFERENCES asset_master(asset_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='人工补录资产元数据';

-- 配置快照：按 hash 变化落库，保留最新配置事实
CREATE TABLE IF NOT EXISTS asset_config_snapshots (
  snapshot_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  asset_id        VARCHAR(128) NOT NULL,
  collector_name  VARCHAR(64)  NOT NULL DEFAULT 'discover_aliyun_assets',
  config_hash     CHAR(64)     NOT NULL,
  spec_json       JSON         DEFAULT NULL,
  capacity_json   JSON         DEFAULT NULL,
  network_json    JSON         DEFAULT NULL,
  labels_json     JSON         DEFAULT NULL,
  raw_json        JSON         DEFAULT NULL,
  collected_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_latest       TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (snapshot_id),
  UNIQUE KEY uk_asset_hash (asset_id, config_hash),
  KEY idx_snap_asset_latest (asset_id, is_latest),
  KEY idx_snap_collected (collected_at),
  CONSTRAINT fk_snap_master FOREIGN KEY (asset_id) REFERENCES asset_master(asset_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='资产配置快照';

-- 资产关系：归属、挂载、依赖
CREATE TABLE IF NOT EXISTS asset_relations (
  relation_id      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  src_asset_id     VARCHAR(128) NOT NULL,
  dst_asset_id     VARCHAR(128) NOT NULL,
  relation_type    VARCHAR(64)  NOT NULL,
  source           VARCHAR(32)  NOT NULL DEFAULT 'aliyun_cli',
  effective_from   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_to     DATETIME     DEFAULT NULL,
  remark           VARCHAR(512) DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (relation_id),
  UNIQUE KEY uk_relation_active (src_asset_id, dst_asset_id, relation_type, effective_to),
  KEY idx_rel_src (src_asset_id),
  KEY idx_rel_dst (dst_asset_id),
  KEY idx_rel_type (relation_type),
  CONSTRAINT fk_rel_src FOREIGN KEY (src_asset_id) REFERENCES asset_master(asset_id)
    ON DELETE CASCADE,
  CONSTRAINT fk_rel_dst FOREIGN KEY (dst_asset_id) REFERENCES asset_master(asset_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='资产关系表';

-- 生命周期事件：从现在开始记录新增、missing、恢复、状态变化、人工变更
CREATE TABLE IF NOT EXISTS asset_lifecycle_events (
  event_id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  asset_id         VARCHAR(128) NOT NULL,
  event_type       VARCHAR(64)  NOT NULL,
  event_time       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operator_name    VARCHAR(128) DEFAULT NULL,
  ticket_no        VARCHAR(128) DEFAULT NULL,
  change_no        VARCHAR(128) DEFAULT NULL,
  before_json      JSON         DEFAULT NULL,
  after_json       JSON         DEFAULT NULL,
  source           VARCHAR(32)  NOT NULL DEFAULT 'system',
  remark           TEXT         DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (event_id),
  KEY idx_event_asset_time (asset_id, event_time),
  KEY idx_event_type (event_type),
  CONSTRAINT fk_event_master FOREIGN KEY (asset_id) REFERENCES asset_master(asset_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='生命周期事件表';

-- 当前运行态：健康、状态、告警、摘要
CREATE TABLE IF NOT EXISTS asset_observations_latest (
  asset_id         VARCHAR(128) NOT NULL,
  observed_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status           VARCHAR(64)  DEFAULT NULL,
  health           ENUM('ok','warn','error','unknown') NOT NULL DEFAULT 'unknown',
  alert_24h        INT          NOT NULL DEFAULT 0,
  summary          VARCHAR(512) DEFAULT NULL,
  details_json     JSON         DEFAULT NULL,
  created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (asset_id),
  KEY idx_obs_health (health),
  KEY idx_obs_observed (observed_at),
  CONSTRAINT fk_obs_master FOREIGN KEY (asset_id) REFERENCES asset_master(asset_id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='当前观测事实表';

-- StarRocks 节点详情：FE / BE / CN 的结构化明细
CREATE TABLE IF NOT EXISTS sr_node_details (
  node_asset_id      VARCHAR(128) NOT NULL COMMENT '节点的 asset_id（与 asset_master.asset_id 关联）',
  cluster_asset_id   VARCHAR(128) NOT NULL COMMENT '所属集群 asset_id',
  warehouse_asset_id VARCHAR(128) DEFAULT NULL COMMENT '所属计算组 asset_id（BE/CN 归属 warehouse）',
  node_role          VARCHAR(32)  NOT NULL COMMENT 'FE / BE / CN',
  host_or_ip         VARCHAR(256) DEFAULT NULL,
  port               INT          DEFAULT NULL,
  version            VARCHAR(64)  DEFAULT NULL,
  spec_display       VARCHAR(256) DEFAULT NULL COMMENT '节点规格摘要',
  cpu_cores          INT          DEFAULT NULL,
  memory_gb          DECIMAL(10,1) DEFAULT NULL,
  disk_type          VARCHAR(32)  DEFAULT NULL,
  disk_size_gb       INT          DEFAULT NULL,
  az                 VARCHAR(64)  DEFAULT NULL,
  alive              TINYINT(1)   DEFAULT NULL COMMENT 'SHOW FRONTENDS/BACKENDS 中的 Alive',
  node_status        VARCHAR(64)  DEFAULT NULL,
  description        TEXT         DEFAULT NULL,
  last_sync_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (node_asset_id),
  KEY idx_srn_cluster (cluster_asset_id),
  KEY idx_srn_warehouse (warehouse_asset_id),
  KEY idx_srn_role (node_role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='StarRocks 节点详情表';

-- StarRocks 参数详情：集群/计算组/节点级参数 KV
CREATE TABLE IF NOT EXISTS sr_param_details (
  param_key          VARCHAR(256) NOT NULL COMMENT '主键 = scope_asset_id:param_name',
  scope_type         VARCHAR(32)  NOT NULL COMMENT 'cluster / warehouse / node',
  scope_asset_id     VARCHAR(128) NOT NULL COMMENT '参数作用域的 asset_id',
  scope_name         VARCHAR(255) DEFAULT NULL,
  param_name         VARCHAR(128) NOT NULL,
  current_value      TEXT         DEFAULT NULL,
  default_value      TEXT         DEFAULT NULL,
  is_non_default     TINYINT(1)   NOT NULL DEFAULT 0,
  param_source       VARCHAR(64)  DEFAULT NULL COMMENT 'SHOW VARIABLES / ADMIN SHOW CONFIG / manual',
  last_sync_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  remark             TEXT         DEFAULT NULL,
  created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (param_key),
  KEY idx_srp_scope (scope_asset_id),
  KEY idx_srp_name (param_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='StarRocks 参数详情表';

-- 兼容投影视图：供旧链路/排障使用
CREATE OR REPLACE VIEW aliyun_assets_v2_projection AS
SELECT
  m.asset_id AS asset_id,
  CONCAT(m.cloud_vendor, ':', m.resource_type, ':', IFNULL(m.region, 'global'), ':', m.resource_id) AS instance_id,
  m.resource_name AS instance_name,
  m.resource_type AS product_type,
  IFNULL(m.region, 'global') AS region,
  m.env AS env,
  o.status AS status,
  o.health AS health,
  JSON_UNQUOTE(JSON_EXTRACT(s.spec_json, '$.display')) AS spec,
  c.purpose AS purpose,
  JSON_UNQUOTE(JSON_EXTRACT(s.network_json, '$.primary_endpoint')) AS ip_or_domain,
  IFNULL(o.alert_24h, 0) AS alert_24h,
  c.manual_tags AS tags,
  s.raw_json AS extra_json,
  m.last_seen_at AS last_sync_at
FROM asset_master m
LEFT JOIN asset_metadata_curated c ON c.asset_id = m.asset_id
LEFT JOIN asset_config_snapshots s ON s.asset_id = m.asset_id AND s.is_latest = 1
LEFT JOIN asset_observations_latest o ON o.asset_id = m.asset_id;

SELECT 'codesprite_assets v2 asset domain initialized.' AS result;
SHOW TABLES;

-- init_asset_db.sql
-- 幂等：可重复执行，不会破坏已有数据
-- 执行方式：
--   docker exec -i codesprite-mysql mysql -uroot -p < cicd/scripts/init_asset_db.sql

-- ----------------------------------------------------------------
-- 1. 建库
-- ----------------------------------------------------------------
CREATE DATABASE IF NOT EXISTS codesprite_assets
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE codesprite_assets;

-- 使用单独的迁移脚本或管理员命令创建最小权限账号。
-- 不要在版本库中保存账号密码。

-- ----------------------------------------------------------------
-- 3. 主表：aliyun_assets
--    一行 = 一个阿里云资源实例
--    upsert 唯一键：instance_id
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS aliyun_assets (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  instance_id   VARCHAR(128)    NOT NULL COMMENT '阿里云实例 ID（upsert 唯一键）',
  instance_name VARCHAR(255)    NOT NULL DEFAULT '' COMMENT '资源名称',
  product_type  VARCHAR(64)     NOT NULL COMMENT '产品类型：ECS/VPC/NAT/VBR/OSS/StarRocks_Warehouse/Flink_Job/DataWorks_Project/RAM/EIP/vSwitch/SecurityGroup',
  region        VARCHAR(32)     NOT NULL COMMENT 'us-west-1 / cn-shenzhen',
  env           VARCHAR(32)     NOT NULL COMMENT '环境名称，例如 production / staging',
  status        VARCHAR(32)     NOT NULL DEFAULT 'Unknown' COMMENT '实例状态：Running/Available/Active/Stopped/Unknown',
  health        ENUM('ok','warn','error','unknown') NOT NULL DEFAULT 'unknown' COMMENT '健康度',
  spec          VARCHAR(512)    DEFAULT NULL COMMENT '规格/版本',
  purpose       TEXT            DEFAULT NULL COMMENT '用途说明',
  ip_or_domain  VARCHAR(256)    DEFAULT NULL COMMENT '内网IP/公网IP/域名',
  alert_24h     INT             NOT NULL DEFAULT 0 COMMENT '24h CMS 告警数',
  tags          VARCHAR(512)    DEFAULT NULL COMMENT '核心资源/监控中/待下线/成本风险/P0保障',
  extra_json    JSON            DEFAULT NULL COMMENT '原始 API 返回关键字段（非敏感）',
  last_sync_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '最近一次 discover 同步时间',
  bitable_record_id VARCHAR(128) DEFAULT NULL COMMENT '飞书 Bitable record_id，用于 upsert',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_instance_id (instance_id),
  KEY idx_region_env (region, env),
  KEY idx_product (product_type),
  KEY idx_health (health),
  KEY idx_last_sync (last_sync_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='阿里云资产台账主表';

-- ----------------------------------------------------------------
-- 4. 日志表：asset_sync_log
--    每次 discover 或 bitable_sync 写一条记录
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS asset_sync_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sync_type   VARCHAR(32)     NOT NULL COMMENT 'discover / bitable_sync',
  region      VARCHAR(32)     DEFAULT NULL COMMENT '扫描区域（discover 时填）',
  env         VARCHAR(32)     DEFAULT NULL COMMENT '环境（discover 时填）',
  status      ENUM('ok','partial','failed') NOT NULL DEFAULT 'ok' COMMENT '整体状态',
  total       INT             NOT NULL DEFAULT 0 COMMENT '发现/同步资产总数',
  upserted    INT             NOT NULL DEFAULT 0 COMMENT '实际 upsert 数',
  errors      INT             NOT NULL DEFAULT 0 COMMENT '失败/跳过数',
  detail      TEXT            DEFAULT NULL COMMENT '错误摘要或说明',
  started_at  DATETIME        NOT NULL COMMENT '开始时间',
  finished_at DATETIME        NOT NULL COMMENT '完成时间',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_sync_type (sync_type),
  KEY idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='资产同步运行日志';

-- ----------------------------------------------------------------
-- 5. 验证
-- ----------------------------------------------------------------
SELECT 'codesprite_assets database initialized.' AS result;
SHOW TABLES;

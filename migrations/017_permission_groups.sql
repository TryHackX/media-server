-- Named permission groups.
--
-- Permissions used to live in `role_permissions`, keyed by two hard-coded names.
-- Groups are now rows, so an operator can define their own with whatever mix of
-- rights and limits they need. The original two are seeded as system groups and
-- cannot be deleted: every account falls back to one of them.

CREATE TABLE IF NOT EXISTS permission_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  description VARCHAR(255) NOT NULL DEFAULT '',
  -- The fallback groups for signed-in and guest accounts. Renameable, not
  -- removable, because dropping one would leave accounts with no rights at all.
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  can_download TINYINT(1) NOT NULL DEFAULT 0,
  can_rate TINYINT(1) NOT NULL DEFAULT 0,
  can_favorite TINYINT(1) NOT NULL DEFAULT 0,
  can_create_collections TINYINT(1) NOT NULL DEFAULT 0,
  can_browse_collections TINYINT(1) NOT NULL DEFAULT 0,
  can_browse_profiles TINYINT(1) NOT NULL DEFAULT 0,
  can_share TINYINT(1) NOT NULL DEFAULT 0,
  -- Zero means no limit, which keeps the seeded groups behaving as before.
  max_concurrent_streams INT NOT NULL DEFAULT 0,
  download_limit_per_hour INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY permission_groups_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split

-- Carry the existing two sets over verbatim so nobody's rights change.
INSERT INTO permission_groups
  (slug, name, description, is_system, sort_order,
   can_download, can_rate, can_favorite, can_create_collections,
   can_browse_collections, can_browse_profiles, can_share)
SELECT
  rp.role_group,
  CASE rp.role_group WHEN 'guest' THEN 'Goście' ELSE 'Użytkownicy' END,
  CASE rp.role_group
    WHEN 'guest' THEN 'Domyślne uprawnienia kont gościa.'
    ELSE 'Domyślne uprawnienia zwykłych kont.'
  END,
  1,
  CASE rp.role_group WHEN 'guest' THEN 20 ELSE 10 END,
  rp.can_download, rp.can_rate, rp.can_favorite, rp.can_create_collections,
  rp.can_browse_collections, rp.can_browse_profiles, rp.can_share
FROM role_permissions rp
WHERE rp.role_group IN ('user', 'guest')
ON DUPLICATE KEY UPDATE slug = permission_groups.slug;

-- migrate:split

ALTER TABLE users
  ADD COLUMN permission_group_id BIGINT UNSIGNED NULL DEFAULT NULL AFTER role,
  ADD CONSTRAINT users_permission_group_fk FOREIGN KEY (permission_group_id)
    REFERENCES permission_groups (id) ON DELETE SET NULL;

-- migrate:split

-- Point every account at the group it was already effectively using. A NULL
-- keeps working as before: the reader falls back by guest flag.
UPDATE users u
INNER JOIN permission_groups g
  ON g.slug = CASE WHEN u.is_guest = 1 THEN 'guest' ELSE 'user' END
SET u.permission_group_id = g.id
WHERE u.permission_group_id IS NULL;

ALTER TABLE role_permissions
  ADD COLUMN can_browse_profiles TINYINT(1) NOT NULL DEFAULT 1 AFTER can_browse_collections
-- migrate:split
UPDATE role_permissions SET can_browse_profiles = 0 WHERE role_group = 'guest'

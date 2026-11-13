-- Favourite visualizer presets, kept with the account.
--
-- The visualizer panel's star (MilkDrop, AVS, VoltViz, Internal…) kept its
-- favourites in `localStorage`: one browser profile on one machine, gone with
-- its site data and invisible from the phone. They belong to the account, the
-- way a track's heart does, and the panel's "Ulubione" plays them from every
-- visualizer at once.
--
-- One row per starred preset. The visualizer and the preset are the panel's own
-- identifiers — a preset's name for MilkDrop and AVS, a short key for VoltViz
-- and Internal — which the server only checks for shape and keeps; what is a
-- preset is the panel's business, and one that has since gone (a pack taken
-- away) stays listed until it is unstarred. Names are compared exactly
-- (`utf8mb4_bin`): two MilkDrop presets may differ only in case. The longest
-- name in the packs today has 144 characters.
--
-- `preset_label` is the name the panel showed when the star was clicked, so the
-- "Ulubione" list can name presets of every visualizer without loading each
-- one's catalogue first. The order of the list is the order they were starred.

CREATE TABLE IF NOT EXISTS visualizer_favorites (
  user_id BIGINT UNSIGNED NOT NULL,
  visualizer_id VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  preset_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  preset_label VARCHAR(255) NOT NULL DEFAULT '',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, visualizer_id, preset_id),
  KEY ix_visualizer_favorites_added (user_id, created_at),
  CONSTRAINT fk_visualizer_favorites_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fourteen visualiser identifiers no longer fit the original VARCHAR(191), and
-- a truncated list is stored silently rather than rejected. Widen it first.
ALTER TABLE app_settings MODIFY setting_value VARCHAR(512) NOT NULL;

-- migrate:split

-- Register the MilkDrop-style visualisers.
-- They are inserted after flow-field so the running order matches
-- defaultVisualizerOrder in frontend/src/shared/visualizations/registry.ts, and
-- appended to the enabled list so they appear without an admin having to opt in.
-- Idempotent: a value already containing warp-tunnel is left untouched.

UPDATE app_settings
SET setting_value = REPLACE(
      setting_value,
      'flow-field,',
      'flow-field,warp-tunnel,kaleidoscope,'
    )
WHERE setting_key IN ('visualizer_order', 'visualizer_enabled')
  AND setting_value LIKE '%flow-field,%'
  AND setting_value NOT LIKE '%warp-tunnel%';

-- migrate:split

-- Covers a stored list that ends on flow-field, where the clause above finds no
-- trailing comma to anchor to.
UPDATE app_settings
SET setting_value = CONCAT(setting_value, ',warp-tunnel,kaleidoscope')
WHERE setting_key IN ('visualizer_order', 'visualizer_enabled')
  AND setting_value NOT LIKE '%warp-tunnel%';

-- migrate:split

-- Drop the two that were withdrawn. The settings reader already skips
-- identifiers it does not know, so this only keeps the stored value tidy.
UPDATE app_settings
SET setting_value = TRIM(BOTH ',' FROM REPLACE(REPLACE(REPLACE(REPLACE(
      setting_value,
      'plasma-field,', ''), ',plasma-field', ''),
      'liquid-aurora,', ''), ',liquid-aurora', ''))
WHERE setting_key IN ('visualizer_order', 'visualizer_enabled');

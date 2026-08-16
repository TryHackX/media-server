-- Make the two kept visualizers usable.
--
-- 021 withdrew the batch that had been unreachable from the panel; Particle
-- Spectrum and Vortex stay, so they are appended to the stored order and enabled
-- set (installs that never stored a value already get every plugin by default).

UPDATE app_settings
   SET setting_value = CONCAT(setting_value, ',particle-spectrum')
 WHERE setting_key IN ('visualizer_order', 'visualizer_enabled')
   AND setting_value <> ''
   AND FIND_IN_SET('particle-spectrum', setting_value) = 0;

-- migrate:split

UPDATE app_settings
   SET setting_value = CONCAT(setting_value, ',vortex')
 WHERE setting_key IN ('visualizer_order', 'visualizer_enabled')
   AND setting_value <> ''
   AND FIND_IN_SET('vortex', setting_value) = 0;

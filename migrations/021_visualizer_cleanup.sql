-- Withdraw the visualizers that were briefly re-added to the default order.
--
-- Only Particle Spectrum and Vortex stay from that batch; the rest are gone from
-- the bundle, so leaving their identifiers in app_settings would keep dead entries
-- in the stored order (the reader drops unknown ids, but the value is tidied here
-- so the panel and the database agree).

UPDATE app_settings
   SET setting_value = TRIM(BOTH ',' FROM REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
       CONCAT(',', setting_value, ','),
       ',wave-circle,', ','), ',circular-wave,', ','), ',neon-pulse,', ','),
       ',fire-pulse,', ','), ',aurora,', ','), ',event-horizon,', ','),
       ',luminous-jellyfish,', ','), ',,', ','))
 WHERE setting_key IN ('visualizer_order', 'visualizer_enabled');

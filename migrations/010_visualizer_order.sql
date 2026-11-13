INSERT INTO app_settings (setting_key, setting_value)
VALUES ('visualizer_order', 'snow-spectrum,poweramp,solar-flare,flow-field,ring-warp,orbit-analyzer,glitch-spectrum,enhanced-snow,prism-tunnel,chromatic-cathedral,quantum-ribbon,milkdrop-pulse,neon-metropolis')
ON DUPLICATE KEY UPDATE setting_value = setting_value;

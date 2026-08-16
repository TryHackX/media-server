-- Technical facts about a video, read once and kept in the catalogue.
--
-- Duration already had a column because audio tags supplied it; resolution,
-- codecs, frame rate and the HDR flag had nowhere to go, so a filter like
-- "only 4K" or an order by resolution was impossible. These are the fields worth
-- querying — the full ffprobe result stays in metadata_json.video, the same way
-- audio tags keep their detail under metadata_json.audio.
--
-- The index carries media_kind first so the browser's "video only" scans stay
-- narrow before the height range is applied.

ALTER TABLE media_items
  ADD COLUMN video_width SMALLINT UNSIGNED NULL DEFAULT NULL AFTER duration_ms,
  ADD COLUMN video_height SMALLINT UNSIGNED NULL DEFAULT NULL AFTER video_width,
  ADD COLUMN video_codec VARCHAR(32) NULL DEFAULT NULL AFTER video_height,
  ADD COLUMN audio_codec VARCHAR(32) NULL DEFAULT NULL AFTER video_codec,
  ADD COLUMN frame_rate DECIMAL(7,3) UNSIGNED NULL DEFAULT NULL AFTER audio_codec,
  ADD COLUMN is_hdr TINYINT(1) NOT NULL DEFAULT 0 AFTER frame_rate
-- migrate:split
ALTER TABLE media_items
  ADD KEY ix_media_items_resolution (media_kind, video_height)

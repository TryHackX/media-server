-- What each device is playing, kept where both devices can see it.
--
-- The queue has lived in `localStorage` since the player was written, and that
-- is exactly one browser profile on exactly one machine. It survives a reload
-- and nothing else: the phone in the kitchen cannot see what the computer is
-- playing, and "hand playback over" has nothing to hand over. The position
-- inside a track was already on the server (`playback_stats`), which makes the
-- gap plainer — the server knew *where* you were in a song and not *which song
-- comes next*.
--
-- One row per (account, device). A device is a browser profile that has been
-- here before; it names itself with an identifier it keeps in its own storage,
-- so clearing site data makes a device new rather than making it somebody
-- else's.
--
-- What is stored is the queue's *identity*, not its contents: which folder or
-- playlist it came from, in what order and with which shuffle seed, how far in
-- it had got, which track was open and how many milliseconds into it. From that
-- any device rebuilds the same list — the same thing a page reload already does
-- with `QueueSource`. Storing the tracks themselves would mean copying up to a
-- few hundred rows per device per save, to describe a list the catalogue can
-- reproduce exactly from five values.
--
-- `source_json` is the one loose field, and deliberately: it is the client's own
-- description of the queue (kind, id, query, shuffle mode and seed, a playlist's
-- display rules). The server never acts on it — it only keeps it and hands it
-- back — while everything the server *does* reason about (whose row this is,
-- what track is open, whether it is playing, when it was last touched) has a
-- column of its own. Writes are still filtered key by key, so the column holds
-- a known shape rather than whatever was posted.
--
-- `yielded_to` is how "hand over" works without a socket. A device that takes a
-- queue over stamps the name it took it from here; the device that was playing
-- finds the stamp on its next save — a save it was making anyway, every few
-- seconds, while playing — and pauses itself. Reading it clears it, so one
-- handover pauses playback once. A device that is already paused never asks and
-- never needs to.

CREATE TABLE IF NOT EXISTS playback_queues (
  user_id BIGINT UNSIGNED NOT NULL,
  device_id VARCHAR(64) NOT NULL,
  device_label VARCHAR(64) NOT NULL DEFAULT '',
  source_json JSON NULL,
  queue_offset INT UNSIGNED NOT NULL DEFAULT 0,
  queue_total INT UNSIGNED NOT NULL DEFAULT 0,
  media_item_id BIGINT UNSIGNED NULL,
  position_ms BIGINT UNSIGNED NOT NULL DEFAULT 0,
  is_playing TINYINT(1) NOT NULL DEFAULT 0,
  repeat_mode VARCHAR(16) NOT NULL DEFAULT 'off',
  context VARCHAR(191) NOT NULL DEFAULT '',
  yielded_to VARCHAR(64) NULL,
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (user_id, device_id),
  KEY ix_playback_queues_recent (user_id, updated_at),
  CONSTRAINT fk_playback_queues_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_playback_queues_item FOREIGN KEY (media_item_id)
    REFERENCES media_items (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci

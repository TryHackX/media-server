-- Anti-bot stage 2, part B: the step-up ladder (StepUpGuard).
--
-- A subject is an account ('u:<id>'), a client digest ('c:<sha256>', the one
-- auth_attempts uses — never the address itself) or a device cookie digest
-- ('d:<sha256>'). Counters are ten-second buckets of unix time; subjects keep
-- the last decision (asked for a challenge, paused, blocked) for the panel's
-- list and for the block itself.

CREATE TABLE IF NOT EXISTS stepup_counters (
  context VARCHAR(16) NOT NULL,
  subject VARCHAR(80) NOT NULL,
  bucket BIGINT UNSIGNED NOT NULL,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (context, subject, bucket),
  KEY stepup_counters_subject (subject),
  KEY stepup_counters_bucket (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- migrate:split

CREATE TABLE IF NOT EXISTS stepup_subjects (
  subject VARCHAR(80) NOT NULL,
  user_id BIGINT UNSIGNED NULL DEFAULT NULL,
  context VARCHAR(16) NOT NULL,
  state VARCHAR(16) NOT NULL,
  until_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  audited_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (subject),
  KEY stepup_subjects_updated (updated_at),
  CONSTRAINT stepup_subjects_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

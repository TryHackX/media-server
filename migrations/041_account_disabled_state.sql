-- An account an administrator switched off is not an account waiting for its link.
--
-- Until now both were `is_active = 0`, told apart only by whether the address had
-- been confirmed — so an account switched off before it ever confirmed looked
-- exactly like one still waiting. The activation link it already had, or a fresh
-- one from "send the link again", then opened it straight back up: a spammer the
-- operator had just disabled could reactivate himself from his own mailbox.
--
-- `disabled_at` records the operator's decision as a fact of its own. Sign-in,
-- activation and the resend form refuse an account that carries it, and only the
-- panel clears it again. The check keeps the two flags from disagreeing: a
-- disabled account is never active.

ALTER TABLE users
  ADD COLUMN disabled_at TIMESTAMP(6) NULL DEFAULT NULL AFTER is_active
-- migrate:split
-- Accounts already switched off. Those that had confirmed their address, or never
-- had one to confirm, cannot be waiting for a link, so they were disabled by
-- somebody. An inactive, unconfirmed account with an address cannot be told apart
-- from one still waiting, and stays pending.
UPDATE users
   SET disabled_at = updated_at
 WHERE is_active = 0
   AND disabled_at IS NULL
   AND (email_verified_at IS NOT NULL OR email IS NULL)
-- migrate:split
ALTER TABLE users
  ADD CONSTRAINT chk_users_disabled_inactive CHECK (disabled_at IS NULL OR is_active = 0)

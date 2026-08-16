-- What a playlist shows in the queue, decided by the person who made it.
--
-- Until now this was one choice per account (`users.preferences_json.queue`):
-- the listener said whether the queue shows a rating, whose, and whether it
-- marks favourites. That is the right default — it is *your* queue — but it
-- cannot express the thing a playlist is for. A list put together by somebody
-- else is an argument about music, and "these three are the ones I keep coming
-- back to" is part of the argument. Showing the listener their own stars over
-- somebody else's selection answers a question nobody asked.
--
-- So the two columns below belong to the list, and every listener sees what its
-- author chose:
--
--   queue_rating    inherit | owner | viewer | average | none
--   queue_favorite  inherit | owner | viewer | none
--
-- `owner` is the author of the playlist, `viewer` is whoever is listening right
-- now. They are separate values rather than one "own", because "own" would mean
-- a different person depending on who reads it — and both readings are wanted:
-- an author says "show my stars", a listener browsing a shared list may still
-- want their own.
--
-- The default is `inherit`, and that matters more than it looks. Anything else
-- would silently restyle every playlist that already exists, and — worse —
-- would publish its author's ratings and favourites to everyone who plays it.
-- Handing your stars to strangers has to be a decision somebody made, not a
-- side effect of a migration running. `inherit` means "do whatever the account
-- reading this has set", which is exactly today's behaviour.
--
-- These are not smart-list rules. A rule decides *which items* are on the list;
-- these decide how the list is *displayed*, so they stay out of `rules_json` and
-- apply to manual and rule-based lists alike.

ALTER TABLE user_collections
  ADD COLUMN queue_rating ENUM('inherit', 'owner', 'viewer', 'average', 'none')
      NOT NULL DEFAULT 'inherit' AFTER is_shared
-- migrate:split
ALTER TABLE user_collections
  ADD COLUMN queue_favorite ENUM('inherit', 'owner', 'viewer', 'none')
      NOT NULL DEFAULT 'inherit' AFTER queue_rating

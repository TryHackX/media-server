-- A device's stored queue remembers the session that saved it.
--
-- The queue panel lists "other devices" from playback_queues, which kept a row
-- for 30 days whatever happened to the browser behind it: a phone signed out
-- yesterday was still offered for "Przejmij" while "Aktywne sesje" showed only
-- this computer. The session that last saved the row ties the two lists
-- together: a row whose session is open is a device that is there now; one
-- whose session was closed (signed out, "Wyloguj wszystkie oprócz tej", a new
-- password) is not listed at all; the rest is only "recent". The value is the
-- same SHA-256 of the session identifier user_sessions keeps, never the
-- identifier itself. Rows saved before this migration have none until their
-- device saves again.

ALTER TABLE playback_queues
  ADD COLUMN session_hash BINARY(32) NULL DEFAULT NULL AFTER device_label

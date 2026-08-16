-- A way to recognise the same file again without knowing where it lives.
--
-- Everything that identifies a catalogued file today is positional: the row id
-- means nothing outside this database, and relative_path means nothing outside
-- this disk — and writing a path into an exported playlist hands the reader a
-- map of the library, which is why the export carries ids instead.
--
-- That leaves a real gap. Ids are perfect for restoring into *this* server and
-- useless anywhere else, and a name is neither: two files called "01 - Intro.mp3"
-- are routinely different recordings, while the same recording is routinely
-- filed under two different names.
--
-- A fingerprint answers "is this the same file?" directly. It is **not** a
-- checksum of the whole file and must not be described as one: reading every
-- byte of 19,000 media files would take hours and the point here is to be
-- cheap. It hashes the size together with the first and last 64 KiB, which is
-- two reads per file regardless of whether the file is four megabytes or forty
-- gigabytes.
--
-- What that buys and what it costs, plainly:
--
--   * two different files agreeing by accident is not a thing that happens —
--     they would have to share a byte length and both ends exactly;
--   * two different files agreeing *on purpose* is easy to arrange, so this is
--     a matching aid, never an authorisation or an integrity check;
--   * re-encoding a file changes it, as it should — that is a different file.
--
-- Not unique, deliberately: the same recording may legitimately sit in the
-- library twice, and both copies should carry the same fingerprint so a rating
-- imported for one is recognised for the other.

ALTER TABLE media_items
  ADD COLUMN content_fingerprint CHAR(32) NULL DEFAULT NULL AFTER legacy_checksum
-- migrate:split
ALTER TABLE media_items
  ADD KEY ix_media_items_fingerprint (content_fingerprint)

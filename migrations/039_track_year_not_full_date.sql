-- A track's `year` was holding a date.
--
-- Vorbis comments — which is to say most of the FLAC library — carry the release
-- date under `date`, and the tag reader stored whatever it found there verbatim.
-- The field is called `year`, it is displayed as a year next to genre and
-- format, and every query against it means a year. So the card for one album
-- read "1940-03-25 · Rock · X-FLAC" where it should have read "1940".
--
-- Measured on this installation before the fix: 6390 tracks with a full
-- YYYY-MM-DD, 71 with YYYY-MM, 2 with a timestamp, against 2260 that were
-- already plain years. The majority of the library, in other words.
--
-- The reader now keeps only the leading year (src/media_server/metadata.py,
-- `release_year`), which fixes every file read from here on. This migration is
-- for the rows already stored: re-reading tags to correct a string we can
-- correct exactly would cost roughly an hour and a half of opening files whose
-- tags have not changed.
--
-- Only values whose first four characters are a plausible year are touched.
-- Anything else a tagger wrote is left exactly as it is, for the same reason the
-- reader leaves it: we cannot tell what it means, and a guess would destroy the
-- only record of it. Human overrides in media_metadata_overrides are not touched
-- at all — those are somebody's decision, not a parsed tag.

UPDATE media_items
   SET metadata_json = JSON_SET(
         metadata_json,
         '$.audio.year',
         LEFT(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.audio.year')), 4)
       )
 WHERE JSON_EXTRACT(metadata_json, '$.audio.year') IS NOT NULL
   AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.audio.year'))) > 4
   AND LEFT(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.audio.year')), 4) REGEXP '^[0-9]{4}$'
   AND CAST(LEFT(JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.audio.year')), 4) AS UNSIGNED)
       BETWEEN 1880 AND 2049

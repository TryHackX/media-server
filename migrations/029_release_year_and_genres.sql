-- What a film is about, next to what it is made of.
--
-- Everything the catalogue knows about a video today comes from ffprobe, which
-- reads the picture and the sound and has no opinion on the story: there is no
-- genre and no release year anywhere, so a smart collection can ask for "4K" but
-- not for "science fiction from the nineties". Audio tags are no help either —
-- exactly one track out of 12,807 in this library carries a genre tag.
--
-- Two facts are stored, and they arrive by different routes, which is why they
-- are shaped differently.
--
-- release_year is a single number and belongs on the item, next to video_height,
-- because it is filtered and sorted the same way. release_year_source records
-- who put it there. The scan owns the value 'filename' and nothing else: a year
-- read off disk may be replaced by a later scan, but a year that came from an
-- external lookup or from a person must survive one, otherwise every correction
-- would be undone by the next walk of the tree.
--
-- Genres are a list, so they get a join table, and the vocabulary gets a
-- dictionary rather than free text. A dictionary buys three things free text
-- cannot: the interface can show the genre in Polish or English from one row,
-- a rule in a smart collection can point at a stable id instead of a spelling,
-- and a second source later maps into the same words instead of inventing its
-- own. The seeded vocabulary and both spellings are Filmweb's own genre list
-- (GET /api/v1/genres, read in pl_PL and en_US), so nothing here is translated
-- by hand — with one correction: Filmweb renders "Komedia kryminalna" as
-- "Action comedy", which is a different genre in English, so it is seeded as
-- "Crime comedy". filmweb_id keeps the mapping the fetcher needs.
--
-- media_item_genres carries its own source per row for the same reason as the
-- year: a genre a person added by hand and a genre pulled off the network live
-- side by side, and a refetch may only clear away what it wrote itself.

ALTER TABLE media_items
  ADD COLUMN release_year SMALLINT UNSIGNED NULL DEFAULT NULL AFTER is_hdr,
  ADD COLUMN release_year_source VARCHAR(16) NULL DEFAULT NULL AFTER release_year
-- migrate:split
ALTER TABLE media_items
  ADD KEY ix_media_items_release_year (media_kind, release_year)
-- migrate:split
CREATE TABLE IF NOT EXISTS media_genres (
  id SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(48) NOT NULL,
  name_pl VARCHAR(64) NOT NULL,
  name_en VARCHAR(64) NOT NULL,
  filmweb_id SMALLINT UNSIGNED NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_media_genres_slug (slug),
  UNIQUE KEY uq_media_genres_filmweb (filmweb_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
CREATE TABLE IF NOT EXISTS media_item_genres (
  media_item_id BIGINT UNSIGNED NOT NULL,
  genre_id SMALLINT UNSIGNED NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'filmweb',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (media_item_id, genre_id),
  KEY ix_media_item_genres_genre (genre_id, media_item_id),
  CONSTRAINT fk_media_item_genres_item FOREIGN KEY (media_item_id)
    REFERENCES media_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_media_item_genres_genre FOREIGN KEY (genre_id)
    REFERENCES media_genres (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
-- migrate:split
INSERT INTO media_genres (slug, name_pl, name_en, filmweb_id) VALUES
  ('action', 'Akcja', 'Action', 28),
  ('animation', 'Animacja', 'Animation', 2),
  ('adult-animation', 'Animacja dla dorosłych', 'Adult animation', 77),
  ('anime', 'Anime', 'Anime', 66),
  ('fairy-tale', 'Baśń', 'Fairy tale', 42),
  ('biblical', 'Biblijny', 'Biblical', 55),
  ('biography', 'Biograficzny', 'Biography', 3),
  ('dark-comedy', 'Czarna komedia', 'Dark comedy', 47),
  ('for-kids', 'Dla dzieci', 'For kids', 4),
  ('teen', 'Dla młodzieży', 'Teen', 41),
  ('mockumentary', 'Dokumentalizowany', 'Mockumentary', 57),
  ('documentary', 'Dokumentalny', 'Documentary', 5),
  ('drama', 'Dramat', 'Drama', 6),
  ('historical-drama', 'Dramat historyczny', 'Historical drama', 59),
  ('kitchen-sink-drama', 'Dramat obyczajowy', 'Kitchen-sink drama', 37),
  ('legal-drama', 'Dramat sądowy', 'Legal drama', 65),
  ('mystery', 'Dreszczowiec', 'Mystery', 46),
  ('erotic', 'Erotyczny', 'Erotic', 7),
  ('fictionalized-documentary', 'Fabularyzowany dok.', 'Fictionalized documentary', 70),
  ('family', 'Familijny', 'Family', 8),
  ('fantasy', 'Fantasy', 'Fantasy', 9),
  ('noir', 'Film-Noir', 'Noir', 27),
  ('gangster', 'Gangsterski', 'Gangster', 53),
  ('grotesque', 'Groteska filmowa', 'Grotesque', 60),
  ('history', 'Historyczny', 'History', 11),
  ('horror', 'Horror', 'Horror', 12),
  ('disaster', 'Katastroficzny', 'Disaster', 40),
  ('comedy', 'Komedia', 'Comedy', 13),
  ('crime-comedy', 'Komedia kryminalna', 'Crime comedy', 58),
  ('comedy-drama', 'Komedia obycz.', 'Comedy drama', 29),
  ('romantic-comedy', 'Komedia rom.', 'Romantic comedy', 30),
  ('costume', 'Kostiumowy', 'Costume', 14),
  ('crime', 'Kryminał', 'Crime', 15),
  ('short', 'Krótkometrażowy', 'Short', 50),
  ('melodrama', 'Melodramat', 'Melodrama', 16),
  ('musical', 'Musical', 'Musical', 17),
  ('music', 'Muzyczny', 'Music', 44),
  ('silent', 'Niemy', 'Silent', 67),
  ('social-drama', 'Obyczajowy', 'Social drama', 19),
  ('poetic', 'Poetycki', 'Poetic', 62),
  ('political', 'Polityczny', 'Political', 43),
  ('propaganda', 'Propagandowy', 'Propaganda', 76),
  ('adventure', 'Przygodowy', 'Adventure', 20),
  ('nature', 'Przyrodniczy', 'Nature', 73),
  ('psychological', 'Psychologiczny', 'Psychological', 38),
  ('religious', 'Religijny', 'Religious', 51),
  ('romance', 'Romans', 'Romance', 32),
  ('satire', 'Satyra', 'Satire', 39),
  ('sci-fi', 'Sci-Fi', 'Sci-Fi', 33),
  ('action-thriller', 'Sensacyjny', 'Action thriller', 22),
  ('sport', 'Sportowy', 'Sport', 61),
  ('surreal', 'Surrealistyczny', 'Surreal', 10),
  ('spy', 'Szpiegowski', 'Spy', 63),
  ('martial-arts', 'Sztuki walki', 'Martial arts', 72),
  ('thriller', 'Thriller', 'Thriller', 24),
  ('true-crime', 'True crime', 'True crime', 80),
  ('western', 'Western', 'Western', 25),
  ('war', 'Wojenny', 'War', 26),
  ('xxx', 'XXX', 'XXX', 71),
  ('christmas', 'Świąteczny', 'Christmas', 78)

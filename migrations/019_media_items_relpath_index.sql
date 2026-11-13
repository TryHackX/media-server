-- Prefix index for subtree scoping.
--
-- Directory rating/preview aggregation matches a whole subtree with
-- `relative_path LIKE 'Folder/%'`. relative_path is TEXT and unindexed, so each
-- of the ~100 directories on a browse page forced a full media_items scan. A
-- (root_id, relative_path prefix) index lets the optimizer range-scan the prefix
-- instead. 191 chars keeps the key within the utf8mb4 index-length limit.

ALTER TABLE media_items
  ADD KEY ix_media_items_root_relpath (root_id, relative_path(191));

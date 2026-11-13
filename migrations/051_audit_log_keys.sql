-- The audit trail's own two questions, indexed.
--
-- The panel filters the trail by event and lists the events with their counts
-- (`WHERE action = ?`, `GROUP BY action`), and one write in two hundred prunes
-- what is older than the retention window (`WHERE created_at < ?`). Neither had
-- an index: both read the whole table, which is nothing at three hundred rows
-- and a slow page at a year of them. InnoDB keeps the primary key in every
-- secondary index, so `(action)` also serves "newest first within one event".

ALTER TABLE audit_log
  ADD KEY ix_audit_log_action (action),
  ADD KEY ix_audit_log_created (created_at)

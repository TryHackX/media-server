ALTER TABLE background_jobs
  ADD COLUMN job_key VARCHAR(191) NULL AFTER job_type,
  ADD UNIQUE KEY uq_background_jobs_job_key (job_key)

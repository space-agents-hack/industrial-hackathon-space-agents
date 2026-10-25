-- ANALYZE without reading the vectors or the paragraph texts (#57). analyze_regulation_search,
-- which the indexer runs after adding keys and at the end of each vector pass, took 9.9 s on
-- average and up to 26.6 s on production (pg_stat_statements, 2026-10-25, under an import), the
-- last step of a slice whose vectors were already saved, against a 30 s timeout.
--
-- ANALYZE reads every sampled value of every column to build its statistics, and these values
-- are the large ones, kept in TOAST: a 2 KB vector per row of regulation_embeddings and up to
-- 24,000 characters of text per paragraph. No query filters or sorts on either, so the planner
-- never uses those statistics. A target of 0 skips the column; the row counts and every other
-- column (organisation, version, keys, fts for the word search) are analysed as before.
--
-- SET STATISTICS takes a lock that lets inserts, updates and deletes go on, so this can be applied
-- while an import or the indexer is running.

alter table public.regulation_embeddings alter column embedding set statistics 0;
alter table public.regulation_paragraphs alter column text set statistics 0;

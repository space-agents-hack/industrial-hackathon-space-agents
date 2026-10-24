-- One regulation list (ADR-0006, Clemente 2026-10-24): the checks read the citable regulations from
-- the organisation's library (regulations, regulation_versions). The copy of index.json that
-- certivity_reference held is removed; the table keeps Certivity's answer keys only. The agent
-- already ignores an "index" row, so this works with the code running before and after it.
delete from public.certivity_reference where kind = 'index';

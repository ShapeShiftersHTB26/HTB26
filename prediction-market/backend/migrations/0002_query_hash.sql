-- sha256 of the normalized market question. The same query maps to the same market
-- (groundwork for using the query hash as the market id). Failed attempts don't block a retry.
alter table markets add column query_hash text;
create unique index markets_query_hash_live on markets (query_hash) where status <> 'failed';

### Storage engine comparison

You asked which engine fits an offline-first note app. Short answer: SQLite,
unless your notes are ~~tiny~~ mostly under a kilobyte, in which case a
key-value store is simpler to operate.

| Engine   | Writes/sec | Query model     | Sync story          |
| :------- | ---------: | :-------------- | :------------------ |
| SQLite   |     48,000 | SQL             | manual, but mature  |
| LevelDB  |     91,000 | key-value       | build it yourself   |
| Realm    |     22,500 | object graph    | vendor-hosted       |

Notes on the numbers:

- Throughput measured on a mid-range phone, batched transactions.
- The SQLite figure assumes `PRAGMA journal_mode = WAL`.
- Realm's sync is convenient but couples you to a vendor.

**Recommendation:** start with SQLite and revisit only if profiling shows
write contention. Migrating early is ~~cheap~~ never cheap.

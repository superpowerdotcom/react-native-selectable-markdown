# Postmortem: the Tuesday cache stampede

**Impact:** 41 minutes of elevated latency. No data loss. One very tired
on-call engineer.

## Timeline

1. 09:12 — deploy lands, cache keys change shape
2. 09:14 — hit rate falls off a cliff
3. 09:19 — autoscaler adds capacity, which *makes it worse*
4. 09:53 — rollback completes, hit rate recovers

## What happened

The deploy renamed `user:{id}:prefs` to `user:{id}:preferences`, so every
request missed and went to the database at once — a classic stampede.

```py
# the offending change, simplified
key = f"user:{user_id}:preferences"   # was ...:prefs
value = cache.get(key) or db.load_prefs(user_id)
```

> The autoscaler saw slow responses and added web nodes. More nodes meant
> more concurrent database queries:
>
> - each new node started cold
> - each cold node missed on every key
> - the database connection pool saturated

---

## Action items

| Owner  | Item                                    | Due    |
| :----- | :-------------------------------------- | :----- |
| dana   | Dual-read old and new keys for a week   | Fri    |
| arjun  | Request coalescing in the cache client  | next sprint |
| oncall | Alert on hit-rate drop, not just latency | done  |

Diagram of the fix lives at
![request coalescing sketch](https://example.com/img/coalesce.png "one flight per key")
and the full dashboard at <https://example.com/dash/cache>.

## Debouncing the search box

The bug is that every keystroke fires a network request. Wrap the handler in
a debounce so only the *last* keystroke within the window wins.

```ts
function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const onQueryChange = debounce((q: string) => {
  void searchApi.fetch(q);
}, 250);
```

Two details matter here:

- `clearTimeout(timer)` is safe even when `timer` is `undefined`.
- The generic `A` keeps the wrapped signature intact — no `any` leaks.

Verify it locally before shipping:

```bash
npm run test -- --filter search
npm run typecheck
```

If the test still flakes, log the timestamps with `console.time('search')`
and check whether the 250 ms window is too tight for slow emulators.

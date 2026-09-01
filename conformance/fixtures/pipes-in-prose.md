# Why your shell pipeline hangs

You wrote grep pattern | less and the terminal froze. The pipe is fine — the
problem is that grep is still waiting on stdin because the filename was
swallowed by your alias.

A few facts about the pipe character in prose:

- In set notation, A | B means "A or B", and P(A | B) is a conditional
  probability. Neither is a table.
- Absolute value bars |x| and the norm ||v|| are everyday math typography.
- The C expression a || b short-circuits; a | b does not.

So the sentence "use foo | bar to filter, or foo || bar to fall back" must
render as plain text, pipes and all, with nothing hidden and no table row
conjured out of thin air.

When you *do* want a literal command, fence it:

```sh
ps aux | grep node | awk '{print $2}'
```

One last stray | before the closing paragraph, just to be rude.

The fix for the original hang: remove the alias, or write grep pattern file |
less so stdin is never involved.

Local modifications to vendored md4c live here as numbered `.patch` files (applied in lexical order per UPSTREAM.md).

- `0001-fence-closed.patch` adds `fence_closed` to `MD_BLOCK_CODE_DETAIL`, so the decoder knows whether a closing fence or a container's end closed a fenced block instead of searching the following lines for one (which could take a sibling's fence). Regenerate it with `git diff -- md4c.h md4c.c` after rebasing onto a new upstream.

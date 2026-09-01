# Vendored md4c

Upstream: <https://github.com/mity/md4c> (MIT, Copyright (c) Martin Mitáš)

| | |
| --- | --- |
| Pinned commit | `3e7ace20d262028baf702db9850520f017c25591` (branch `master`) |
| Fetched | 2026-08-20 (UTC) |
| Fetched by | `curl https://raw.githubusercontent.com/mity/md4c/<SHA>/...` |

## Why master and not a tagged release

`MD_FLAG_FOOTNOTES`, and several other extension flags this library may want
to expose later, exist only on master. No tagged md4c release contains them.
So we pin an exact master commit SHA instead of a release tag. The pin is what
makes the build reproducible: never fetch "latest master" without updating
this file.

## Vendored files

| File | Upstream path | SHA-256 |
| --- | --- | --- |
| `md4c.h` | `src/md4c.h` | `29578d3d7544e70928a7dd7f40e8b4451c17d269186b060cc63b2742b5e2fc2a` |
| `md4c.c` | `src/md4c.c` | `393a7f287f39429221c5af56e6a160635a810650ac2a849afb969d9e3b7da1bf` |
| `entity.h` | `src/entity.h` | `99a8952be6629e4114947cb61a901bf4f73b10d84d1ac5e17ad8299dfbad708e` |
| `entity.c` | `src/entity.c` | `7ea50d695d9210958e01b12b3e4d1db78d783d03d95b040fd7d2d9cfe1f1d39c` |
| `LICENSE.md` | `LICENSE.md` | `e547c9a66c120b19f9838a1f7c2f51137f5c71ba27b70c3611b673f2cdb4e02e` |

## Local modifications

The vendored `.h` and `.c` files are never edited in place. Every local change
lives in `patches/` as a numbered `.patch` file (unified diff, applied in
lexical order). There are currently no patches: the files above are
byte-identical to upstream at the pinned SHA.

## Sync procedure (moving to a newer upstream)

1. Resolve the new master SHA:
   `git ls-remote https://github.com/mity/md4c.git refs/heads/master`
2. Re-fetch every file in the table above at that SHA from
   `https://raw.githubusercontent.com/mity/md4c/<NEW_SHA>/<upstream path>`.
3. Update this file: new SHA, new fetch date, new SHA-256 checksums.
4. Re-apply the patches in `patches/` in lexical order
   (`patch -p1 < patches/NNNN-name.patch` from this directory). If a patch no
   longer applies, rebase it onto the new upstream and keep the same number.
5. Re-run the gates: the C/C++ compile smoke test
   (`cc -c md4c.c entity.c` and `c++ -std=c++17 -c ../../OffsetParser.cpp -I .`),
   `npm run typecheck`, `npm test`, and `npm run conformance`.
6. Skim the upstream diff for new `MD_FLAG_*` values or changed callback
   detail structs. `OffsetParser.{h,cpp}` maps them explicitly and must be
   reviewed whenever the flag set changes.

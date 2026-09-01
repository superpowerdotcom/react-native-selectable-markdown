# Vendored spec fixtures

## spec.json — CommonMark 0.31.2 test suite (652 examples)

Canonical URL: <https://spec.commonmark.org/0.31.2/spec.json>

At vendoring time (2026-08-20) `spec.commonmark.org` was unreachable from the
build network, so this file was regenerated from the canonical, tag-pinned
source text instead:

- Source: <https://raw.githubusercontent.com/commonmark/commonmark-spec/0.31.2/spec.txt>
  (sha256 `257c41ad946f7a1414a499aca402a1aa8fdac3678532266611348c1cf54f4b80`)
- Extraction: the same algorithm as the spec repo's
  `test/spec_tests.py --dump-tests` (examples delimited by a 32-backtick
  `example` fence, `.` separating markdown from expected HTML, `→` denoting a
  tab, section = nearest ATX heading), serialized as JSON with 2-space indent.
- Result: 652 examples across 26 sections, matching the official dump's shape:
  `{ markdown, html, example, start_line, end_line, section }`.

To refresh: download the canonical `spec.json` URL above directly (preferred),
or re-run the extraction against the `spec.txt` of the new tag, and update this
note with the new version and checksum.

Do not edit `spec.json` by hand.

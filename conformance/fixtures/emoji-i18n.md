# Release notes, now with more skin tones 🎉

Shipping week! The team 👩‍💻👨‍💻 closed the localization epic, so here is what
changed for international users.

## Highlights

- Family emoji like 👨‍👩‍👧‍👦 and 👩‍👩‍👧 no longer break line-wrapping mid-sequence.
- Flags render correctly: 🇯🇵 🇧🇷 🇺🇦 🇰🇷 — including the rainbow flag 🏳️‍🌈 and
  the pirate one 🏴‍☠️.
- Skin-tone modifiers survive copy/paste: 👍🏽 stays 👍🏽, not 👍 + 🏽.

## Script coverage

The renderer was tested against mixed-script paragraphs such as:

**日本語のテキスト**と *한국어 텍스트* と العربية والعبרית — plus Zürich,
naïve café, and the combining-mark stress word Z̷̘̈a̶͖͐l̸̟̈g̸̼̈o̵̜͝.

1. CJK line-breaking follows the platform's rules 🀄
2. RTL segments keep their direction inside LTR paragraphs
3. `code spans with emoji 🧪 inside` measure correctly

Thanks to everyone who filed bugs — especially the person whose display name
is a single 🦖.

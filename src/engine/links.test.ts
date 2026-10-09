import { extractLinks } from './links';
import { presets } from './options';
import { describeNative, linkNativeEngineAsDefault } from './native/__tests__/support';

linkNativeEngineAsDefault();

describeNative('extractLinks', () => {
  test('lists links and autolinks with their label text', () => {
    const links = extractLinks('see [the *site*](https://e.com) or <https://f.org>\n', presets.llmChat);
    expect(links).toEqual([
      { kind: 'link', href: 'https://e.com', blocked: false, text: 'the site', span: { start: 4, end: 31 } },
      { kind: 'autolink', href: 'https://f.org', blocked: false, text: 'https://f.org', span: { start: 35, end: 50 } },
    ]);
  });

  test('a label nested as deep as the source likes does not overflow the stack', () => {
    const depth = 20_000;
    const source = `[${'*'.repeat(depth)}x${'*'.repeat(depth)}](https://e.com)\n`;
    const [link] = extractLinks(source, presets.llmChat);
    expect(link).toMatchObject({ kind: 'link', href: 'https://e.com', text: 'x' });
  });
});

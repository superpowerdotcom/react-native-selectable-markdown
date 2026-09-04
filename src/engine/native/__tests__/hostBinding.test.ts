/**
 * How the app-facing engine decides whether a native module is usable.
 *
 * Two failures this pins used to be live. The first: nothing ever called the
 * platform `install()`, so `isNativeEngineAvailable()` read a global that no
 * code path had put there and answered "no" no matter how well the native
 * module was linked. The second: the answer ignored `protocolVersion`, so a
 * stale native binary counted as available and then threw a
 * `NativeProtocolError` out of the decoder on every parse, one opaque
 * exception per document, saying nothing about the rebuild that would fix it
 * — the exact opposite of what SelectableMarkdownJsi.h promises.
 *
 * Both answers carry more weight than they used to. md4c is the only parser
 * in the package, so `isNativeEngineAvailable()` returning `false` no longer
 * means "a slower path will be taken"; it means this JS context cannot parse
 * markdown at all. A wrong answer either way is now the difference between a
 * rendered document and an actionable exception.
 *
 * Both are module-state questions (`installed`, the memoized engine), so
 * every case runs against a freshly required module registry.
 */

import { parseDocument } from '../../Engine';
import { presets } from '../../options';
import type { NativeHostBinding } from '../index';
import { nativeAddonOrNull } from './support';

type Globals = typeof globalThis & { __selectableMarkdown?: NativeHostBinding };

/** A binding that parses for real, so "available" can be taken all the way. */
function realBinding(protocolVersion: number): NativeHostBinding | null {
  const addon = nativeAddonOrNull();
  return addon ? { protocolVersion, parse: addon.parse } : null;
}

function withFreshModules<T>(body: (native: typeof import('../index')) => T): T {
  let out!: T;
  jest.isolateModules(() => {
    out = body(require('../index') as typeof import('../index'));
  });
  return out;
}

describe('host binding discovery', () => {
  const globals = globalThis as Globals;
  let installCalls = 0;

  afterEach(() => {
    delete globals.__selectableMarkdown;
    installCalls = 0;
    jest.resetModules();
  });

  /**
   * Stands in for `NativeModules.SelectableMarkdown` on device: `install()`
   * is the only thing that ever writes the global, and it is called from JS
   * or not at all.
   *
   * DELIBERATELY NOT A VIRTUAL MOCK, and that is load-bearing. Jest keys an
   * explicit mock by a module ID derived from the *requiring* file, and it
   * caches those IDs on a Resolver shared by every test file a worker process
   * runs. A virtual mock IDs as the bare string "react-native"; an ordinary
   * require of the installed package IDs as its resolved path. So if a file
   * that lets install.ts require react-native for real runs earlier in the
   * same worker — engine.test.ts does exactly that, since an unmocked
   * `isNativeEngineAvailable()` is the behaviour it pins — the resolved-path
   * ID is already cached for install.ts's require, the virtual ID registered
   * here never matches it, and install.ts gets the real react-native instead
   * of this mock. It throws on its own ESM entry point, the catch in
   * `installNativeEngine` turns that into `false`, and the two cases below
   * that expect an available binding fail — but only in the worker shuffles
   * where that file lands first, which is what made this a heisenbug rather
   * than a red suite. Mocking non-virtually gives both sides the same
   * resolved-path ID, so the order stops mattering. react-native is a
   * devDependency of this package, so resolving it always succeeds.
   */
  function mockPlatform(binding: NativeHostBinding | null): void {
    jest.doMock('react-native', () => ({
      NativeModules: {
        SelectableMarkdown: {
          install: () => {
            installCalls += 1;
            if (binding) (globalThis as Globals).__selectableMarkdown = binding;
            return binding !== null ? 'installed' : 'unavailable';
          },
        },
      },
    }));
  }

  /**
   * A platform module that answers with a fixed outcome and never installs
   * anything — the shape of a device that cannot host the binding at all.
   *
   * `outcome` is typed `unknown` on purpose: the three strings are what a
   * current binary returns, and a bare `false` is what an older one returns,
   * and `installNativeEngine` has to read both.
   */
  function mockRefusingPlatform(outcome: unknown): void {
    jest.doMock('react-native', () => ({
      NativeModules: {
        SelectableMarkdown: {
          install: () => {
            installCalls += 1;
            return outcome;
          },
        },
      },
    }));
  }

  test('availability asks the platform to install, and reports the result', () => {
    const binding = realBinding(1);
    if (!binding) return; // no compiled addon on this machine
    mockPlatform(binding);
    withFreshModules((native) => {
      expect(globals.__selectableMarkdown).toBeUndefined();
      expect(native.isNativeEngineAvailable()).toBe(true);
      expect(installCalls).toBe(1);
      const doc = parseDocument('# hi\n', presets.commonmark, native.nativeEngine);
      expect(doc.blocks[0].kind).toBe('heading');
    });
  });

  test('a second call does not re-cross the bridge', () => {
    const binding = realBinding(1);
    if (!binding) return;
    mockPlatform(binding);
    withFreshModules((native) => {
      expect(native.isNativeEngineAvailable()).toBe(true);
      expect(native.isNativeEngineAvailable()).toBe(true);
      // install() is a blocking synchronous method; calling it once per
      // render would be a real cost, and the memo is what prevents it.
      expect(installCalls).toBe(1);
    });
  });

  test('no native module means unavailable, not an exception', () => {
    mockPlatform(null);
    withFreshModules((native) => {
      expect(native.isNativeEngineAvailable()).toBe(false);
      expect(native.findHostBinding()).toBeNull();
    });
  });

  test('a host that is not React Native at all is unavailable', () => {
    // Plain Node: `require('react-native')` throws from its own entry point.
    // Non-virtual for the reason spelled out over `mockPlatform`.
    jest.doMock('react-native', () => {
      throw new Error('not a React Native host');
    });
    withFreshModules((native) => {
      expect(native.isNativeEngineAvailable()).toBe(false);
    });
  });

  /**
   * The warning is the feature here, so it is captured and asserted rather
   * than left to print.
   *
   * Both cases below drive `installNativeEngine` down its protocol-mismatch
   * path, which warns. Unspied, Jest renders that with a code frame and a
   * stack, so a passing run looked like a failing one — and the message
   * itself, the actionable half this file's docblock is about, went
   * unchecked. The spy is installed for the whole block: a stray warning from
   * anywhere else in it fails `toHaveBeenCalledTimes`.
   */
  describe('protocol version skew', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    test('a binding at the wrong version is not available, and says why once', () => {
      const binding = realBinding(999);
      if (!binding) return;
      mockPlatform(binding);
      withFreshModules((native) => {
        expect(native.PROTOCOL_VERSION).not.toBe(999);
        expect(native.findHostBinding()).toBeNull();
        expect(native.isNativeEngineAvailable()).toBe(false);

        // Both numbers and the fix, because "not available" alone would send
        // the reader looking at their own code.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(
          new RegExp(
            `wire protocol v999 .*decodes v${native.PROTOCOL_VERSION}\\..*Rebuild the app`,
          ),
        );

        // The once-per-JS-context guard (`warnedAboutProtocol` in
        // install.ts). An app that polls availability from a render path must
        // get a diagnostic, not a flood.
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });

    test('and parsing through it fails with the actionable error, not a decode error', () => {
      const binding = realBinding(999);
      if (!binding) return;
      mockPlatform(binding);
      withFreshModules((native) => {
        // The distinction that matters: a caller who ignores availability and
        // parses anyway is told to rebuild the app, rather than being handed
        // a NativeProtocolError from somewhere inside the decoder.
        const parse = (): unknown =>
          parseDocument('# hi\n', presets.commonmark, native.nativeEngine);
        expect(parse).toThrow(/native engine not usable/);
        expect(parse).not.toThrow(native.NativeProtocolError);
        // Two failed parses, still one warning.
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
  });

  /**
   * The failure path used to cost as much as the success path, every time.
   *
   * `isNativeEngineAvailable()` is documented as safe to poll, and
   * `install()` is a BLOCKING SYNCHRONOUS method that logs from the native
   * side on every refusal (RCTLogWarn / Log.w). Because a `false` was never
   * memoized, a component that asked once per render crossed the bridge once
   * per render and turned a one-line diagnostic into a flood. The platform
   * modules now say which refusals are permanent, and that is what these
   * cases pin.
   */
  describe('a permanent refusal is asked for once', () => {
    test("'refused' stops the polling, and availability stays false", () => {
      mockRefusingPlatform('refused');
      withFreshModules((native) => {
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(installCalls).toBe(1);

        // The whole point: five more asks, still one bridge crossing.
        for (let i = 0; i < 5; i += 1) {
          expect(native.isNativeEngineAvailable()).toBe(false);
        }
        expect(installCalls).toBe(1);

        // And the reason is legible to an app that wants to stop waiting.
        expect(native.isNativeEnginePermanentlyRefused()).toBe(true);
        expect(native.isNativeEngineInstalled()).toBe(false);
      });
    });

    test("'unavailable' is retried, because the bridge may still arrive", () => {
      mockRefusingPlatform('unavailable');
      withFreshModules((native) => {
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(native.isNativeEngineAvailable()).toBe(false);
        // Three asks, three crossings — deliberately, since this is the state
        // that resolves itself once the runtime is up.
        expect(installCalls).toBe(3);
        expect(native.isNativeEnginePermanentlyRefused()).toBe(false);
      });
    });

    test('a native binary older than this bundle still answers a bare boolean', () => {
      // Forward compatibility in the direction that actually happens: JS
      // reloads without a rebuild. A `false` carries no permanence claim, so
      // it must read as transient — retried forever, exactly as before.
      mockRefusingPlatform(false);
      withFreshModules((native) => {
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(installCalls).toBe(2);
        expect(native.isNativeEnginePermanentlyRefused()).toBe(false);
      });
    });

    test('an unrecognised outcome is read as transient, never as permanent', () => {
      // A future binary inventing a fourth string must not be able to make
      // this bundle give up on a binding that is really there.
      mockRefusingPlatform('something-new');
      withFreshModules((native) => {
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(native.isNativeEngineAvailable()).toBe(false);
        expect(installCalls).toBe(2);
        expect(native.isNativeEnginePermanentlyRefused()).toBe(false);
      });
    });

    test('a refusal is not remembered once the binding is actually there', () => {
      // The refusal memo is only consulted when nothing landed on the global.
      // A binary that reports 'refused' but installs anyway (or a host that
      // installed during startup) must still be used.
      const binding = realBinding(1);
      if (!binding) return;
      jest.doMock('react-native', () => ({
        NativeModules: {
          SelectableMarkdown: {
            install: () => {
              installCalls += 1;
              (globalThis as Globals).__selectableMarkdown = binding;
              return 'refused';
            },
          },
        },
      }));
      withFreshModules((native) => {
        expect(native.isNativeEngineAvailable()).toBe(true);
        expect(native.isNativeEnginePermanentlyRefused()).toBe(false);
      });
    });
  });

  test('an explicitly linked parse function needs no platform module', () => {
    const addon = nativeAddonOrNull();
    if (!addon) return;
    jest.doMock('react-native', () => {
      throw new Error('not a React Native host');
    });
    withFreshModules((native) => {
      native.__linkNativeEngine(addon.parse);
      expect(native.isNativeEngineAvailable()).toBe(true);
      const doc = parseDocument('*x*\n', presets.commonmark, native.nativeEngine);
      expect(doc.blocks).toHaveLength(1);
    });
  });
});

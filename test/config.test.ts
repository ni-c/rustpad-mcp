import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
} from '../src/config.js';

const URL_OK = 'https://rustpad.example.net';

function silence() {
  return vi.spyOn(console, 'error').mockImplementation(() => undefined);
}

function trapExit() {
  return vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loadConfig', () => {
  it('loads a complete configuration', () => {
    const config = loadConfig({ RUSTPAD_URL: 'https://rustpad.example.net' });
    expect(config).toEqual({
      url: 'https://rustpad.example.net',
      insecureTls: false,
      readOnly: false,
      elicitation: true,
    });
  });

  describe('ELICITATION', () => {
    it('defaults to on, and to on for an empty value', () => {
      // The only variable of this family that defaults to *on*. An unset
      // switch has to mean "ask", or a deployment that never heard of it
      // would quietly stop asking.
      expect(loadConfig({ RUSTPAD_URL: URL_OK }).elicitation).toBe(true);
      expect(
        loadConfig({ RUSTPAD_URL: URL_OK, ELICITATION: '' }).elicitation
      ).toBe(true);
    });

    it('is switched off by "false", in any casing or padding', () => {
      for (const raw of ['false', 'FALSE', ' False ']) {
        expect(
          loadConfig({ RUSTPAD_URL: URL_OK, ELICITATION: raw }).elicitation,
          raw
        ).toBe(false);
      }
    });

    it('refuses to start on anything else, naming both valid values', () => {
      // Deliberately fatal rather than falling back to the default. A typo
      // would leave the dialog running while the operator believes it is off,
      // and nothing else would ever tell them.
      for (const raw of ['1', 'off', 'no', 'yes']) {
        const error = silence();
        const exit = trapExit();
        expect(() =>
          loadConfig({ RUSTPAD_URL: URL_OK, ELICITATION: raw })
        ).toThrow('exit');
        expect(exit).toHaveBeenCalledWith(1);
        const message = String(error.mock.calls[0]?.[0] ?? '');
        expect(message, raw).toContain('ELICITATION');
        expect(message, raw).toContain('"true"');
        expect(message, raw).toContain('"false"');
        vi.restoreAllMocks();
      }
    });
  });

  it('warns but does not exit without a URL', () => {
    const error = silence();
    const config = loadConfig({});
    expect(config.url).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('RUSTPAD_URL'));
  });

  it('strips trailing slashes', () => {
    const config = loadConfig({ RUSTPAD_URL: 'https://rustpad.example.net//' });
    expect(config.url).toBe('https://rustpad.example.net');
  });

  it('exits on a malformed URL without echoing the value', () => {
    const error = silence();
    trapExit();
    expect(() => loadConfig({ RUSTPAD_URL: 'not a url' })).toThrow('exit');
    for (const call of error.mock.calls) {
      expect(String(call[0])).not.toContain('not a url');
    }
  });

  it('exits on a non-http protocol', () => {
    silence();
    trapExit();
    expect(() =>
      loadConfig({ RUSTPAD_URL: 'ftp://rustpad.example.net' })
    ).toThrow('exit');
  });

  it('exits on credentials in the URL', () => {
    silence();
    trapExit();
    expect(() =>
      loadConfig({ RUSTPAD_URL: 'https://user:pass@rustpad.example.net' })
    ).toThrow('exit');
  });

  it('exits on a query string or fragment', () => {
    silence();
    trapExit();
    expect(() =>
      loadConfig({ RUSTPAD_URL: 'https://rustpad.example.net/?x=1' })
    ).toThrow('exit');
    expect(() =>
      loadConfig({ RUSTPAD_URL: 'https://rustpad.example.net/#pad' })
    ).toThrow('exit');
  });

  it('warns on plain http to a non-local host', () => {
    const error = silence();
    loadConfig({ RUSTPAD_URL: 'http://rustpad.example.net' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
  });

  it('does not warn on loopback http, including bracketed IPv6', () => {
    const error = silence();
    loadConfig({ RUSTPAD_URL: 'http://localhost:3030' });
    loadConfig({ RUSTPAD_URL: 'http://127.0.0.1:3030' });
    loadConfig({ RUSTPAD_URL: 'http://[::1]:3030' });
    expect(error).not.toHaveBeenCalled();
  });

  describe('RUSTPAD_READ_ONLY', () => {
    const base = { RUSTPAD_URL: 'https://rustpad.example.net' };

    it('accepts every spelling an operator plausibly means by "on"', () => {
      // Parsed leniently on purpose, and not for convenience. This switch is
      // the difference between three tools and eight against an instance with
      // no authentication of its own; read strictly, `RUSTPAD_READ_ONLY=1`
      // would register every write tool and nothing would ever report it.
      for (const raw of ['true', 'True', 'TRUE', ' true ', '1', 'yes', 'YES']) {
        expect(
          loadConfig({ ...base, RUSTPAD_READ_ONLY: raw }).readOnly,
          raw
        ).toBe(true);
      }
    });

    it('stays off when unset or empty', () => {
      expect(loadConfig(base).readOnly).toBe(false);
      expect(loadConfig({ ...base, RUSTPAD_READ_ONLY: '  ' }).readOnly).toBe(
        false
      );
      expect(loadConfig({ ...base, RUSTPAD_READ_ONLY: 'false' }).readOnly).toBe(
        false
      );
    });
  });

  it('reads RUSTPAD_INSECURE_TLS as exactly "true"', () => {
    // The opposite direction from RUSTPAD_READ_ONLY, deliberately: this one
    // removes a protection, so a typo has to leave certificate validation on.
    const base = { RUSTPAD_URL: 'https://rustpad.example.net' };
    expect(
      loadConfig({ ...base, RUSTPAD_INSECURE_TLS: 'true' }).insecureTls
    ).toBe(true);
    expect(loadConfig({ ...base, RUSTPAD_INSECURE_TLS: '1' }).insecureTls).toBe(
      false
    );
    expect(
      loadConfig({ ...base, RUSTPAD_INSECURE_TLS: 'True' }).insecureTls
    ).toBe(false);
  });
});

describe('missingConfigKeys', () => {
  it('names the missing URL', () => {
    expect(
      missingConfigKeys({ url: undefined, insecureTls: false, readOnly: false })
    ).toEqual(['RUSTPAD_URL']);
    expect(
      missingConfigKeys({
        url: 'https://x',
        insecureTls: false,
        readOnly: false,
      })
    ).toEqual([]);
  });

  it('produces a message that names required and optional variables', () => {
    const message = missingConfigMessage(['RUSTPAD_URL']);
    expect(message).toContain('RUSTPAD_URL');
    expect(message).toContain('RUSTPAD_READ_ONLY');
    expect(message).toContain('RUSTPAD_INSECURE_TLS');
  });
});

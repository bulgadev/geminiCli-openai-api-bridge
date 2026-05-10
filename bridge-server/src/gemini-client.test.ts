import { describe, it, expect, vi } from 'vitest';

// @google/gemini-cli-core is resolved from the global npm install path
// @google/genai is installed as a devDependency

import {
  base64urlEncode,
  base64urlDecode,
  extractThoughtSigFromId,
  mergeFunctionResponseUserEntries,
  sanitizeGeminiSchema,
  GeminiApiClient,
} from './gemini-client.js';

class TestClient extends GeminiApiClient {
  constructor() {
    const mockConfig = {
      getGeminiClient: () => ({ getContentGenerator: () => ({}) }),
      getUserMemory: () => null,
      setModel: () => {},
      getModel: () => 'gemini-2.5-flash',
      getContentGeneratorConfig: () => undefined,
      getQuotaErrorOccurred: () => false,
      flashFallbackHandler: null,
    };
    super(mockConfig as any, false);
  }
  parseFn(id: string) { return this.parseFunctionNameFromId(id); }
}

describe('base64urlEncode / base64urlDecode', () => {
  it('round-trips standard Base64 with +', () => {
    const orig = 'CiwBjz1rX9YIeQYopkOtQOfpZpjzKaEI1PPL42hPGV9dAcKrcQw7XzjtvRSz+Qp7';
    const b64url = base64urlEncode(orig);
    expect(b64url).not.toContain('+');
    expect(base64urlDecode(b64url)).toBe(orig);
  });

  it('round-trips standard Base64 with /', () => {
    const orig = 'ab/cd/ef'; // 8 chars, 8%4=0, no padding, valid Base64
    const b64url = base64urlEncode(orig);
    expect(b64url).not.toContain('/');
    expect(b64url).not.toContain('=');
    expect(base64urlDecode(b64url)).toBe(orig);
  });

  it('round-trips 1-padding Base64', () => {
    const orig = 'YWI='; // 2 input bytes → 3 Base64 chars + 1 = (4 total)
    const b64url = base64urlEncode(orig);
    expect(b64url).not.toContain('=');
    expect(base64urlDecode(b64url)).toBe(orig);
  });

  it('round-trips 2-padding Base64', () => {
    const orig = 'YQ=='; // 1 input byte → 2 Base64 chars + 2 == (4 total)
    const b64url = base64urlEncode(orig);
    expect(b64url).not.toContain('=');
    expect(base64urlDecode(b64url)).toBe(orig);
  });

  it('round-trips with 2 padding', () => {
    const orig = 'YWJjZGVmZw==';
    expect(base64urlDecode(base64urlEncode(orig))).toBe(orig);
  });

  it('handles empty string', () => {
    expect(base64urlDecode(base64urlEncode(''))).toBe('');
  });
});

describe('extractThoughtSigFromId', () => {
  it('extracts sig from valid ID', () => {
    const id = 'call.get_current_date.CiwBjz1rX9YI.622336f2-cd2e-41fe-9943-4a81c5efeb92';
    expect(extractThoughtSigFromId(id)).toBe('CiwBjz1rX9YI');
  });

  it('extracts sig with base64url chars (- and _)', () => {
    const raw = 'CiwBjz1rX9YI+Qp7/ab+';
    const encoded = base64urlEncode(raw);
    const id = `call.test_tool.${encoded}.uuid-here`;
    expect(extractThoughtSigFromId(id)).toBe(raw);
  });

  it('returns null for ID without dot format', () => {
    expect(extractThoughtSigFromId('call_test_tool_uuid')).toBeNull();
  });

  it('returns null for ID with only 3 parts', () => {
    expect(extractThoughtSigFromId('call.name.uuid')).toBeNull();
  });

  it('returns null for ID with short encoded sig', () => {
    expect(extractThoughtSigFromId('call.name.ab.uuid')).toBeNull();
  });

  it('returns null for non-call prefix', () => {
    expect(extractThoughtSigFromId('something.name.abc123.uuid')).toBeNull();
  });

  it('handles empty string', () => {
    expect(extractThoughtSigFromId('')).toBeNull();
  });
});

describe('parseFunctionNameFromId', () => {
  const client = new TestClient();

  it('extracts simple name', () => {
    expect(client.parseFn('call.get_current_date.CiwBjz1r.0945d-3195-42b3')).toBe('get_current_date');
  });

  it('extracts name with underscore', () => {
    expect(client.parseFn('call.default_api:bash.Cl4Bjz1r.uuid')).toBe('default_api:bash');
  });

  it('returns fallback for unknown format', () => {
    expect(client.parseFn('nope')).toBe('unknown_tool_from_id');
  });
});

describe('mergeFunctionResponseUserEntries', () => {
  it('merges consecutive function responses into one', () => {
    const input: Content[] = [
      { role: 'user', parts: [{ text: 'hello' }] },
      { role: 'model', parts: [{ functionCall: { name: 'foo', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'foo', response: { ok: true } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'bar', response: { ok: true } } }] },
    ];
    const result = mergeFunctionResponseUserEntries(input);
    expect(result).toHaveLength(3);
    expect(result[2].role).toBe('user');
    expect(result[2].parts).toHaveLength(2);
  });

  it('does not merge across model turns', () => {
    const input: Content[] = [
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: {} } }] },
      { role: 'model', parts: [{ text: 'thinking' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'b', response: {} } }] },
    ];
    const result = mergeFunctionResponseUserEntries(input);
    expect(result).toHaveLength(3);
  });

  it('does not merge text-only with function responses', () => {
    const input: Content[] = [
      { role: 'user', parts: [{ functionResponse: { name: 'a', response: {} } }] },
      { role: 'user', parts: [{ text: 'follow up' }] },
    ];
    const result = mergeFunctionResponseUserEntries(input);
    expect(result).toHaveLength(2);
    expect(result[0].parts).toHaveLength(1);
    expect(result[1].parts![0]).toHaveProperty('text');
  });

  it('handles empty input', () => {
    expect(mergeFunctionResponseUserEntries([])).toEqual([]);
  });

  it('handles single entry', () => {
    const input: Content[] = [{ role: 'user', parts: [{ text: 'hi' }] }];
    expect(mergeFunctionResponseUserEntries(input)).toEqual(input);
  });
});

describe('sanitizeGeminiSchema', () => {
  it('resolves $ref from $defs', () => {
    const schema = {
      type: 'object',
      properties: { name: { $ref: '#/$defs/StringType' } },
      $defs: { StringType: { type: 'string' } },
    };
    const result = sanitizeGeminiSchema(schema);
    expect(result.properties.name).toEqual({ type: 'string' });
    expect(result).not.toHaveProperty('$defs');
    expect(result).not.toHaveProperty('$ref');
  });

  it('strips unsupported keywords', () => {
    const schema = {
      type: 'object',
      properties: { x: { type: 'string' } },
      additionalProperties: false,
    };
    const result = sanitizeGeminiSchema(schema);
    expect(result).not.toHaveProperty('additionalProperties');
  });

  it('resolves protobuf-style ref from definitions', () => {
    const schema = {
      type: 'object',
      properties: { msg: { ref: 'QuestionPrompt', description: 'A prompt' } },
      definitions: { QuestionPrompt: { type: 'string' } },
    };
    const result = sanitizeGeminiSchema(schema);
    expect(result.properties.msg).toEqual({ type: 'string', description: 'A prompt' });
  });

  it('passes plain schema through', () => {
    expect(sanitizeGeminiSchema({ type: 'string' })).toEqual({ type: 'string' });
  });
});

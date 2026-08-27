import { describe, expect, test } from 'bun:test'
import { sanitizeCodexDiagnostic } from './codex.ts'

describe('sanitizeCodexDiagnostic', () => {
  test('removes credential values and auth file paths', () => {
    const raw = 'Bearer abc.def access_token=secret123 https://x.test?a=1&token=query-secret /Users/tina/.codex/auth.json sk-secretvalue'
    const safe = sanitizeCodexDiagnostic(raw)
    expect(safe).not.toContain('abc.def')
    expect(safe).not.toContain('secret123')
    expect(safe).not.toContain('query-secret')
    expect(safe).not.toContain('auth.json')
    expect(safe).not.toContain('sk-secretvalue')
  })
})

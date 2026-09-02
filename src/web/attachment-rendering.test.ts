import { beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('web attachment rendering', () => {
  let html = ''
  let render: (file: unknown) => string

  beforeAll(() => {
    html = readFileSync(new URL('../../web/workgroup-v2/index.html', import.meta.url), 'utf8')
    const partsSource = html.match(/function attachmentFileParts\(file\) \{[\s\S]*?\n\}/)?.[0]
    const renderSource = html.match(/function renderAttachmentFile\(file, extraStyle = ''\) \{[\s\S]*?\n\}/)?.[0]
    expect(partsSource).toBeTruthy()
    expect(renderSource).toBeTruthy()

    const makeRenderer = new Function(`
      const esc = value => String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
      ${partsSource}
      ${renderSource}
      return renderAttachmentFile;
    `)
    render = makeRenderer() as (file: unknown) => string
  })

  test('renders normalized message asset objects with the stored filename and original label', () => {
    const output = render({ server: 'stored-a1.txt', original: 'meeting notes.txt', size: 42 })

    expect(output).toContain('/images/stored-a1.txt')
    expect(output).toContain('meeting notes.txt')
    expect(output).not.toContain('[object Object]')
  })

  test('keeps historical string-format document attachments compatible', () => {
    const output = render('legacy-report.pdf')
    expect(output).toContain('/images/legacy-report.pdf')
    expect(output).toContain('legacy-report.pdf')
    expect(output).not.toContain('[object Object]')
  })

  test('uses the shared attachment renderer for Shared Channel and Thread messages', () => {
    expect(html).toContain('(m.files || []).map(fn => renderAttachmentFile(fn)).join(\'\')')
    expect(html).toContain('messages.map(renderGroupMsg).join(\'\')')
  })

  test('keeps image attachment URLs filename-based', () => {
    const imageRenderers = html.match(/<img src="\/images\/\$\{encodeURIComponent\(fn\)\}/g) || []
    expect(imageRenderers.length).toBeGreaterThanOrEqual(2)
    expect(html).not.toContain('encodeURIComponent(file)')
  })

  test('never emits object coercion for malformed attachment records', () => {
    expect(render({ original: 'missing-server.txt' })).toBe('')
    expect(render(null)).toBe('')
  })
})

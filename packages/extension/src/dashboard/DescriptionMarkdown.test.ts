import { expect, it } from 'vitest'

import { descriptionMarkdown } from './DescriptionMarkdown'

it('renders PR headings, emphasis, lists, code, quotes, tables, and links', () => {
  const html = descriptionMarkdown(
    '# Changes\n\n**NOTE**: Keep `AppDelegate`.\n\n- First\n- Second\n\n> Review carefully\n\n```ts\nconst scene = "<window>"\n```\n\n| File | Status |\n| --- | --- |\n| Scene | Added |\n\nSee https://github.com/react/react-native/pull/53744',
  )

  expect(html).toContain('<h1>Changes</h1>')
  expect(html).toContain('<strong>NOTE</strong>')
  expect(html).toContain('<code>AppDelegate</code>')
  expect(html).toContain('<li>First</li>')
  expect(html).toContain('<blockquote>')
  expect(html).toContain('<pre><code class="language-ts">')
  expect(html).toContain('&lt;window&gt;')
  expect(html).toContain('<table>')
  expect(html).toContain('href="https://github.com/react/react-native/pull/53744"')
  expect(html).toContain('target="_blank" rel="noopener noreferrer"')
})

it('keeps provider HTML inert and never loads Markdown images', () => {
  const html = descriptionMarkdown(
    '<script>alert(1)</script>\n<img src="https://tracker.test/pixel" onerror="alert(1)">\n<iframe src="https://tracker.test"></iframe>\n\n![Image <label>](https://tracker.test/markdown.png)',
  )

  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).toContain('&lt;img')
  expect(html).toContain('Image &lt;label&gt;')
  expect(html).not.toMatch(/<(?:script|img|iframe)\b/)
  expect(html).not.toContain('markdown.png')
})

it('rejects command, script, data, file and relative link destinations', () => {
  for (const destination of [
    'javascript:alert%281%29',
    'command:workbench.action.terminal.new',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'vscode://publisher.extension',
    '/relative/path',
    '//tracker.test/path',
    'jav&#x61;script:alert%281%29',
  ]) {
    expect(descriptionMarkdown(`[Click](${destination})`)).not.toContain('<a ')
  }

  expect(descriptionMarkdown('[Docs](https://example.test/?a=1&b=2)')).toContain(
    'href="https://example.test/?a=1&amp;b=2"',
  )
})

it('labels empty descriptions and preserves soft line breaks', () => {
  expect(descriptionMarkdown(' \n ')).toBe('<p>No description provided.</p>\n')
  expect(descriptionMarkdown('First\nSecond')).toBe('<p>First<br>\nSecond</p>\n')
})

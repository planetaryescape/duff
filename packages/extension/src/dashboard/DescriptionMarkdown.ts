import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true })

markdown.validateLink = (destination) =>
  URL.canParse(destination) && ['https:', 'http:'].includes(new URL(destination).protocol)

markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]?.content ?? '')

markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  const token = tokens[index]

  if (token) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }

  return renderer.renderToken(tokens, index, options)
}

export function descriptionMarkdown(description: string): string {
  return markdown.render(description.trim() ? description : 'No description provided.')
}

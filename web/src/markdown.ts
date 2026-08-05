/**
 * A small Markdown parser for the subset agent answers actually use: headings, bold,
 * italics, inline code, fenced code, and flat lists.
 *
 * Hand-rolled rather than pulled from a library for one reason that matters — `@Term`
 * references have to be links into the glossary, and they appear *inside* the prose. A
 * library would mean post-processing its text nodes to find them anyway, so the mention is
 * a first-class token here instead.
 *
 * Parsing produces plain data; rendering happens in `Markdown.tsx`. That split is what
 * makes the awkward parts testable without a DOM.
 *
 * Deliberately unsupported: tables, blockquotes, nested lists, and `_italics_`. That last
 * one is not laziness — this domain is full of snake_case identifiers like
 * `analyze_pending` and `mcp__blueprints__read_glossary`, and underscore italics would
 * mangle them. `*italics*` works.
 */

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'mention'; name: string }
  | { kind: 'strong'; children: Token[] }
  | { kind: 'em'; children: Token[] }

export type Block =
  | { kind: 'heading'; level: number; tokens: Token[] }
  | { kind: 'paragraph'; tokens: Token[] }
  | { kind: 'list'; ordered: boolean; items: Token[][] }
  | { kind: 'code'; lang: string | null; text: string }

/**
 * Built fresh per call, never shared. `parseInline` recurses for nested emphasis, and a
 * module-level `g`-flagged regex would have its `lastIndex` reset by the inner call and
 * restart the outer scan forever.
 */
const INLINE_PATTERN = String.raw`\`([^\`]+)\`|\*\*([\s\S]+?)\*\*|\*([^*\n]+)\*|@([A-Za-z][A-Za-z0-9_-]*)`

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/
const FENCE = /^\s*```\s*(\S+)?\s*$/

/**
 * `depth` stops `**a *b* c**` from recursing forever and keeps emphasis from nesting
 * more than prose ever needs.
 */
export function parseInline(text: string, depth = 0): Token[] {
  const tokens: Token[] = []
  const inline = new RegExp(INLINE_PATTERN, 'g')
  let at = 0

  for (let match = inline.exec(text); match; match = inline.exec(text)) {
    // Nothing here can match empty, but a zero-length match would never advance
    // `lastIndex` and would hang the parser rather than fail.
    if (match[0].length === 0) break
    if (match.index > at) tokens.push({ kind: 'text', text: text.slice(at, match.index) })

    const [, code, strong, em, mention] = match
    if (code !== undefined) {
      tokens.push({ kind: 'code', text: code })
    } else if (strong !== undefined) {
      tokens.push(
        depth >= 2
          ? { kind: 'text', text: strong }
          : { kind: 'strong', children: parseInline(strong, depth + 1) },
      )
    } else if (em !== undefined) {
      tokens.push(
        depth >= 2 ? { kind: 'text', text: em } : { kind: 'em', children: parseInline(em, depth + 1) },
      )
    } else if (mention !== undefined) {
      tokens.push({ kind: 'mention', name: mention })
    }

    at = match.index + match[0].length
  }

  if (at < text.length) tokens.push({ kind: 'text', text: text.slice(at) })
  return tokens
}

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []

  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', tokens: parseInline(paragraph.join(' ')) })
    paragraph = []
  }

  const flushList = () => {
    if (!list) return
    blocks.push({
      kind: 'list',
      ordered: list.ordered,
      items: list.items.map((item) => parseInline(item)),
    })
    list = null
  }

  const flush = () => {
    flushParagraph()
    flushList()
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!

    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      index += 1
      // An unterminated fence swallows the rest rather than dropping the content.
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        body.push(lines[index]!)
        index += 1
      }
      blocks.push({ kind: 'code', lang: fence[1] ?? null, text: body.join('\n') })
      continue
    }

    if (line.trim() === '') {
      flush()
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', level: heading[1]!.length, tokens: parseInline(heading[2]!) })
      continue
    }

    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const ordered = Boolean(numbered)
      // A change of marker starts a new list rather than silently reusing the old one.
      if (list && list.ordered !== ordered) flushList()
      list ??= { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1]!)
      continue
    }

    // A plain line directly under a list item continues it, which is how wrapped
    // bullets arrive.
    if (list) {
      list.items[list.items.length - 1] += ` ${line.trim()}`
      continue
    }

    paragraph.push(line.trim())
  }

  flush()
  return blocks
}

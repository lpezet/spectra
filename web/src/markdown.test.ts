import { describe, expect, it } from 'vitest'
import { parseBlocks, parseInline } from './markdown.js'

const text = (value: string) => ({ kind: 'text', text: value })

describe('parseInline', () => {
  it('leaves plain prose alone', () => {
    expect(parseInline('just words')).toEqual([text('just words')])
  })

  it('pulls out inline code', () => {
    expect(parseInline('call `analyze_pending` first')).toEqual([
      text('call '),
      { kind: 'code', text: 'analyze_pending' },
      text(' first'),
    ])
  })

  it('does not italicise snake_case identifiers', () => {
    // The reason `_italics_` is unsupported: this domain is full of names like these.
    expect(parseInline('mcp__blueprints__read_glossary')).toEqual([
      text('mcp__blueprints__read_glossary'),
    ])
  })

  it('reads bold and italics', () => {
    expect(parseInline('**cs-003** is *the* pivot')).toEqual([
      { kind: 'strong', children: [text('cs-003')] },
      text(' is '),
      { kind: 'em', children: [text('the')] },
      text(' pivot'),
    ])
  })

  it('keeps code inside bold', () => {
    expect(parseInline('**run `x` now**')).toEqual([
      {
        kind: 'strong',
        children: [text('run '), { kind: 'code', text: 'x' }, text(' now')],
      },
    ])
  })

  it('treats bold before italics, so ** is not two emphases', () => {
    expect(parseInline('**a**')).toEqual([{ kind: 'strong', children: [text('a')] }])
  })

  it('finds mentions', () => {
    expect(parseInline('see @deleteProject')).toEqual([
      text('see '),
      { kind: 'mention', name: 'deleteProject' },
    ])
  })

  it('does not treat an unmatched asterisk as emphasis', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([text('2 * 3 = 6')])
  })

  it('stops nesting emphasis past two levels', () => {
    const tokens = parseInline('**a *b* c**')
    expect(tokens[0]!.kind).toBe('strong')
  })
})

describe('parseBlocks', () => {
  it('splits paragraphs on blank lines and joins wrapped ones', () => {
    expect(parseBlocks('one\nstill one\n\ntwo')).toEqual([
      { kind: 'paragraph', tokens: [text('one still one')] },
      { kind: 'paragraph', tokens: [text('two')] },
    ])
  })

  it('reads headings with their level', () => {
    const [block] = parseBlocks('## Where to start')
    expect(block).toEqual({ kind: 'heading', level: 2, tokens: [text('Where to start')] })
  })

  it('groups consecutive bullets into one list', () => {
    const [block] = parseBlocks('- first\n- second')
    expect(block).toEqual({
      kind: 'list',
      ordered: false,
      items: [[text('first')], [text('second')]],
    })
  })

  it('reads numbered lists as ordered', () => {
    const [block] = parseBlocks('1. first\n2. second')
    expect(block).toMatchObject({ kind: 'list', ordered: true })
  })

  it('starts a new list when the marker changes', () => {
    const blocks = parseBlocks('- bullet\n1. numbered')
    expect(blocks.map((block) => block.kind)).toEqual(['list', 'list'])
    expect(blocks.map((block) => (block.kind === 'list' ? block.ordered : null))).toEqual([false, true])
  })

  it('continues a wrapped bullet rather than starting a paragraph', () => {
    const [block] = parseBlocks('- a bullet that\n  wraps')
    expect(block).toEqual({ kind: 'list', ordered: false, items: [[text('a bullet that wraps')]] })
  })

  it('keeps fenced code verbatim, including markdown inside it', () => {
    const [block] = parseBlocks('```ts\nconst a = **1**\n```')
    expect(block).toEqual({ kind: 'code', lang: 'ts', text: 'const a = **1**' })
  })

  it('keeps an unterminated fence rather than dropping its content', () => {
    const [block] = parseBlocks('```\nstill here')
    expect(block).toEqual({ kind: 'code', lang: null, text: 'still here' })
  })

  it('handles the shape a real answer arrives in', () => {
    const blocks = parseBlocks(
      '## Where to start\n\n**cs-003** is the pivot:\n\n- breaks `cs-002`\n- breaks @q-001\n\nEverything else is safe.',
    )
    expect(blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list', 'paragraph'])
  })

  it('returns nothing for empty input', () => {
    expect(parseBlocks('')).toEqual([])
  })
})

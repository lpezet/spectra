/**
 * Renders the block/token data from `markdown.ts`. Kept separate from parsing so the
 * fiddly part is testable without a DOM.
 */
import type { Block, Token } from '../markdown.js'
import { parseBlocks } from '../markdown.js'

interface MarkdownProps {
  text: string
  /** `@Term` becomes a link into the glossary; unknown names stay as plain text. */
  known: Set<string>
  onSelectTerm: (name: string) => void
}

export function Markdown({ text, known, onSelectTerm }: MarkdownProps) {
  return (
    <div className="md">
      {parseBlocks(text).map((block, index) => (
        <BlockView key={index} block={block} known={known} onSelectTerm={onSelectTerm} />
      ))}
    </div>
  )
}

function BlockView({
  block,
  known,
  onSelectTerm,
}: {
  block: Block
  known: Set<string>
  onSelectTerm: (name: string) => void
}) {
  if (block.kind === 'code') {
    return (
      <pre className="md-code">
        <code>{block.text}</code>
      </pre>
    )
  }

  if (block.kind === 'heading') {
    // Heading levels are relative to a chat bubble, not a page, so they all render as
    // one element and lean on the level only for weight.
    return (
      <p className={`md-heading md-h${Math.min(block.level, 3)}`}>
        <Tokens tokens={block.tokens} known={known} onSelectTerm={onSelectTerm} />
      </p>
    )
  }

  if (block.kind === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul'
    return (
      <Tag className="md-list">
        {block.items.map((item, index) => (
          <li key={index}>
            <Tokens tokens={item} known={known} onSelectTerm={onSelectTerm} />
          </li>
        ))}
      </Tag>
    )
  }

  return (
    <p className="md-p">
      <Tokens tokens={block.tokens} known={known} onSelectTerm={onSelectTerm} />
    </p>
  )
}

function Tokens({
  tokens,
  known,
  onSelectTerm,
}: {
  tokens: Token[]
  known: Set<string>
  onSelectTerm: (name: string) => void
}) {
  return (
    <>
      {tokens.map((token, index) => {
        if (token.kind === 'text') return <span key={index}>{token.text}</span>
        if (token.kind === 'code') return <code key={index}>{token.text}</code>

        if (token.kind === 'mention') {
          // Only link what the glossary actually has — an `@` in prose should not become
          // a dead link to a term that never existed.
          if (!known.has(token.name)) return <span key={index}>@{token.name}</span>
          return (
            <button key={index} type="button" className="term-ref" onClick={() => onSelectTerm(token.name)}>
              {token.name}
            </button>
          )
        }

        const Tag = token.kind === 'strong' ? 'strong' : 'em'
        return (
          <Tag key={index}>
            <Tokens tokens={token.children} known={known} onSelectTerm={onSelectTerm} />
          </Tag>
        )
      })}
    </>
  )
}

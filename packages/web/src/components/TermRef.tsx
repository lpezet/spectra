interface TermRefProps {
  name: string
  known: Set<string>
  onSelect: (name: string) => void
}

/**
 * A term name rendered as a link. A name that no term file declares is shown as
 * broken rather than silently linking nowhere — dangling refs are the main thing
 * that goes wrong in a hand-edited glossary.
 */
export function TermRef({ name, known, onSelect }: TermRefProps) {
  if (!known.has(name)) {
    return (
      <span className="term-ref term-ref-missing" title="No term file declares this name">
        {name} ⚠
      </span>
    )
  }
  return (
    <button type="button" className="term-ref" onClick={() => onSelect(name)}>
      {name}
    </button>
  )
}

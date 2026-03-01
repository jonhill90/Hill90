'use client'

import { useState } from 'react'

interface TagInputProps {
  label: string
  value: string[]
  onChange: (tags: string[]) => void
  validate?: (value: string) => string | null
  placeholder?: string
  disabled?: boolean
}

export default function TagInput({ label, value, onChange, validate, placeholder, disabled }: TagInputProps) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()

    const trimmed = input.trim()
    if (!trimmed) return

    if (value.includes(trimmed)) {
      setInput('')
      return
    }

    if (validate) {
      const err = validate(trimmed)
      if (err) {
        setError(err)
        return
      }
    }

    setError('')
    onChange([...value, trimmed])
    setInput('')
  }

  const handleRemove = (index: number) => {
    onChange(value.filter((_, i) => i !== index))
  }

  return (
    <div>
      <span className="block text-xs font-medium text-mountain-500 uppercase tracking-wide mb-1">{label}</span>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map((tag, i) => (
            <span
              key={`${tag}-${i}`}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md bg-navy-900 text-mountain-300 border border-navy-600"
            >
              {tag}
              <button
                type="button"
                onClick={() => handleRemove(i)}
                disabled={disabled}
                className="text-mountain-500 hover:text-white transition-colors disabled:opacity-50"
                aria-label={`Remove ${tag}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={input}
        onChange={(e) => { setInput(e.target.value); setError('') }}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder || `Add ${label.toLowerCase()}...`}
        className="w-full rounded-lg border border-navy-600 bg-navy-900 px-3 py-1.5 text-white text-sm placeholder:text-mountain-600 focus:border-brand-500 focus:outline-none disabled:opacity-50"
      />
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  )
}

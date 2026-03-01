import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import TagInput from '@/components/TagInput'

describe('TagInput', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders existing tags as removable pills', () => {
    const onChange = vi.fn()
    render(<TagInput label="Binaries" value={['bash', 'python3']} onChange={onChange} />)

    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText('python3')).toBeInTheDocument()
    // Each tag should have a remove button
    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    expect(removeButtons).toHaveLength(2)
  })

  it('adds tag on Enter keypress', () => {
    const onChange = vi.fn()
    render(<TagInput label="Binaries" value={[]} onChange={onChange} />)

    const input = screen.getByPlaceholderText(/add/i)
    fireEvent.change(input, { target: { value: 'node' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith(['node'])
  })

  it('does not add duplicate tags', () => {
    const onChange = vi.fn()
    render(<TagInput label="Binaries" value={['bash']} onChange={onChange} />)

    const input = screen.getByPlaceholderText(/add/i)
    fireEvent.change(input, { target: { value: 'bash' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('does not add empty tags', () => {
    const onChange = vi.fn()
    render(<TagInput label="Binaries" value={[]} onChange={onChange} />)

    const input = screen.getByPlaceholderText(/add/i)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects invalid tag via validate prop', () => {
    const onChange = vi.fn()
    const validate = (v: string) => v.startsWith('/') ? null : 'Must start with /'
    render(<TagInput label="Paths" value={[]} onChange={onChange} validate={validate} />)

    const input = screen.getByPlaceholderText(/add/i)
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('Must start with /')).toBeInTheDocument()
  })

  it('removes tag when X button clicked', () => {
    const onChange = vi.fn()
    render(<TagInput label="Binaries" value={['bash', 'python3']} onChange={onChange} />)

    const removeButtons = screen.getAllByRole('button', { name: /remove/i })
    fireEvent.click(removeButtons[0])

    expect(onChange).toHaveBeenCalledWith(['python3'])
  })

  it('clears input after successful add', () => {
    const onChange = vi.fn()
    render(<TagInput label="Binaries" value={[]} onChange={onChange} />)

    const input = screen.getByPlaceholderText(/add/i) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'node' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(input.value).toBe('')
  })

  it('is disabled when disabled prop is true', () => {
    const onChange = vi.fn()
    render(<TagInput label="Binaries" value={['bash']} onChange={onChange} disabled />)

    const input = screen.getByPlaceholderText(/add/i) as HTMLInputElement
    expect(input.disabled).toBe(true)
  })
})

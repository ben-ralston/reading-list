import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { CardThumbnail } from './card-thumbnail'

describe('CardThumbnail', () => {
  // Regression (#168): the error flag must be tied to the URL, not latched
  // globally. The hero thumbnail is an un-keyed singleton, so once any cover
  // failed to load (e.g. a hot-link-blocked Amazon/Goodreads host) every later
  // book — even ones with a perfectly valid cover — was stuck on the placeholder.
  it('retries loading when the imageUrl changes after a previous error', () => {
    const { container, rerender } = render(
      <CardThumbnail imageUrl="https://cdn.example.com/broken.jpg" platform="Goodreads" title="Old" shape="portrait" />,
    )
    fireEvent.error(container.querySelector('img')!)
    expect(container.querySelector('img')).toBeNull() // fell back to placeholder

    rerender(
      <CardThumbnail imageUrl="https://covers.openlibrary.org/b/id/999-L.jpg" platform="Goodreads" title="New" shape="portrait" />,
    )
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toBe('https://covers.openlibrary.org/b/id/999-L.jpg')
  })

  // Regression (#168): book covers load through a slow Open Library → archive.org
  // redirect chain, so the <img> can sit pending for seconds. While it does, a
  // placeholder icon must stay visible behind it instead of an empty box.
  it('keeps a placeholder icon behind the image so a pending/slow cover is never an empty box', () => {
    const { container } = render(
      <CardThumbnail imageUrl="https://covers.openlibrary.org/b/id/123-L.jpg" platform="Goodreads" title="Snow Crash" shape="portrait" />,
    )
    expect(container.querySelector('img')).toBeTruthy()
    // a placeholder icon is rendered behind the (still-loading) cover
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('renders an <img> with the source when imageUrl is set', () => {
    const { container } = render(
      <CardThumbnail imageUrl="https://cdn.example.com/a.jpg" platform="Substack" title="Post" />,
    )
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/a.jpg')
    expect(img?.getAttribute('loading')).toBe('lazy')
    expect(img?.classList.contains('object-cover')).toBe(true)
    // uniform square — the box size lives on the wrapper, the img fills it
    const wrapper = img?.parentElement
    expect(wrapper?.classList.contains('h-14')).toBe(true)
    expect(wrapper?.classList.contains('w-14')).toBe(true)
  })

  it('renders a source-tinted placeholder (with the source icon) when imageUrl is null', () => {
    const { container } = render(
      <CardThumbnail imageUrl={null} platform="Substack" title="Post" />,
    )
    expect(container.querySelector('img')).toBeNull()
    const placeholder = container.querySelector('[aria-label="Substack placeholder"]')
    expect(placeholder).toBeTruthy()
    // the source icon renders inside the placeholder
    expect(placeholder?.querySelector('svg')).toBeTruthy()
    // uniform square — same dimensions as the image variant
    expect(placeholder?.classList.contains('h-14')).toBe(true)
    expect(placeholder?.classList.contains('w-14')).toBe(true)
  })

  it('swaps to the placeholder when the image fails to load', () => {
    const { container } = render(
      <CardThumbnail imageUrl="https://cdn.example.com/broken.jpg" platform="Spotify" title="Show" />,
    )
    const img = container.querySelector('img')
    expect(img).toBeTruthy()
    fireEvent.error(img!)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('[aria-label="Spotify placeholder"]')).toBeTruthy()
  })

  describe('portrait shape (book covers)', () => {
    it('renders a portrait <img> (taller than wide) when imageUrl is set', () => {
      const { container } = render(
        <CardThumbnail
          imageUrl="https://covers.openlibrary.org/b/id/123-L.jpg"
          platform="Goodreads"
          title="Snow Crash"
          shape="portrait"
        />,
      )
      const img = container.querySelector('img')
      expect(img).toBeTruthy()
      expect(img?.getAttribute('src')).toBe('https://covers.openlibrary.org/b/id/123-L.jpg')
      expect(img?.classList.contains('object-cover')).toBe(true)
      // portrait sm box: taller (h-20) than wide (w-14) — on the wrapper
      const wrapper = img?.parentElement
      expect(wrapper?.classList.contains('h-20')).toBe(true)
      expect(wrapper?.classList.contains('w-14')).toBe(true)
    })

    it('renders a BookOpen placeholder (not a source icon) when imageUrl is null', () => {
      const { container } = render(
        <CardThumbnail imageUrl={null} platform="Goodreads" title="Snow Crash" shape="portrait" />,
      )
      expect(container.querySelector('img')).toBeNull()
      const placeholder = container.querySelector('[aria-label="Book cover placeholder"]')
      expect(placeholder).toBeTruthy()
      // a book icon renders inside the placeholder
      expect(placeholder?.querySelector('svg')).toBeTruthy()
      // same portrait dimensions as the image variant (uniform card shape)
      expect(placeholder?.classList.contains('h-20')).toBe(true)
      expect(placeholder?.classList.contains('w-14')).toBe(true)
    })

    it('swaps to the book placeholder when the cover fails to load', () => {
      const { container } = render(
        <CardThumbnail
          imageUrl="https://covers.openlibrary.org/b/id/broken-L.jpg"
          platform="Goodreads"
          title="Snow Crash"
          shape="portrait"
        />,
      )
      const img = container.querySelector('img')
      expect(img).toBeTruthy()
      fireEvent.error(img!)
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('[aria-label="Book cover placeholder"]')).toBeTruthy()
    })

    it('uses a larger portrait box for the lg (hero) size', () => {
      const { container } = render(
        <CardThumbnail imageUrl={null} platform="Goodreads" title="Snow Crash" shape="portrait" size="lg" />,
      )
      const placeholder = container.querySelector('[aria-label="Book cover placeholder"]')
      expect(placeholder?.classList.contains('h-28')).toBe(true)
      expect(placeholder?.classList.contains('w-20')).toBe(true)
    })
  })
})

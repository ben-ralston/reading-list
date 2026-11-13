"use client"

import { useState } from "react"
import { BookOpen } from "lucide-react"
import { SourceIcon } from "./source-icon"
import { cn } from "@/lib/utils"

// Thumbnail dimensions per shape and size. "square" keeps every feed card the
// same shape whether or not it has a preview image (#167). "portrait" (~2:3) is
// for book covers (#168). "sm" is for list cards, "lg" for the featured hero item.
const SIZES = {
  square: {
    sm: { box: "h-14 w-14", icon: "h-6 w-6" },
    lg: { box: "h-20 w-20", icon: "h-8 w-8" },
  },
  portrait: {
    sm: { box: "h-20 w-14", icon: "h-6 w-6" },
    lg: { box: "h-28 w-20", icon: "h-8 w-8" },
  },
} as const

// Source-tinted placeholder backgrounds. Falls back to the neutral secondary
// token for platforms without a brand color.
const PLATFORM_TINT: Record<string, string> = {
  Spotify: "bg-green-500/10 text-green-600",
  YouTube: "bg-red-500/10 text-red-600",
  Substack: "bg-orange-500/10 text-orange-600",
  Audible: "bg-amber-500/10 text-amber-700",
  Podcast: "bg-purple-500/10 text-purple-600",
}

interface CardThumbnailProps {
  imageUrl: string | null
  platform: string
  title: string
  size?: keyof (typeof SIZES)["square"]
  shape?: keyof typeof SIZES
}

/**
 * Card preview thumbnail. Renders a plain <img> (not next/image — cover/og:image
 * hosts are arbitrary CDNs, and images are unoptimized) layered over a
 * placeholder, falling back to the placeholder when there's no image or the
 * image fails to load.
 *
 * shape="square" (default) is the #167 feed thumbnail: source-tinted placeholder
 * with the source icon. shape="portrait" is the #168 book cover (~2:3): a neutral
 * placeholder with a book icon.
 *
 * Two behaviours matter for book covers (#168):
 *  - The error flag is keyed to the URL, not a latching boolean. The hero
 *    thumbnail is an un-keyed singleton reused across items, so a global flag
 *    would stick on the placeholder for every later book once any cover failed
 *    to load (e.g. a hot-link-blocked Amazon/Goodreads host). Tracking the
 *    failed URL means a new imageUrl is always retried.
 *  - The placeholder icon is layered BEHIND the image. Open Library covers load
 *    through a slow `covers.openlibrary.org` → archive.org redirect chain, so the
 *    <img> can sit pending for seconds; showing the placeholder underneath means
 *    a slow/pending cover is never an empty box — the image simply paints over it.
 */
export function CardThumbnail({ imageUrl, platform, title, size = "sm", shape = "square" }: CardThumbnailProps) {
  const [erroredUrl, setErroredUrl] = useState<string | null>(null)
  const { box, icon } = SIZES[shape][size]
  const base = `${box} shrink-0 rounded-lg`
  const showImage = imageUrl != null && imageUrl !== erroredUrl

  const placeholderIcon =
    shape === "portrait" ? <BookOpen className={icon} /> : <SourceIcon platform={platform} className={icon} />

  if (showImage) {
    return (
      <div className={cn(base, "relative overflow-hidden bg-secondary")}>
        {/* Placeholder layered behind the cover so a slow/pending image never
            flashes an empty box; the loaded image paints over it. */}
        <div aria-hidden="true" className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          {placeholderIcon}
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt=""
          title={title}
          loading="lazy"
          decoding="async"
          onError={() => setErroredUrl(imageUrl)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      </div>
    )
  }

  if (shape === "portrait") {
    return (
      <div
        role="img"
        aria-label="Book cover placeholder"
        className={cn(base, "flex items-center justify-center bg-secondary text-muted-foreground")}
      >
        <BookOpen className={icon} />
      </div>
    )
  }

  const tint = PLATFORM_TINT[platform] ?? "bg-secondary text-secondary-foreground"
  return (
    <div
      role="img"
      aria-label={`${platform} placeholder`}
      className={cn(base, "flex items-center justify-center", tint)}
    >
      <SourceIcon platform={platform} className={icon} />
    </div>
  )
}

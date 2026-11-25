// What `send` hands to baileyrs: a text message, or a photo with its caption.
// baileyrs encrypts and uploads the photo's bytes itself. It would also make a
// thumbnail and read the size with sharp or jimp, which Workers don't have, so the
// size is read from the image header here and the thumbnail is left out.
import type { AnyMessageContent } from "@oxidezap/baileyrs/lib/Types/Message.js"

export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

export interface Size {
  readonly width: number
  readonly height: number
}

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at]! << 8) | bytes[at + 1]!
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!
  )
}

function u24le(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16)
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(at, at + length))
}

/** The pixel size from a PNG, JPEG or WebP header, or null when it can't be read. */
export function imageSize(bytes: Uint8Array): Size | null {
  // PNG: signature, then the IHDR chunk with width and height.
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) }
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2
    while (at + 9 < bytes.length) {
      if (bytes[at] !== 0xff) return null
      const marker = bytes[at + 1]!
      if (marker === 0xff) {
        at += 1
        continue
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
      if (isFrame) return { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) }
      at += 2 + u16be(bytes, at + 2)
    }
    return null
  }
  // WebP: RIFF container with a VP8, VP8L or VP8X chunk.
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === "VP8X") return { width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
    if (chunk === "VP8 ") {
      return { width: u16be(bytes, 26) & 0x3fff, height: u16be(bytes, 28) & 0x3fff }
    }
    if (chunk === "VP8L") {
      const b = bytes.subarray(21, 25)
      return {
        width: 1 + (((b[1]! & 0x3f) << 8) | b[0]!),
        height: 1 + (((b[3]! & 0x0f) << 10) | (b[2]! << 2) | ((b[1]! & 0xc0) >> 6)),
      }
    }
  }
  return null
}

/** The type the bytes say they are, whatever the caller claimed. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === "PNG") return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg"
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    return "image/webp"
  }
  return null
}

export function outgoingContent(
  text: string,
  mentions: string[],
  image?: { readonly bytes: Uint8Array; readonly mimetype: string },
): AnyMessageContent {
  if (!image) return { text, mentions }
  // baileyrs takes any Uint8Array as `image`, which Workers' Buffer type also is.
  return {
    image: image.bytes,
    mimetype: image.mimetype,
    ...(text ? { caption: text } : {}),
    ...imageSize(image.bytes),
    mentions,
  }
}

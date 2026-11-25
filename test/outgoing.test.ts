import { describe, expect, test } from "bun:test"

import { imageSize, outgoingContent, sniffImageType } from "../src/whatsapp/outgoing"

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return bytes
}

const zeros = (length: number) => Array.from({ length }, () => 0)

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment of 16 bytes, then SOF0 with height and width.
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...zeros(14)]
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3]
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0, ...zeros(10)])
}

function webpVp8x(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30)
  bytes.set(new TextEncoder().encode("RIFF"), 0)
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8)
  const w = width - 1
  const h = height - 1
  bytes.set(
    [w & 255, (w >> 8) & 255, (w >> 16) & 255, h & 255, (h >> 8) & 255, (h >> 16) & 255],
    24,
  )
  return bytes
}

describe("imageSize", () => {
  test("reads PNG, JPEG and WebP headers", () => {
    expect(imageSize(png(1024, 1536))).toEqual({ width: 1024, height: 1536 })
    expect(imageSize(jpeg(800, 600))).toEqual({ width: 800, height: 600 })
    expect(imageSize(webpVp8x(1920, 1080))).toEqual({ width: 1920, height: 1080 })
  })

  test("gives up on anything else", () => {
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull()
  })
})

describe("sniffImageType", () => {
  test("names the real type", () => {
    expect(sniffImageType(png(1, 1))).toBe("image/png")
    expect(sniffImageType(jpeg(1, 1))).toBe("image/jpeg")
    expect(sniffImageType(webpVp8x(1, 1))).toBe("image/webp")
    expect(sniffImageType(new TextEncoder().encode("%PDF-1.7"))).toBeNull()
  })
})

describe("outgoingContent", () => {
  test("is plain text without an image", () => {
    expect(outgoingContent("hi", ["1@s.whatsapp.net"])).toEqual({
      text: "hi",
      mentions: ["1@s.whatsapp.net"],
    })
  })

  test("is a photo with caption and size with one", () => {
    const bytes = png(512, 256)
    expect(outgoingContent("look", [], { bytes, mimetype: "image/png" })).toMatchObject({
      image: bytes,
      mimetype: "image/png",
      caption: "look",
      width: 512,
      height: 256,
      mentions: [],
    })
  })

  test("leaves the caption out when there is no text", () => {
    const content = outgoingContent("", [], { bytes: png(2, 2), mimetype: "image/png" })
    expect("caption" in content).toBe(false)
  })
})

const MAX_DIMENSION = 1568
const JPEG_QUALITY = 0.85
const SKIP_THRESHOLD_BYTES = 200 * 1024 // 200KB

export type CompressionResult = {
  base64: string
  mediaType: string
  compressed: boolean
  originalBytes: number
  compressedBytes: number
}

export async function compressImage(base64: string, mediaType: string): Promise<CompressionResult> {
  const originalBytes = Math.ceil(base64.length * 3 / 4)

  // Skip GIFs (would lose animation)
  if (mediaType === 'image/gif') {
    return { base64, mediaType, compressed: false, originalBytes, compressedBytes: originalBytes }
  }

  // Load image to check dimensions
  const img = await loadImage(base64, mediaType)

  const needsResize = img.width > MAX_DIMENSION || img.height > MAX_DIMENSION

  // Only compress if resizing is needed — re-encoding without resize degrades quality
  // (especially PNGs with text/screenshots) without meaningful size savings
  if (!needsResize) {
    return { base64, mediaType, compressed: false, originalBytes, compressedBytes: originalBytes }
  }

  // Compute target dimensions
  let targetW = img.width
  let targetH = img.height
  if (needsResize) {
    const scale = MAX_DIMENSION / Math.max(img.width, img.height)
    targetW = Math.round(img.width * scale)
    targetH = Math.round(img.height * scale)
  }

  // Draw to canvas and compress
  const canvas = document.createElement('canvas')
  canvas.width = targetW
  canvas.height = targetH
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0, targetW, targetH)

  // Use JPEG for best compression (except PNGs with transparency — keep PNG)
  const outputType = mediaType === 'image/png' ? 'image/png' : 'image/jpeg'
  const quality = outputType === 'image/jpeg' ? JPEG_QUALITY : undefined
  const dataUrl = canvas.toDataURL(outputType, quality)
  const compressedBase64 = dataUrl.split(',')[1]
  const compressedBytes = Math.ceil(compressedBase64.length * 3 / 4)

  // If compression made it larger (unlikely but possible for small PNGs), return original
  if (compressedBytes >= originalBytes) {
    return { base64, mediaType, compressed: false, originalBytes, compressedBytes: originalBytes }
  }

  return {
    base64: compressedBase64,
    mediaType: outputType,
    compressed: true,
    originalBytes,
    compressedBytes
  }
}

/** The edge of a workspace's picture: twice the rail's 32px tile, for 2x displays. */
export const WORKSPACE_IMAGE_SIZE = 128

/**
 * A picture cut to a centred square and scaled down to `size`, as a PNG data
 * URL — what a workspace keeps instead of the file it was picked from. PNG so a
 * logo's transparency survives; at 128px it is a few kilobytes either way. A
 * picture smaller than `size` is not scaled up.
 */
export async function squareThumbnail(
  base64: string,
  mediaType: string,
  size: number = WORKSPACE_IMAGE_SIZE
): Promise<string> {
  const img = await loadImage(base64, mediaType)
  const side = Math.min(img.width, img.height)
  const edge = Math.min(size, side)
  const canvas = document.createElement('canvas')
  canvas.width = edge
  canvas.height = edge
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, edge, edge)
  return canvas.toDataURL('image/png')
}

function loadImage(base64: string, mediaType: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = `data:${mediaType};base64,${base64}`
  })
}

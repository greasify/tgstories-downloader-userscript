/* eslint-disable antfu/top-level-function -- this module uses arrow functions */

const BUTTON_CLASS = 'tgsd-download'
const LABEL = 'Скачать сторис'
const MIN_MEDIA_AREA = 80 * 80
const PROGRESSIVE_URL = /\/(?:progressive|download)\//

const progressiveUrls = new WeakMap<HTMLMediaElement, string>()

const rememberProgressiveUrl = (element: HTMLMediaElement, url: string) => {
  if (PROGRESSIVE_URL.test(url)) progressiveUrls.set(element, url)
}

// Safari swaps video.src for a MediaSource blob. The progressive URL has to survive that.
const patchMediaUrls = () => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  const setSrc = descriptor?.set
  const getSrc = descriptor?.get
  if (!descriptor || !setSrc || !getSrc) return

  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get(this: HTMLMediaElement) {
      return getSrc.call(this)
    },
    set(this: HTMLMediaElement, value: string) {
      rememberProgressiveUrl(this, String(value))
      setSrc.call(this, value)
    },
  })

  const setAttribute = HTMLMediaElement.prototype.setAttribute
  HTMLMediaElement.prototype.setAttribute = function (this: HTMLMediaElement, name: string, value: string) {
    if (name === 'src') rememberProgressiveUrl(this, value)
    setAttribute.call(this, name, value)
  }
}

const centerDistance = (element: Element, origin: DOMRect) => {
  const rect = element.getBoundingClientRect()
  const dx = (rect.left + rect.width / 2) - (origin.left + origin.width / 2)
  const dy = (rect.top + rect.height / 2) - (origin.top + origin.height / 2)
  return Math.hypot(dx, dy)
}

const closestToCenter = <T extends Element>(elements: T[], viewer: HTMLElement) => {
  const origin = viewer.getBoundingClientRect()
  let best: T | undefined
  let bestDistance = Number.POSITIVE_INFINITY

  for (const element of elements) {
    const distance = centerDistance(element, origin)
    if (distance < bestDistance) {
      best = element
      bestDistance = distance
    }
  }

  return best
}

const isStoryFrame = (element: Element) => {
  const rect = element.getBoundingClientRect()
  return rect.width * rect.height > MIN_MEDIA_AREA
}

const pickStoryMedia = (viewer: HTMLElement) => {
  const videos = [...viewer.querySelectorAll('video')].filter(isStoryFrame)
  const video = closestToCenter(videos, viewer)
  if (video) return video

  const images = [...viewer.querySelectorAll('img')].filter(isStoryFrame)
  return closestToCenter(images, viewer)
}

const mediaUrl = (element: HTMLImageElement | HTMLVideoElement) => {
  const current = element.currentSrc || element.src
  if (!(element instanceof HTMLVideoElement)) return current

  const remembered = progressiveUrls.get(element)
  if (current.startsWith('blob:') && remembered) return remembered

  return current
}

const readPeerName = (viewer: HTMLElement) => {
  const origin = viewer.getBoundingClientRect()
  const topLimit = origin.top + Math.min(origin.height * 0.28, 160)
  let bestText = ''
  let bestScore = Number.NEGATIVE_INFINITY

  for (const element of viewer.querySelectorAll('span, a, h1, h2, h3, div')) {
    if (element.closest('button, textarea, input, .tgsd-download')) continue
    if (element.childElementCount > 0) continue

    const text = element.textContent?.trim() ?? ''
    if (text.length < 1 || text.length > 80) continue

    const rect = element.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8 || rect.top > topLimit || rect.bottom < origin.top) continue

    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize)
    const dx = Math.abs((rect.left + rect.width / 2) - (origin.left + origin.width / 2))
    const score = fontSize * 1000 - dx
    if (score > bestScore) {
      bestScore = score
      bestText = text
    }
  }

  return bestText
}

const fileSlug = (value: string) => {
  const slug = value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)

  return slug || 'telegram'
}

const timestamp = () => {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

const extensionFor = (type: string, isVideo: boolean) => {
  const normalized = type.split(';')[0]?.trim().toLowerCase() ?? ''
  const known: Record<string, string> = {
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  }

  return known[normalized] ?? (isVideo ? 'mp4' : 'jpg')
}

const FETCH_FAILED = 'Не удалось скачать файл'

const fetchWhole = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(FETCH_FAILED)

  const blob = await response.blob()
  if (blob.size === 0) throw new Error('Файл пустой')

  return blob
}

const readTotalSize = (header: string | null) => {
  const match = header?.match(/\/(\d+)\s*$/)
  if (!match?.[1]) return

  return Number(match[1])
}

const fetchProgressive = async (url: string, onProgress: (loaded: number, total: number) => void) => {
  const parts: BlobPart[] = []
  let start = 0
  let fullSize = 0
  let mimeType = ''

  while (fullSize === 0 || start < fullSize) {
    const response = await fetch(url, {
      headers: { Range: `bytes=${start}-` },
    })
    if (response.status !== 206) throw new Error(FETCH_FAILED)

    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.byteLength === 0) throw new Error('Файл пустой')

    const total = readTotalSize(response.headers.get('Content-Range'))
    if (total === undefined) throw new Error(FETCH_FAILED)

    parts.push(buffer)
    mimeType ||= response.headers.get('Content-Type')?.split(';')[0]?.trim() ?? ''
    const loaded = start + buffer.byteLength
    if (loaded <= start) throw new Error(FETCH_FAILED)

    start = loaded
    fullSize = total
    onProgress(Math.min(start, fullSize), fullSize)
  }

  return new Blob(parts, { type: mimeType || 'video/mp4' })
}

const fetchStory = async (url: string, onProgress: (loaded: number, total: number) => void) => {
  if (url.includes('/progressive/')) return fetchProgressive(url, onProgress)

  return fetchWhole(url)
}

const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  const mount = document.body ?? document.documentElement
  mount.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1500)
}

const errorMessage = (error: unknown) => {
  if (error instanceof Error && error.message && !error.message.startsWith('Failed to')) return error.message

  return 'Не удалось скачать файл'
}

const svgCircle = (className: string) => {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '20')
  circle.setAttribute('cy', '20')
  circle.setAttribute('r', '16')
  circle.setAttribute('pathLength', '100')
  circle.classList.add(className)
  return circle
}

const progressRing = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 40 40')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('tgsd-ring')
  svg.append(svgCircle('tgsd-ring-track'), svgCircle('tgsd-ring-value'))
  return svg
}

const downloadIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '20')
  svg.setAttribute('height', '20')
  svg.setAttribute('aria-hidden', 'true')
  svg.classList.add('tgsd-icon')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('d', 'M11 4h2v8.2l2.6-2.6 1.4 1.4L12 16l-5-5 1.4-1.4L11 12.2V4zM5 18h14v2H5v-2z')
  svg.append(path)
  return svg
}

const paintButton = (button: HTMLButtonElement, mode: 'idle' | 'loading' | 'error', message = LABEL) => {
  button.disabled = mode === 'loading'
  button.classList.toggle('is-loading', mode === 'loading')
  button.classList.toggle('is-error', mode === 'error')
  button.title = message
  button.setAttribute('aria-label', message)
  button.setAttribute('aria-busy', mode === 'loading' ? 'true' : 'false')
  if (mode !== 'loading') {
    button.classList.remove('is-indeterminate')
    button.style.removeProperty('--tgsd-progress')
  }
}

const setProgress = (button: HTMLButtonElement, percent: number) => {
  button.classList.remove('is-indeterminate')
  button.style.setProperty('--tgsd-progress', String(percent))
}

const downloadCurrentStory = async (
  viewer: HTMLElement,
  button: HTMLButtonElement,
  showError: (message: string) => void,
) => {
  if (button.disabled) return

  const media = pickStoryMedia(viewer)
  const url = media ? mediaUrl(media) : ''
  if (!media || !url) {
    showError('Сторис ещё не загрузилась')
    return
  }

  paintButton(button, 'loading', 'Скачивание…')
  button.classList.add('is-indeterminate')
  try {
    const blob = await fetchStory(url, (loaded, total) => {
      const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
      setProgress(button, percent)
      paintButton(button, 'loading', `Скачивание… ${percent}%`)
    })
    const extension = extensionFor(blob.type, media instanceof HTMLVideoElement)
    saveBlob(blob, `story-${fileSlug(readPeerName(viewer))}-${timestamp()}.${extension}`)
    paintButton(button, 'idle')
  } catch (error) {
    showError(errorMessage(error))
  }
}

const createButton = (viewer: HTMLElement) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = BUTTON_CLASS
  button.append(progressRing(), downloadIcon())
  paintButton(button, 'idle')

  let errorTimer = 0
  const showError = (message: string) => {
    window.clearTimeout(errorTimer)
    paintButton(button, 'error', message)
    errorTimer = window.setTimeout(() => {
      if (button.isConnected && button.classList.contains('is-error')) paintButton(button, 'idle')
    }, 2500)
  }

  const stopStoryNavigation = (event: Event) => {
    event.stopPropagation()
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'touchstart'] as const) {
    button.addEventListener(type, (event) => {
      stopStoryNavigation(event)
      if (type !== 'click') return

      event.preventDefault()
      void downloadCurrentStory(viewer, button, showError)
    })
  }

  return button
}

const ensurePositioned = (viewer: HTMLElement) => {
  if (getComputedStyle(viewer).position === 'static') viewer.style.position = 'relative'
}

const mountButton = (viewer: HTMLElement) => {
  if (viewer.querySelector(':scope > .tgsd-download')) return

  ensurePositioned(viewer)
  viewer.append(createButton(viewer))
}

const syncButton = () => {
  const viewer = document.getElementById('StoryViewer')
  if (viewer) mountButton(viewer)
}

const watchStoryViewer = () => {
  syncButton()
  const root = document.documentElement
  if (!root) return

  const observer = new MutationObserver(syncButton)
  observer.observe(root, { childList: true, subtree: true })
}

export const startStoryDownloader = () => {
  patchMediaUrls()

  if (document.documentElement) watchStoryViewer()
  else document.addEventListener('DOMContentLoaded', watchStoryViewer, { once: true })
}

import {
  type AnchorBox,
  FLOATING_INPUT_MIN_HEIGHT,
  FLOATING_INPUT_MIN_WIDTH,
  type ViewportSize,
} from './floating-input-rect'

export const CHAT_ANCHOR_SELECTORS = [
  '#chat-control-panel-vm',
  '.control-panel-ctnr',
  '#aside-area-vm',
  '.aside-area',
] as const

export interface ChatAnchorSyncHandle {
  schedule: () => void
  dispose: () => void
}

interface AnchorRectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

const ATTR_MUTATION_OPTIONS: MutationObserverInit = {
  attributes: true,
  attributeFilter: ['class', 'style'],
}

const ANCESTOR_MUTATION_OPTIONS: MutationObserverInit = {
  attributes: true,
  attributeFilter: ['class', 'style'],
  childList: true,
}

const BODY_SUBTREE_MUTATION_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'style'],
}

/** Read the layout viewport dimensions, falling back to `window.inner*`. */
export function getViewportSize(): ViewportSize {
  return {
    width: document.documentElement?.clientWidth || window.innerWidth,
    height: document.documentElement?.clientHeight || window.innerHeight,
  }
}

function findVisibleAnchor(): { element: HTMLElement; rect: AnchorRectLike } | null {
  if (typeof document === 'undefined') return null
  for (const selector of CHAT_ANCHOR_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector)
    if (!el) continue
    const rect = el.getBoundingClientRect()
    if (rect.width >= FLOATING_INPUT_MIN_WIDTH && rect.height >= FLOATING_INPUT_MIN_HEIGHT) {
      return { element: el, rect }
    }
  }
  return null
}

function findAnyAnchorNode(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  for (const selector of CHAT_ANCHOR_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el) return el
  }
  return null
}

/** Find the first B站 chat control panel element large enough to host the floating input. */
export function findChatAnchorElement(): HTMLElement | null {
  return findVisibleAnchor()?.element ?? null
}

/** Snapshot the viewport-relative bounding box of `el`, or `null` when disconnected. */
export function readChatAnchorBox(el: HTMLElement | null): AnchorBox | null {
  if (!el?.isConnected) return null
  const r = el.getBoundingClientRect()
  return { right: r.right, bottom: r.bottom, width: r.width, height: r.height }
}

function sameElements(a: HTMLElement[], b: HTMLElement[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function isContainingTarget(target: EventTarget | null, node: HTMLElement | null): boolean {
  if (!node || !target) return false
  const maybeNode = target as { contains?: unknown }
  return typeof maybeNode.contains === 'function' && (maybeNode as Node).contains(node)
}

function createIntersectionObserver(
  callback: IntersectionObserverCallback,
  doc: Document | null | undefined,
  options: IntersectionObserverInit
): IntersectionObserver {
  if (doc) {
    try {
      return new IntersectionObserver(callback, { ...options, root: doc })
    } catch {
      // Some environments reject a Document root; fall back to default viewport root.
    }
  }
  return new IntersectionObserver(callback, options)
}

interface TightGuardKey {
  el: HTMLElement
  insetTop: number
  insetRight: number
  insetBottom: number
  insetLeft: number
  vpWidth: number
  vpHeight: number
}

function createPositionGuard(onMove: () => void, isDisposed: () => boolean) {
  let currentIo: IntersectionObserver | null = null
  let mode: 'idle' | 'reentry' | 'tight' = 'idle'
  let reentryEl: HTMLElement | null = null
  let tightKey: TightGuardKey | null = null

  const disconnect = () => {
    if (currentIo) {
      currentIo.disconnect()
      currentIo = null
    }
    mode = 'idle'
    reentryEl = null
    tightKey = null
  }

  const armReentry = (el: HTMLElement) => {
    if (typeof IntersectionObserver === 'undefined' || isDisposed()) return
    if (mode === 'reentry' && reentryEl === el) return
    disconnect()

    let isFirstUpdate = true
    let io: IntersectionObserver | null = null
    const doc = el.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
    const handleObserve: IntersectionObserverCallback = entries => {
      if (isDisposed() || !io || io !== currentIo) return
      const ratio = entries[entries.length - 1]?.intersectionRatio ?? 0
      if (isFirstUpdate) {
        isFirstUpdate = false
        return
      }
      if (ratio > 0) onMove()
    }

    io = createIntersectionObserver(handleObserve, doc, { threshold: 0 })
    currentIo = io
    mode = 'reentry'
    reentryEl = el
    io.observe(el)
  }

  const armTight = (
    el: HTMLElement,
    insetTop: number,
    insetRight: number,
    insetBottom: number,
    insetLeft: number,
    vpWidth: number,
    vpHeight: number,
    threshold: number,
    calibrated: boolean
  ) => {
    if (typeof IntersectionObserver === 'undefined' || isDisposed()) return
    disconnect()

    let isFirstUpdate = true
    let io: IntersectionObserver | null = null
    const doc = el.ownerDocument ?? (typeof document !== 'undefined' ? document : null)
    const rootMargin = `${-insetTop}px ${-insetRight}px ${-insetBottom}px ${-insetLeft}px`

    const handleObserve: IntersectionObserverCallback = entries => {
      if (isDisposed() || !io || io !== currentIo) return
      const ratio = entries[entries.length - 1]?.intersectionRatio ?? 0
      if (isFirstUpdate) {
        isFirstUpdate = false
        if (ratio === 0) {
          armReentry(el)
        } else if (ratio < threshold && !calibrated) {
          armTight(el, insetTop, insetRight, insetBottom, insetLeft, vpWidth, vpHeight, Math.max(1e-7, ratio), true)
        }
        return
      }
      onMove()
    }

    io = createIntersectionObserver(handleObserve, doc, { rootMargin, threshold })
    currentIo = io
    mode = 'tight'
    tightKey = { el, insetTop, insetRight, insetBottom, insetLeft, vpWidth, vpHeight }
    io.observe(el)
  }

  const sync = (el: HTMLElement | null, rect: AnchorRectLike | null, vp: ViewportSize) => {
    if (typeof IntersectionObserver === 'undefined' || isDisposed()) return
    if (!el || !rect || rect.width <= 0 || rect.height <= 0) {
      disconnect()
      return
    }
    if (rect.right <= 0 || rect.left >= vp.width || rect.bottom <= 0 || rect.top >= vp.height) {
      armReentry(el)
      return
    }

    const insetTop = Math.floor(rect.top)
    const insetRight = Math.floor(vp.width - rect.right)
    const insetBottom = Math.floor(vp.height - rect.bottom)
    const insetLeft = Math.floor(rect.left)

    if (
      mode === 'tight' &&
      tightKey &&
      tightKey.el === el &&
      tightKey.insetTop === insetTop &&
      tightKey.insetRight === insetRight &&
      tightKey.insetBottom === insetBottom &&
      tightKey.insetLeft === insetLeft &&
      tightKey.vpWidth === vp.width &&
      tightKey.vpHeight === vp.height
    ) {
      return
    }

    armTight(el, insetTop, insetRight, insetBottom, insetLeft, vp.width, vp.height, 1, false)
  }

  return { sync, disconnect }
}

/**
 * Observe B站's chat anchor across size, scroll, ancestor style/DOM, transition, and viewport-position shifts.
 * Emits an initial `(viewport, anchor)` snapshot synchronously, then coalesces subsequent updates via `requestAnimationFrame`.
 */
export function observeChatAnchor(
  onSync: (viewport: ViewportSize, anchor: AnchorBox | null) => void
): ChatAnchorSyncHandle {
  let disposed = false
  let raf = 0
  let trackedNode: HTMLElement | null = null
  let observedAncestors: HTMLElement[] = []
  let watchingSubtree = false

  const observedResizeTargets = new Set<Element>()
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => scheduleSync()) : null
  const mutationObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(() => scheduleSync()) : null

  const scheduleSync = () => {
    if (!disposed && !raf) {
      raf = requestAnimationFrame(syncAnchor)
    }
  }

  const positionGuard = createPositionGuard(scheduleSync, () => disposed)

  const syncResizeTargets = (targets: Array<Element | null | undefined>) => {
    if (!resizeObserver) return
    const desired = new Set<Element>()
    for (const target of targets) {
      if (target) desired.add(target)
    }
    for (const prev of observedResizeTargets) {
      if (!desired.has(prev)) {
        resizeObserver.unobserve(prev)
        observedResizeTargets.delete(prev)
      }
    }
    for (const next of desired) {
      if (!observedResizeTargets.has(next)) {
        resizeObserver.observe(next)
        observedResizeTargets.add(next)
      }
    }
  }

  const syncMutationTargets = (node: HTMLElement | null) => {
    if (!mutationObserver) return

    if (!node) {
      if (!watchingSubtree && document.body) {
        mutationObserver.disconnect()
        observedAncestors = []
        mutationObserver.observe(document.body, BODY_SUBTREE_MUTATION_OPTIONS)
        watchingSubtree = true
      }
      return
    }

    const nextAncestors: HTMLElement[] = []
    for (let cur: HTMLElement | null = node; cur; cur = cur.parentElement) {
      nextAncestors.push(cur)
    }

    if (watchingSubtree || !sameElements(observedAncestors, nextAncestors)) {
      mutationObserver.disconnect()
      for (let i = 0; i < nextAncestors.length; i++) {
        const ancestor = nextAncestors[i]
        // Observe attributes + childList in a single call; a second observe() on the same node overwrites options.
        const watchChildren = i > 0 && ancestor !== document.documentElement && (ancestor !== document.body || i === 1)
        mutationObserver.observe(ancestor, watchChildren ? ANCESTOR_MUTATION_OPTIONS : ATTR_MUTATION_OPTIONS)
      }
      if (document.body && !nextAncestors.includes(document.body)) {
        mutationObserver.observe(document.body, ATTR_MUTATION_OPTIONS)
      }
      observedAncestors = nextAncestors
      watchingSubtree = false
    }
  }

  const syncAnchor = () => {
    raf = 0
    if (disposed) return

    const vp = getViewportSize()
    const visible = findVisibleAnchor()
    trackedNode = visible?.element ?? findAnyAnchorNode()

    syncResizeTargets([document.documentElement, trackedNode, document.querySelector<HTMLElement>('.app-body')])
    syncMutationTargets(trackedNode)
    positionGuard.sync(visible?.element ?? null, visible?.rect ?? null, vp)

    const anchorBox = visible
      ? {
          right: visible.rect.right,
          bottom: visible.rect.bottom,
          width: visible.rect.width,
          height: visible.rect.height,
        }
      : null
    onSync(vp, anchorBox)
  }

  const onScroll = (e: Event) => {
    const target = e.target
    if (
      target === window ||
      target === document ||
      target === document.documentElement ||
      target === document.body ||
      isContainingTarget(target, trackedNode)
    ) {
      scheduleSync()
    }
  }

  const onLayoutEvent = (e: Event) => {
    if (isContainingTarget(e.target, trackedNode)) {
      scheduleSync()
    }
  }

  const visualViewport = typeof window !== 'undefined' ? window.visualViewport : null

  window.addEventListener('resize', scheduleSync)
  window.addEventListener('scroll', onScroll, { capture: true, passive: true })
  document.addEventListener('transitionend', onLayoutEvent, { capture: true, passive: true })
  document.addEventListener('transitioncancel', onLayoutEvent, { capture: true, passive: true })
  document.addEventListener('animationend', onLayoutEvent, { capture: true, passive: true })
  document.addEventListener('fullscreenchange', scheduleSync)
  visualViewport?.addEventListener('resize', scheduleSync)
  visualViewport?.addEventListener('scroll', scheduleSync)

  syncAnchor()

  return {
    schedule: scheduleSync,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
      resizeObserver?.disconnect()
      observedResizeTargets.clear()
      mutationObserver?.disconnect()
      observedAncestors = []
      positionGuard.disconnect()
      window.removeEventListener('resize', scheduleSync)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('transitionend', onLayoutEvent, true)
      document.removeEventListener('transitioncancel', onLayoutEvent, true)
      document.removeEventListener('animationend', onLayoutEvent, true)
      document.removeEventListener('fullscreenchange', scheduleSync)
      visualViewport?.removeEventListener('resize', scheduleSync)
      visualViewport?.removeEventListener('scroll', scheduleSync)
    },
  }
}

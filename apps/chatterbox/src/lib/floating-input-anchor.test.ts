import { describe, expect, it, mock } from 'bun:test'

import type { AnchorBox, ViewportSize } from './floating-input-rect'

import { observeChatAnchor } from './floating-input-anchor'

interface FakeRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

interface FakeElement {
  id: string
  className: string
  isConnected: boolean
  parentElement: FakeElement | null
  ownerDocument: unknown
  rect: FakeRect
  getBoundingClientRect: () => FakeRect
  contains: (other: unknown) => boolean
}

function makeRect(left: number, top: number, width: number, height: number): FakeRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  }
}

function createFakeElement(opts: {
  id?: string
  className?: string
  parent?: FakeElement | null
  ownerDocument?: unknown
  rect?: FakeRect
  isConnected?: boolean
}): FakeElement {
  const el: FakeElement = {
    id: opts.id ?? '',
    className: opts.className ?? '',
    isConnected: opts.isConnected ?? true,
    parentElement: opts.parent ?? null,
    ownerDocument: opts.ownerDocument ?? null,
    rect: opts.rect ?? makeRect(0, 0, 0, 0),
    getBoundingClientRect() {
      return el.rect
    },
    contains(other: unknown) {
      let cur = other as FakeElement | null | undefined
      while (cur) {
        if (cur === el) return true
        cur = cur.parentElement
      }
      return false
    },
  }
  return el
}

function createEventBus() {
  const listeners = new Map<string, Set<EventListener>>()
  const keyFor = (type: string, options?: boolean | AddEventListenerOptions | EventListenerOptions) => {
    const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
    return `${type}:${capture ? 'capture' : 'bubble'}`
  }

  return {
    addEventListener: mock((type: string, fn: EventListener, options?: boolean | AddEventListenerOptions) => {
      const key = keyFor(type, options)
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      set.add(fn)
    }),
    removeEventListener: mock((type: string, fn: EventListener, options?: boolean | EventListenerOptions) => {
      const key = keyFor(type, options)
      listeners.get(key)?.delete(fn)
    }),
    emit(type: string, event: unknown, capture = false) {
      const key = keyFor(type, capture)
      for (const fn of [...(listeners.get(key) ?? [])]) fn(event as Event)
    },
    listenerCount(type: string, capture = false) {
      return listeners.get(keyFor(type, capture))?.size ?? 0
    },
  }
}

function setupHarness(options?: {
  viewport?: ViewportSize
  rejectDocumentRootIo?: boolean
  anchorRect?: FakeRect | null
  mountAnchor?: boolean
  includeAppBody?: boolean
}) {
  const saved = {
    document: globalThis.document,
    window: globalThis.window,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
    MutationObserver: globalThis.MutationObserver,
    IntersectionObserver: globalThis.IntersectionObserver,
  }

  const vp = options?.viewport ?? { width: 1335, height: 800 }
  const docBus = createEventBus()
  const winBus = createEventBus()
  const vvBus = createEventBus()

  const docEl = createFakeElement({ id: 'html' })
  Object.assign(docEl, { clientWidth: vp.width, clientHeight: vp.height })

  const body = createFakeElement({ id: 'body', parent: docEl })
  const appBody = options?.includeAppBody === false ? null : createFakeElement({ className: 'app-body', parent: body })
  const aside = createFakeElement({ id: 'aside-area-vm', parent: appBody ?? body, rect: makeRect(1035, 100, 300, 650) })
  const anchor = createFakeElement({
    id: 'chat-control-panel-vm',
    parent: aside,
    rect:
      options?.anchorRect === undefined ? makeRect(1035, 676, 300, 74) : (options.anchorRect ?? makeRect(0, 0, 0, 0)),
  })

  const selectors = new Map<string, FakeElement | null>()
  if (appBody) selectors.set('.app-body', appBody)
  if (options?.mountAnchor !== false) selectors.set('#chat-control-panel-vm', anchor)

  const fakeDocument = {
    documentElement: docEl,
    body,
    querySelector: (sel: string) => selectors.get(sel) ?? null,
    addEventListener: docBus.addEventListener,
    removeEventListener: docBus.removeEventListener,
    emit: docBus.emit,
    listenerCount: docBus.listenerCount,
  }

  for (const el of [docEl, body, appBody, aside, anchor]) {
    if (el) el.ownerDocument = fakeDocument
  }

  const fakeWindow = {
    innerWidth: vp.width,
    innerHeight: vp.height,
    visualViewport: {
      addEventListener: vvBus.addEventListener,
      removeEventListener: vvBus.removeEventListener,
      emit: vvBus.emit,
      listenerCount: vvBus.listenerCount,
    },
    addEventListener: winBus.addEventListener,
    removeEventListener: winBus.removeEventListener,
    emit: winBus.emit,
    listenerCount: winBus.listenerCount,
  }

  let nextRafId = 1
  const pendingRafs = new Map<number, FrameRequestCallback>()
  const fakeRaf = mock((cb: FrameRequestCallback) => {
    const id = nextRafId++
    pendingRafs.set(id, cb)
    return id
  })
  const fakeCancelRaf = mock((id: number) => {
    pendingRafs.delete(id)
  })
  const flushRaf = () => {
    const entries = [...pendingRafs.entries()]
    pendingRafs.clear()
    for (const [, cb] of entries) cb(16)
  }

  const resizeInstances: Array<{
    callback: ResizeObserverCallback
    targets: Set<Element>
    disconnected: boolean
  }> = []
  class FakeResizeObserver {
    callback: ResizeObserverCallback
    targets = new Set<Element>()
    disconnected = false
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback
      resizeInstances.push(this)
    }
    observe(el: Element) {
      this.targets.add(el)
    }
    unobserve(el: Element) {
      this.targets.delete(el)
    }
    disconnect() {
      this.disconnected = true
      this.targets.clear()
    }
  }

  const mutationInstances: Array<{
    callback: MutationCallback
    records: Array<{ target: Node; options?: MutationObserverInit }>
    byTarget: Map<Node, MutationObserverInit | undefined>
    disconnected: boolean
  }> = []
  class FakeMutationObserver {
    callback: MutationCallback
    records: Array<{ target: Node; options?: MutationObserverInit }> = []
    byTarget = new Map<Node, MutationObserverInit | undefined>()
    disconnected = false
    constructor(callback: MutationCallback) {
      this.callback = callback
      mutationInstances.push(this)
    }
    observe(target: Node, init?: MutationObserverInit) {
      this.records.push({ target, options: init })
      this.byTarget.set(target, init)
    }
    disconnect() {
      this.disconnected = true
      this.byTarget.clear()
    }
    takeRecords() {
      return []
    }
  }

  const ioInstances: Array<{
    callback: IntersectionObserverCallback
    options: IntersectionObserverInit | undefined
    targets: Set<Element>
    disconnected: boolean
    trigger: (ratio: number) => void
  }> = []
  class FakeIntersectionObserver {
    callback: IntersectionObserverCallback
    options: IntersectionObserverInit | undefined
    targets = new Set<Element>()
    disconnected = false
    constructor(callback: IntersectionObserverCallback, init?: IntersectionObserverInit) {
      if (options?.rejectDocumentRootIo && init?.root === (fakeDocument as unknown as Document)) {
        throw new TypeError('Document root unsupported')
      }
      this.callback = callback
      this.options = init
      ioInstances.push(this)
    }
    observe(el: Element) {
      this.targets.add(el)
    }
    unobserve(el: Element) {
      this.targets.delete(el)
    }
    disconnect() {
      this.disconnected = true
      this.targets.clear()
    }
    takeRecords() {
      return []
    }
    trigger(ratio: number) {
      this.callback(
        [{ intersectionRatio: ratio } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver
      )
    }
  }

  globalThis.document = fakeDocument as unknown as Document
  globalThis.window = fakeWindow as unknown as Window & typeof globalThis
  globalThis.requestAnimationFrame = fakeRaf
  globalThis.cancelAnimationFrame = fakeCancelRaf
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver
  globalThis.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver

  return {
    vp,
    docEl,
    body,
    appBody,
    aside,
    anchor,
    selectors,
    fakeDocument,
    fakeWindow,
    pendingRafs,
    flushRaf,
    resizeInstances,
    mutationInstances,
    ioInstances,
    restore() {
      globalThis.document = saved.document
      globalThis.window = saved.window
      globalThis.requestAnimationFrame = saved.requestAnimationFrame
      globalThis.cancelAnimationFrame = saved.cancelAnimationFrame
      globalThis.ResizeObserver = saved.ResizeObserver
      globalThis.MutationObserver = saved.MutationObserver
      globalThis.IntersectionObserver = saved.IntersectionObserver
    },
  }
}

describe('observeChatAnchor', () => {
  it('observes anchor ancestor chain with single combined options per node and syncs on ancestor style/transform moves', () => {
    const h = setupHarness()
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      expect(syncs).toHaveLength(1)
      expect(syncs[0]?.box).toEqual({ right: 1335, bottom: 750, width: 300, height: 74 })

      const mo = h.mutationInstances[0]
      expect(mo).toBeDefined()
      // Each node in the chain is observed at most once (no second observe() overwriting options).
      expect(mo.records).toHaveLength(5)
      expect(mo.byTarget.get(h.anchor as unknown as Node)).toEqual({
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
      expect(mo.byTarget.get(h.aside as unknown as Node)).toEqual({
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true,
      })
      expect(mo.byTarget.get(h.appBody as unknown as Node)).toEqual({
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true,
      })
      expect(mo.byTarget.get(h.body as unknown as Node)).toEqual({
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
      expect(mo.byTarget.get(h.docEl as unknown as Node)).toEqual({
        attributes: true,
        attributeFilter: ['class', 'style'],
      })

      // Simulate Bilibili shifting an ancestor via class/transform without changing anchor size.
      h.anchor.rect = makeRect(935, 636, 300, 74)
      mo.callback([], mo as unknown as MutationObserver)
      expect(syncs).toHaveLength(1)
      h.flushRaf()

      expect(syncs).toHaveLength(2)
      expect(syncs[1]?.box).toEqual({ right: 1235, bottom: 710, width: 300, height: 74 })
      handle.dispose()
    } finally {
      h.restore()
    }
  })

  it('triggers sync on document/ancestor scroll and ignores unrelated descendant scrolls like .chat-items', () => {
    const h = setupHarness()
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      const chatItems = createFakeElement({ className: 'chat-items', parent: h.aside, ownerDocument: h.fakeDocument })

      // Unrelated scroll inside chat list is ignored.
      h.fakeWindow.emit('scroll', { target: chatItems }, true)
      expect(h.pendingRafs.size).toBe(0)

      // Scroll on an ancestor containing anchor schedules sync.
      h.anchor.rect = makeRect(1035, 576, 300, 74)
      h.fakeWindow.emit('scroll', { target: h.appBody }, true)
      expect(h.pendingRafs.size).toBe(1)
      h.flushRaf()
      expect(syncs).toHaveLength(2)
      expect(syncs[1]?.box?.bottom).toBe(650)

      // Scroll on document also schedules sync.
      h.anchor.rect = makeRect(1035, 476, 300, 74)
      h.fakeWindow.emit('scroll', { target: h.fakeDocument }, true)
      h.flushRaf()
      expect(syncs).toHaveLength(3)
      expect(syncs[2]?.box?.bottom).toBe(550)

      handle.dispose()
    } finally {
      h.restore()
    }
  })

  it('triggers sync on transition/animation events for anchor or ancestors and ignores unrelated targets', () => {
    const h = setupHarness()
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      const unrelated = createFakeElement({ className: 'toast', parent: h.body, ownerDocument: h.fakeDocument })

      h.fakeDocument.emit('transitionend', { target: unrelated }, true)
      h.fakeDocument.emit('animationend', { target: unrelated }, true)
      expect(h.pendingRafs.size).toBe(0)

      h.anchor.rect = makeRect(1015, 676, 300, 74)
      h.fakeDocument.emit('transitionend', { target: h.aside }, true)
      h.flushRaf()
      expect(syncs).toHaveLength(2)
      expect(syncs[1]?.box?.right).toBe(1315)

      h.anchor.rect = makeRect(1025, 676, 300, 74)
      h.fakeDocument.emit('transitioncancel', { target: h.anchor }, true)
      h.flushRaf()
      expect(syncs).toHaveLength(3)

      h.anchor.rect = makeRect(1035, 676, 300, 74)
      h.fakeDocument.emit('animationend', { target: h.appBody }, true)
      h.flushRaf()
      expect(syncs).toHaveLength(4)

      handle.dispose()
    } finally {
      h.restore()
    }
  })

  it('arms tight IntersectionObserver with rootMargin, ignores isFirstUpdate, and syncs + re-arms on move', () => {
    const h = setupHarness()
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      expect(h.ioInstances).toHaveLength(1)
      const io1 = h.ioInstances[0]
      expect(io1.options).toEqual({
        root: h.fakeDocument as unknown as Document,
        rootMargin: '-676px 0px -50px -1035px',
        threshold: 1,
      })

      // Initial IntersectionObserver callback does not trigger sync or re-arm.
      io1.trigger(1)
      expect(h.pendingRafs.size).toBe(0)
      expect(h.ioInstances).toHaveLength(1)

      // Subsequent position shift moves anchor and triggers sync + re-arm with updated rootMargin.
      h.anchor.rect = makeRect(980, 620, 300, 74)
      io1.trigger(0.85)
      expect(h.pendingRafs.size).toBe(1)
      h.flushRaf()

      expect(syncs).toHaveLength(2)
      expect(syncs[1]?.box).toEqual({ right: 1280, bottom: 694, width: 300, height: 74 })
      expect(io1.disconnected).toBe(true)
      expect(h.ioInstances).toHaveLength(2)
      expect(h.ioInstances[1]?.options?.rootMargin).toBe('-620px -55px -106px -980px')

      // Stale callbacks from the disconnected observer are ignored.
      io1.trigger(0.5)
      expect(h.pendingRafs.size).toBe(0)

      // Unchanged position re-syncs do not churn the tight observer.
      handle.schedule()
      h.flushRaf()
      expect(h.ioInstances).toHaveLength(2)

      handle.dispose()
    } finally {
      h.restore()
    }
  })

  it('falls back without root when Document root throws, calibrates partial visibility once, and switches to reentry when off-screen', () => {
    const h = setupHarness({ rejectDocumentRootIo: true })
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      expect(h.ioInstances).toHaveLength(1)
      const io1 = h.ioInstances[0]
      expect(io1.options).toEqual({
        rootMargin: '-676px 0px -50px -1035px',
        threshold: 1,
      })

      // Partial initial ratio calibrates threshold once without calling sync or looping.
      io1.trigger(0.75)
      expect(h.pendingRafs.size).toBe(0)
      expect(h.ioInstances).toHaveLength(2)
      const io2 = h.ioInstances[1]
      expect(io2.options?.threshold).toBe(0.75)

      // Even if calibrated first callback still reports < 0.75, it does not re-calibrate again.
      io2.trigger(0.74)
      expect(h.pendingRafs.size).toBe(0)
      expect(h.ioInstances).toHaveLength(2)

      // Switching off-screen moves to threshold: 0 reentry observer without timers.
      h.anchor.rect = makeRect(1500, 900, 300, 74)
      io2.trigger(0)
      h.flushRaf()
      expect(h.ioInstances).toHaveLength(3)
      const reentryIo = h.ioInstances[2]
      expect(reentryIo.options).toEqual({ threshold: 0 })

      // Reentry initial callback is skipped; subsequent >0 reentry fires sync and re-arms tight guard.
      reentryIo.trigger(0)
      expect(h.pendingRafs.size).toBe(0)

      h.anchor.rect = makeRect(1035, 676, 300, 74)
      reentryIo.trigger(0.4)
      expect(h.pendingRafs.size).toBe(1)
      h.flushRaf()
      expect(h.ioInstances).toHaveLength(4)
      expect(h.ioInstances[3]?.options?.threshold).toBe(1)

      handle.dispose()
    } finally {
      h.restore()
    }
  })

  it('keeps ResizeObserver and ancestor MutationObserver on collapsed 0x0 anchor without enabling body subtree', () => {
    const h = setupHarness({ anchorRect: makeRect(0, 0, 0, 0) })
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      expect(syncs[0]?.box).toBeNull()

      const ro = h.resizeInstances[0]
      expect(ro.targets.has(h.anchor as unknown as Element)).toBe(true)

      const mo = h.mutationInstances[0]
      expect(mo.byTarget.get(h.body as unknown as Node)).toEqual({
        attributes: true,
        attributeFilter: ['class', 'style'],
      })

      // Expanding from 0x0 -> visible wakes ResizeObserver and emits the anchor box.
      h.anchor.rect = makeRect(1035, 676, 300, 74)
      ro.callback([], ro as unknown as ResizeObserver)
      h.flushRaf()

      expect(syncs).toHaveLength(2)
      expect(syncs[1]?.box).toEqual({ right: 1335, bottom: 750, width: 300, height: 74 })
      handle.dispose()
    } finally {
      h.restore()
    }
  })

  it('watches body subtree when anchor is absent and drops subtree once mounted', () => {
    const h = setupHarness({ mountAnchor: false })
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      expect(syncs[0]?.box).toBeNull()

      const mo = h.mutationInstances[0]
      expect(mo.byTarget.get(h.body as unknown as Node)).toEqual({
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      })

      const lateAnchor = createFakeElement({
        id: 'chat-control-panel-vm',
        parent: h.aside,
        ownerDocument: h.fakeDocument,
        rect: makeRect(1035, 676, 300, 74),
      })
      h.selectors.set('#chat-control-panel-vm', lateAnchor)
      mo.callback([], mo as unknown as MutationObserver)
      h.flushRaf()

      expect(syncs).toHaveLength(2)
      expect(syncs[1]?.box).toEqual({ right: 1335, bottom: 750, width: 300, height: 74 })
      expect(mo.byTarget.get(h.body as unknown as Node)).toEqual({
        attributes: true,
        attributeFilter: ['class', 'style'],
      })
      handle.dispose()
    } finally {
      h.restore()
    }
  })

  it('dispose cancels pending rAF, removes all listeners, disconnects observers, and suppresses late callbacks', () => {
    const h = setupHarness()
    const syncs: Array<{ vp: ViewportSize; box: AnchorBox | null }> = []
    try {
      const handle = observeChatAnchor((vp, box) => syncs.push({ vp, box }))
      expect(h.fakeWindow.listenerCount('resize', false)).toBe(1)
      expect(h.fakeWindow.listenerCount('scroll', true)).toBe(1)
      expect(h.fakeDocument.listenerCount('transitionend', true)).toBe(1)
      expect(h.fakeDocument.listenerCount('transitioncancel', true)).toBe(1)
      expect(h.fakeDocument.listenerCount('animationend', true)).toBe(1)
      expect(h.fakeDocument.listenerCount('fullscreenchange', false)).toBe(1)
      expect(h.fakeWindow.visualViewport.listenerCount('resize', false)).toBe(1)
      expect(h.fakeWindow.visualViewport.listenerCount('scroll', false)).toBe(1)

      handle.schedule()
      expect(h.pendingRafs.size).toBe(1)

      handle.dispose()
      expect(h.pendingRafs.size).toBe(0)
      expect(h.resizeInstances[0]?.disconnected).toBe(true)
      expect(h.mutationInstances[0]?.disconnected).toBe(true)
      expect(h.ioInstances[0]?.disconnected).toBe(true)
      expect(h.fakeWindow.listenerCount('resize', false)).toBe(0)
      expect(h.fakeWindow.listenerCount('scroll', true)).toBe(0)
      expect(h.fakeDocument.listenerCount('transitionend', true)).toBe(0)
      expect(h.fakeDocument.listenerCount('transitioncancel', true)).toBe(0)
      expect(h.fakeDocument.listenerCount('animationend', true)).toBe(0)
      expect(h.fakeDocument.listenerCount('fullscreenchange', false)).toBe(0)
      expect(h.fakeWindow.visualViewport.listenerCount('resize', false)).toBe(0)
      expect(h.fakeWindow.visualViewport.listenerCount('scroll', false)).toBe(0)

      // Calling schedule or late observer callbacks after dispose does nothing.
      handle.schedule()
      h.ioInstances[0]?.trigger(0.5)
      h.mutationInstances[0]?.callback([], h.mutationInstances[0] as unknown as MutationObserver)
      expect(h.pendingRafs.size).toBe(0)
      expect(syncs).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})

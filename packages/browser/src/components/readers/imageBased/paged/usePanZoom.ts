import { useCallback, useEffect, useRef, useState } from 'react'

import {
	fitToScreen,
	isZoomed as isZoomedState,
	type Measurements,
	panBy,
	type PanZoomState,
	zoomToScale,
} from './panZoom'

type Params = {
	/**
	 * The element which is transformed
	 */
	targetRef: React.RefObject<HTMLElement | null>
	/**
	 * The element which acts as the viewport. Defaults to the target's parent.
	 */
	viewportRef?: React.RefObject<HTMLElement | null>
	/**
	 * The minimum zoom level
	 */
	minScale?: number
	/**
	 * The maximum zoom level
	 */
	maxScale?: number
	/**
	 * The zoom level applied by a double tap
	 */
	doubleTapScale?: number
	/**
	 * Whether the ctrl/cmd key is required in order to zoom with the mouse wheel. When
	 * `false`, the wheel always zooms.
	 */
	requireModifier?: boolean
	/**
	 * Whether the pan/zoom interactions are enabled
	 */
	enabled?: boolean
}

type Point = { x: number; y: number }

const TAP_MOVE_THRESHOLD = 8

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value))

/**
 * Apply the transform to the element. This is done imperatively rather than via React state
 * so that a pan gesture does not trigger a re-render on every pointer move.
 */
const applyTransform = (element: HTMLElement | null, state: PanZoomState) => {
	if (!element) return
	element.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`
}

/**
 * Provides pan & zoom for the paged reader.
 *
 * The content is transformed with `translate(x, y) scale(s)` about its center. Panning is
 * constrained so that the content always covers the viewport, i.e. empty space is never
 * exposed around its edges.
 */
export function usePanZoom({
	targetRef,
	viewportRef,
	minScale = 1,
	maxScale = 4,
	doubleTapScale = 2,
	requireModifier = true,
	enabled = true,
}: Params) {
	/**
	 * The authoritative state. The DOM is updated imperatively so that we never read a
	 * stale layout during a gesture.
	 */
	const stateRef = useRef<PanZoomState>({ scale: 1, x: 0, y: 0 })
	const pointersRef = useRef(new Map<number, Point>())
	const lastDistanceRef = useRef<number | null>(null)
	const panStartRef = useRef<{ x: number; y: number } | null>(null)
	const panOriginRef = useRef<{ x: number; y: number } | null>(null)
	const movedRef = useRef(false)
	const didPanRef = useRef(false)

	/**
	 * Whether the content is currently zoomed in. This is tracked as state (rather than read
	 * from the ref) so that it can be used during render.
	 */
	const [isZoomed, setIsZoomed] = useState(false)

	const applyState = useCallback(
		(next: PanZoomState) => {
			stateRef.current = next
			setIsZoomed(isZoomedState(next))
			applyTransform(targetRef.current, next)
		},
		[targetRef],
	)

	/**
	 * Measure the content and the viewport, in viewport-relative coordinates
	 */
	const measure = useCallback((): Measurements | null => {
		const el = targetRef.current
		if (!el) return null

		const viewportEl = viewportRef?.current ?? el.parentElement
		if (!viewportEl) return null

		const rect = el.getBoundingClientRect()
		const viewportRect = viewportEl.getBoundingClientRect()

		return {
			viewport: { width: viewportRect.width, height: viewportRect.height },
			rect: {
				left: rect.left - viewportRect.left,
				top: rect.top - viewportRect.top,
				width: rect.width,
				height: rect.height,
			},
			state: stateRef.current,
		}
	}, [targetRef, viewportRef])

	/**
	 * Reset the content to its "fit to screen" state
	 */
	const reset = useCallback(() => {
		applyState(fitToScreen())
	}, [applyState])

	const zoomTo = useCallback(
		(scale: number, focal?: Point) => {
			const measurements = measure()
			if (!measurements) return

			applyState(
				zoomToScale(measurements, clamp(scale, minScale, maxScale), focal),
			)
		},
		[applyState, measure, minScale, maxScale],
	)

	/**
	 * Convert client (viewport) coordinates into viewport-relative coordinates
	 */
	const toViewportPoint = useCallback(
		(clientX: number, clientY: number): Point => {
			const el = targetRef.current
			const viewportEl = (viewportRef?.current ?? el?.parentElement) ?? null
			if (!viewportEl) return { x: clientX, y: clientY }

			const viewportRect = viewportEl.getBoundingClientRect()
			return {
				x: clientX - viewportRect.left,
				y: clientY - viewportRect.top,
			}
		},
		[targetRef, viewportRef],
	)

	const handlePointerDown = useCallback(
		(event: PointerEvent) => {
			if (!enabled) return
			if (event.button !== 0) return

			// Ignore interactions with overlay controls (e.g. the side navigation)
			if ((event.target as HTMLElement)?.closest?.('.z-50')) return

			// Prevent the browser's native image drag from hijacking the gesture (breaks panning)
			event.preventDefault()

			pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
			movedRef.current = false

			if (pointersRef.current.size === 1) {
				panOriginRef.current = { x: event.clientX, y: event.clientY }
				panStartRef.current = { x: event.clientX, y: event.clientY }
				lastDistanceRef.current = null
			} else if (pointersRef.current.size === 2) {
				const [a, b] = [...pointersRef.current.values()]
				if (a && b) {
					lastDistanceRef.current = Math.hypot(a.x - b.x, a.y - b.y)
				}
			}
		},
		[enabled],
	)

	const handlePointerMove = useCallback(
		(event: PointerEvent) => {
			if (!enabled) return
			if (!pointersRef.current.has(event.pointerId)) return

			pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
			const measurements = measure()
			if (!measurements) return

			if (pointersRef.current.size >= 2) {
				// Pinch to zoom, anchored at the midpoint between the fingers
				const [a, b] = [...pointersRef.current.values()]
				if (!a || !b) return

				const distance = Math.hypot(a.x - b.x, a.y - b.y)
				const lastDistance = lastDistanceRef.current

				if (lastDistance) {
					const ratio = distance / lastDistance
					const nextScale = clamp(stateRef.current.scale * ratio, minScale, maxScale)
					const midpoint = toViewportPoint((a.x + b.x) / 2, (a.y + b.y) / 2)

					applyState(zoomToScale(measurements, nextScale, midpoint))
					didPanRef.current = true
				}

				lastDistanceRef.current = distance
				return
			}

			const start = panStartRef.current
			const origin = panOriginRef.current
			if (!start) return

			const deltaX = event.clientX - start.x
			const deltaY = event.clientY - start.y

			applyState(panBy(measurements, deltaX, deltaY))

			panStartRef.current = { x: event.clientX, y: event.clientY }

			if (origin) {
				const totalX = Math.abs(event.clientX - origin.x)
				const totalY = Math.abs(event.clientY - origin.y)
				if (totalX > TAP_MOVE_THRESHOLD || totalY > TAP_MOVE_THRESHOLD) {
					movedRef.current = true
				}
			}
		},
		[applyState, enabled, measure, maxScale, minScale, toViewportPoint],
	)

	const handlePointerUp = useCallback(
		(event: PointerEvent) => {
			if (!enabled) return

			pointersRef.current.delete(event.pointerId)
			if (pointersRef.current.size < 2) {
				lastDistanceRef.current = null
			}
			if (pointersRef.current.size > 0) {
				// A finger was lifted from a pinch; restart the pan from here
				const [remaining] = [...pointersRef.current.values()]
				if (remaining) {
					panOriginRef.current = { x: remaining.x, y: remaining.y }
					panStartRef.current = { x: remaining.x, y: remaining.y }
				}
				return
			}

			panStartRef.current = null
			panOriginRef.current = null

			if (movedRef.current) {
				didPanRef.current = true
				return
			}
		},
		[enabled],
	)

	/**
	 * Handle zooming via the mouse wheel or a trackpad pinch. This is gated behind the
	 * ctrl/cmd key (unless the user has opted out) so that the wheel still scrolls the page.
	 */
	const handleWheel = useCallback(
		(event: WheelEvent) => {
			if (!enabled) return
			if (requireModifier && !event.ctrlKey && !event.metaKey) return

			const measurements = measure()
			if (!measurements) return

			event.preventDefault()

			const delta = event.deltaY === 0 && event.deltaX ? event.deltaX : event.deltaY
			const factor = Math.exp(-delta / 200)
			const nextScale = clamp(stateRef.current.scale * factor, minScale, maxScale)
			const focal = toViewportPoint(event.clientX, event.clientY)

			applyState(zoomToScale(measurements, nextScale, focal))
		},
		[applyState, enabled, measure, maxScale, minScale, requireModifier, toViewportPoint],
	)

	const handleDoubleClick = useCallback(
		(event: MouseEvent) => {
			if (!enabled) return
			if (doubleTapScale === 0) return

			const measurements = measure()
			if (!measurements) return

			event.preventDefault()

			const point = toViewportPoint(event.clientX, event.clientY)

			if (isZoomedState(stateRef.current)) {
				reset()
			} else {
				zoomTo(doubleTapScale, point)
			}
		},
		[doubleTapScale, enabled, measure, reset, toViewportPoint, zoomTo],
	)

	useEffect(() => {
		const el = targetRef.current
		if (!el) return

		el.addEventListener('pointerdown', handlePointerDown)
		// Listen on the document so a drag keeps generating events even once the
		// cursor leaves the (possibly transformed / smaller) page element. This is
		// what makes panning work reliably, in particular after a double-tap zoom.
		document.addEventListener('pointermove', handlePointerMove)
		document.addEventListener('pointerup', handlePointerUp)
		document.addEventListener('pointercancel', handlePointerUp)
		el.addEventListener('wheel', handleWheel, { passive: false })
		if (doubleTapScale !== 0) {
			el.addEventListener('dblclick', handleDoubleClick)
		}

		return () => {
			el.removeEventListener('pointerdown', handlePointerDown)
			document.removeEventListener('pointermove', handlePointerMove)
			document.removeEventListener('pointerup', handlePointerUp)
			document.removeEventListener('pointercancel', handlePointerUp)
			el.removeEventListener('wheel', handleWheel)
			if (doubleTapScale !== 0) {
				el.removeEventListener('dblclick', handleDoubleClick)
			}
		}
	}, [targetRef, handlePointerDown, handlePointerMove, handlePointerUp, handleWheel, handleDoubleClick, doubleTapScale])

	/**
	 * Whether the user has panned (as opposed to tapped) since the last check. Used to
	 * suppress the click handler which toggles the toolbar.
	 */
	const consumeDidPan = useCallback(() => {
		const didPan = didPanRef.current
		didPanRef.current = false
		return didPan
	}, [])

	/**
	 * Whether the user has panned (as opposed to tapped). Unlike {@link consumeDidPan},
	 * this does not reset the flag, so it can be polled by e.g. the page navigation handlers.
	 */
	const didPan = useCallback(() => {
		const value = didPanRef.current
		// Clear the flag once reported so it only suppresses the gesture that
		// immediately follows the pan.
		didPanRef.current = false
		return value
	}, [])

	return {
		isZoomed,
		reset,
		zoomTo,
		consumeDidPan,
		didPan,
	}
}

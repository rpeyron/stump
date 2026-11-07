import { describe, expect, it } from 'vitest'

import {
	deriveMetrics,
	fitToScreen,
	isZoomed,
	type Measurements,
	offsetLimits,
	panBy,
	zoomToScale,
} from '../panZoom'

/**
 * A viewport of 1000x800 with a 500x400 page centered within it.
 */
const buildMeasurements = (state = { scale: 1, x: 0, y: 0 }): Measurements => {
	const viewport = { width: 1000, height: 800 }
	const scale = state.scale

	return {
		viewport,
		rect: {
			// The content stays centered in the viewport, offset by the translation
			left: 500 - (500 * scale) / 2 + state.x,
			top: 400 - (400 * scale) / 2 + state.y,
			width: 500 * scale,
			height: 400 * scale,
		},
		state,
	}
}

describe('deriveMetrics', () => {
	it('recovers the laid-out size and center of the content', () => {
		const metrics = deriveMetrics(buildMeasurements({ scale: 2, x: 30, y: -10 }))

		expect(metrics.width).toBe(500)
		expect(metrics.height).toBe(400)
		expect(metrics.centerX).toBe(500)
		expect(metrics.centerY).toBe(400)
	})
})

describe('offsetLimits', () => {
	it('forces the content to stay centered when it is smaller than the viewport', () => {
		const limits = offsetLimits(500, 1000, 1, 500)

		expect(limits.min).toBe(0)
		expect(limits.max).toBe(0)
	})

	it('allows panning when the content is larger than the viewport', () => {
		// Content is 1000 wide in a 1000 wide viewport, centered at 500
		const limits = offsetLimits(1000, 1000, 1, 500)

		expect(limits.min).toBe(0)
		expect(limits.max).toBe(0)
	})

	it('allows panning up to half of the overflow when the content overflows', () => {
		// Content is 1500 wide in a 1000 wide viewport, centered at 500
		const limits = offsetLimits(1500, 1000, 1, 500)

		expect(limits.min).toBe(-250)
		expect(limits.max).toBe(250)
	})
})

describe('panBy', () => {
	it('does not expose empty space when the content is smaller than the viewport', () => {
		const next = panBy(buildMeasurements(), 500, 500)

		expect(next.x).toBe(0)
		expect(next.y).toBe(0)
	})

	it('does not expose empty space when the content is larger than the viewport', () => {
		const next = panBy(buildMeasurements({ scale: 3, x: 0, y: 0 }), 10000, 10000)

		// At scale 3, the content is 1500x1200 in a 1000x800 viewport
		expect(next.x).toBe(250)
		expect(next.y).toBe(200)
	})

	it('pans by the requested delta when there is room', () => {
		const next = panBy(buildMeasurements({ scale: 3, x: 0, y: 0 }), 50, -30)

		expect(next.x).toBe(50)
		expect(next.y).toBe(-30)
	})
})

describe('zoomToScale', () => {
	it('keeps the focal point anchored to the same screen position', () => {
		const measurements = buildMeasurements()
		// A focal point which is actually on the page (the page spans 250..750 x 200..600)
		const focal = { x: 550, y: 450 }
		const next = zoomToScale(measurements, 3, focal)

		const metrics = deriveMetrics(measurements)
		// The content offset from the page center, in content space
		const contentX = (focal.x - (metrics.centerX + measurements.state.x)) / measurements.state.scale
		const contentY = (focal.y - (metrics.centerY + measurements.state.y)) / measurements.state.scale

		// Where that content point ends up after the zoom
		const afterX = metrics.centerX + contentX * next.scale + next.x
		const afterY = metrics.centerY + contentY * next.scale + next.y

		expect(afterX).toBeCloseTo(focal.x)
		expect(afterY).toBeCloseTo(focal.y)
	})

	it('prefers not exposing empty space over anchoring the focal point', () => {
		const measurements = buildMeasurements()
		// A focal point far off to the side, which would require panning past the edge
		const focal = { x: 900, y: 450 }
		const next = zoomToScale(measurements, 3, focal)

		const metrics = deriveMetrics(measurements)
		const contentX = (focal.x - (metrics.centerX + measurements.state.x)) / measurements.state.scale
		const afterX = metrics.centerX + contentX * next.scale + next.x

		// The anchor is not preserved, but no empty space is exposed
		expect(afterX).not.toBeCloseTo(focal.x)
		expect(next.x).toBeGreaterThanOrEqual(-250)
		expect(next.x).toBeLessThanOrEqual(250)
	})

	it('never exposes empty space around the content', () => {
		const next = zoomToScale(buildMeasurements(), 4, { x: 0, y: 0 })

		// At scale 4 the content is 2000x1600 in a 1000x800 viewport
		expect(next.x).toBeGreaterThanOrEqual(-500)
		expect(next.x).toBeLessThanOrEqual(500)
		expect(next.y).toBeGreaterThanOrEqual(-400)
		expect(next.y).toBeLessThanOrEqual(400)
	})

	it('keeps a letterboxed page centered when zooming in', () => {
		const measurements = buildMeasurements()
		const next = zoomToScale(measurements, 2, { x: 100, y: 100 })

		const metrics = deriveMetrics(measurements)
		// The content is 1000x800 at scale 2, exactly filling the viewport, so the
		// content's center must land on the viewport's center
		expect(metrics.centerX + next.x).toBeCloseTo(500)
		expect(metrics.centerY + next.y).toBeCloseTo(400)
	})
})

describe('fitToScreen', () => {
	it('resets to the identity transform', () => {
		expect(fitToScreen()).toEqual({ scale: 1, x: 0, y: 0 })
	})
})

describe('isZoomed', () => {
	it('is false at the fit-to-screen scale', () => {
		expect(isZoomed({ scale: 1, x: 0, y: 0 })).toBe(false)
	})

	it('is true when zoomed in', () => {
		expect(isZoomed({ scale: 2, x: 0, y: 0 })).toBe(true)
	})
})

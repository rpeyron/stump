/**
 * The pan/zoom math for the paged reader.
 *
 * The content is transformed with `translate(x, y) scale(s)` about its own center, so
 * `x`/`y` are plain screen pixels: the content's center moves by exactly `(x, y)`.
 *
 * Panning is constrained so that the scaled content always covers the viewport. When the
 * scaled content is *smaller* than the viewport on an axis (e.g. a letterboxed page), it
 * stays centered on that axis instead, so no extra empty space is ever exposed.
 */

export type PanZoomState = {
	/**
	 * The zoom level. `1` is the reader's "fit to screen" scale.
	 */
	scale: number
	/**
	 * The horizontal translation of the content, in screen pixels
	 */
	x: number
	/**
	 * The vertical translation of the content, in screen pixels
	 */
	y: number
}

export type Viewport = {
	width: number
	height: number
}

export type ContentRect = {
	left: number
	top: number
	width: number
	height: number
}

export type Point = {
	x: number
	y: number
}

export type Measurements = {
	viewport: Viewport
	/**
	 * The bounding rect of the content, *with the current transform applied*
	 */
	rect: ContentRect
	state: PanZoomState
}

export type Metrics = {
	/**
	 * The size of the content, ignoring the current transform
	 */
	width: number
	height: number
	/**
	 * The position of the content's center in viewport coordinates, ignoring the current
	 * translation
	 */
	centerX: number
	centerY: number
}

export const IDENTITY_STATE: PanZoomState = { scale: 1, x: 0, y: 0 }

/**
 * Derive the layout metrics of the content from the current measurements.
 *
 * The measured rect already includes the current transform, so it is un-transformed here
 * to recover the content's laid-out size and center.
 */
export const deriveMetrics = ({ rect, state }: Measurements): Metrics => {
	const scale = state.scale || 1

	return {
		width: rect.width / scale,
		height: rect.height / scale,
		centerX: rect.left + rect.width / 2 - state.x,
		centerY: rect.top + rect.height / 2 - state.y,
	}
}

const clamp = (value: number, min: number, max: number) =>
	Math.min(max, Math.max(min, value))

/**
 * The range of translations which keep the content covering the viewport on a single axis.
 *
 * If the scaled content is smaller than the viewport, the only valid translation is the
 * one which centers it.
 */
export const offsetLimits = (
	contentSize: number,
	viewportSize: number,
	scale: number,
	contentCenter: number,
): { min: number; max: number } => {
	const half = (contentSize * scale) / 2

	if (half * 2 <= viewportSize) {
		// The content is narrower than the viewport, so it must stay centered
		const centered = viewportSize / 2 - contentCenter
		return { min: centered, max: centered }
	}

	return {
		min: viewportSize - contentCenter - half,
		max: half - contentCenter,
	}
}

/**
 * Pan the content by the given screen-pixel delta, keeping the content within bounds.
 */
export const panBy = (measurements: Measurements, deltaX: number, deltaY: number): PanZoomState => {
	const metrics = deriveMetrics(measurements)
	const { scale, x, y } = measurements.state

	const limitsX = offsetLimits(metrics.width, measurements.viewport.width, scale, metrics.centerX)
	const limitsY = offsetLimits(metrics.height, measurements.viewport.height, scale, metrics.centerY)

	return {
		scale,
		x: clamp(x + deltaX, limitsX.min, limitsX.max),
		y: clamp(y + deltaY, limitsY.min, limitsY.max),
	}
}

/**
 * Zoom the content to the given scale, optionally anchoring a content point to a screen
 * position.
 */
export const zoomToScale = (
	measurements: Measurements,
	nextScale: number,
	focal?: Point,
): PanZoomState => {
	const metrics = deriveMetrics(measurements)
	const { scale, x, y } = measurements.state

	let nextX = x
	let nextY = y

	if (focal) {
		// The focal point's offset from the content's center, in screen pixels
		const ux = focal.x - (metrics.centerX + x)
		const uy = focal.y - (metrics.centerY + y)

		// The same content point, in content space
		const contentX = ux / scale
		const contentY = uy / scale

		// Keep that content point under the focal position after the zoom
		nextX = focal.x - metrics.centerX - contentX * nextScale
		nextY = focal.y - metrics.centerY - contentY * nextScale
	}

	const limitsX = offsetLimits(metrics.width, measurements.viewport.width, nextScale, metrics.centerX)
	const limitsY = offsetLimits(metrics.height, measurements.viewport.height, nextScale, metrics.centerY)

	return {
		scale: nextScale,
		x: clamp(nextX, limitsX.min, limitsX.max),
		y: clamp(nextY, limitsY.min, limitsY.max),
	}
}

/**
 * Reset the content to its "fit to screen" state, i.e. the identity transform.
 */
export const fitToScreen = (): PanZoomState => IDENTITY_STATE

/**
 * Whether the content is currently zoomed in beyond its "fit to screen" state.
 */
export const isZoomed = (state: PanZoomState, epsilon = 0.001): boolean =>
	Math.abs(state.scale - 1) > epsilon

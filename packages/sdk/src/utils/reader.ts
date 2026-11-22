export type ImageBasedBookPageRef = {
	height: number
	width: number
	ratio: number
}

export type PageSetIndexes = [number, number] | [number]

export type GeneratePageSetsParams = {
	imageSizes: Record<number, ImageBasedBookPageRef>
	pages: number
	secondPageSeparate?: boolean
}

/**
 * The minimum zoom level at which a higher quality render is requested.
 */
export const QUALITY_SCALE_THRESHOLD = 1.05

/**
 * The maximum render scale which may be requested from the server. This mirrors the
 * server-side limit.
 */
export const MAX_RENDER_SCALE = 4

/**
 * The render quality tiers which are used when zooming. Rendering a PDF page at a higher
 * DPI is expensive, so rather than requesting a render for every zoom step, the zoom level
 * is bucketed into a small number of discrete quality tiers.
 */
export const RENDER_SCALE_TIERS = [1, 1.5, 2, 3] as const

/**
 * Determine the render scale which should be requested for a given zoom level.
 *
 * The zoom level is bucketed into discrete quality tiers so that the number of distinct
 * images (and thus server-side renders) remains small. A zoom level at (or below) the
 * "fit to screen" scale returns `undefined`, which means the server's default render
 * quality should be used.
 *
 * @param zoomScale - The current zoom level of the reader. `1` is "fit to screen".
 * @returns The render scale to request, or `undefined` to use the server default.
 */
export const renderScaleForZoom = (zoomScale?: number): number | undefined => {
	if (!zoomScale || !Number.isFinite(zoomScale)) {
		return undefined
	}

	if (zoomScale <= QUALITY_SCALE_THRESHOLD) {
		return undefined
	}

	const tier = RENDER_SCALE_TIERS.find((scale) => zoomScale <= scale)
	return tier ?? MAX_RENDER_SCALE
}

export const generatePageSets = ({
	imageSizes,
	pages,
	secondPageSeparate = false,
}: GeneratePageSetsParams): PageSetIndexes[] => {
	if (Object.keys(imageSizes).length === 0) {
		return Array.from({ length: pages }, (_, i) => [i])
	}

	const landscapePages = Object.entries(imageSizes).reduce(
		(acc, [key, dimensions]) => {
			const idx = parseInt(key)
			if (isNaN(idx)) return acc

			const { width, height, ratio } = dimensions

			const computedRatio = width / height
			if (computedRatio !== ratio) {
				console.warn(
					`Image size ratio mismatch for page ${idx + 1}: expected ${ratio}, got ${computedRatio}`,
					{
						width,
						height,
					},
				)
			}

			acc[idx] = ratio >= 1
			return acc
		},
		{} as Record<number, boolean>,
	)

	const pageSets: PageSetIndexes[] = []
	let i = 0
	while (i < pages) {
		const isFirst = i === 0
		const separateSecond = i === 1 && secondPageSeparate
		const isLandscape = landscapePages[i]
		const isLast = i === pages - 1
		// these next two conditions are because: if we are looking to pair page `i` with the next page `i+1`
		// but the next page is separate, the current page has nothing to pair with, thus has to be separate too
		const nextIsLandscape = landscapePages[i + 1]
		const nextIsLast = i + 1 === pages - 1

		const keepPageSeparate =
			isFirst || separateSecond || isLandscape || isLast || nextIsLandscape || nextIsLast

		if (keepPageSeparate) {
			pageSets.push([i])
			i++
		} else {
			pageSets.push([i, i + 1])
			i += 2
		}
	}

	return pageSets
}

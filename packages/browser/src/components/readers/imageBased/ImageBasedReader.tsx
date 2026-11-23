import { DEFAULT_BOOK_PREFERENCES, useSDK } from '@stump/client'
import { ReadingDirection, ReadingMode } from '@stump/graphql'
import { generatePageSets, MAX_RENDER_SCALE, renderScaleForZoom } from '@stump/sdk'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useWindowSize } from 'rooks'

import { usePreloadPage } from '@/hooks/usePreloadPage'
import { usePaths } from '@/paths'
import { useBookPreferences } from '@/scenes/book/reader/useBookPreferences'
import { useBookTimer } from '@/stores/reader'

import ReaderContainer from './container'
import { ImageBaseReaderContext, ImagePageDimensionRef, ImageReaderBookRef } from './context'
import { ContinuousScrollReader } from './continuous'
import { AnimatedPagedReader, PagedReader } from './paged'
import { useImageSizes } from './useImageSizes'

/**
 * The default render scale used when preloading the current page at a high quality. This
 * is used when the user has not configured a double-tap zoom level.
 */
const DEFAULT_PRELOAD_SCALE = 2

type Props = {
	/**
	 * The media which is being read
	 */
	media: ImageReaderBookRef
	/**
	 * Whether or not the reader is in incognito mode. If true, no progress will be reported.
	 */
	isIncognito?: boolean
	/**
	 * The initial page to start on, if any. This is 1-indexed, and defaults to 1 if not provided.
	 */
	initialPage?: number
	onProgress?: (page: number, elapsedSeconds: number) => void
}

export default function ImageBasedReader({ media, isIncognito, initialPage, onProgress }: Props) {
	const { sdk } = useSDK()
	const paths = usePaths()

	/**
	 * The media API controller. This is memoized because `sdk.media` is a getter which
	 * creates a new instance on every access, which would invalidate any callback
	 * depending on it.
	 */
	const mediaApi = useMemo(() => sdk.media, [sdk])

	const client = useQueryClient()
	const navigate = useNavigate()

	/**
	 * The current page of the reader
	 */
	const [currentPage, setCurrentPage] = useState(() => initialPage || 1)

	/**
	 * The render scale used when requesting page images. This is bumped up when the user
	 * zooms in so that the rendered image stays sharp instead of being blurry.
	 *
	 * When `undefined`, the server's default render quality is used.
	 */
	const [renderScale, setRenderScale] = useState<number | undefined>(undefined)

	const { imageSizes, setPageSize } = useImageSizes({ book: media })

	const {
		settings: { preload, showToolBar, animatedReader },
		bookPreferences: {
			doublePageBehavior = DEFAULT_BOOK_PREFERENCES.doublePageBehavior,
			doubleTapZoom,
			readingMode,
			readingDirection,
			trackElapsedTime,
			secondPageSeparate,
		},
		setSettings,
	} = useBookPreferences({ book: media })

	const timer = useBookTimer(media?.id || '', {
		initial: media?.readProgress?.elapsedSeconds,
		enabled: trackElapsedTime && !showToolBar,
	})

	const windowSize = useWindowSize()

	const deviceOrientation = useMemo(
		() => ((windowSize.innerWidth || 0) > (windowSize.innerHeight || 0) ? 'landscape' : 'portrait'),
		[windowSize],
	)

	const pages = media.pages
	const pageSets = useMemo(() => {
		const autoButOff = doublePageBehavior === 'auto' && deviceOrientation === 'portrait'
		const modeForceOff = readingMode === ReadingMode.ContinuousVertical

		let sets: number[][] = []
		if (doublePageBehavior === 'off' || autoButOff || modeForceOff) {
			sets = Array.from({ length: pages }, (_, i) => [i])
		} else {
			sets = generatePageSets({
				imageSizes,
				pages: pages,
				secondPageSeparate: secondPageSeparate,
			})
		}

		if (readingDirection === ReadingDirection.Rtl) {
			return [...sets.map((set) => [...set].reverse())].reverse()
		}

		return sets
	}, [
		doublePageBehavior,
		pages,
		imageSizes,
		deviceOrientation,
		readingMode,
		readingDirection,
		secondPageSeparate,
	])

	/**
	 * A callback to handle when the page changes. This will update the URL to reflect the new page
	 * if the reader mode is not continuous.
	 */
	const handleChangePage = useCallback(
		(newPage: number) => {
			if (readingMode !== ReadingMode.Paged) {
				setCurrentPage(newPage)
			} else {
				setCurrentPage(newPage)
				navigate(paths.bookReader(media.id, { isIncognito, page: newPage }), { replace: true })
			}

			if (!isIncognito) {
				const elapsedSeconds = timer.getCurrentTime()
				onProgress?.(newPage, elapsedSeconds)
			}
		},
		[media.id, isIncognito, navigate, readingMode, paths, timer, onProgress],
	)

	/**
	 * A callback to get the URL of a page. This is *not* 0-indexed, so the first page is 1.
	 *
	 * The `scale` param is used to request a higher quality render when the user has
	 * zoomed in. This is a no-op for non-PDF media, since the server only applies it when
	 * rendering PDFs.
	 */
	const getPageUrl = useCallback(
		(pageNumber: number) =>
			mediaApi.bookPageURL(media.id, pageNumber, renderScale ? { scale: renderScale } : undefined),
		[media.id, mediaApi, renderScale],
	)

	/**
	 * The render scale used when preloading the current page at a high quality. This is
	 * derived from the double-tap zoom preference, since that is the quality the page
	 * will need once the user zooms in.
	 *
	 * The scale is bucketed using the same tiers as {@link renderScaleForZoom}, so that the
	 * preloaded image is exactly the image which will be requested once the user zooms in.
	 * Otherwise the browser cache would not be able to serve it.
	 */
	const preloadScale = useMemo(() => {
		const targetScale = doubleTapZoom && doubleTapZoom > 1 ? doubleTapZoom : DEFAULT_PRELOAD_SCALE
		return renderScaleForZoom(targetScale) ?? MAX_RENDER_SCALE
	}, [doubleTapZoom])

	/**
	 * A callback to get the URL of a page at a high render quality, regardless of the
	 * current zoom level. This is used to preload the current page at a sharp quality so
	 * that it is ready by the time the user zooms in.
	 */
	const getScaledPageUrl = useCallback(
		(pageNumber: number) => mediaApi.bookPageURL(media.id, pageNumber, { scale: preloadScale }),
		[media.id, mediaApi, preloadScale],
	)

	const lastPage = useMemo(() => media.pages, [media.pages])
	/**
	 * The pages before and after the current page to preload. Any pages that are
	 * less than 1 or greater than the total number of pages will be ignored.
	 */
	const pagesToPreload = useMemo(
		() =>
			[...Array(preload.behind).keys()]
				.map((i) => currentPage - i - 1)
				.reverse()
				.concat([...Array(preload.ahead).keys()].map((i) => currentPage + i + 1))
				.filter((i) => i > 0 && i <= lastPage),

		[currentPage, preload, lastPage],
	)

	/**
	 * Whether the media is a PDF. Only PDFs are rendered server-side, so they are the only
	 * media for which requesting a higher quality has any effect.
	 */
	const isPdf = useMemo(() => media.extension?.toLowerCase() === 'pdf', [media.extension])

	/**
	 * Preload pages that are not currently visible. This is done to try and
	 * prevent wait times for the next page to load.
	 */
	// TODO: Fix on desktop
	const storeDimensions = useCallback(
		(page: number, dimensions: ImagePageDimensionRef) => {
			setPageSize(page - 1, dimensions)
		},
		[setPageSize],
	)
	usePreloadPage({
		onStoreDimensions: storeDimensions,
		pages: pagesToPreload,
		urlBuilder: getPageUrl,
		// The current page is preloaded at a higher quality *after* the adjacent pages have
		// been preloaded, so that zooming in on the current page does not compete with
		// them for bandwidth.
		scaledPage: isPdf ? currentPage : undefined,
		scaledUrlBuilder: getScaledPageUrl,
	})

	/**
	 * This effect is primarily responsible for two cleanup tasks:
	 *
	 * 1. Hiding the toolbar when the component unmounts. This is done to ensure that the toolbar is not
	 *    visible when the user navigates *back* to a reader again at some point.
	 * 2. Invalidating the in-progress media query when the component unmounts. This is done to ensure that
	 *    when the user navigates away from the reader, the in-progress media is accurately reflected with
	 *    the latest reading session.
	 */
	useEffect(() => {
		return () => {
			setSettings({
				showToolBar: false,
			})
			client.invalidateQueries({ exact: false, queryKey: ['keepReading'] })
			client.invalidateQueries({ queryKey: ['bookOverview', media.id], exact: false })
		}
	}, [client, media.id, setSettings])

	const renderReader = () => {
		if (readingMode.startsWith('CONTINUOUS')) {
			return (
				<ContinuousScrollReader
					media={media}
					initialPage={currentPage}
					getPageUrl={getPageUrl}
					onPageChanged={handleChangePage}
					orientation={
						(readingMode.split('_')[1]?.toLowerCase() as 'vertical' | 'horizontal') || 'vertical'
					}
				/>
			)
		} else if (animatedReader) {
			const Component = AnimatedPagedReader
			return <Component initialPage={initialPage || 1} onPageChanged={handleChangePage} />
		} else {
			return <PagedReader currentPage={initialPage || 1} onPageChange={handleChangePage} />
		}
	}

	return (
		<ImageBaseReaderContext.Provider
			value={{
				book: media,
				currentPage,
				imageSizes,
				setCurrentPage: handleChangePage,
				getPageUrl,
				renderScale,
				setRenderScale,
				setPageSize,
				pageSets,
				timer,
				toggleToolbar: () => setSettings({ showToolBar: !showToolBar }),
			}}
		>
			<ReaderContainer>{renderReader()}</ReaderContainer>
		</ImageBaseReaderContext.Provider>
	)
}

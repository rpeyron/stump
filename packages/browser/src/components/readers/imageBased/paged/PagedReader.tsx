import clsx from 'clsx'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { Hotkey } from 'react-hotkeys-hook/dist/types'
import { useMediaMatch, useWindowSize } from 'rooks'

import { useBookPreferences } from '@/scenes/book/reader/useBookPreferences'

import { useImageBaseReaderContext } from '../context'
import PageSet from './PageSet'
import { usePanZoom } from './usePanZoom'

export type PagedReaderProps = {
	/** The current page which the reader should render */
	currentPage: number
	/** A callback that is called in order to change the page */
	onPageChange: (page: number) => void
}

/**
 * A reader component for image-based media. Images are displayed one at a time,
 * however preloading is done to reduce wait times for consecutive pages.
 *
 * Note: This component lacks animations between pages. The `AnimatedPagedReader` component
 * will have animations between pages, but is currently a WIP
 */
const svgCursor = (svg: string, x: number, y: number) =>
	`url("data:image/svg+xml,${encodeURIComponent(svg)}") ${x} ${y}, pointer`

const LEFT_ARROW_CURSOR = svgCursor(
	`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M18 5 L8 14 L18 23 Z" fill="white" stroke="black" stroke-width="2.5" stroke-linejoin="round"/></svg>`,
	8,
	14,
)

const RIGHT_ARROW_CURSOR = svgCursor(
	`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M10 5 L20 14 L10 23 Z" fill="white" stroke="black" stroke-width="2.5" stroke-linejoin="round"/></svg>`,
	20,
	14,
)

function PagedReader({ currentPage, onPageChange }: PagedReaderProps) {
	const { pageSets, book, getPageUrl } = useImageBaseReaderContext()
	const {
		bookPreferences: {
			tapSidesToNavigate,
			panzoomWithoutCtrl,
			doubleTapZoom,
		},
		settings: { showToolBar },
		setSettings,
	} = useBookPreferences({ book })

	const { innerWidth } = useWindowSize()

	const isMobile = useMediaMatch('(max-width: 768px)')

	const pageSetRef = useRef<HTMLDivElement | null>(null)
	const viewportRef = useRef<HTMLDivElement | null>(null)
	const toolbarToggleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

	const [pageSetWidth, setPageSetWidth] = useState(0)
	useEffect(() => {
		const pageSetElement = pageSetRef.current
		if (!pageSetElement) return

		const resizeObserver = new ResizeObserver((entries) => {
			if (!entries[0]) return
			const newWidth = entries[0].contentRect.width
			setPageSetWidth(newWidth)
		})
		resizeObserver.observe(pageSetElement)
		return () => {
			resizeObserver.disconnect()
		}
	}, [])

	/**
	 * Pan & zoom for the page set. Double tapping zooms in on the tapped point, and double
	 * tapping while zoomed in returns the page to its "fit to screen" state.
	 */
	const { reset: resetPanZoom, consumeDidPan, didPan, isZoomed } = usePanZoom({
		targetRef: pageSetRef,
		viewportRef,
		doubleTapScale: doubleTapZoom ?? 0,
		requireModifier: !panzoomWithoutCtrl,
	})

	/**
	 * Reset the zoom whenever the page changes, since the new page has different dimensions
	 */
	useEffect(() => {
		resetPanZoom()
	}, [currentPage, resetPanZoom])

	const currentSetIdx = useMemo(
		() => pageSets.findIndex((set) => set.includes(currentPage - 1)),
		[currentPage, pageSets],
	)

	/**
	 * If the image parts are collective >= 86% of the screen width, we want to fix the side navigation
	 */
	const fixSideNavigation = useMemo(() => {
		return (!!innerWidth && pageSetWidth >= innerWidth * 0.86) || isMobile
	}, [pageSetWidth, innerWidth, isMobile])

	/**
	 * Record previous scroll position to restore if backtracked within 3 seconds
	 */
	const scrollPositionMap = useRef(new Map<number, { scrollTop: number; timestamp: number }>())

	useEffect(() => {
		const scrollElement = pageSetRef.current?.parentElement?.parentElement?.parentElement
		const storedScrollState = scrollPositionMap.current.get(currentSetIdx)
		let scrollTop = 0
		if (storedScrollState && Date.now() - storedScrollState.timestamp < 3000) {
			scrollTop = storedScrollState.scrollTop
		}
		scrollElement?.scrollTo({ top: scrollTop, behavior: 'smooth' })
	}, [currentSetIdx])

	/**
	 * A callback to actually change the page. This should not be called directly, but rather
	 * through the `handleLeftwardPageChange` and `handleRightwardPageChange` callbacks to
	 * ensure that the reading direction is respected.
	 *
	 * @param newPage The new page to navigate to (1-indexed)
	 */
	const doChangePage = useCallback(
		(newPage: number) => {
			const scrollElement = pageSetRef.current?.parentElement?.parentElement?.parentElement
			const scrollTop = scrollElement?.scrollTop ?? 0
			scrollPositionMap.current.set(currentSetIdx, { scrollTop: scrollTop, timestamp: Date.now() })

			if (newPage <= book.pages && newPage > 0) {
				onPageChange(newPage)
			}
		},
		[book.pages, onPageChange, currentSetIdx],
	)

	/**
	 * A callback to change the page to the left. This will respect the reading direction
	 * and the double spread setting.
	 */
	const handleLeftwardPageChange = useCallback(() => {
		const nextSetIdx = currentSetIdx - 1
		const nextSet = pageSets[nextSetIdx]
		const endOfNextSet = nextSet?.at(-1)

		if (!nextSet || endOfNextSet == null || didPan()) {
			return
		}

		if (nextSetIdx >= 0 && nextSetIdx < pageSets.length) {
			doChangePage(endOfNextSet + 1)
		}
	}, [didPan, doChangePage, currentSetIdx, pageSets])
	/**
	 * A callback to change the page to the right. This will respect the reading direction
	 * and the double spread setting.
	 */
	const handleRightwardPageChange = useCallback(() => {
		const nextSetIdx = currentSetIdx + 1
		const nextSet = pageSets[nextSetIdx]
		const startOfNextSet = nextSet?.at(0)

		if (!nextSet || startOfNextSet == null || didPan()) {
			return
		}

		if (nextSetIdx >= 0 && nextSetIdx < pageSets.length) {
			doChangePage(startOfNextSet + 1)
		}
	}, [didPan, doChangePage, currentSetIdx, pageSets])

	/**
	 * A callback handler for changing the page or toggling the toolbar visibility via
	 * keyboard shortcuts.
	 */
	const hotKeyHandler = useCallback(
		(hotkey: Hotkey) => {
			const targetKey = hotkey.keys?.at(0)
			switch (targetKey) {
				case 'right':
				case 'd':
					handleRightwardPageChange()
					break
				case 'left':
				case 'a':
					handleLeftwardPageChange()
					break
				case 'space':
					setSettings({
						showToolBar: !showToolBar,
					})
					break
				case 'escape':
					setSettings({
						showToolBar: false,
					})
					break
				default:
					break
			}
		},
		[setSettings, showToolBar, handleRightwardPageChange, handleLeftwardPageChange],
	)
	/**
	 * Register the hotkeys for the reader component
	 */
	useHotkeys('right, left, a, d, space, escape', (_, handler) => hotKeyHandler(handler))

	return (
		<div
			ref={viewportRef}
			className="relative m-auto flex h-screen w-screen justify-center overflow-hidden"
		>
			{!showToolBar && tapSidesToNavigate && (
				<SideBarControl
					fixed={fixSideNavigation}
					position="left"
					cursor={LEFT_ARROW_CURSOR}
					onClick={() => handleLeftwardPageChange()}
				/>
			)}

			<PageSet
				ref={pageSetRef}
				currentPage={currentPage}
				getPageUrl={getPageUrl}
				isZoomed={isZoomed}
				onPageClick={(e) => {
					if (consumeDidPan()) return
					// If double-tap zoom is disabled, toggle immediately (no delay)
					// If enabled, defer to allow double-click to cancel
					const delay = doubleTapZoom && doubleTapZoom > 0 ? 300 : 0
					if (delay === 0) {
						setSettings({ showToolBar: !showToolBar })
					} else {
						if (toolbarToggleTimeoutRef.current) {
							clearTimeout(toolbarToggleTimeoutRef.current)
						}
						toolbarToggleTimeoutRef.current = setTimeout(() => {
							if (!consumeDidPan()) {
								setSettings({ showToolBar: !showToolBar })
							}
							toolbarToggleTimeoutRef.current = null
						}, delay)
					}
				}}
				onPageDoubleClick={() => {
					if (consumeDidPan()) return
					// Cancel toolbar toggle on double-click
					if (toolbarToggleTimeoutRef.current) {
						clearTimeout(toolbarToggleTimeoutRef.current)
						toolbarToggleTimeoutRef.current = null
					}
				}}
			/>

			{!showToolBar && tapSidesToNavigate && (
				<SideBarControl
					fixed={fixSideNavigation}
					position="right"
					cursor={RIGHT_ARROW_CURSOR}
					onClick={() => handleRightwardPageChange()}
				/>
			)}
		</div>
	)
}

type SideBarControlProps = {
	/** A callback that is called when the sidebar is clicked */
	onClick: () => void
	/** The position of the sidebar control */
	position: 'left' | 'right'
	/** Whether the sidebar should be fixed to the screen */
	fixed: boolean
	/** Optional cursor override */
	cursor?: string
}

/**
 * A component that renders an invisible div on either the left or right side of the screen that, when
 * clicked, will call the onClick callback. This is used in the `PagedReader` component for
 * navigating to the next/previous page.
 */
function SideBarControl({ onClick, position, fixed, cursor }: SideBarControlProps) {
	return (
		<div
			className={clsx(
				'z-50 h-full shrink-0 border border-transparent transition-all duration-300',
				'active:border-border active:bg-muted/50',
				fixed ? 'absolute w-[10%]' : 'relative mx-[-3%] flex flex-1 grow',
				{ 'right-0': position === 'right' },
				{ 'left-0': position === 'left' },
			)}
			onClick={onClick}
			style={{ cursor: cursor ?? 'inherit' }}
		/>
	)
}

export default memo(PagedReader)
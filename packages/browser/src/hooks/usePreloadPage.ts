import { useEffect, useRef, useState } from 'react'

import { ImagePageDimensionRef } from '@/components/readers/imageBased/context'

type Params = {
	/**
	 * The pages to preload
	 */
	pages: number[]
	/**
	 * A function to build the url for a given page
	 */
	urlBuilder: (page: number) => string
	/**
	 * A callback to store the dimensions of a page after it has been preloaded
	 */
	onStoreDimensions?: (page: number, dimensions: ImagePageDimensionRef) => void
	/**
	 * An additional page to preload *after* the main pages, typically the current page at a
	 * scaled (zoomed) quality so that it is sharp as soon as the user zooms in.
	 */
	scaledPage?: number
	/**
	 * A function to build the url for the scaled page. This should produce a url with a
	 * higher render quality than the one produced by `urlBuilder`.
	 */
	scaledUrlBuilder?: (page: number) => string
}
/**
 * A hook to preload a list of pages, provided a function to build the url for each page
 *
 * TODO: handle errors a bit better?
 */
export function usePreloadPage({
	pages,
	urlBuilder,
	onStoreDimensions,
	scaledPage,
	scaledUrlBuilder,
}: Params) {
	const [isPreloading, setIsPreloading] = useState(false)

	/**
	 * The pages which have already been preloaded, keyed by their url. Keying by url (rather
	 * than by page number) ensures that pages are re-preloaded when the url changes, e.g.
	 * when the requested render quality changes because the user has zoomed in.
	 */
	const preloadRef = useRef<Record<string, boolean>>({})

	/**
	 * This effect will attempt to preload all pages by creating an image element
	 * for each page and setting the src to the urlBuilder function.
	 *
	 * The `scaledPage` (if provided) is preloaded *after* the main pages, so that the
	 * current page is sharp as soon as the user zooms in. Since the adjacent pages are
	 * preloaded at their normal quality first, zooming in on the current page does not
	 * have to compete with them for bandwidth.
	 *
	 * It currently does not handle errors, but it could be extended to do so.
	 */
	useEffect(() => {
		/**
		 * Preload a single page by creating an image element and setting its src.
		 *
		 * @param page - The page being preloaded
		 * @param src - The url to load
		 * @param storeDimensions - Whether the dimensions of the image should be stored. This
		 * is disabled for scaled renders, since the natural dimensions of the page should
		 * always be preferred when laying out the reader.
		 */
		const preloadPage = (page: number, src: string, storeDimensions: boolean) => {
			const image = new Image()
			return new Promise<void>((resolve, reject) => {
				image.src = src
				image.onload = () => {
					if (storeDimensions && image.width && image.height) {
						onStoreDimensions?.(page, {
							height: image.height,
							ratio: image.width / image.height,
							width: image.width,
						})
					}
					resolve()
				}
				image.onerror = (error) => reject(error)
			})
		}

		const pageUrls = new Map(pages.map((page) => [page, urlBuilder(page)] as const))
		const filteredPages = pages.filter((page) => !preloadRef.current[pageUrls.get(page)!])

		const scaledUrl = scaledPage && scaledUrlBuilder ? scaledUrlBuilder(scaledPage) : undefined
		const shouldPreloadScaled = !!scaledUrl && !preloadRef.current[scaledUrl]

		if (!filteredPages.length && !shouldPreloadScaled) return

		filteredPages.forEach((page) => {
			preloadRef.current[pageUrls.get(page)!] = true
		})
		if (scaledUrl) {
			preloadRef.current[scaledUrl] = true
		}

		const preloadPages = async () => {
			setIsPreloading(true)
			const results = await Promise.allSettled(
				filteredPages.map((page) => preloadPage(page, pageUrls.get(page)!, true)),
			)
			const errors = results.filter((result) => result.status === 'rejected')
			if (errors.length) {
				console.error(errors)
			}

			/**
			 * Preload the current page at scaled quality after the adjacent pages.
			 * This ensures the page the user is reading stays sharp when zoomed in.
			 */
			if (scaledUrl && scaledPage) {
				try {
					await preloadPage(scaledPage, scaledUrl, false)
				} catch (error) {
					console.error(error)
				}
			}

			setIsPreloading(false)
		}

		preloadPages()
	}, [pages, urlBuilder, onStoreDimensions, scaledPage, scaledUrlBuilder])

	return { isPreloading }
}

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
}
/**
 * A hook to preload a list of pages, provided a function to build the url for each page
 *
 * TODO: handle errors a bit better?
 */
export function usePreloadPage({ pages, urlBuilder, onStoreDimensions }: Params) {
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
	 * It currently does not handle errors, but it could be extended to do so.
	 */
	useEffect(() => {
		const pageUrls = new Map(pages.map((page) => [page, urlBuilder(page)] as const))
		const filteredPages = pages.filter((page) => !preloadRef.current[pageUrls.get(page)!])
		const shouldPreload = filteredPages.length > 0

		if (!shouldPreload) return

		filteredPages.forEach((page) => {
			preloadRef.current[pageUrls.get(page)!] = true
		})

		const preloadPage = (page: number) => {
			const image = new Image()
			return new Promise((resolve, reject) => {
				image.src = pageUrls.get(page)!
				image.onload = () => {
					if (image.width && image.height) {
						onStoreDimensions?.(page, {
							height: image.height,
							ratio: image.width / image.height,
							width: image.width,
						})
					}
					resolve(image)
				}
				image.onerror = (error) => reject(error)
			})
		}

		const preloadPages = async () => {
			setIsPreloading(true)
			const results = await Promise.allSettled(filteredPages.map(preloadPage))
			const errors = results.filter((result) => result.status === 'rejected')
			if (errors.length) {
				console.error(errors)
			}
			setIsPreloading(false)
		}

		preloadPages()
	}, [pages, urlBuilder, onStoreDimensions])

	return { isPreloading }
}

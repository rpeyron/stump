import { APIBase } from '../base'
import { createRouteURLHandler } from './utils'

/**
 * The root route for the media API
 */
const MEDIA_ROUTE = '/media'
/**
 * A helper function to format the URL for media API routes with optional query parameters
 */
const mediaURL = createRouteURLHandler(MEDIA_ROUTE)

/**
 * Options which can be used to request a specific render quality for a page.
 *
 * These are primarily useful for PDF files, where the page is rendered server-side as an
 * image. Requesting a higher scale yields a sharper image when the user zooms in, since
 * the default render is sized for a "fit to screen" view.
 */
export type BookPageUrlOptions = {
	/**
	 * A multiplier applied to the server's configured render quality. A value of `2` will
	 * render the page at twice the configured DPI (and twice the max dimension).
	 *
	 * Only applies to PDF files.
	 */
	scale?: number
}

/**
 * The media API controller, used for interacting with the media endpoints of the Stump API
 */
export class MediaAPI extends APIBase {
	/**
	 * The URL for fetching the thumbnail of a media entity
	 */
	thumbnailURL(id: string): string {
		return this.withServiceURL(mediaURL(`/${id}/thumbnail`))
	}

	/**
	 * The URL for fetching the file of a media entity
	 */
	downloadURL(id: string): string {
		return this.withServiceURL(mediaURL(`/${id}/file`))
	}

	/**
	 * The URL for fetching a page of a media entity
	 */
	bookPageURL(mediaID: string, page: number, options?: BookPageUrlOptions): string {
		return this.withServiceURL(mediaURL(`${mediaID}/page/${page}`, options))
	}
}

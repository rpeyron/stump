import { useParams } from 'react-router'

import NativePDFViewer from '@/components/readers/pdf/NativePDFViewer'

/**
 * A scene for reading PDFs using the native PDF viewer in the browser.
 *
 * Note: PDFs are read with the image-based reader by default, which supports features such
 * as double tap zooming. This scene is an opt-in for the browser's built-in viewer.
 */
export default function PDFReaderScene() {
	const { id } = useParams()

	if (!id) {
		throw new Error('Media ID is required')
	}

	return <NativePDFViewer id={id} />
}

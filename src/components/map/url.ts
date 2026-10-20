/**
 * Absolute URL for mapbox-managed GeoJSON sources. Mapbox hands the URL to
 * its web worker, which fetches + parses the payload off the UI thread.
 * Relative paths are not resolvable from the worker context, so absolute.
 */
export function apiUrl(path: string): string {
	return new URL(path, window.location.origin).href;
}

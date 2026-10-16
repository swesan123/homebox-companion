/**
 * Homebox QR code parsing.
 *
 * Homebox label QR codes encode `{HBURL}/location/{uuid}`, `{HBURL}/item/{uuid}`
 * or `{HBURL}/a/{assetId}` (asset IDs look like `000-001`). The host is
 * ignored so labels keep working behind proxies or after a domain change.
 */

export type HomeboxQrTarget =
	{ type: 'location'; id: string } | { type: 'item'; id: string } | { type: 'asset'; id: string };

const LOCATION_PATH = /\/location\/([a-f0-9-]+)(?:\/|$)/i;
const ITEM_PATH = /\/item\/([a-f0-9-]+)(?:\/|$)/i;
const ASSET_PATH = /\/a\/([A-Za-z0-9-]+)(?:\/|$)/;

/** Extract what a scanned QR code points at, or null when it isn't a Homebox code. */
export function parseHomeboxQr(text: string): HomeboxQrTarget | null {
	const trimmed = text.trim();
	let path = trimmed;
	try {
		path = new URL(trimmed).pathname;
	} catch {
		// Not an absolute URL: match the raw text so bare `/location/<uuid>` paths still work.
	}

	const location = LOCATION_PATH.exec(path);
	if (location) return { type: 'location', id: location[1] };
	const item = ITEM_PATH.exec(path);
	if (item) return { type: 'item', id: item[1] };
	const asset = ASSET_PATH.exec(path);
	if (asset) return { type: 'asset', id: asset[1] };
	return null;
}

// -----------------------------------------------------------------------------
// Camera snapshots in the format Gladys expects.
//
// Gladys takes `image/jpg;base64,...` strings of at most 150 KB. Frigate
// resizes and re-encodes its latest frame on demand (`height` and `quality`
// query parameters), so we ask for the configured height first and step the
// quality, then the height, down until the image fits.
// -----------------------------------------------------------------------------

export const MAX_IMAGE_LENGTH = 150 * 1024;
const IMAGE_PREFIX = 'image/jpg;base64,';
const QUALITIES = [70, 50, 35];
const HEIGHT_FACTORS = [1, 0.75, 0.5, 0.35];
const MIN_HEIGHT = 120;

export function toGladysImage(jpeg) {
  return `${IMAGE_PREFIX}${jpeg.toString('base64')}`;
}

/** Height/quality attempts, from the best image to the smallest one. */
export function snapshotAttempts(height) {
  const heights = [
    ...new Set(HEIGHT_FACTORS.map((f) => Math.max(MIN_HEIGHT, Math.round(height * f)))),
  ];
  return heights.flatMap((h) => QUALITIES.map((quality) => ({ height: h, quality })));
}

/**
 * Fetch the latest frame of a camera, sized to fit the Gladys image limit.
 * @param {import('./frigate/client.js').FrigateClient} client
 * @param {string} camera Frigate camera name
 * @param {number} height preferred height, in pixels
 * @returns {Promise<string>} `image/jpg;base64,...`
 */
export async function fetchSnapshot(client, camera, height) {
  for (const attempt of snapshotAttempts(height)) {
    const image = toGladysImage(await client.getLatestJpeg(camera, attempt));
    if (image.length <= MAX_IMAGE_LENGTH) {
      return image;
    }
  }
  throw new Error(`The snapshot of camera "${camera}" stays above 150 KB even at low quality`);
}

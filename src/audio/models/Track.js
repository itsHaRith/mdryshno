/**
 * Unified Track model.
 * Every layer in the pipeline produces and consumes this shape.
 * No layer may invent its own track representation.
 */
export class Track {
  /**
   * @param {object} data
   * @param {string} data.id           YouTube video ID
   * @param {string} data.url          Canonical watch URL
   * @param {string} data.title        Track title
   * @param {string} [data.artist]     Artist / channel name
   * @param {number} [data.durationMs] Duration in milliseconds (0 = unknown/live)
   * @param {string} [data.thumbnail]  Thumbnail URL
   * @param {string} [data.requester]  Discord user tag who requested it
   */
  constructor(data) {
    this.id          = data.id;
    this.url         = `https://www.youtube.com/watch?v=${data.id}`;
    this.title       = data.title       ?? 'Unknown Title';
    this.artist      = data.artist      ?? 'YouTube';
    this.durationMs  = data.durationMs  ?? 0;
    this.thumbnail   = data.thumbnail   ?? null;
    this.requester   = data.requester   ?? 'Unknown';
    this.addedAt     = Date.now();
  }

  /** Back-compat alias used by dashboard */
  get durationMS() { return this.durationMs; }
}

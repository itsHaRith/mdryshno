/**
 * Structured audio pipeline error.
 * Every failure in the pipeline emits one of these —
 * never a plain Error() — so the monitoring layer has
 * full context for every incident.
 */
export class AudioError extends Error {
  /**
   * @param {string} message  Human-readable description
   * @param {object} ctx      Structured context
   * @param {string} [ctx.source]      Layer that threw (search|resolver|extraction|stream|voice)
   * @param {string} [ctx.provider]    Library/service name
   * @param {string} [ctx.videoId]     YouTube video ID if known
   * @param {string} [ctx.guildId]     Discord guild ID
   * @param {number} [ctx.httpStatus]  HTTP status code if applicable
   * @param {number} [ctx.retryCount]  How many retries were attempted
   * @param {number} [ctx.latencyMs]   Round-trip time in milliseconds
   * @param {Error}  [ctx.cause]       Underlying error
   */
  constructor(message, ctx = {}) {
    super(message);
    this.name = 'AudioError';
    this.source     = ctx.source     ?? 'unknown';
    this.provider   = ctx.provider   ?? 'unknown';
    this.videoId    = ctx.videoId    ?? null;
    this.guildId    = ctx.guildId    ?? null;
    this.httpStatus = ctx.httpStatus ?? null;
    this.retryCount = ctx.retryCount ?? 0;
    this.latencyMs  = ctx.latencyMs  ?? null;
    this.cause      = ctx.cause      ?? null;
    this.timestamp  = new Date().toISOString();
  }

  toJSON() {
    return {
      name:       this.name,
      message:    this.message,
      source:     this.source,
      provider:   this.provider,
      videoId:    this.videoId,
      guildId:    this.guildId,
      httpStatus: this.httpStatus,
      retryCount: this.retryCount,
      latencyMs:  this.latencyMs,
      timestamp:  this.timestamp
    };
  }
}

// Minimal logger. Never log secret values — log presence/errors only.
const ts = () => new Date().toISOString();

export const logger = {
  info: (...a) => console.log(ts(), 'INFO ', ...a),
  warn: (...a) => console.warn(ts(), 'WARN ', ...a),
  error: (...a) => console.error(ts(), 'ERROR', ...a),
};

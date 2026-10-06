export function withDefaults(config, defaults) {
  return { ...defaults, ...config };
}

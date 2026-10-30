// The benchmark's current version, as printed on every generated report so
// a score can always be attributed to the harness that produced it. This is
// the single source: report renderers import it rather than repeating the
// string, and package.json's "version" field is kept equal to it (without
// the "v" prefix). Bump both together when the version moves.
export const BENCH_VERSION = 'v1.5';

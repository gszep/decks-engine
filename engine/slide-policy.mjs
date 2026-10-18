// Local 3D renderers need same-origin asset reads and generated sorter workers.
// This is a strict manifest opt-in; ordinary slides retain the closed policy.
export function localRendererPolicy(manifest) {
  return manifest.localRenderer === true
    ? "connect-src 'self'; worker-src 'self' blob:;"
    : "connect-src 'none';";
}

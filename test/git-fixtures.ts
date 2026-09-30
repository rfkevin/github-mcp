/** Fixture d'un unique fichier : arbres non récursifs, blob, résolution de ref. */
export function gitFileResponse(url: string, file: {
  path: string; sha: string; content: string; size: number; type?: string; encoding?: string;
}): Response | undefined {
  const segments = file.path.split('/');
  const treeIds = segments.map((_, i) => (i + 1).toString(16).padStart(40, '0'));
  if (url.includes('/git/trees/')) {
    const ref = decodeURIComponent(new URL(url).pathname.split('/git/trees/')[1]);
    const position = treeIds.indexOf(ref) + 1;
    const index = position === 0 ? 0 : position;
    const last = index === segments.length - 1;
    return Response.json({ truncated: false, tree: [{ path: segments[index],
      type: !last || file.type === 'dir' ? 'tree' : 'blob',
      mode: !last || file.type === 'dir' ? '040000' : '100644',
      sha: last ? file.sha : treeIds[index], size: last ? file.size : undefined }] });
  }
  if (url.includes('/git/blobs/')) return Response.json({ encoding: file.encoding ?? 'base64', content: file.content, size: file.size });
  if (url.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
  return undefined;
}

export function textFileResponse(url: string, path: string, content: string): Response | undefined {
  const bytes = new TextEncoder().encode(content);
  return gitFileResponse(url, { path, content: btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')),
    size: bytes.length, sha: 'c'.repeat(40), type: 'file' });
}

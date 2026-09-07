/**
 * Decompress zlib-compressed board data with built-in DecompressionStream
 */

// ArrayBuffer -> Blob -> ReadableStream -> [inflate pipe] -> Response -> ArrayBuffer -> Uint8Array
export async function inflate(bytes: ArrayBuffer): Promise<Uint8Array> {
    const stream = new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream("deflate")); // as we used deflateSync(board) in encodeSnapshot()
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

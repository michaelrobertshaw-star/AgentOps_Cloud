import { NextRequest, NextResponse } from "next/server";

/**
 * Image proxy — fetches an external image URL server-side and returns the bytes.
 * Used to bypass network restrictions on the Express server for S3 presigned URLs.
 * Only allows specific trusted patterns (iCabbi S3 signatures).
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url required" }, { status: 400 });

  // Allowlist: only icabbi S3 signatures
  if (!/^https:\/\/s3\.amazonaws\.com\/icabbius\./i.test(url)) {
    return NextResponse.json({ error: "URL not allowed" }, { status: 403 });
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) {
      return NextResponse.json({ error: `Upstream HTTP ${res.status}` }, { status: 502 });
    }
    const buf = await res.arrayBuffer();
    const mime = res.headers.get("content-type") || "image/png";
    return new NextResponse(buf, {
      status: 200,
      headers: { "Content-Type": mime, "Cache-Control": "private, max-age=3600" },
    });
  } catch (err: any) {
    return NextResponse.json({ error: String(err.message ?? err) }, { status: 502 });
  }
}

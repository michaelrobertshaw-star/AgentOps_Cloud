import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const runId = params.id;

    // Forward the native access_token cookie as Bearer token to the backend.
    // The cookie already contains a valid JWT with the correct company_id,
    // issued by the backend's own auth system at login time.
    const token = request.cookies.get("access_token")?.value;
    if (!token) {
      return NextResponse.json(
        { error: "Not authenticated — please log in" },
        { status: 401 }
      );
    }

    // Proxy SSE stream from backend
    const backendUrl = `http://localhost:4000/api/agent-runs/${runId}/stream`;
    const response = await fetch(backendUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[agent-runs/stream] Backend error ${response.status}:`, text);
      return NextResponse.json(
        { error: `Backend error: ${response.status}` },
        { status: response.status }
      );
    }

    // Return the SSE stream as-is
    return new NextResponse(response.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[agent-runs/stream] Error:`, message);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
